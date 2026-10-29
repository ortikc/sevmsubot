"""HTTP API + static Mini App."""
import asyncio
import base64
import hashlib
import hmac
import html
import json
import logging
import mimetypes
import os
import re
import secrets
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta, timezone
from io import BytesIO
from pathlib import Path
from urllib.parse import parse_qsl

import httpx
from dotenv import load_dotenv
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

from . import backup, db, scraper
from .auth import AuthError, validate_init_data
from .bot import Bot
from .profanity import has_profanity

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
DEV_AUTH = os.getenv("DEV_AUTH") == "1"
AVATARS = ROOT / "data" / "avatars"   # uploaded profile photos, named by a random token
AVATARS.mkdir(parents=True, exist_ok=True)
AVATAR_SIZE = 256
AVATAR_MAX_BYTES = 8 * 1024 * 1024
NICK_MAX = 32
CONSENT_VERSION = "2026-10-27.2"   # the edition of the consent and privacy policy; a new one asks everyone again
BIO_MAX = 200
Image.MAX_IMAGE_PIXELS = 50_000_000
FULL_SYNC_EVERY = timedelta(hours=6)
GROUP_STALE_AFTER = timedelta(hours=2)
MSK = timezone(timedelta(hours=3))  # Sevastopol keeps Moscow time, no DST
REMIND_BEFORE = timedelta(minutes=10)
LEADS = (5, 10, 15)                                        # "remind about every pair", minutes before
DIGEST_TIMES = ("06:30", "07:00", "07:30", "08:00", "08:30")  # morning summary
REFRESH_COOLDOWN = timedelta(seconds=60)
KINDS = {"лк": "лекция", "сем": "семинар", "пз": "практика", "лб": "лабораторная", "лаб": "лабораторная"}
BOT_USERNAME = os.getenv("BOT_USERNAME", "sevmsubot")   # for the sign-in link until the bot has said its name
LOGIN_MINUTES = 10           # a sign-in through the bot must be confirmed within this
LOGINS_MAX = 200             # sign-ins waiting at once, so nobody can fill the table
DEVICE_IDLE_DAYS = 180       # a device that has not opened the app for half a year is signed out
INSTALL_LINK_HOURS = 24      # the «Скачать» button under the bot's offer works once, for a day
APP_OFFER = ("Поставьте «Расписание» на главный экран телефона: пары, статистика и друзья будут открываться "
             "даже без интернета.\n\nНажмите «Скачать»: откроется браузер, вход уже будет выполнен, а стрелки "
             "и подсказки покажут, куда нажать.")
mimetypes.add_type("application/manifest+json", ".webmanifest")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("app")

bot: Bot | None = None
_group_locks: dict[int, asyncio.Lock] = {}


async def full_sync_loop():
    while True:
        scraper.prune_past_weeks()  # a finished week leaves soon after Monday midnight
        with db.session() as conn:
            last = db.get_meta(conn, "all_synced_at")
        due = not last or datetime.now(timezone.utc) - datetime.fromisoformat(last) > FULL_SYNC_EVERY
        if due:
            try:
                await scraper.sync_all()
            except Exception as e:
                log.warning("full sync failed: %s", e)
                await admin.alert(f"Полное обновление расписания не прошло: {e}")
            with db.session() as conn:
                broken = conn.execute("SELECT COUNT(*) FROM groups WHERE sync_error IS NOT NULL").fetchone()[0]
            if broken:
                await admin.alert(f"Расписание: {broken} групп не обновились. Подробности в разделе «Расписание».")
        await asyncio.sleep(15 * 60)


def _clock(hhmm: str) -> str:
    h, m = hhmm.split(":")
    return f"{int(h)}:{m}"


def _pairs_word(n: int) -> str:
    a, b = n % 10, n % 100
    if a == 1 and b != 11:
        return "пара"
    if 2 <= a <= 4 and not 12 <= b <= 14:
        return "пары"
    return "пар"


def materialize_auto_reminders(conn, now: datetime, tg_id: int | None = None):
    """'Remind about every pair' becomes reminder rows for today and tomorrow, one per pair slot."""
    today = now.astimezone(MSK).date()
    users = conn.execute(
        "SELECT tg_id, group_id, remind_lead FROM users WHERE remind_all=1 AND group_id IS NOT NULL "
        "AND consent_at IS NOT NULL"
        + (" AND tg_id=?" if tg_id else ""), (tg_id,) if tg_id else (),
    ).fetchall()
    for u in users:
        slots = conn.execute(
            "SELECT date, start, end, MIN(subject) AS subject, room FROM lessons "
            "WHERE group_id=? AND date BETWEEN ? AND ? GROUP BY date, start",
            (u["group_id"], today.isoformat(), (today + timedelta(days=1)).isoformat()),
        ).fetchall()
        for l in slots:
            starts = datetime.combine(date.fromisoformat(l["date"]), time.fromisoformat(l["start"]), MSK)
            remind_at = starts - timedelta(minutes=u["remind_lead"])
            if remind_at < now:
                continue  # too late to say "in N minutes"
            conn.execute(
                "INSERT OR IGNORE INTO reminders(tg_id, date, start, end, subject, room, remind_at, lead, auto) "
                "VALUES(?,?,?,?,?,?,?,?,1)",
                (u["tg_id"], l["date"], l["start"], l["end"], l["subject"], l["room"],
                 remind_at.astimezone(timezone.utc).isoformat(timespec="seconds"), u["remind_lead"]),
            )


def _reminder_html(r, e):
    text = f"{e('alarm')} <b>Через {r['lead']} минут: {html.escape(r['subject'])}</b>\n{e('clock')} {_clock(r['start'])}–{_clock(r['end'])}"
    if r["room"]:
        text += f" · {e('pin')} ауд. {html.escape(r['room'])}"
    return text


def _digest_html(slots, e):
    lines = [f"{e('sun')} <b>Доброе утро! Сегодня {len(slots)} {_pairs_word(len(slots))}</b>", ""]
    for i, s in enumerate(slots):
        kind = KINDS.get((s["kind"] or "").lower(), s["kind"] or "")
        room = f" · {e('pin')} {html.escape(s['room'])}" if s["room"] else ""
        lines.append(f"{e('book')} <b>{_clock(s['start'])}</b> {html.escape(s['subject'])}"
                     f"{f' ({html.escape(kind)})' if kind else ''}{room}")
    return "\n".join(lines)


async def send_due_reminders(now: datetime):
    with db.session() as conn:
        due = [dict(r) for r in conn.execute(
            "SELECT r.*, u.group_id, u.consent_at FROM reminders r JOIN users u ON u.tg_id = r.tg_id "
            f"WHERE r.sent_at IS NULL AND r.remind_at <= ? AND r.tg_id NOT IN {BANNED} ORDER BY r.remind_at",
            (now.isoformat(timespec="seconds"),))]
    for r in due:
        with db.session() as conn:
            # the schedule may have changed since the reminder was set: stay quiet about a pair that is gone
            still = conn.execute("SELECT 1 FROM lessons WHERE group_id=? AND date=? AND start=?",
                                 (r["group_id"], r["date"], r["start"])).fetchone()
        msg_id = None
        # without consent the reminder is dropped; after the pair has begun (the server was down) it is no use
        if still and r["consent_at"] and now < _pair_start(r):
            try:
                sent = await bot.send_rich(r["tg_id"], lambda e: _reminder_html(r, e))
                msg_id = sent.get("message_id") if isinstance(sent, dict) else None
            except Exception as e:  # the student may have blocked the bot; never retry forever
                log.warning("reminder %s not sent: %s", r["id"], e)
        with db.session() as conn:
            conn.execute("UPDATE reminders SET sent_at=?, msg_id=? WHERE id=?",
                         (datetime.now(timezone.utc).isoformat(timespec="seconds"), msg_id, r["id"]))


def _pair_start(r) -> datetime:
    return datetime.fromisoformat(f"{r['date']}T{r['start']}").replace(tzinfo=MSK)


async def retire_reminders(now: datetime):
    """A reminder has done its job once its pair begins: its message leaves the chat, so the chat stays clean."""
    with db.session() as conn:
        sent = [dict(r) for r in conn.execute("SELECT id, tg_id, date, start, msg_id FROM reminders WHERE msg_id IS NOT NULL")]
    for r in sent:
        if now < _pair_start(r):
            continue
        try:
            await bot.call("deleteMessage", chat_id=r["tg_id"], message_id=r["msg_id"])
        except Exception as e:  # the student deleted it already, or blocked the bot: nothing left to clean
            log.info("reminder %s message not deleted: %s", r["id"], e)
        with db.session() as conn:
            conn.execute("UPDATE reminders SET msg_id=NULL WHERE id=?", (r["id"],))


async def send_digests(now: datetime):
    """The morning summary goes once a day, at the chosen time or as soon after it as the server is up,
    but only before the first pair, and only on days with pairs."""
    local = now.astimezone(MSK)
    today, hhmm = local.date().isoformat(), local.strftime("%H:%M")
    with db.session() as conn:
        users = [dict(u) for u in conn.execute(
            "SELECT tg_id, group_id, digest_time FROM users WHERE digest_time IS NOT NULL AND group_id IS NOT NULL "
            f"AND consent_at IS NOT NULL AND tg_id NOT IN {BANNED} "
            "AND (digest_sent_on IS NULL OR digest_sent_on < ?) AND digest_time <= ?", (today, hhmm))]
    for u in users:
        with db.session() as conn:
            conn.execute("UPDATE users SET digest_sent_on=? WHERE tg_id=?", (today, u["tg_id"]))
            slots = [dict(r) for r in conn.execute(
                "SELECT start, end, MIN(subject) AS subject, kind, room FROM lessons "
                "WHERE group_id=? AND date=? GROUP BY start ORDER BY start", (u["group_id"], today))]
        if not slots or hhmm >= slots[0]["start"]:
            continue
        try:
            await bot.send_rich(u["tg_id"], lambda e: _digest_html(slots, e))
        except Exception as e:
            log.warning("digest for %s not sent: %s", u["tg_id"], e)


# ---------- the week in the bot's chat, retired ----------
# The bot used to keep the week's pairs pinned in its chat. It no longer does; on the first start without it
# the messages it left behind are taken down, a few a second: deleted, or where Telegram no longer allows that,
# unpinned and marked as old. week_msg empties as it goes, so the round is done once.

async def clear_pinned_weeks():
    await asyncio.sleep(20)   # the bot first
    if not bot:
        return
    with db.session() as conn:
        left = [dict(r) for r in conn.execute("SELECT tg_id, week_msg FROM users WHERE week_msg IS NOT NULL")]
    for u in left:
        try:
            await bot.call("deleteMessage", chat_id=u["tg_id"], message_id=u["week_msg"])
        except Exception:
            for method, params in (("unpinChatMessage", {"message_id": u["week_msg"]}),
                                   ("editMessageText", {"message_id": u["week_msg"],
                                                        "text": "Расписание недели в этом чате больше не обновляется: оно в приложении."})):
                try:
                    await bot.call(method, chat_id=u["tg_id"], **params)
                except Exception as e:   # blocked the bot, or the message is gone: nothing to take down
                    log.info("pinned week of %s: %s", u["tg_id"], e)
        with db.session() as conn:
            conn.execute("UPDATE users SET week_msg=NULL, week_hash=NULL WHERE tg_id=?", (u["tg_id"],))
        await asyncio.sleep(0.2)
    if left:
        log.info("pinned weeks taken down: %d", len(left))


BACKUPS = ROOT / "data" / "backups"
BACKUP_KEEP = 14   # two weeks of daily copies


async def backup_loop():
    """A copy of the database once a day (by Moscow date), as soon as the server is up that day.
    The same round signs out devices nobody has opened the app on for half a year."""
    while True:
        with db.session() as conn:
            conn.execute("DELETE FROM devices WHERE seen_at < datetime('now', ?)", (f"-{DEVICE_IDLE_DAYS} days",))
            conn.execute("DELETE FROM install_links WHERE created_at < datetime('now', ?)", (f"-{INSTALL_LINK_HOURS} hours",))
        stamp = datetime.now(MSK).date().isoformat()
        if not (BACKUPS / f"msu-{stamp}.sqlite3").exists():
            try:
                path = await asyncio.to_thread(backup.make_backup, db.DB_PATH, BACKUPS, stamp, BACKUP_KEEP)
                log.info("backup: %s", path.name)
            except Exception as e:
                log.warning("backup failed: %s", e)
                await admin.alert(f"Резервная копия базы не сделалась: {e}")
        await asyncio.sleep(30 * 60)


async def reminder_loop():
    """Every 20 seconds: plan the automatic reminders, send what is due, take down the ones whose pair has
    begun, send morning summaries."""
    while True:
        await asyncio.sleep(20)
        if not bot:
            continue
        now = datetime.now(timezone.utc)
        try:
            with db.session() as conn:
                materialize_auto_reminders(conn, now)
            await send_due_reminders(now)
            await retire_reminders(now)
            await send_digests(now)
        except Exception as e:
            log.warning("reminder loop: %s", e)


async def _repoint_everyone(url: str):
    with db.session() as conn:
        chats = [r["tg_id"] for r in conn.execute("SELECT tg_id FROM users WHERE tg_id > 1")]
        buttons = [(r["chat_id"], r["message_id"]) for r in conn.execute("SELECT chat_id, message_id FROM open_buttons")]
    await bot.repoint(url, chats, buttons)
    log.info("re-pointed %d chats and %d open buttons to %s", len(chats), len(buttons), url)


def _remember_open_button(chat_id: int, message_id: int):
    with db.session() as conn:
        conn.execute("INSERT OR IGNORE INTO open_buttons(chat_id, message_id) VALUES(?, ?)", (chat_id, message_id))


@asynccontextmanager
async def lifespan(_app):
    global bot
    db.init()
    _close_profane_open_posts()
    tasks = [asyncio.create_task(full_sync_loop()), asyncio.create_task(reminder_loop()), asyncio.create_task(backup_loop()),
             asyncio.create_task(clear_pinned_weeks())]
    if BOT_TOKEN:
        bot = Bot(BOT_TOKEN, os.getenv("WEBAPP_URL", ""), ROOT / "data" / "webapp_url.txt")
        bot.on_url_change = _repoint_everyone
        bot.on_open_button = _remember_open_button
        bot.on_login = _login_ask
        bot.on_login_answer = _login_answer
        bot.on_app = _app_command
        bot.on_app_declined = _app_declined
        bot.is_banned = _ban_text
        try:
            await bot.setup()
            tasks.append(asyncio.create_task(bot.poll()))
            tasks.append(asyncio.create_task(bot.watch_url()))
        except Exception as e:
            log.warning("bot setup failed: %s", e)
    tasks += await admin.start()
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def no_stale_assets(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/") and "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.middleware("http")
async def admin_host(request: Request, call_next):
    """admin.sevstud.site is the CRM: its pages come from webapp-admin (mounted at /crm) and its API is
    /api/admin. The app's own address serves neither; on localhost both work, for testing."""
    host = (request.headers.get("host") or "").split(":")[0]
    path = request.url.path
    if host == admin.CRM_HOST:
        if not path.startswith(("/api/admin/", "/avatars/", "/posts/", "/crm/")):
            request.scope["path"] = "/crm" + path
    elif path.startswith(("/api/admin/", "/crm")) and host not in ("localhost", "127.0.0.1"):
        return Response("Not Found", status_code=404)
    return await call_next(request)


# ---------- auth ----------

DEV_USER = {"id": 1, "first_name": "Анна", "last_name": "Ковалёва", "username": "test_student"}


def current_tg_user(request: Request) -> dict:
    init_data = request.headers.get("X-Init-Data", "")
    if init_data:
        try:
            return validate_init_data(init_data, BOT_TOKEN)
        except AuthError as e:
            log.warning("auth rejected: %s (fields: %s)", e,
                        ",".join(sorted(k for k, _ in parse_qsl(init_data))))
            raise HTTPException(401, f"Telegram auth failed: {e}")
    auth = request.headers.get("authorization", "")
    if auth[:7].lower() == "bearer ":
        return _device_user(auth[7:].strip())
    host = (request.headers.get("host") or "").split(":")[0]
    if DEV_AUTH and host in ("localhost", "127.0.0.1"):
        dev_id = request.headers.get("X-Dev-User", "")
        if dev_id.isdigit() and int(dev_id) != DEV_USER["id"]:
            with db.session() as conn:
                u = conn.execute("SELECT * FROM users WHERE tg_id=?", (int(dev_id),)).fetchone()
            if u:
                return {"id": u["tg_id"], "first_name": u["tg_first"], "last_name": u["tg_last"],
                        "username": u["username"], "photo_url": u["photo_url"]}
        return DEV_USER
    log.warning("auth rejected: request without initData (host %s)", host)
    raise HTTPException(401, "Open the app from Telegram")


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _device_user(key: str) -> dict:
    """The app on a phone's home screen, outside Telegram: it shows the key it got at sign-in through the bot."""
    with db.session() as conn:
        row = conn.execute("SELECT d.id AS device_id, u.* FROM devices d JOIN users u ON u.tg_id = d.tg_id "
                           "WHERE d.key_hash=?", (_hash(key),)).fetchone()
        if not row:
            raise HTTPException(401, "Вход на этом устройстве закончился, войдите снова")
        conn.execute("UPDATE devices SET seen_at=datetime('now') WHERE id=? AND seen_at < datetime('now', '-10 minutes')",
                     (row["device_id"],))
    return {"id": row["tg_id"], "first_name": row["tg_first"], "last_name": row["tg_last"],
            "username": row["username"], "photo_url": row["photo_url"], "device_id": row["device_id"]}


def _device_name(ua: str) -> str:
    """"Android · Chrome" from a User-Agent: enough to tell one's own devices apart in the list."""
    system = next((name for key, name in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"),
                                          ("Windows", "Windows"), ("Mac OS X", "Mac"), ("CrOS", "ChromeOS"),
                                          ("Linux", "Linux")) if key in ua), "")
    browser = next((name for key, name in (("YaBrowser", "Яндекс Браузер"), ("SamsungBrowser", "Samsung Internet"),
                                           ("Edg", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
                                           ("FxiOS", "Firefox"), ("CriOS", "Chrome"), ("Chrome/", "Chrome"),
                                           ("Safari/", "Safari")) if key in ua), "")
    return " · ".join(filter(None, (system, browser))) or "Браузер"


# students the admin banned, as SQL: `tg_id NOT IN {BANNED}`
BANNED = ("(SELECT tg_id FROM restrictions WHERE kind='ban' "
          "AND (until IS NULL OR until > strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')))")


def _restriction(conn, tg_id: int, kind: str):
    """The admin's ban or mute on the student while it lasts, or None."""
    return conn.execute("SELECT * FROM restrictions WHERE tg_id=? AND kind=? AND (until IS NULL OR until > ?)",
                        (tg_id, kind, datetime.now(timezone.utc).isoformat(timespec="seconds"))).fetchone()


def _until_text(until: str | None) -> str:
    return f"до {datetime.fromisoformat(until).astimezone(MSK).strftime('%d.%m.%Y %H:%M')}" if until else "бессрочно"


def _ban_text(tg_id: int) -> str | None:
    """What the bot says to a banned student instead of anything else."""
    with db.session() as conn:
        ban = _restriction(conn, tg_id, "ban")
    if not ban:
        return None
    return (f"Ваш аккаунт заблокирован {_until_text(ban['until'])}."
            + (f"\nПричина: {ban['reason']}" if ban["reason"] else "")
            + f"\n\nЕсли это ошибка, напишите разработчику: @{admin.CRM_ADMIN}")


def current_user(request: Request, tg: dict = Depends(current_tg_user)):
    """The student's row with the Telegram fields refreshed. A newcomer is not written down until they
    consent (a tick on the last onboarding step): until then they get a row that lives only for this request.
    A banned student gets nothing but the ban (deleting the account stays open to them); every request of a
    registered one marks the hour as active, for the admin panel's stats."""
    fields = {"tg_first": tg.get("first_name", ""), "tg_last": tg.get("last_name", ""),
              "username": tg.get("username", ""), "photo_url": tg.get("photo_url", "")}
    with db.session() as conn:
        ban = _restriction(conn, tg["id"], "ban")
        if ban and not (request.method == "DELETE" and request.url.path == "/api/account"):
            raise HTTPException(403, {"banned": True, "until": ban["until"], "reason": ban["reason"],
                                      "contact": admin.CRM_ADMIN})
        if not conn.execute("SELECT 1 FROM users WHERE tg_id=?", (tg["id"],)).fetchone():
            blank = dict.fromkeys(c[0] for c in conn.execute("SELECT * FROM users LIMIT 0").description)
            return {**blank, **fields, "tg_id": tg["id"]}
        conn.execute("UPDATE users SET tg_first=:tg_first, tg_last=:tg_last, username=:username, "
                     "photo_url=:photo_url, updated_at=datetime('now') WHERE tg_id=:id", {**fields, "id": tg["id"]})
        local = datetime.now(MSK)
        conn.execute("INSERT OR IGNORE INTO activity(tg_id, day, hour) VALUES(?, ?, ?)",
                     (tg["id"], local.date().isoformat(), local.hour))
        return dict(conn.execute("SELECT * FROM users WHERE tg_id=?", (tg["id"],)).fetchone())


def consented_user(user=Depends(current_user)):
    """Everything past the onboarding needs consent to the current edition of the policy."""
    if user["consent_version"] != CONSENT_VERSION:
        raise HTTPException(403, "Сначала нужно согласие на обработку персональных данных")
    return user


def speaking_user(user=Depends(consented_user)):
    """Writing anything others read (posts, comments, clubs, the nick, «о себе», the photo) is closed to a
    student the admin muted; reading stays open."""
    with db.session() as conn:
        mute = _restriction(conn, user["tg_id"], "mute")
    if mute:
        raise HTTPException(403, f"Администратор ограничил вам публикации {_until_text(mute['until'])}"
                                 + (f". Причина: {mute['reason']}" if mute["reason"] else ""))
    return user


# what the admin can switch off without a deploy (the admin panel's «Настройки»); all on by default
FEATURES = {"registration": "Регистрация новых студентов", "friends": "Заявки в друзья",
            "clubs_create": "Создание клубов", "posts": "Новые записи в клубах", "comments": "Комментарии"}
FEATURE_OFF = {"registration": "Регистрация новых пользователей временно закрыта. Попробуйте позже.",
               "friends": "Заявки в друзья временно отключены.",
               "clubs_create": "Создание клубов временно отключено.",
               "posts": "Новые записи временно отключены.",
               "comments": "Комментарии временно отключены."}


def app_config(conn) -> dict:
    """The settings the admin changes from the panel: semester dates, the switches, the banner."""
    try:
        cfg = json.loads(db.get_meta(conn, "app_config") or "{}")
    except ValueError:
        cfg = {}
    return {"semester": {"start": "2026-09-01", "session": "2027-01-03", **cfg.get("semester", {})},
            "features": {k: True for k in FEATURES} | cfg.get("features", {}),
            "banner": cfg.get("banner") or ""}


def _feature(conn, name: str):
    if not app_config(conn)["features"].get(name, True):
        raise HTTPException(403, FEATURE_OFF[name])


def _watch_words(conn, tg_id: int, place: str, text: str, blocked: bool = False):
    """Swearing anywhere in what students write goes to the admin panel's log; only open posts are refused."""
    if text and has_profanity(text):
        conn.execute("INSERT INTO profanity_log(tg_id, place, body, blocked) VALUES(?, ?, ?, ?)",
                     (tg_id, place, text[:1000], int(blocked)))


def _not_frozen(club):
    if club["frozen"]:
        raise HTTPException(403, "Клуб заморожен администрацией: в нём сейчас нельзя писать и вступать")


@app.get("/api/config")
def public_config():
    """What the app reads at launch: the semester's dates and the admin's banner."""
    with db.session() as conn:
        cfg = app_config(conn)
    return {"semester": cfg["semester"], "banner": cfg["banner"], "features": cfg["features"]}


class ReportIn(BaseModel):
    kind: str
    target: int
    reason: str = Field(max_length=40)
    note: str = Field("", max_length=500)


REPORT_REASONS = ("Спам", "Оскорбления", "Мат", "Неприемлемое", "Обман", "Другое")
REPORTS_PER_DAY = 20


@app.post("/api/report")
async def report(body: ReportIn, user=Depends(consented_user)):
    """«Пожаловаться» on a post, a comment, a student or a club: it waits in the admin panel's queue,
    with the text as it read then."""
    me = user["tg_id"]
    if body.kind not in ("post", "comment", "user", "club") or body.reason not in REPORT_REASONS:
        raise HTTPException(400, "Выберите причину жалобы")
    with db.session() as conn:
        if conn.execute("SELECT COUNT(*) FROM reports WHERE reporter=? AND created_at > datetime('now', '-1 day')",
                        (me,)).fetchone()[0] >= REPORTS_PER_DAY:
            raise HTTPException(429, "Слишком много жалоб за день. Мы уже разбираемся.")
        if body.kind == "post":
            row = conn.execute("SELECT body, author FROM club_posts WHERE id=?", (body.target,)).fetchone()
            snapshot = row and f"{row['body'] or '[фото]'}"
        elif body.kind == "comment":
            row = conn.execute("SELECT body FROM post_comments WHERE id=?", (body.target,)).fetchone()
            snapshot = row and row["body"]
        elif body.kind == "club":
            row = conn.execute("SELECT name, about FROM clubs WHERE id=?", (body.target,)).fetchone()
            snapshot = row and f"{row['name']}: {row['about']}"
        else:
            row = conn.execute("SELECT * FROM users WHERE tg_id=?", (body.target,)).fetchone()
            snapshot = row and " · ".join(filter(None, (_display_name(row), row["bio"])))
        if not row:
            raise HTTPException(404, "Это уже удалено")
        if conn.execute("SELECT 1 FROM reports WHERE reporter=? AND kind=? AND target=? AND status='open'",
                        (me, body.kind, body.target)).fetchone():
            return {"ok": True}
        conn.execute("INSERT INTO reports(reporter, kind, target, reason, note, snapshot) VALUES(?, ?, ?, ?, ?, ?)",
                     (me, body.kind, body.target, body.reason, _clean_about(body.note), (snapshot or "")[:1000]))
    what = {"post": "запись", "comment": "комментарий", "user": "пользователя", "club": "клуб"}[body.kind]
    await admin.alert(f"Новая жалоба на {what}: {body.reason}\n{(snapshot or '')[:200]}")
    return {"ok": True}


class FeedbackIn(BaseModel):
    body: str = Field(max_length=4000)


@app.post("/api/feedback")
async def feedback(body: FeedbackIn, user=Depends(consented_user)):
    """«Написать разработчику»: the message lands in the admin panel; the answer comes from the bot."""
    text = _clean_about(body.body)
    if len(text) < 3:
        raise HTTPException(400, "Напишите пару слов")
    with db.session() as conn:
        if conn.execute("SELECT COUNT(*) FROM feedback WHERE tg_id=? AND created_at > datetime('now', '-1 day')",
                        (user["tg_id"],)).fetchone()[0] >= 10:
            raise HTTPException(429, "Сегодня вы уже много написали. Мы ответим, как только прочитаем.")
        conn.execute("INSERT INTO feedback(tg_id, body) VALUES(?, ?)", (user["tg_id"], text[:2000]))
        name = _display_name(user)
    await admin.alert(f"Сообщение от {name}" + (f" (@{user['username']})" if user["username"] else "") + f":\n{text[:500]}")
    return {"ok": True}


# ---------- api ----------

def _photo(u) -> str:
    """The photo everyone sees: an uploaded one if there is one, else the Telegram photo."""
    return f"/avatars/{u['avatar']}.jpg" if u["avatar"] else u["photo_url"]


def _profile(conn, user):
    group = None
    if user["group_id"]:
        row = conn.execute(
            "SELECT g.id, g.name, g.course, f.id AS faculty_id, f.name AS faculty, f.is_master "
            "FROM groups g JOIN faculties f ON f.id = g.faculty_id WHERE g.id=?", (user["group_id"],)
        ).fetchone()
        group = dict(row) if row else None
    return {
        "tg_id": user["tg_id"],
        "first_name": user["tg_first"],
        "last_name": user["tg_last"],
        "username": user["username"],
        "photo_url": _photo(user),
        "custom_avatar": bool(user["avatar"]),
        "real_name": user["real_name"],
        "nickname": user["nickname"],
        "bio": user["bio"],
        "group": group,
        "onboarded": bool(user["real_name"] and group),
        "consent": user["consent_version"] == CONSENT_VERSION,
        "consent_at": user["consent_at"],
    }


@app.get("/api/me")
def me(user=Depends(current_user)):
    with db.session() as conn:
        return _profile(conn, user)


@app.get("/api/catalog")
def catalog():
    with db.session() as conn:
        rows = conn.execute(
            "SELECT f.id AS fid, f.name AS fname, f.is_master, g.id AS gid, g.name AS gname, g.course "
            "FROM faculties f JOIN groups g ON g.faculty_id = f.id ORDER BY f.is_master, f.sort, g.course, g.name"
        ).fetchall()
    faculties: dict[int, dict] = {}
    for r in rows:
        f = faculties.setdefault(r["fid"], {"id": r["fid"], "name": r["fname"],
                                            "is_master": bool(r["is_master"]), "courses": {}})
        f["courses"].setdefault(r["course"], []).append({"id": r["gid"], "name": r["gname"]})
    return [
        {**f, "courses": [{"course": c, "groups": g} for c, g in sorted(f["courses"].items())]}
        for f in faculties.values()
    ]


class ProfileIn(BaseModel):
    real_name: str = Field(min_length=2, max_length=80)
    group_id: int
    consent: bool = False   # the tick under the name: consent to processing and the privacy policy


@app.post("/api/profile")
def save_profile(body: ProfileIn, background: BackgroundTasks, user=Depends(current_user)):
    name = " ".join(body.real_name.split())
    agrees = user["consent_version"] == CONSENT_VERSION or body.consent
    if not agrees:
        raise HTTPException(400, "Отметьте согласие с политикой конфиденциальности: без него приложение не может сохранить ваши данные")
    with db.session() as conn:
        g = conn.execute("SELECT * FROM groups WHERE id=?", (body.group_id,)).fetchone()
        if not g:
            raise HTTPException(400, "Такой группы нет")
        newcomer = not conn.execute("SELECT 1 FROM users WHERE tg_id=?", (user["tg_id"],)).fetchone()
        if newcomer:
            _feature(conn, "registration")
        conn.execute("INSERT INTO users(tg_id, tg_first, tg_last, username, photo_url) VALUES(?, ?, ?, ?, ?) "
                     "ON CONFLICT(tg_id) DO NOTHING",
                     (user["tg_id"], user["tg_first"], user["tg_last"], user["username"], user["photo_url"]))
        conn.execute(
            "UPDATE users SET real_name=?, group_id=?, faculty_id=?, course=?, updated_at=datetime('now') "
            "WHERE tg_id=?", (name, g["id"], g["faculty_id"], g["course"], user["tg_id"]),
        )
        if user["consent_version"] != CONSENT_VERSION:
            conn.execute("UPDATE users SET consent_at=?, consent_version=? WHERE tg_id=?",
                         (datetime.now(timezone.utc).isoformat(timespec="seconds"), CONSENT_VERSION, user["tg_id"]))
        user = dict(conn.execute("SELECT * FROM users WHERE tg_id=?", (user["tg_id"],)).fetchone())
        if newcomer:   # just signed up: the bot offers the app for the phone
            background.add_task(_offer_app, user["tg_id"])
        return _profile(conn, user)


@app.post("/api/consent")
def give_consent(user=Depends(current_user)):
    """The consent of someone who signed up before it was asked for, or before a new edition of the policy."""
    with db.session() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE tg_id=?", (user["tg_id"],)).fetchone():
            raise HTTPException(400, "Сначала заполните профиль")
        conn.execute("UPDATE users SET consent_at=?, consent_version=?, updated_at=datetime('now') WHERE tg_id=?",
                     (datetime.now(timezone.utc).isoformat(timespec="seconds"), CONSENT_VERSION, user["tg_id"]))
        return _profile(conn, dict(conn.execute("SELECT * FROM users WHERE tg_id=?", (user["tg_id"],)).fetchone()))


@app.delete("/api/account")
def delete_account(user=Depends(current_user)):
    """Withdrawing consent: the student and everything tied to them is erased at once, freed pages zeroed.
    A club they own with other members in it must be handed over first; one they are alone in goes with them."""
    me = user["tg_id"]
    files = []
    with db.session() as conn:
        owned = conn.execute("SELECT c.id, c.name FROM club_members m JOIN clubs c ON c.id = m.club_id "
                             "WHERE m.tg_id=? AND m.role='owner'", (me,)).fetchall()
        crowded = [c["name"] for c in owned if _club_size(conn, c["id"]) > 1]
        if crowded:
            raise HTTPException(409, f"Вы владелец клуба «{crowded[0]}», в котором есть участники. "
                                     "Сначала передайте права владельца другому участнику.")
        conn.execute("PRAGMA secure_delete=ON")
        for c in owned:
            files += _erase_club(conn, c["id"])
        for r in conn.execute("SELECT id, photo FROM club_posts WHERE author=?", (me,)).fetchall():
            if r["photo"]:
                files.append(POSTS / f"{r['photo']}.jpg")
            _drop_post(conn, r["id"])
        for sql in ("DELETE FROM post_comments WHERE author=?", "DELETE FROM post_reactions WHERE tg_id=?",
                    "DELETE FROM club_members WHERE tg_id=?", "DELETE FROM club_requests WHERE tg_id=?",
                    "DELETE FROM club_invites WHERE invitee=?1 OR inviter=?1",
                    "DELETE FROM notifications WHERE tg_id=?1 OR actor=?1",
                    "DELETE FROM friendships WHERE requester=?1 OR addressee=?1",
                    "DELETE FROM flame_taps WHERE tapper=?1 OR friend=?1",
                    "DELETE FROM reminders WHERE tg_id=?", "DELETE FROM open_buttons WHERE chat_id=?",
                    "DELETE FROM devices WHERE tg_id=?", "DELETE FROM logins WHERE tg_id=?",
                    "DELETE FROM install_links WHERE tg_id=?",
                    "DELETE FROM activity WHERE tg_id=?", "DELETE FROM feedback WHERE tg_id=?",
                    "DELETE FROM reports WHERE reporter=?", "DELETE FROM profanity_log WHERE tg_id=?",
                    "DELETE FROM users WHERE tg_id=?"):
            conn.execute(sql, (me,))
    with db.session() as conn:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    if user["avatar"]:
        files.append(AVATARS / f"{user['avatar']}.jpg")
    for f in files:
        f.unlink(missing_ok=True)
    return {"deleted": True}


class NicknameIn(BaseModel):
    nickname: str = Field(max_length=200)


@app.post("/api/profile/nickname")
def save_nickname(body: NicknameIn, user=Depends(speaking_user)):
    """The name friends see, changeable any time; empty brings back the real name.
    The Telegram @tag is not stored as editable: it comes from Telegram on every request."""
    nick = " ".join("".join(ch for ch in body.nickname if ch.isprintable()).split())
    if nick and not 2 <= len(nick) <= NICK_MAX:
        raise HTTPException(400, f"Ник: от 2 до {NICK_MAX} символов")
    with db.session() as conn:
        _watch_words(conn, user["tg_id"], "nickname", nick)
        conn.execute("UPDATE users SET nickname=?, updated_at=datetime('now') WHERE tg_id=?",
                     (nick or None, user["tg_id"]))
        user = dict(conn.execute("SELECT * FROM users WHERE tg_id=?", (user["tg_id"],)).fetchone())
        return _profile(conn, user)


class BioIn(BaseModel):
    bio: str = Field(max_length=1000)


@app.post("/api/profile/bio")
def save_bio(body: BioIn, user=Depends(speaking_user)):
    """A few words about yourself; empty removes them."""
    bio = _clean_about(body.bio)
    if len(bio) > BIO_MAX:
        raise HTTPException(400, f"Описание: не длиннее {BIO_MAX} символов")
    with db.session() as conn:
        _watch_words(conn, user["tg_id"], "bio", bio)
        conn.execute("UPDATE users SET bio=?, updated_at=datetime('now') WHERE tg_id=?", (bio or None, user["tg_id"]))
        return _profile(conn, dict(conn.execute("SELECT * FROM users WHERE tg_id=?", (user["tg_id"],)).fetchone()))


def _encode_avatar(raw: bytes) -> bytes:
    """Whatever was sent becomes a square JPEG without metadata, or fails if it is not a picture."""
    img = ImageOps.exif_transpose(Image.open(BytesIO(raw))).convert("RGB")
    img = ImageOps.fit(img, (AVATAR_SIZE, AVATAR_SIZE), Image.LANCZOS)
    out = BytesIO()
    img.save(out, "JPEG", quality=86, optimize=True)
    return out.getvalue()


def _set_avatar(conn, user, token):
    if user["avatar"]:
        (AVATARS / f"{user['avatar']}.jpg").unlink(missing_ok=True)
    conn.execute("UPDATE users SET avatar=?, updated_at=datetime('now') WHERE tg_id=?", (token, user["tg_id"]))
    return _profile(conn, dict(conn.execute("SELECT * FROM users WHERE tg_id=?", (user["tg_id"],)).fetchone()))


async def _save_photo(request: Request) -> str:
    """The request body (an image) stored as a square JPEG; returns its file name without extension."""
    if int(request.headers.get("content-length") or 0) > AVATAR_MAX_BYTES:
        raise HTTPException(413, "Фото слишком большое")
    raw = await request.body()
    if not raw or len(raw) > AVATAR_MAX_BYTES:
        raise HTTPException(400, "Фото пустое или слишком большое")
    try:
        jpeg = await asyncio.to_thread(_encode_avatar, raw)
    except Exception:
        raise HTTPException(400, "Это не похоже на фото")
    token = secrets.token_urlsafe(12)   # a fresh name on every change, so no cache shows the old photo
    (AVATARS / f"{token}.jpg").write_bytes(jpeg)
    return token


@app.post("/api/profile/avatar")
async def upload_avatar(request: Request, user=Depends(speaking_user)):
    """A photo of your own instead of the Telegram one; the body is the image itself."""
    token = await _save_photo(request)
    with db.session() as conn:
        return _set_avatar(conn, user, token)


@app.delete("/api/profile/avatar")
def remove_avatar(user=Depends(consented_user)):
    """Back to the Telegram photo."""
    with db.session() as conn:
        return _set_avatar(conn, user, None)


async def _refresh_group(group_id: int):
    lock = _group_locks.setdefault(group_id, asyncio.Lock())
    if lock.locked():
        return
    async with lock:
        try:
            await scraper.sync_group(group_id)
        except Exception as e:
            log.warning("group %s refresh failed: %s", group_id, e)


@app.get("/api/schedule")
async def schedule(start: date, end: date, user=Depends(consented_user)):
    if not user["group_id"]:
        raise HTTPException(409, "Профиль не заполнен")
    return await _group_schedule(user["group_id"], start, end)


async def _group_schedule(gid: int, start: date, end: date):
    if (end - start).days > 62:
        raise HTTPException(400, "Слишком длинный период")
    with db.session() as conn:
        synced = conn.execute("SELECT synced_at FROM groups WHERE id=?", (gid,)).fetchone()["synced_at"]
    if not synced:
        await _refresh_group(gid)
    elif datetime.now(timezone.utc) - datetime.fromisoformat(synced) > GROUP_STALE_AFTER:
        asyncio.create_task(_refresh_group(gid))
    with db.session() as conn:
        rows = conn.execute(
            "SELECT date, pair, start, end, subject, kind, room, teacher FROM lessons "
            "WHERE group_id=? AND date BETWEEN ? AND ? ORDER BY date, pair, subject",
            (gid, start.isoformat(), end.isoformat()),
        ).fetchall()
        synced = conn.execute("SELECT synced_at FROM groups WHERE id=?", (gid,)).fetchone()["synced_at"]
    return {"lessons": [dict(r) for r in rows], "synced_at": synced}


class ReminderIn(BaseModel):
    date: date
    start: str = Field(pattern=r"^\d{2}:\d{2}$")
    subject: str = Field(min_length=1, max_length=200)


def _reminder_out(r):
    return {"id": r["id"], "date": r["date"], "start": r["start"], "subject": r["subject"]}


@app.get("/api/reminders")
def list_reminders(user=Depends(consented_user)):
    with db.session() as conn:
        rows = conn.execute(
            "SELECT * FROM reminders WHERE tg_id=? AND sent_at IS NULL ORDER BY remind_at", (user["tg_id"],)
        ).fetchall()
    return [_reminder_out(r) for r in rows]


@app.post("/api/reminders")
def add_reminder(body: ReminderIn, user=Depends(consented_user)):
    if not user["group_id"]:
        raise HTTPException(409, "Профиль не заполнен")
    with db.session() as conn:
        lesson = conn.execute(
            "SELECT * FROM lessons WHERE group_id=? AND date=? AND start=? AND subject=?",
            (user["group_id"], body.date.isoformat(), body.start, body.subject),
        ).fetchone()
        if not lesson:
            raise HTTPException(404, "Такой пары нет в расписании")
        starts_at = datetime.combine(body.date, time.fromisoformat(body.start), MSK)
        if starts_at <= datetime.now(timezone.utc):
            raise HTTPException(400, "Пара уже началась")
        remind_at = max(starts_at - REMIND_BEFORE, datetime.now(timezone.utc))
        conn.execute(
            "INSERT OR IGNORE INTO reminders(tg_id, date, start, end, subject, room, remind_at) VALUES(?,?,?,?,?,?,?)",
            (user["tg_id"], lesson["date"], lesson["start"], lesson["end"], lesson["subject"], lesson["room"],
             remind_at.astimezone(timezone.utc).isoformat(timespec="seconds")),
        )
        row = conn.execute(
            "SELECT * FROM reminders WHERE tg_id=? AND date=? AND start=? AND subject=?",
            (user["tg_id"], lesson["date"], lesson["start"], lesson["subject"]),
        ).fetchone()
    return _reminder_out(row)


@app.delete("/api/reminders/{rid}")
def delete_reminder(rid: int, user=Depends(consented_user)):
    with db.session() as conn:
        conn.execute("DELETE FROM reminders WHERE id=? AND tg_id=?", (rid, user["tg_id"]))
    return {"ok": True}


class SettingsIn(BaseModel):
    remind_all: bool | None = None
    remind_lead: int | None = None
    digest_time: str | None = None  # "HH:MM" from DIGEST_TIMES, or "off"
    show_club: bool | None = None


def _calendar_url(conn, user) -> str:
    token = user["cal_token"]
    if not token:
        token = secrets.token_urlsafe(18)
        conn.execute("UPDATE users SET cal_token=? WHERE tg_id=?", (token, user["tg_id"]))
    base = (bot.webapp_url if bot else "") or "http://localhost:8080"
    return f"{base}/cal/{token}.ics"


def _settings(conn, user):
    user = dict(conn.execute("SELECT * FROM users WHERE tg_id=?", (user["tg_id"],)).fetchone())
    return {
        "remind_all": bool(user["remind_all"]),
        "remind_lead": user["remind_lead"],
        "digest_time": user["digest_time"],
        "show_club": bool(user["show_club"]),
        "calendar_url": _calendar_url(conn, user),
        "leads": list(LEADS),
        "digest_times": list(DIGEST_TIMES),
    }


@app.get("/api/settings")
def get_settings(user=Depends(consented_user)):
    with db.session() as conn:
        return _settings(conn, user)


@app.post("/api/settings")
def save_settings(body: SettingsIn, user=Depends(consented_user)):
    now = datetime.now(timezone.utc)
    with db.session() as conn:
        if body.remind_lead is not None:
            if body.remind_lead not in LEADS:
                raise HTTPException(400, "Можно напоминать за 5, 10 или 15 минут")
            conn.execute("UPDATE users SET remind_lead=? WHERE tg_id=?", (body.remind_lead, user["tg_id"]))
        if body.remind_all is not None:
            conn.execute("UPDATE users SET remind_all=? WHERE tg_id=?", (int(body.remind_all), user["tg_id"]))
        if body.remind_all is not None or body.remind_lead is not None:
            # replan this student's automatic reminders with the new rule
            conn.execute("DELETE FROM reminders WHERE tg_id=? AND auto=1 AND sent_at IS NULL", (user["tg_id"],))
            materialize_auto_reminders(conn, now, user["tg_id"])
        if body.digest_time is not None:
            if body.digest_time == "off":
                conn.execute("UPDATE users SET digest_time=NULL WHERE tg_id=?", (user["tg_id"],))
            elif body.digest_time in DIGEST_TIMES:
                # a time already past today starts tomorrow, rather than firing the moment it is chosen
                local = now.astimezone(MSK)
                sent_on = local.date().isoformat() if local.strftime("%H:%M") >= body.digest_time else None
                conn.execute("UPDATE users SET digest_time=?, digest_sent_on=? WHERE tg_id=?",
                             (body.digest_time, sent_on, user["tg_id"]))
            else:
                raise HTTPException(400, "Такого времени нет в списке")
        if body.show_club is not None:
            conn.execute("UPDATE users SET show_club=? WHERE tg_id=?", (int(body.show_club), user["tg_id"]))
        return _settings(conn, user)


@app.post("/api/refresh")
async def refresh(user=Depends(consented_user)):
    """Fetch the student's group from the site now, at most once a minute per group."""
    if not user["group_id"]:
        raise HTTPException(409, "Профиль не заполнен")
    gid = user["group_id"]
    with db.session() as conn:
        synced = conn.execute("SELECT synced_at FROM groups WHERE id=?", (gid,)).fetchone()["synced_at"]
    if not synced or datetime.now(timezone.utc) - datetime.fromisoformat(synced) > REFRESH_COOLDOWN:
        await _refresh_group(gid)
    with db.session() as conn:
        synced = conn.execute("SELECT synced_at FROM groups WHERE id=?", (gid,)).fetchone()["synced_at"]
    return {"synced_at": synced}


def _ics_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _ics_fold(line: str) -> str:
    """RFC 5545: lines over 75 octets continue on the next line after a space."""
    out, cur = [], b""
    for ch in line:
        b = ch.encode("utf-8")
        if len(cur) + len(b) > (75 if not out else 74):
            out.append(cur.decode("utf-8"))
            cur = b""
        cur += b
    out.append(cur.decode("utf-8"))
    return "\r\n ".join(out)


@app.get("/cal/{token}.ics")
def calendar(token: str):
    """A calendar subscription: Google or Apple Calendar fetch it by this secret link, no Telegram needed."""
    with db.session() as conn:
        user = conn.execute("SELECT * FROM users WHERE cal_token=?", (token,)).fetchone()
        if not user or not user["group_id"]:
            raise HTTPException(404)
        group = conn.execute("SELECT name FROM groups WHERE id=?", (user["group_id"],)).fetchone()
        monday, last = scraper.week_window()
        lessons = conn.execute(
            "SELECT * FROM lessons WHERE group_id=? AND date BETWEEN ? AND ? ORDER BY date, start",
            (user["group_id"], monday.isoformat(), last.isoformat()),
        ).fetchall()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    utc = lambda d, t: datetime.combine(date.fromisoformat(d), time.fromisoformat(t), MSK) \
        .astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")  # noqa: E731
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MSU Sevastopol//Raspisanie//RU", "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH", f"X-WR-CALNAME:{_ics_escape('Пары ' + group['name'])}", "X-WR-TIMEZONE:Europe/Moscow",
        "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H",
    ]
    for l in lessons:
        kind = KINDS.get((l["kind"] or "").lower(), l["kind"] or "")
        uid = hashlib.sha1(f"{user['group_id']}|{l['date']}|{l['start']}|{l['subject']}|{l['teacher']}".encode()).hexdigest()[:16]
        lines += [
            "BEGIN:VEVENT", f"UID:{uid}@raspisanie-sev-msu", f"DTSTAMP:{stamp}",
            f"DTSTART:{utc(l['date'], l['start'])}", f"DTEND:{utc(l['date'], l['end'])}",
            f"SUMMARY:{_ics_escape(l['subject'] + (f' ({kind})' if kind else ''))}",
        ]
        if l["room"]:
            lines.append(f"LOCATION:{_ics_escape('ауд. ' + l['room'])}")
        if l["teacher"]:
            lines.append(f"DESCRIPTION:{_ics_escape(l['teacher'])}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    body = "\r\n".join(_ics_fold(x) for x in lines) + "\r\n"
    return Response(body, media_type="text/calendar; charset=utf-8",
                    headers={"Content-Disposition": 'inline; filename="raspisanie.ics"', "Cache-Control": "no-cache"})


# ---------- notifications: what happened to you, for the bell on the main screen ----------

NOTIFY_KEEP = 100   # the newest per student; older ones are dropped


def _preview(text: str) -> str:
    line = " ".join((text or "").split())
    return line if len(line) <= 90 else f"{line[:89]}…"


def _notify(conn, to: int, kind: str, actor: int | None = None, club_id: int | None = None,
            post_id: int | None = None, text: str = ""):
    """One line in someone's notifications; nobody is told about their own doing."""
    if to == actor:
        return
    conn.execute("INSERT INTO notifications(tg_id, kind, actor, club_id, post_id, text) VALUES(?, ?, ?, ?, ?, ?)",
                 (to, kind, actor, club_id, post_id, _preview(text)))
    conn.execute("DELETE FROM notifications WHERE tg_id=? AND id <= (SELECT id FROM notifications WHERE tg_id=? "
                 "ORDER BY id DESC LIMIT 1 OFFSET ?)", (to, to, NOTIFY_KEEP))


def _unread(conn, me: int) -> int:
    return conn.execute("SELECT COUNT(*) FROM notifications WHERE tg_id=? AND read_at IS NULL", (me,)).fetchone()[0]


@app.get("/api/notifications")
def notifications(user=Depends(consented_user)):
    """The newest 50, each with who did it and in which club."""
    me = user["tg_id"]
    with db.session() as conn:
        items = []
        for r in conn.execute("SELECT * FROM notifications WHERE tg_id=? ORDER BY id DESC LIMIT 50", (me,)).fetchall():
            actor = _card(conn, r["actor"]) if r["actor"] else None
            club = conn.execute("SELECT * FROM clubs WHERE id=?", (r["club_id"],)).fetchone() if r["club_id"] else None
            items.append({"id": r["id"], "kind": r["kind"], "text": r["text"], "created_at": r["created_at"],
                          "read": bool(r["read_at"]), "post_id": r["post_id"],
                          "actor": {"tg_id": actor["tg_id"], "name": actor["name"], "photo_url": actor["photo_url"]} if actor else None,
                          "club": {"id": club["id"], "name": club["name"], "category": club["category"],
                                   "photo_url": f"/avatars/{club['avatar']}.jpg" if club["avatar"] else ""} if club else None})
        return {"items": items, "unread": _unread(conn, me)}


@app.get("/api/notifications/unread")
def notifications_unread(user=Depends(consented_user)):
    """Just the number for the red badge on the bell."""
    with db.session() as conn:
        return {"unread": _unread(conn, user["tg_id"])}


@app.post("/api/notifications/read")
def notifications_read(user=Depends(consented_user)):
    with db.session() as conn:
        conn.execute("UPDATE notifications SET read_at=datetime('now') WHERE tg_id=? AND read_at IS NULL", (user["tg_id"],))
    return {"unread": 0}


# ---------- friends ----------
# Found by exact Telegram @username only (no partial search, so nobody can list everyone);
# a friend's schedule is visible only when the friendship is mutual.

def _display_name(u) -> str:
    return u["nickname"] or u["real_name"] or " ".join(x for x in (u["tg_first"], u["tg_last"]) if x) or "Студент"


def _now_status(conn, group_id, now: datetime):
    """What the student has right now: a running pair, the next one today, or nothing."""
    if not group_id:
        return {"state": "unknown"}
    local = now.astimezone(MSK)
    hhmm = local.strftime("%H:%M")
    slots = conn.execute(
        "SELECT start, end, MIN(subject) AS subject, room FROM lessons WHERE group_id=? AND date=? "
        "GROUP BY start ORDER BY start", (group_id, local.date().isoformat())).fetchall()
    if not slots:
        return {"state": "free"}
    for sl in slots:
        if sl["start"] <= hhmm < sl["end"]:
            return {"state": "now", **dict(sl)}
        if hhmm < sl["start"]:
            return {"state": "next", **dict(sl)}
    return {"state": "done"}


def _card(conn, tg_id: int, with_now: bool = False):
    u = conn.execute(
        "SELECT u.*, g.name AS group_name, g.course AS group_course, f.name AS faculty, f.is_master "
        "FROM users u LEFT JOIN groups g ON g.id = u.group_id LEFT JOIN faculties f ON f.id = g.faculty_id "
        "WHERE u.tg_id=? AND u.consent_at IS NOT NULL", (tg_id,)).fetchone()
    if not u:
        return None
    card = {"tg_id": u["tg_id"], "name": _display_name(u), "photo_url": _photo(u), "bio": u["bio"] or "",
            "group": u["group_name"], "course": u["group_course"],
            "faculty": u["faculty"], "is_master": bool(u["is_master"])}
    if with_now:
        card["now"] = _now_status(conn, u["group_id"], datetime.now(timezone.utc))
    return card


def _shown_clubs(conn, tg_id: int):
    """The clubs a friend chose to show to friends (a setting of theirs, off by default); their own first."""
    rows = conn.execute(
        "SELECT c.id, c.name, c.category FROM users u JOIN club_members m ON m.tg_id = u.tg_id "
        "JOIN clubs c ON c.id = m.club_id WHERE u.tg_id=? AND u.show_club=1 "
        "ORDER BY m.role = 'owner' DESC, m.joined_at", (tg_id,)).fetchall()
    return [dict(r) for r in rows]


def _flame(conn, me: int, other: int, today: date | None = None):
    """The streak between two friends: a day counts when both pressed the flame on it.
    Today still being open, a streak that reached yesterday is alive until midnight."""
    today = today or datetime.now(MSK).date()
    mine = {r["day"] for r in conn.execute("SELECT day FROM flame_taps WHERE tapper=? AND friend=?", (me, other))}
    theirs = {r["day"] for r in conn.execute("SELECT day FROM flame_taps WHERE tapper=? AND friend=?", (other, me))}
    both = mine & theirs
    t = today.isoformat()
    day = today if t in both else today - timedelta(days=1)
    streak = 0
    while day.isoformat() in both:
        streak += 1
        day -= timedelta(days=1)
    return {"streak": streak, "me_today": t in mine, "friend_today": t in theirs}


def _relation(conn, me: int, other: int) -> str:
    if me == other:
        return "self"
    out = conn.execute("SELECT status FROM friendships WHERE requester=? AND addressee=?", (me, other)).fetchone()
    inc = conn.execute("SELECT status FROM friendships WHERE requester=? AND addressee=?", (other, me)).fetchone()
    if (out and out["status"] == "accepted") or (inc and inc["status"] == "accepted"):
        return "friend"
    if out:
        return "outgoing"
    if inc:
        return "incoming"
    return "none"


@app.get("/api/friends")
def friends(user=Depends(consented_user)):
    me = user["tg_id"]
    with db.session() as conn:
        mutual = [r["other"] for r in conn.execute(
            "SELECT CASE WHEN requester=? THEN addressee ELSE requester END AS other FROM friendships "
            "WHERE (requester=? OR addressee=?) AND status='accepted' ORDER BY created_at", (me, me, me))]
        incoming = [r["requester"] for r in conn.execute(
            "SELECT requester FROM friendships WHERE addressee=? AND status='pending' ORDER BY created_at", (me,))]
        outgoing = [r["addressee"] for r in conn.execute(
            "SELECT addressee FROM friendships WHERE requester=? AND status='pending' ORDER BY created_at", (me,))]
        cards = lambda ids, now=False: [c for c in (_card(conn, i, now) for i in ids) if c]  # noqa: E731
        friend_cards = cards(mutual, True)
        for c in friend_cards:
            c["flame"] = _flame(conn, me, c["tg_id"])
            c["clubs"] = _shown_clubs(conn, c["tg_id"])
        return {"friends": friend_cards, "incoming": cards(incoming), "outgoing": cards(outgoing)}


@app.get("/api/users/find")
def find_user(username: str, user=Depends(consented_user)):
    name = username.strip().lstrip("@").lower()
    if not 3 <= len(name) <= 32 or not all(ch.isalnum() or ch == "_" for ch in name):
        raise HTTPException(400, "Введите тег Telegram, например @ivan_petrov")
    with db.session() as conn:
        found = conn.execute(
            "SELECT tg_id FROM users WHERE lower(username)=? AND real_name IS NOT NULL AND group_id IS NOT NULL "
            "AND consent_at IS NOT NULL "
            "ORDER BY updated_at DESC LIMIT 1", (name,)).fetchone()
        if not found:
            return {"user": None, "relation": None}
        return {"user": _card(conn, found["tg_id"]), "relation": _relation(conn, user["tg_id"], found["tg_id"])}


@app.post("/api/friends/{other}")
def add_friend(other: int, user=Depends(consented_user)):
    """Send a request; if they already asked you, this accepts it."""
    me = user["tg_id"]
    with db.session() as conn:
        _feature(conn, "friends")
        if not conn.execute("SELECT 1 FROM users WHERE tg_id=? AND real_name IS NOT NULL AND consent_at IS NOT NULL",
                            (other,)).fetchone():
            raise HTTPException(404, "Такого студента нет в приложении")
        rel = _relation(conn, me, other)
        if rel == "self":
            raise HTTPException(400, "Это вы")
        if rel == "incoming":
            conn.execute("UPDATE friendships SET status='accepted' WHERE requester=? AND addressee=?", (other, me))
            _notify(conn, other, "friend_accept", me)
        elif rel == "none":
            conn.execute("INSERT INTO friendships(requester, addressee) VALUES(?, ?)", (me, other))
            _notify(conn, other, "friend_request", me)
        return {"relation": _relation(conn, me, other)}


@app.post("/api/friends/{other}/accept")
def accept_friend(other: int, user=Depends(consented_user)):
    me = user["tg_id"]
    with db.session() as conn:
        n = conn.execute("UPDATE friendships SET status='accepted' WHERE requester=? AND addressee=? AND status='pending'",
                         (other, me)).rowcount
        if not n:
            raise HTTPException(404, "Заявки уже нет")
        _notify(conn, other, "friend_accept", me)
        return {"relation": "friend"}


@app.delete("/api/friends/{other}")
def remove_friend(other: int, user=Depends(consented_user)):
    """Decline a request, cancel your own, or remove a friend: the link goes in both directions."""
    me = user["tg_id"]
    with db.session() as conn:
        conn.execute("DELETE FROM friendships WHERE (requester=? AND addressee=?) OR (requester=? AND addressee=?)",
                     (me, other, other, me))
        conn.execute("DELETE FROM flame_taps WHERE (tapper=? AND friend=?) OR (tapper=? AND friend=?)",
                     (me, other, other, me))
    return {"relation": "none"}


@app.post("/api/friends/{other}/flame")
def press_flame(other: int, user=Depends(consented_user)):
    """Press today's flame with a friend; pressing again the same day changes nothing."""
    me = user["tg_id"]
    with db.session() as conn:
        if _relation(conn, me, other) != "friend":
            raise HTTPException(403, "Огонёк есть только у друзей")
        today = datetime.now(MSK).date().isoformat()
        pressed = conn.execute("INSERT OR IGNORE INTO flame_taps(tapper, friend, day) VALUES(?, ?, ?)",
                               (me, other, today)).rowcount
        if pressed and not conn.execute("SELECT 1 FROM flame_taps WHERE tapper=? AND friend=? AND day=?",
                                        (other, me, today)).fetchone():
            _notify(conn, other, "flame", me)   # their turn to keep the streak
        return _flame(conn, me, other)


@app.get("/api/friends/{other}/schedule")
async def friend_schedule(other: int, start: date, end: date, user=Depends(consented_user)):
    with db.session() as conn:
        if _relation(conn, user["tg_id"], other) != "friend":
            raise HTTPException(403, "Расписание видно только друзьям")
        friend = conn.execute("SELECT group_id FROM users WHERE tg_id=?", (other,)).fetchone()
    if not friend or not friend["group_id"]:
        raise HTTPException(404, "У друга не выбрана группа")
    return await _group_schedule(friend["group_id"], start, end)


# ---------- clubs ----------
# Anyone can found a club; a student may be in any number of clubs but owns at most CLUB_OWN_MAX.
# Roles: owner (one per club; the only one who appoints admins, hands the club over or deletes it),
# admin (sets the club up, invites, removes ordinary members, posts to the feed), member.
# Visibility: public (anyone sees and joins), friends (the owner's friends see and join),
# closed (anyone sees it and asks to join; the owner or an admin decides), invite (only by invitation).
# Every club has a feed that only its members read; the owner and admins post to it.

CLUB_CATEGORIES = ("science", "it", "sport", "art", "music", "games", "language", "volunteer", "other")
CLUB_VISIBILITY = ("public", "friends", "closed", "invite")
CLUB_NAME_MAX = 48
CLUB_ABOUT_MAX = 600
CLUB_OWN_MAX = 3
CHAT_LINK = re.compile(r"(?:https?://)?(?:t\.me|telegram\.me)/([A-Za-z0-9_+/=-]{2,96})")
CHAT_HANDLE = re.compile(r"@([A-Za-z0-9_]{4,32})")
ROLE_ORDER = {"owner": 0, "admin": 1, "member": 2}
POST_MAX = 2000
POST_PHOTO_SIDE = 1280
POSTS_PAGE = 20
REACTIONS = ("👍", "❤️", "😂", "😮", "😢", "🔥")
COMMENT_MAX = 1000
POSTS = ROOT / "data" / "posts"   # feed photos, named by a random token that only the club's members are given
POSTS.mkdir(parents=True, exist_ok=True)


def _clean_line(text: str) -> str:
    return " ".join("".join(ch for ch in text if ch.isprintable()).split())


def _clean_about(text: str) -> str:
    """Keeps the paragraphs, drops control characters and runs of empty lines."""
    return re.sub(r"\n{3,}", "\n\n", "\n".join(_clean_line(line) for line in text.splitlines())).strip()


def _chat_url(raw: str) -> str | None:
    """A Telegram chat as typed (t.me/..., https://t.me/+..., @name) becomes https://t.me/...; empty clears it."""
    raw = raw.strip()
    if not raw:
        return None
    m = CHAT_LINK.fullmatch(raw) or CHAT_HANDLE.fullmatch(raw)
    if not m:
        raise HTTPException(400, "Ссылка на чат должна вести в Telegram: t.me/… или @название")
    return f"https://t.me/{m.group(1)}"


def _member_role(conn, club_id: int, tg_id: int) -> str | None:
    row = conn.execute("SELECT role FROM club_members WHERE club_id=? AND tg_id=?", (club_id, tg_id)).fetchone()
    return row["role"] if row else None


def _owned(conn, tg_id: int) -> int:
    return conn.execute("SELECT COUNT(*) FROM club_members WHERE tg_id=? AND role='owner'", (tg_id,)).fetchone()[0]


def _club_row(conn, club_id: int):
    club = conn.execute("SELECT * FROM clubs WHERE id=?", (club_id,)).fetchone()
    if not club:
        raise HTTPException(404, "Такого клуба нет")
    return club


def _club_owner(conn, club_id: int) -> int:
    return conn.execute("SELECT tg_id FROM club_members WHERE club_id=? AND role='owner'", (club_id,)).fetchone()["tg_id"]


def _club_size(conn, club_id: int) -> int:
    return conn.execute("SELECT COUNT(*) FROM club_members WHERE club_id=?", (club_id,)).fetchone()[0]


def _invited(conn, club_id: int, tg_id: int) -> bool:
    return bool(conn.execute("SELECT 1 FROM club_invites WHERE club_id=? AND invitee=?", (club_id, tg_id)).fetchone())


def _open_to(conn, club, me: int) -> bool:
    """Whether the student may see and join the club without an invitation."""
    if club["visibility"] == "public":
        return True
    return club["visibility"] == "friends" and _relation(conn, me, _club_owner(conn, club["id"])) == "friend"


def _club_card(conn, club):
    return {"id": club["id"], "name": club["name"], "about": club["about"], "category": club["category"],
            "visibility": club["visibility"], "photo_url": f"/avatars/{club['avatar']}.jpg" if club["avatar"] else "",
            "members": _club_size(conn, club["id"]), "official": bool(club["official"]), "frozen": bool(club["frozen"])}


def _can_view(conn, club, me: int, role: str | None) -> bool:
    """Members, the invited, whoever may join it freely, and anyone at all for a club that takes requests."""
    return bool(role) or club["visibility"] == "closed" or _invited(conn, club["id"], me) or _open_to(conn, club, me)


def _club_view(conn, club, me: int):
    """The club as this student sees it. Whoever may open it sees its members;
    the chat, writing to members and the invitations stay with the members."""
    role = _member_role(conn, club["id"], me)
    invited = _invited(conn, club["id"], me)
    if not _can_view(conn, club, me, role):
        raise HTTPException(404, "Такого клуба нет")
    owner = _card(conn, _club_owner(conn, club["id"]))
    can_join = not role and (invited or _open_to(conn, club, me))
    view = {**_club_card(conn, club), "role": role, "invited": invited, "owner": owner["name"] if owner else "",
            "can_join": can_join, "can_request": not role and not can_join and club["visibility"] == "closed",
            "requested": bool(conn.execute("SELECT 1 FROM club_requests WHERE club_id=? AND tg_id=?", (club["id"], me)).fetchone())}
    rows = conn.execute("SELECT m.tg_id, m.role, u.username FROM club_members m JOIN users u ON u.tg_id = m.tg_id "
                        "WHERE m.club_id=? ORDER BY m.joined_at", (club["id"],))
    members = [{**c, "role": r["role"], "can_dm": bool(role and r["username"]),
                "relation": "self" if r["tg_id"] == me else _relation(conn, me, r["tg_id"])}
               for r in rows if (c := _card(conn, r["tg_id"]))]
    view["member_list"] = sorted(members, key=lambda m: ROLE_ORDER[m["role"]])
    if role:
        view["chat_url"] = club["chat_url"]
    if role in ("owner", "admin"):
        invites = conn.execute("SELECT invitee FROM club_invites WHERE club_id=? ORDER BY created_at", (club["id"],))
        view["invites"] = [c for r in invites if (c := _card(conn, r["invitee"]))]
        requests = conn.execute("SELECT tg_id FROM club_requests WHERE club_id=? ORDER BY created_at", (club["id"],))
        view["requests"] = [c for r in requests if (c := _card(conn, r["tg_id"]))]
    return view


def _require_role(conn, club_id: int, me: int, *roles: str) -> str:
    role = _member_role(conn, club_id, me)
    if role not in roles:
        raise HTTPException(403, "Это может только владелец клуба" if roles == ("owner",)
                            else "Это могут только владелец и админы клуба" if "member" not in roles
                            else "Вы не состоите в этом клубе")
    return role


def _club_member(conn, club_id: int, other: int) -> str:
    role = _member_role(conn, club_id, other)
    if not role:
        raise HTTPException(404, "Этот человек не состоит в клубе")
    return role


class ClubIn(BaseModel):
    name: str | None = Field(None, max_length=200)
    about: str | None = Field(None, max_length=3000)
    category: str | None = None
    visibility: str | None = None
    chat_url: str | None = Field(None, max_length=300)


def _club_fields(conn, body: ClubIn, club_id: int | None = None) -> dict:
    """The checked columns to write; only the fields that were sent."""
    fields = {}
    if body.name is not None:
        name = _clean_line(body.name)
        if not 2 <= len(name) <= CLUB_NAME_MAX:
            raise HTTPException(400, f"Название: от 2 до {CLUB_NAME_MAX} символов")
        # SQLite's lower() only knows ASCII, so names are compared here, Cyrillic included
        if any(r["name"].casefold() == name.casefold() and r["id"] != club_id for r in conn.execute("SELECT id, name FROM clubs")):
            raise HTTPException(409, "Клуб с таким названием уже есть")
        fields["name"] = name
    if body.about is not None:
        about = _clean_about(body.about)
        if len(about) > CLUB_ABOUT_MAX:
            raise HTTPException(400, f"Описание: не длиннее {CLUB_ABOUT_MAX} символов")
        fields["about"] = about
    if body.category is not None:
        if body.category not in CLUB_CATEGORIES:
            raise HTTPException(400, "Такой направленности нет")
        fields["category"] = body.category
    if body.visibility is not None:
        if body.visibility not in CLUB_VISIBILITY:
            raise HTTPException(400, "Выберите, кто может вступить")
        fields["visibility"] = body.visibility
    if body.chat_url is not None:
        fields["chat_url"] = _chat_url(body.chat_url)
    return fields


@app.get("/api/clubs")
def clubs(user=Depends(consented_user)):
    """Your clubs, the invitations waiting for you, and the clubs you may join."""
    me = user["tg_id"]
    with db.session() as conn:
        rows = conn.execute(
            "SELECT c.*, m.role, (SELECT MAX(id) FROM club_posts p WHERE p.club_id = c.id) AS last_post "
            "FROM club_members m JOIN clubs c ON c.id = m.club_id WHERE m.tg_id=? "
            "ORDER BY m.role = 'owner' DESC, m.role = 'admin' DESC, m.joined_at", (me,)).fetchall()
        my = [{**_club_card(conn, c), "role": c["role"], "last_post": c["last_post"] or 0,
               "requests": conn.execute("SELECT COUNT(*) FROM club_requests WHERE club_id=?", (c["id"],)).fetchone()[0]
               if c["role"] in ("owner", "admin") else 0} for c in rows]
        mine = {c["id"] for c in my}
        invites, invited = [], set()
        for r in conn.execute("SELECT club_id, inviter FROM club_invites WHERE invitee=? ORDER BY created_at DESC", (me,)).fetchall():
            club = conn.execute("SELECT * FROM clubs WHERE id=?", (r["club_id"],)).fetchone()
            if club and club["id"] not in mine:
                inviter = _card(conn, r["inviter"])
                invites.append({**_club_card(conn, club), "inviter": inviter["name"] if inviter else ""})
                invited.add(club["id"])
        discover = [_club_card(conn, c) for c in conn.execute("SELECT * FROM clubs WHERE visibility != 'invite'").fetchall()
                    if c["id"] not in mine and c["id"] not in invited and _can_view(conn, c, me, None)]
        discover.sort(key=lambda c: (-c["members"], c["name"].casefold()))
        return {"my": my, "invites": invites, "discover": discover,
                "owned": sum(c["role"] == "owner" for c in my), "own_max": CLUB_OWN_MAX}


@app.get("/api/clubs/{club_id}")
def club(club_id: int, user=Depends(consented_user)):
    with db.session() as conn:
        return _club_view(conn, _club_row(conn, club_id), user["tg_id"])


@app.post("/api/clubs")
def create_club(body: ClubIn, user=Depends(speaking_user)):
    """Found a club and become its owner; a student owns at most CLUB_OWN_MAX clubs."""
    me = user["tg_id"]
    with db.session() as conn:
        _feature(conn, "clubs_create")
        _watch_words(conn, me, "club", f"{body.name or ''} {body.about or ''}".strip())
        if _owned(conn, me) >= CLUB_OWN_MAX:
            raise HTTPException(409, f"Своих клубов может быть не больше {CLUB_OWN_MAX}. Чтобы создать новый, "
                                     "передайте один из своих клубов другому участнику или удалите его.")
        if not body.name:
            raise HTTPException(400, "Придумайте название клуба")
        fields = {"category": "other", "visibility": "public", **_club_fields(conn, body)}
        cur = conn.execute(f"INSERT INTO clubs({', '.join(fields)}) VALUES({', '.join('?' * len(fields))})",
                           tuple(fields.values()))
        conn.execute("INSERT INTO club_members(club_id, tg_id, role) VALUES(?, ?, 'owner')", (cur.lastrowid, me))
        return _club_view(conn, _club_row(conn, cur.lastrowid), me)


@app.post("/api/clubs/{club_id}/settings")
def club_settings(club_id: int, body: ClubIn, user=Depends(speaking_user)):
    me = user["tg_id"]
    with db.session() as conn:
        _not_frozen(_club_row(conn, club_id))
        _require_role(conn, club_id, me, "owner", "admin")
        _watch_words(conn, me, "club", f"{body.name or ''} {body.about or ''}".strip())
        fields = _club_fields(conn, body, club_id)
        if fields:
            conn.execute(f"UPDATE clubs SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?", (*fields.values(), club_id))
        return _club_view(conn, _club_row(conn, club_id), me)


def _set_club_avatar(club_id: int, me: int, token: str | None):
    with db.session() as conn:
        old = _club_row(conn, club_id)["avatar"]
        conn.execute("UPDATE clubs SET avatar=? WHERE id=?", (token, club_id))
        if old:
            (AVATARS / f"{old}.jpg").unlink(missing_ok=True)
        return _club_view(conn, _club_row(conn, club_id), me)


@app.post("/api/clubs/{club_id}/avatar")
async def club_avatar(club_id: int, request: Request, user=Depends(speaking_user)):
    with db.session() as conn:
        _not_frozen(_club_row(conn, club_id))
        _require_role(conn, club_id, user["tg_id"], "owner", "admin")
    return _set_club_avatar(club_id, user["tg_id"], await _save_photo(request))


@app.delete("/api/clubs/{club_id}/avatar")
def remove_club_avatar(club_id: int, user=Depends(consented_user)):
    with db.session() as conn:
        _club_row(conn, club_id)
        _require_role(conn, club_id, user["tg_id"], "owner", "admin")
    return _set_club_avatar(club_id, user["tg_id"], None)


@app.post("/api/clubs/{club_id}/join")
def join_club(club_id: int, user=Depends(consented_user)):
    """Join an open club, or accept an invitation."""
    me = user["tg_id"]
    with db.session() as conn:
        club = _club_row(conn, club_id)
        if not _member_role(conn, club_id, me):
            _not_frozen(club)
            if not (_invited(conn, club_id, me) or _open_to(conn, club, me)):
                raise HTTPException(403, "В этот клуб вступают только друзья владельца" if club["visibility"] == "friends"
                                    else "В этот клуб вступают по заявке" if club["visibility"] == "closed"
                                    else "В этот клуб вступают только по приглашению")
            conn.execute("INSERT INTO club_members(club_id, tg_id, role) VALUES(?, ?, 'member')", (club_id, me))
            conn.execute("DELETE FROM club_invites WHERE club_id=? AND invitee=?", (club_id, me))
            conn.execute("DELETE FROM club_requests WHERE club_id=? AND tg_id=?", (club_id, me))
        return _club_view(conn, club, me)


@app.post("/api/clubs/{club_id}/leave")
def leave_club(club_id: int, user=Depends(consented_user)):
    me = user["tg_id"]
    with db.session() as conn:
        _club_row(conn, club_id)
        if _require_role(conn, club_id, me, "owner", "admin", "member") == "owner":
            raise HTTPException(400, "Сначала передайте права владельца другому участнику" if _club_size(conn, club_id) > 1
                                else "Вы единственный участник: клуб можно только удалить")
        conn.execute("DELETE FROM club_members WHERE club_id=? AND tg_id=?", (club_id, me))
    return {"left": True}


@app.delete("/api/clubs/{club_id}")
def delete_club(club_id: int, user=Depends(consented_user)):
    """Only the owner, and only once nobody else is left: a club with members is handed over, not deleted."""
    with db.session() as conn:
        club = _club_row(conn, club_id)
        _require_role(conn, club_id, user["tg_id"], "owner")
        if _club_size(conn, club_id) > 1:
            raise HTTPException(400, "В клубе есть участники, поэтому удалить его нельзя. "
                                     "Можно передать права владельца другому участнику.")
        files = _erase_club(conn, club_id)
    for f in files:
        f.unlink(missing_ok=True)
    return {"deleted": True}


def _erase_club(conn, club_id: int) -> list:
    """Every row of a club; returns its photo files, to be removed once the rows are gone."""
    club = _club_row(conn, club_id)
    files = [POSTS / f"{r['photo']}.jpg" for r in conn.execute(
        "SELECT photo FROM club_posts WHERE club_id=? AND photo IS NOT NULL", (club_id,))]
    if club["avatar"]:
        files.append(AVATARS / f"{club['avatar']}.jpg")
    for r in conn.execute("SELECT id FROM club_posts WHERE club_id=?", (club_id,)).fetchall():
        _drop_post(conn, r["id"])
    for table in ("club_invites", "club_requests", "notifications", "club_members"):
        conn.execute(f"DELETE FROM {table} WHERE club_id=?", (club_id,))
    conn.execute("DELETE FROM clubs WHERE id=?", (club_id,))
    return files


@app.post("/api/clubs/{club_id}/invites/{other}")
def invite_to_club(club_id: int, other: int, user=Depends(consented_user)):
    me = user["tg_id"]
    with db.session() as conn:
        _not_frozen(_club_row(conn, club_id))
        _require_role(conn, club_id, me, "owner", "admin")
        if not conn.execute("SELECT 1 FROM users WHERE tg_id=? AND real_name IS NOT NULL AND group_id IS NOT NULL "
                            "AND consent_at IS NOT NULL", (other,)).fetchone():
            raise HTTPException(404, "Такого студента нет в приложении")
        if _member_role(conn, club_id, other):
            raise HTTPException(409, "Этот человек уже в клубе")
        if conn.execute("INSERT OR IGNORE INTO club_invites(club_id, invitee, inviter) VALUES(?, ?, ?)",
                        (club_id, other, me)).rowcount:
            _notify(conn, other, "club_invite", me, club_id)
        return _club_view(conn, _club_row(conn, club_id), me)


@app.post("/api/clubs/{club_id}/request")
def request_to_join(club_id: int, user=Depends(consented_user)):
    """Ask to join a club that takes members by request; its owner and admins hear about it."""
    me = user["tg_id"]
    with db.session() as conn:
        club = _club_row(conn, club_id)
        if _member_role(conn, club_id, me):
            raise HTTPException(409, "Вы уже в клубе")
        if club["visibility"] != "closed":
            raise HTTPException(400, "В этот клуб заявки не подают")
        _not_frozen(club)
        if conn.execute("INSERT OR IGNORE INTO club_requests(club_id, tg_id) VALUES(?, ?)", (club_id, me)).rowcount:
            for r in conn.execute("SELECT tg_id FROM club_members WHERE club_id=? AND role IN ('owner', 'admin')", (club_id,)).fetchall():
                _notify(conn, r["tg_id"], "club_request", me, club_id)
        return _club_view(conn, club, me)


@app.delete("/api/clubs/{club_id}/request")
def cancel_request(club_id: int, user=Depends(consented_user)):
    me = user["tg_id"]
    with db.session() as conn:
        club = _club_row(conn, club_id)
        conn.execute("DELETE FROM club_requests WHERE club_id=? AND tg_id=?", (club_id, me))
        # the owner and admins need not hear about a request that is gone, if they have not seen it yet
        conn.execute("DELETE FROM notifications WHERE kind='club_request' AND actor=? AND club_id=? AND read_at IS NULL",
                     (me, club_id))
        return _club_view(conn, club, me)


@app.post("/api/clubs/{club_id}/requests/{other}/accept")
def accept_request(club_id: int, other: int, user=Depends(consented_user)):
    """The owner or an admin lets the student in."""
    me = user["tg_id"]
    with db.session() as conn:
        _not_frozen(_club_row(conn, club_id))
        _require_role(conn, club_id, me, "owner", "admin")
        if not conn.execute("DELETE FROM club_requests WHERE club_id=? AND tg_id=?", (club_id, other)).rowcount:
            raise HTTPException(404, "Заявки уже нет")
        conn.execute("INSERT OR IGNORE INTO club_members(club_id, tg_id, role) VALUES(?, ?, 'member')", (club_id, other))
        conn.execute("DELETE FROM club_invites WHERE club_id=? AND invitee=?", (club_id, other))
        _notify(conn, other, "request_accept", me, club_id)
        return _club_view(conn, _club_row(conn, club_id), me)


@app.delete("/api/clubs/{club_id}/requests/{other}")
def decline_request(club_id: int, other: int, user=Depends(consented_user)):
    me = user["tg_id"]
    with db.session() as conn:
        _require_role(conn, club_id, me, "owner", "admin")
        conn.execute("DELETE FROM club_requests WHERE club_id=? AND tg_id=?", (club_id, other))
        return _club_view(conn, _club_row(conn, club_id), me)


@app.delete("/api/clubs/{club_id}/invites/{other}")
def drop_club_invite(club_id: int, other: int, user=Depends(consented_user)):
    """The invitee declines, or an owner or admin takes the invitation back."""
    me = user["tg_id"]
    with db.session() as conn:
        if other != me:
            _require_role(conn, club_id, me, "owner", "admin")
        conn.execute("DELETE FROM club_invites WHERE club_id=? AND invitee=?", (club_id, other))
    return {"ok": True}


class RoleIn(BaseModel):
    role: str


@app.post("/api/clubs/{club_id}/members/{other}/role")
def set_club_role(club_id: int, other: int, body: RoleIn, user=Depends(consented_user)):
    """The owner makes a member an admin, or an admin a member again."""
    me = user["tg_id"]
    with db.session() as conn:
        _require_role(conn, club_id, me, "owner")
        if other == me or _club_member(conn, club_id, other) == "owner":
            raise HTTPException(400, "Свою роль владелец меняет, только передав права")
        if body.role not in ("admin", "member"):
            raise HTTPException(400, "Можно сделать админом или участником")
        conn.execute("UPDATE club_members SET role=? WHERE club_id=? AND tg_id=?", (body.role, club_id, other))
        if body.role == "admin":
            _notify(conn, other, "club_admin", me, club_id)
        return _club_view(conn, _club_row(conn, club_id), me)


@app.get("/api/clubs/{club_id}/members/{other}/contact")
def club_member_contact(club_id: int, other: int, user=Depends(consented_user)):
    """The Telegram chat link of a fellow member, asked for only when "write" is pressed:
    the club's pages never carry anyone's @tag."""
    with db.session() as conn:
        _require_role(conn, club_id, user["tg_id"], "owner", "admin", "member")
        _club_member(conn, club_id, other)
        row = conn.execute("SELECT username FROM users WHERE tg_id=?", (other,)).fetchone()
    if not row or not row["username"]:
        raise HTTPException(404, "У этого человека нет тега в Telegram, поэтому написать ему отсюда не получится")
    return {"url": f"https://t.me/{row['username']}"}


@app.post("/api/clubs/{club_id}/transfer/{other}")
def transfer_club(club_id: int, other: int, user=Depends(consented_user)):
    """Hand the club over: the member becomes the owner, the old owner stays on as an admin."""
    me = user["tg_id"]
    with db.session() as conn:
        _require_role(conn, club_id, me, "owner")
        if other == me:
            raise HTTPException(400, "Вы и так владелец")
        _club_member(conn, club_id, other)
        if _owned(conn, other) >= CLUB_OWN_MAX:
            raise HTTPException(409, f"У этого человека уже {CLUB_OWN_MAX} своих клуба, больше владеть нельзя")
        conn.execute("UPDATE club_members SET role='admin' WHERE club_id=? AND tg_id=?", (club_id, me))
        conn.execute("UPDATE club_members SET role='owner' WHERE club_id=? AND tg_id=?", (club_id, other))
        _notify(conn, other, "club_owner", me, club_id)
        return _club_view(conn, _club_row(conn, club_id), me)


@app.delete("/api/clubs/{club_id}/members/{other}")
def remove_club_member(club_id: int, other: int, user=Depends(consented_user)):
    """The owner removes anyone else; an admin removes ordinary members."""
    me = user["tg_id"]
    with db.session() as conn:
        role = _require_role(conn, club_id, me, "owner", "admin")
        theirs = _club_member(conn, club_id, other)
        if other == me or theirs == "owner" or (role == "admin" and theirs == "admin"):
            raise HTTPException(403, "Админ может исключать только обычных участников")
        conn.execute("DELETE FROM club_members WHERE club_id=? AND tg_id=?", (club_id, other))
        _notify(conn, other, "club_kicked", me, club_id)
        return _club_view(conn, _club_row(conn, club_id), me)


# ---------- a club's feed: news, announcements and jokes, for members' eyes only ----------

def _author(conn, tg_id: int):
    card = _card(conn, tg_id)
    return {"tg_id": tg_id, "name": card["name"] if card else "Бывший участник",
            "photo_url": card["photo_url"] if card else "", "group": card["group"] if card else ""}


def _reactions(conn, post_id: int, me: int):
    """Counts in the order of the set, only those someone chose, and this student's own choice."""
    counts = dict(conn.execute("SELECT emoji, COUNT(*) FROM post_reactions WHERE post_id=? GROUP BY emoji", (post_id,)).fetchall())
    mine = conn.execute("SELECT emoji FROM post_reactions WHERE post_id=? AND tg_id=?", (post_id, me)).fetchone()
    return {"reactions": [{"emoji": e, "count": counts[e]} for e in REACTIONS if counts.get(e)],
            "mine": mine["emoji"] if mine else None}


def _post_card(conn, post, me: int, role: str | None):
    return {"id": post["id"], "club_id": post["club_id"], "member": bool(role),
            "body": post["body"], "created_at": post["created_at"],
            "photo_url": f"/posts/{post['photo']}.jpg" if post["photo"] else "",
            "author": _author(conn, post["author"]),
            "can_delete": post["author"] == me or role in ("owner", "admin"),
            "comments_off": bool(post["comments_off"]),
            "public": bool(post["public"]),
            "comments": conn.execute("SELECT COUNT(*) FROM post_comments WHERE post_id=?", (post["id"],)).fetchone()[0],
            **_reactions(conn, post["id"], me)}


def _club_post(conn, club_id: int, post_id: int):
    post = conn.execute("SELECT * FROM club_posts WHERE id=? AND club_id=?", (post_id, club_id)).fetchone()
    if not post:
        raise HTTPException(404, "Такой записи нет")
    return post


def _drop_post(conn, post_id: int):
    conn.execute("DELETE FROM post_reactions WHERE post_id=?", (post_id,))
    conn.execute("DELETE FROM post_comments WHERE post_id=?", (post_id,))
    conn.execute("DELETE FROM notifications WHERE post_id=?", (post_id,))
    conn.execute("DELETE FROM club_posts WHERE id=?", (post_id,))


@app.get("/api/clubs/{club_id}/posts")
def club_posts(club_id: int, before: int | None = None, user=Depends(consented_user)):
    """The newest posts first, a page at a time; older ones with ?before=<the last id you have>.
    Members read every post; a visitor who may open the club reads only the open ones."""
    me = user["tg_id"]
    with db.session() as conn:
        club = _club_row(conn, club_id)
        role = _member_role(conn, club_id, me)
        if not _can_view(conn, club, me, role):
            raise HTTPException(404, "Такого клуба нет")
        rows = conn.execute("SELECT * FROM club_posts WHERE club_id=? AND id < ? AND (public=1 OR ?) ORDER BY id DESC LIMIT ?",
                            (club_id, before or 2 ** 62, int(bool(role)), POSTS_PAGE + 1)).fetchall()
        return {"posts": [_post_card(conn, p, me, role) for p in rows[:POSTS_PAGE]], "more": len(rows) > POSTS_PAGE,
                "reaction_set": list(REACTIONS)}


def _close_profane_open_posts():
    """Open posts published before the swearing filter: those that would not pass it now are left to the
    club's members only, so the shared feed and the club's visitors never see them. Nothing is deleted."""
    with db.session() as conn:
        rows = conn.execute("SELECT id, body FROM club_posts WHERE public=1").fetchall()
        closed = [r["id"] for r in rows if has_profanity(r["body"])]
        for post_id in closed:
            conn.execute("UPDATE club_posts SET public=0 WHERE id=?", (post_id,))
    if closed:
        log.info("swearing filter: %d open posts left to members only (%s)", len(closed), closed)


@app.get("/api/feed")
def shared_feed(before: int | None = None, user=Depends(consented_user)):
    """The shared feed: open posts of every club this student may open, newest first, each with its club."""
    me = user["tg_id"]
    with db.session() as conn:
        roles = dict(conn.execute("SELECT club_id, role FROM club_members WHERE tg_id=?", (me,)).fetchall())
        clubs = {c["id"]: c for c in conn.execute("SELECT * FROM clubs").fetchall()
                 if _can_view(conn, c, me, roles.get(c["id"]))}
        if not clubs:
            return {"posts": [], "more": False}
        rows = conn.execute(f"SELECT * FROM club_posts WHERE public=1 AND club_id IN ({','.join('?' * len(clubs))}) "
                            "AND id < ? ORDER BY id DESC LIMIT ?", (*clubs, before or 2 ** 62, POSTS_PAGE + 1)).fetchall()
        posts = []
        for p in rows[:POSTS_PAGE]:
            c = clubs[p["club_id"]]
            posts.append({**_post_card(conn, p, me, roles.get(c["id"])),
                          "club": {"id": c["id"], "name": c["name"], "category": c["category"],
                                   "photo_url": f"/avatars/{c['avatar']}.jpg" if c["avatar"] else ""}})
        return {"posts": posts, "more": len(rows) > POSTS_PAGE}


class PostIn(BaseModel):
    body: str = Field("", max_length=10000)
    photo: str | None = Field(None, max_length=12_000_000)   # the picture, base64
    comments_off: bool = False
    public: bool = False   # open to visitors of the club; members-only unless chosen


def _encode_post_photo(raw: bytes) -> bytes:
    """A feed photo keeps its shape, at most POST_PHOTO_SIDE on the long side, without metadata."""
    img = ImageOps.exif_transpose(Image.open(BytesIO(raw))).convert("RGB")
    img.thumbnail((POST_PHOTO_SIDE, POST_PHOTO_SIDE), Image.LANCZOS)
    out = BytesIO()
    img.save(out, "JPEG", quality=84, optimize=True)
    return out.getvalue()


@app.post("/api/clubs/{club_id}/posts")
async def create_post(club_id: int, body: PostIn, user=Depends(speaking_user)):
    """The owner and admins post text, a photo, or both."""
    me = user["tg_id"]
    with db.session() as conn:
        _feature(conn, "posts")
        _not_frozen(_club_row(conn, club_id))
        role = _require_role(conn, club_id, me, "owner", "admin")
    text = _clean_about(body.body)
    if len(text) > POST_MAX:
        raise HTTPException(400, f"Запись: не длиннее {POST_MAX} символов")
    with db.session() as conn:
        _watch_words(conn, me, "post", text, blocked=body.public)
    if body.public and has_profanity(text):
        raise HTTPException(400, "В записях для всех нельзя использовать мат. Уберите его или выключите «Видна всем», "
                                 "и запись увидят только участники клуба.")
    photo = None
    if body.photo:
        try:
            raw = base64.b64decode(body.photo, validate=True)
        except ValueError:
            raise HTTPException(400, "Это не похоже на фото")
        if len(raw) > AVATAR_MAX_BYTES:
            raise HTTPException(413, "Фото слишком большое")
        try:
            jpeg = await asyncio.to_thread(_encode_post_photo, raw)
        except Exception:
            raise HTTPException(400, "Это не похоже на фото")
        photo = secrets.token_urlsafe(16)
        (POSTS / f"{photo}.jpg").write_bytes(jpeg)
    if not text and not photo:
        raise HTTPException(400, "Напишите что-нибудь или прикрепите фото")
    with db.session() as conn:
        cur = conn.execute("INSERT INTO club_posts(club_id, author, body, photo, comments_off, public) VALUES(?, ?, ?, ?, ?, ?)",
                           (club_id, me, text, photo, int(body.comments_off), int(body.public)))
        for r in conn.execute("SELECT tg_id FROM club_members WHERE club_id=?", (club_id,)).fetchall():
            _notify(conn, r["tg_id"], "club_post", me, club_id, cur.lastrowid, text or "Фото")
        return _post_card(conn, conn.execute("SELECT * FROM club_posts WHERE id=?", (cur.lastrowid,)).fetchone(), me, role)


@app.delete("/api/clubs/{club_id}/posts/{post_id}")
def delete_post(club_id: int, post_id: int, user=Depends(consented_user)):
    """The author, the owner or an admin."""
    me = user["tg_id"]
    with db.session() as conn:
        post = _club_post(conn, club_id, post_id)
        if post["author"] != me and _member_role(conn, club_id, me) not in ("owner", "admin"):
            raise HTTPException(403, "Удалить запись могут автор, владелец и админы")
        _drop_post(conn, post_id)
    if post["photo"]:
        (POSTS / f"{post['photo']}.jpg").unlink(missing_ok=True)
    return {"deleted": True}


class ReactionIn(BaseModel):
    emoji: str


@app.post("/api/clubs/{club_id}/posts/{post_id}/reaction")
def react(club_id: int, post_id: int, body: ReactionIn, user=Depends(consented_user)):
    """One reaction per member: a new one replaces the old, the same one again takes it back."""
    me = user["tg_id"]
    if body.emoji not in REACTIONS:
        raise HTTPException(400, "Такой реакции нет")
    with db.session() as conn:
        _require_role(conn, club_id, me, "owner", "admin", "member")
        _club_post(conn, club_id, post_id)
        had = conn.execute("SELECT emoji FROM post_reactions WHERE post_id=? AND tg_id=?", (post_id, me)).fetchone()
        if had and had["emoji"] == body.emoji:
            conn.execute("DELETE FROM post_reactions WHERE post_id=? AND tg_id=?", (post_id, me))
        else:
            conn.execute("INSERT INTO post_reactions(post_id, tg_id, emoji) VALUES(?, ?, ?) "
                         "ON CONFLICT(post_id, tg_id) DO UPDATE SET emoji=excluded.emoji", (post_id, me, body.emoji))
        return _reactions(conn, post_id, me)


def _comment_card(conn, row, me: int, role: str | None):
    return {"id": row["id"], "body": row["body"], "created_at": row["created_at"], "author": _author(conn, row["author"]),
            "can_delete": row["author"] == me or role in ("owner", "admin")}


@app.get("/api/clubs/{club_id}/posts/{post_id}/comments")
def comments(club_id: int, post_id: int, user=Depends(consented_user)):
    """All of a post's comments, oldest first, like a chat. Visitors read those under open posts;
    writing stays with the members."""
    me = user["tg_id"]
    with db.session() as conn:
        role = _member_role(conn, club_id, me)
        post = _club_post(conn, club_id, post_id)
        if not role and not (post["public"] and _can_view(conn, _club_row(conn, club_id), me, role)):
            raise HTTPException(403, "Эту запись видят только участники клуба")
        rows = conn.execute("SELECT * FROM post_comments WHERE post_id=? ORDER BY id", (post_id,)).fetchall()
        return {"comments": [_comment_card(conn, r, me, role) for r in rows], "comments_off": bool(post["comments_off"]),
                "can_comment": bool(role) and not post["comments_off"]}


class CommentIn(BaseModel):
    body: str = Field(max_length=5000)


@app.post("/api/clubs/{club_id}/posts/{post_id}/comments")
def add_comment(club_id: int, post_id: int, body: CommentIn, user=Depends(speaking_user)):
    """Every member may comment, unless the post was published with comments off."""
    me = user["tg_id"]
    with db.session() as conn:
        _feature(conn, "comments")
        _not_frozen(_club_row(conn, club_id))
        role = _require_role(conn, club_id, me, "owner", "admin", "member")
        post = _club_post(conn, club_id, post_id)
        if post["comments_off"]:
            raise HTTPException(403, "К этой записи комментарии отключены")
        text = _clean_about(body.body)
        if not text:
            raise HTTPException(400, "Напишите комментарий")
        if len(text) > COMMENT_MAX:
            raise HTTPException(400, f"Комментарий: не длиннее {COMMENT_MAX} символов")
        _watch_words(conn, me, "comment", text)
        cur = conn.execute("INSERT INTO post_comments(post_id, author, body) VALUES(?, ?, ?)", (post_id, me, text))
        _notify(conn, post["author"], "comment", me, club_id, post_id, text)
        return _comment_card(conn, conn.execute("SELECT * FROM post_comments WHERE id=?", (cur.lastrowid,)).fetchone(), me, role)


@app.delete("/api/clubs/{club_id}/posts/{post_id}/comments/{comment_id}")
def delete_comment(club_id: int, post_id: int, comment_id: int, user=Depends(consented_user)):
    """The comment's author, the owner or an admin."""
    me = user["tg_id"]
    with db.session() as conn:
        _club_post(conn, club_id, post_id)
        row = conn.execute("SELECT author FROM post_comments WHERE id=? AND post_id=?", (comment_id, post_id)).fetchone()
        if not row:
            raise HTTPException(404, "Такого комментария нет")
        if row["author"] != me and _member_role(conn, club_id, me) not in ("owner", "admin"):
            raise HTTPException(403, "Удалить комментарий могут автор, владелец и админы")
        conn.execute("DELETE FROM post_comments WHERE id=?", (comment_id,))
    return {"deleted": True}


# ---------- the app outside Telegram: sign-in through the bot, signed-in devices ----------
# The app on a phone's home screen has no Telegram signature. It asks for a code (/api/login/start), the
# student opens t.me/<bot>?start=login_<code> and confirms in the bot, and the app, which kept a secret that
# never left it, trades code and secret for a long key of its own (/api/login/claim).

def _fresh_login(conn, code: str):
    return conn.execute("SELECT * FROM logins WHERE code=? AND created_at >= datetime('now', ?)",
                        (code, f"-{LOGIN_MINUTES} minutes")).fetchone()


@app.post("/api/login/start")
def login_start(request: Request):
    code, secret = secrets.token_urlsafe(16), secrets.token_urlsafe(32)
    with db.session() as conn:
        conn.execute("DELETE FROM logins WHERE created_at < datetime('now', ?)", (f"-{LOGIN_MINUTES} minutes",))
        if conn.execute("SELECT count(*) FROM logins").fetchone()[0] >= LOGINS_MAX:
            raise HTTPException(429, "Сейчас входит слишком много людей сразу, попробуйте через пару минут")
        conn.execute("INSERT INTO logins(code, secret_hash, device) VALUES(?, ?, ?)",
                     (code, _hash(secret), _device_name(request.headers.get("user-agent", ""))))
    name = (bot.username if bot else None) or BOT_USERNAME
    return {"code": code, "secret": secret, "link": f"https://t.me/{name}?start=login_{code}"}


class ClaimIn(BaseModel):
    code: str = Field(max_length=64)
    secret: str = Field(max_length=128)


@app.post("/api/login/claim")
def login_claim(body: ClaimIn, request: Request):
    """Pending until the student says yes in the bot; then the device's key, once."""
    with db.session() as conn:
        row = _fresh_login(conn, body.code)
        if not row or not hmac.compare_digest(row["secret_hash"], _hash(body.secret)):
            return {"status": "expired"}
        if row["status"] == "denied":
            conn.execute("DELETE FROM logins WHERE code=?", (body.code,))
            return {"status": "denied"}
        if row["status"] != "confirmed":
            return {"status": "pending"}
        key = secrets.token_urlsafe(32)
        conn.execute("DELETE FROM logins WHERE code=?", (body.code,))
        conn.execute("INSERT INTO devices(tg_id, key_hash, name) VALUES(?, ?, ?)",
                     (row["tg_id"], _hash(key), row["device"] or _device_name(request.headers.get("user-agent", ""))))
    return {"status": "ok", "key": key}


def _login_ask(sender: dict, code: str):
    """/start login_<code> in the bot: which device wants in, and a warning against links sent by others."""
    with db.session() as conn:
        row = _fresh_login(conn, code)
        if not row or row["status"] not in ("pending", "asked"):
            return "Эта ссылка для входа устарела. Нажмите «Войти через Telegram» в приложении ещё раз.", None
        if not conn.execute("SELECT 1 FROM users WHERE tg_id=?", (sender.get("id"),)).fetchone():
            return ("Сначала зарегистрируйтесь: нажмите «Расписание» внизу этого чата и заполните профиль. "
                    "Потом снова нажмите «Войти через Telegram» в приложении на телефоне."), None
        conn.execute("UPDATE logins SET tg_id=?, status='asked' WHERE code=?", (sender["id"], code))
    return (f"Войти в приложение «Расписание» на устройстве «{row['device'] or 'новое устройство'}»?\n\n"
            "Подтверждайте, только если сами нажали «Войти через Telegram» в приложении. Если ссылку прислал "
            "кто-то другой, нажмите «Нет»: иначе он получит доступ к вашему аккаунту.",
            {"inline_keyboard": [[{"text": "Да, это я", "callback_data": f"login:{code}:yes"},
                                  {"text": "Нет", "callback_data": f"login:{code}:no"}]]})


def _login_answer(sender: dict, code: str, yes: bool) -> str:
    with db.session() as conn:
        row = _fresh_login(conn, code)
        if not row or row["status"] != "asked" or row["tg_id"] != sender.get("id"):
            return "Эта ссылка для входа уже не действует."
        conn.execute("UPDATE logins SET status=? WHERE code=?", ("confirmed" if yes else "denied", code))
    if yes:
        return f"Готово, вход на устройстве «{row['device'] or 'новое устройство'}» подтверждён. Вернитесь в приложение."
    return "Вход отменён. Без вашего подтверждения войти в аккаунт нельзя."


@app.post("/api/devices/handoff")
def device_handoff(user=Depends(consented_user)):
    """«Приложение на телефон» inside Telegram: the site in the phone's browser, already signed in.
    The code and secret travel in the #fragment, which browsers never send to a server."""
    with db.session() as conn:
        fragment = _handoff(conn, user["tg_id"])
    base = (bot.webapp_url if bot else "") or "http://localhost:8080"
    return {"url": f"{base}/{fragment}"}


def _handoff(conn, tg_id: int) -> str:
    """A sign-in already confirmed for this student, as the #fragment the site signs in with."""
    code, secret = secrets.token_urlsafe(16), secrets.token_urlsafe(32)
    conn.execute("INSERT INTO logins(code, secret_hash, tg_id, status) VALUES(?, ?, ?, 'confirmed')",
                  (code, _hash(secret), tg_id))
    return f"#login={code}.{secret}"


# ---------- the bot offers the app for the phone: after sign-up, and once to those who signed up earlier ----------

async def _offer_app(tg_id: int, again: bool = False):
    """«Скачать» opens the site in the phone's browser, signed in, where arrows show where to tap;
    «Нет, не надо» takes the offer away. again: /app, sent whatever was answered before."""
    if not bot or not bot.webapp_url:
        return
    with db.session() as conn:
        if not again:
            if conn.execute("SELECT 1 FROM devices WHERE tg_id=?", (tg_id,)).fetchone():
                conn.execute("UPDATE users SET app_offer='installed' WHERE tg_id=? AND app_offer IS NULL", (tg_id,))
                return
            if not conn.execute("UPDATE users SET app_offer='sent' WHERE tg_id=? AND app_offer IS NULL "
                                "AND consent_at IS NOT NULL", (tg_id,)).rowcount:
                return   # offered before, or not signed up
        token = secrets.token_urlsafe(24)
        conn.execute("INSERT INTO install_links(token_hash, tg_id) VALUES(?, ?)", (_hash(token), tg_id))
    try:
        sent = await bot.call("sendMessage", chat_id=tg_id, text=APP_OFFER, reply_markup={"inline_keyboard": [[
            {"text": "Скачать", "url": f"{bot.webapp_url}/install/{token}"},
            {"text": "Нет, не надо", "callback_data": "app:no"}]]})
    except Exception as e:
        log.warning("app offer to %s: %s", tg_id, e)
        return
    with db.session() as conn:
        conn.execute("UPDATE users SET app_offer_msg=? WHERE tg_id=?", (sent["message_id"], tg_id))


async def _app_command(chat_id: int):
    """/app: the offer again, with a fresh link."""
    with db.session() as conn:
        known = conn.execute("SELECT 1 FROM users WHERE tg_id=? AND consent_at IS NOT NULL", (chat_id,)).fetchone()
    if not known:
        await bot.call("sendMessage", chat_id=chat_id,
                       text="Сначала откройте приложение кнопкой «Расписание» и заполните профиль, потом пришлю ссылку.")
        return
    await _offer_app(chat_id, again=True)


def _app_declined(sender: dict) -> str:
    with db.session() as conn:
        conn.execute("UPDATE users SET app_offer='declined' WHERE tg_id=?", (sender.get("id"),))
    return "Хорошо, не будем. Если передумаете, отправьте /app, и я пришлю ссылку снова."


async def _retire_offer(tg_id: int, message_id: int):
    """The used «Скачать» button leaves the chat: the link in it works only once."""
    try:
        await bot.call("editMessageText", chat_id=tg_id, message_id=message_id,
                       text="Ссылка открыта в браузере. Если не получилось поставить приложение, отправьте /app, "
                            "и я пришлю новую.")
    except Exception:
        pass   # deleted or too old to edit


@app.get("/install/{token}")
def install_link(token: str, background: BackgroundTasks):
    """«Скачать» under the bot's offer: the site in the browser, signed in, with the steps to the home screen open."""
    headers = {"Cache-Control": "no-store"}
    with db.session() as conn:
        row = conn.execute("SELECT l.tg_id, u.app_offer_msg FROM install_links l JOIN users u ON u.tg_id = l.tg_id "
                           "WHERE l.token_hash=? AND l.created_at >= datetime('now', ?)",
                           (_hash(token), f"-{INSTALL_LINK_HOURS} hours")).fetchone()
        conn.execute("DELETE FROM install_links WHERE token_hash=?", (_hash(token),))
        if not row:
            return RedirectResponse("/#login=used", status_code=303, headers=headers)
        fragment = _handoff(conn, row["tg_id"])
        conn.execute("UPDATE users SET app_offer='opened', app_offer_msg=NULL WHERE tg_id=?", (row["tg_id"],))
    if bot and row["app_offer_msg"]:
        background.add_task(_retire_offer, row["tg_id"], row["app_offer_msg"])
    return RedirectResponse(f"/{fragment}", status_code=303, headers=headers)


@app.post("/api/app-offer")
def app_offer(background: BackgroundTasks, user=Depends(consented_user)):
    """Called as the Mini App opens: those who signed up before the offer existed get it once from the bot."""
    background.add_task(_offer_app, user["tg_id"])
    return {"ok": True}


@app.get("/api/devices")
def devices(user=Depends(consented_user), tg=Depends(current_tg_user)):
    with db.session() as conn:
        rows = conn.execute("SELECT id, name, created_at, seen_at FROM devices WHERE tg_id=? ORDER BY seen_at DESC",
                            (user["tg_id"],)).fetchall()
    return [{**dict(r), "current": r["id"] == tg.get("device_id")} for r in rows]


@app.delete("/api/devices/current")
def sign_out_here(tg=Depends(current_tg_user)):
    """«Выйти на этом устройстве»: the key this device shows stops working."""
    if tg.get("device_id"):
        with db.session() as conn:
            conn.execute("DELETE FROM devices WHERE id=?", (tg["device_id"],))
    return {"signed_out": True}


@app.delete("/api/devices/{device_id}")
def sign_out_device(device_id: int, user=Depends(current_user)):
    with db.session() as conn:
        conn.execute("DELETE FROM devices WHERE id=? AND tg_id=?", (device_id, user["tg_id"]))
    return {"signed_out": True}


@app.get("/sw.js")
def service_worker():
    """The offline worker, stamped with the state of the app's files: after any change browsers see
    a new worker, which fetches the new files and drops the old ones."""
    stamp = hashlib.sha256()
    for p in sorted((ROOT / "webapp").rglob("*")):
        if p.is_file() and p.name != "sw.js":
            st = p.stat()
            stamp.update(f"{p.relative_to(ROOT)}:{st.st_size}:{st.st_mtime_ns};".encode())
    code = (ROOT / "webapp" / "sw.js").read_text(encoding="utf-8").replace("__VERSION__", stamp.hexdigest()[:12])
    return Response(code, media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/api/avatar")
async def avatar(user=Depends(consented_user)):
    """Profile photo through the bot, for clients whose initData has no photo_url."""
    if not bot:
        raise HTTPException(404)
    try:
        url = await bot.file_url(user["tg_id"])
        if not url:
            raise HTTPException(404)
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.get(url)
        return Response(r.content, media_type=r.headers.get("content-type", "image/jpeg"),
                        headers={"Cache-Control": "private, max-age=3600"})
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(404)


@app.get("/privacy")
def privacy_page():
    return FileResponse(ROOT / "webapp" / "privacy.html")


@app.get("/consent")
def consent_page():
    return FileResponse(ROOT / "webapp" / "consent.html")


from . import admin  # noqa: E402  (it reads this module's helpers)

app.include_router(admin.router)
app.mount("/crm", StaticFiles(directory=ROOT / "webapp-admin", html=True), name="crm")
app.mount("/avatars", StaticFiles(directory=AVATARS), name="avatars")
app.mount("/posts", StaticFiles(directory=POSTS), name="posts")
app.mount("/", StaticFiles(directory=ROOT / "webapp", html=True), name="webapp")
