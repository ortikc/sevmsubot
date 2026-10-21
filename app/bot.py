"""Minimal Telegram bot: /start answers with a button that opens the Mini App."""
import asyncio
import logging
from pathlib import Path

import httpx

log = logging.getLogger("bot")

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
        self.api = f"https://api.telegram.org/bot{token}"
        self.client = httpx.AsyncClient(timeout=40)

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
        log.info("bot @%s", me.get("username"))
        await self.call("setMyCommands", commands=[{"command": "start", "description": "Открыть расписание"}])
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
                                          allowed_updates=["message"])
                for u in updates:
                    offset = u["update_id"] + 1
                    await self.handle(u)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("polling error: %s", e)
                await asyncio.sleep(5)

    async def handle(self, update):
        msg = update.get("message") or {}
        chat = msg.get("chat", {}).get("id")
        if not chat:
            return
        if not self.webapp_url:
            await self.call("sendMessage", chat_id=chat,
                            text="Приложение сейчас не запущено. Попробуйте позже.")
            return
        await self.call("sendMessage", chat_id=chat, text=GREETING, reply_markup={
            "inline_keyboard": [[{"text": "Открыть расписание", "web_app": {"url": self.webapp_url}}]],
        })
