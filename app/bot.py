"""Minimal Telegram bot: /start answers with a button that opens the Mini App; it also sends
reminders and the morning summary, dressed in emoji (Telegram Premium ones once the owner sets them),
and confirms sign-ins of the app outside Telegram (/start login_<code>)."""
import asyncio
import html
import json
import logging
import os
from pathlib import Path

import httpx

log = logging.getLogger("bot")

# emoji slots used in the bot's messages, in the order /emoji fills them; values are the plain fallbacks
EMOJI_SLOTS = {"alarm": "⏰", "sun": "☀️", "clock": "🕘", "pin": "📍", "book": "📚"}
EMOJI_FILE = Path(__file__).resolve().parent.parent / "data" / "emoji.json"
# Telegram lets a bot use Premium (custom) emoji in private chats when the bot's owner has Premium
OWNER = os.getenv("BOT_OWNER", "ortikc").lstrip("@").lower()

GREETING = (
    "Привет! Это расписание Севастопольского филиала МГУ.\n"
    "Нажмите кнопку ниже, чтобы открыть своё расписание."
)


class Bot:
    def __init__(self, token: str, webapp_url: str, url_file: Path | None = None):
        self.token = token
        self.static_url = webapp_url
        self.url_file = url_file
        self.menu_url = None
        # hooks the app sets: who to re-point when the address changes, and where "open" buttons were sent
        self.on_url_change = None   # async (url) -> None
        self.on_open_button = None  # (chat_id, message_id) -> None
        self.on_login = None        # (sender, code) -> (text, keyboard | None): /start login_<code> from the app outside Telegram
        self.on_login_answer = None # (sender, code, yes) -> text: the student's answer under that question
        self.on_app = None          # async (chat_id) -> None: /app sends the offer of the app for the phone again
        self.on_app_declined = None # (sender) -> text: «Нет, не надо» under that offer
        self.username = None        # the bot's @name, known after setup()
        self.api = f"https://api.telegram.org/bot{token}"
        self.client = httpx.AsyncClient(timeout=40)
        self.custom = self._load_custom()

    # ---------- emoji ----------

    @staticmethod
    def _load_custom() -> dict:
        try:
            return {k: v for k, v in json.loads(EMOJI_FILE.read_text(encoding="utf-8")).items() if k in EMOJI_SLOTS}
        except (OSError, ValueError):
            return {}

    def emoji(self, slot: str, premium: bool = True) -> str:
        """HTML for one emoji: the owner's Premium emoji when set, the plain one otherwise."""
        plain = EMOJI_SLOTS[slot]
        cid = self.custom.get(slot) if premium else None
        return f'<tg-emoji emoji-id="{html.escape(cid)}">{plain}</tg-emoji>' if cid else plain

    async def send_rich(self, chat_id, build):
        """build(emoji) -> HTML text. If Telegram refuses the Premium emoji, send the plain version."""
        try:
            return await self.call("sendMessage", chat_id=chat_id, text=build(self.emoji), parse_mode="HTML")
        except RuntimeError as e:
            if not self.custom:
                raise
            log.warning("premium emoji refused (%s), sending plain emoji", e)
            return await self.call("sendMessage", chat_id=chat_id, parse_mode="HTML",
                                   text=build(lambda slot: self.emoji(slot, premium=False)))

    async def set_custom_emoji(self, msg):
        """/emoji followed by Premium emoji, in slot order: alarm, sun, clock, pin, book."""
        ids = [e["custom_emoji_id"] for e in msg.get("entities", []) if e.get("type") == "custom_emoji"]
        chat = msg["chat"]["id"]
        if not ids:
            order = " ".join(EMOJI_SLOTS.values())
            await self.call("sendMessage", chat_id=chat, text=(
                "Отправьте /emoji и после него Premium-эмодзи в таком порядке, на замену этим: "
                f"{order} (напоминание, утро, время, аудитория, пара)."))
            return
        self.custom = dict(zip(EMOJI_SLOTS, ids))
        EMOJI_FILE.parent.mkdir(exist_ok=True)
        EMOJI_FILE.write_text(json.dumps(self.custom, ensure_ascii=False, indent=1), encoding="utf-8")
        await self.send_rich(chat, lambda e: (
            f"Готово, запомнил {len(self.custom)} эмодзи. Так будут выглядеть напоминания:\n\n"
            f"{e('alarm')} <b>Через 10 минут: Математический анализ</b>\n"
            f"{e('clock')} 10:40–12:10 · {e('pin')} ауд. 172"))

    @property
    def webapp_url(self):
        """WEBAPP_URL from .env wins; otherwise the tunnel address run.py keeps in a file."""
        if self.static_url:
            return self.static_url
        if self.url_file and self.url_file.exists():
            return self.url_file.read_text().strip()
        return ""

    async def sync_menu_button(self):
        url = self.webapp_url
        if url and url != self.menu_url:
            await self.call("setChatMenuButton", menu_button={
                "type": "web_app", "text": "Расписание", "web_app": {"url": url},
            })
            self.menu_url = url
            log.info("menu button -> %s", url)
            if self.on_url_change:  # a new address, after a restart too: the old one is dead
                await self.on_url_change(url)

    async def watch_url(self):
        while True:
            try:
                await self.sync_menu_button()
            except Exception as e:
                log.warning("menu button update failed: %s", e)
            await asyncio.sleep(10)

    async def call(self, method, **params):
        r = await self.client.post(f"{self.api}/{method}", json=params)
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError(f"{method}: {data.get('description')}")
        return data["result"]

    async def setup(self):
        me = await self.call("getMe")
        self.username = me.get("username")
        log.info("bot @%s", self.username)
        await self.call("setMyCommands", commands=[
            {"command": "start", "description": "Открыть расписание"},
            {"command": "app", "description": "Приложение на телефон"},
        ])
        return me

    async def file_url(self, user_id: int):
        """URL of the user's current profile photo, or None."""
        photos = await self.call("getUserProfilePhotos", user_id=user_id, limit=1)
        if not photos.get("total_count"):
            return None
        sizes = photos["photos"][0]
        f = await self.call("getFile", file_id=sizes[min(1, len(sizes) - 1)]["file_id"])
        return f"https://api.telegram.org/file/bot{self.token}/{f['file_path']}"

    async def poll(self):
        offset = 0
        while True:
            try:
                updates = await self.call("getUpdates", offset=offset, timeout=30,
                                          allowed_updates=["message", "callback_query"])
                for u in updates:
                    offset = u["update_id"] + 1
                    await self.handle(u)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("polling error: %s", e)
                await asyncio.sleep(5)

    async def handle(self, update):
        if "callback_query" in update:
            await self.handle_button(update["callback_query"])
            return
        msg = update.get("message") or {}
        chat = msg.get("chat", {}).get("id")
        if not chat:
            return
        sender = (msg.get("from", {}).get("username") or "").lower()
        if (msg.get("text") or "").startswith("/emoji") and sender == OWNER:
            await self.set_custom_emoji(msg)
            return
        if (msg.get("text") or "").startswith("/start login_") and self.on_login:
            text, keyboard = self.on_login(msg.get("from", {}), msg["text"].split("login_", 1)[1].strip())
            await self.call("sendMessage", chat_id=chat, text=text, **({"reply_markup": keyboard} if keyboard else {}))
            return
        if (msg.get("text") or "").split("@")[0].strip() == "/app" and self.on_app:
            await self.on_app(chat)
            return
        if not self.webapp_url:
            await self.call("sendMessage", chat_id=chat,
                            text="Приложение сейчас не запущено. Попробуйте позже.")
            return
        sent = await self.call("sendMessage", chat_id=chat, text=GREETING, reply_markup=self.open_button())
        if self.on_open_button:
            self.on_open_button(chat, sent["message_id"])

    async def handle_button(self, q):
        """A tap on an inline button: "yes"/"no" under a sign-in question, or «Нет, не надо» under the app offer.
        The answer replaces the message, and its buttons go with it."""
        kind, _, rest = (q.get("data") or "").partition(":")
        text = None
        if kind == "login" and self.on_login_answer:
            code, _, answer = rest.partition(":")
            text = self.on_login_answer(q.get("from", {}), code, answer == "yes")
        elif kind == "app" and rest == "no" and self.on_app_declined:
            text = self.on_app_declined(q.get("from", {}))
        await self.call("answerCallbackQuery", callback_query_id=q["id"])
        msg = q.get("message")
        if text and msg:
            await self.call("editMessageText", chat_id=msg["chat"]["id"], message_id=msg["message_id"], text=text)

    def open_button(self, url=None):
        return {"inline_keyboard": [[{"text": "Открыть расписание", "web_app": {"url": url or self.webapp_url}}]]}

    async def repoint(self, url, chats, buttons):
        """Every known chat gets its own menu button and its old "open" buttons re-pointed, so Telegram
        never keeps a dead tunnel address in its cache or in the chat history."""
        for chat in chats:
            try:
                await self.call("setChatMenuButton", chat_id=chat, menu_button={
                    "type": "web_app", "text": "Расписание", "web_app": {"url": url}})
            except Exception as e:
                log.warning("menu button for %s: %s", chat, e)
            await asyncio.sleep(0.05)
        for chat, message_id in buttons:
            try:
                await self.call("editMessageReplyMarkup", chat_id=chat, message_id=message_id,
                                reply_markup=self.open_button(url))
            except Exception:
                pass  # deleted or too old to edit; nothing to do
            await asyncio.sleep(0.05)
