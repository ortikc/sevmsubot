"""HTTP API + static Mini App."""
import asyncio
import base64
import hashlib
import html
import logging
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
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

from . import db, scraper
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
        "SELECT tg_id, group_id, remind_lead FROM users WHERE remind_all=1 AND group_id IS NOT NULL"
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
            "SELECT r.*, u.group_id FROM reminders r JOIN users u ON u.tg_id = r.tg_id "
            "WHERE r.sent_at IS NULL AND r.remind_at <= ? ORDER BY r.remind_at",
            (now.isoformat(timespec="seconds"),))]
    for r in due:
        with db.session() as conn:
            # the schedule may have changed since the reminder was set: stay quiet about a pair that is gone
            still = conn.execute("SELECT 1 FROM lessons WHERE group_id=? AND date=? AND start=?",
                                 (r["group_id"], r["date"], r["start"])).fetchone()
        if still:
            try:
                await bot.send_rich(r["tg_id"], lambda e: _reminder_html(r, e))
            except Exception as e:  # the student may have blocked the bot; never retry forever
                log.warning("reminder %s not sent: %s", r["id"], e)
        with db.session() as conn:
            conn.execute("UPDATE reminders SET sent_at=? WHERE id=?",
                         (datetime.now(timezone.utc).isoformat(timespec="seconds"), r["id"]))


async def send_digests(now: datetime):
    """The morning summary goes once a day, at the chosen time or as soon after it as the server is up,
    but only before the first pair, and only on days with pairs."""
    local = now.astimezone(MSK)
    today, hhmm = local.date().isoformat(), local.strftime("%H:%M")
    with db.session() as conn:
        users = [dict(u) for u in conn.execute(
            "SELECT tg_id, group_id, digest_time FROM users WHERE digest_time IS NOT NULL AND group_id IS NOT NULL "
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


async def reminder_loop():
    """Every 20 seconds: plan the automatic reminders, send what is due, send morning summaries."""
    while True:
        await asyncio.sleep(20)
        if not bot:
            continue
        now = datetime.now(timezone.utc)
        try:
            with db.session() as conn:
                materialize_auto_reminders(conn, now)
            await send_due_reminders(now)
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
    tasks = [asyncio.create_task(full_sync_loop()), asyncio.create_task(reminder_loop())]
    if BOT_TOKEN:
        bot = Bot(BOT_TOKEN, os.getenv("WEBAPP_URL", ""), ROOT / "data" / "webapp_url.txt")
        bot.on_url_change = _repoint_everyone
        bot.on_open_button = _remember_open_button
        try:
            await bot.setup()
            tasks.append(asyncio.create_task(bot.poll()))
            tasks.append(asyncio.create_task(bot.watch_url()))
        except Exception as e:
            log.warning("bot setup failed: %s", e)
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def no_stale_assets(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


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


def current_user(tg: dict = Depends(current_tg_user)):
    with db.session() as conn:
        conn.execute(
            "INSERT INTO users(tg_id, tg_first, tg_last, username, photo_url) VALUES(?,?,?,?,?) "
            "ON CONFLICT(tg_id) DO UPDATE SET tg_first=excluded.tg_first, tg_last=excluded.tg_last, "
            "username=excluded.username, photo_url=excluded.photo_url, updated_at=datetime('now')",
            (tg["id"], tg.get("first_name", ""), tg.get("last_name", ""), tg.get("username", ""),
             tg.get("photo_url", "")),
        )
        return dict(conn.execute("SELECT * FROM users WHERE tg_id=?", (tg["id"],)).fetchone())


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


@app.post("/api/profile")
def save_profile(body: ProfileIn, user=Depends(current_user)):
    name = " ".join(body.real_name.split())
    with db.session() as conn:
        g = conn.execute("SELECT * FROM groups WHERE id=?", (body.group_id,)).fetchone()
        if not g:
            raise HTTPException(400, "Такой группы нет")
        conn.execute(
            "UPDATE users SET real_name=?, group_id=?, faculty_id=?, course=?, updated_at=datetime('now') "
            "WHERE tg_id=?", (name, g["id"], g["faculty_id"], g["course"], user["tg_id"]),
        )
        user = dict(conn.execute("SELECT * FROM users WHERE tg_id=?", (user["tg_id"],)).fetchone())
        return _profile(conn, user)


class NicknameIn(BaseModel):
    nickname: str = Field(max_length=200)


@app.post("/api/profile/nickname")
def save_nickname(body: NicknameIn, user=Depends(current_user)):
    """The name friends see, changeable any time; empty brings back the real name.
    The Telegram @tag is not stored as editable: it comes from Telegram on every request."""
    nick = " ".join("".join(ch for ch in body.nickname if ch.isprintable()).split())
    if nick and not 2 <= len(nick) <= NICK_MAX:
        raise HTTPException(400, f"Ник: от 2 до {NICK_MAX} символов")
    with db.session() as conn:
        conn.execute("UPDATE users SET nickname=?, updated_at=datetime('now') WHERE tg_id=?",
                     (nick or None, user["tg_id"]))
        user = dict(conn.execute("SELECT * FROM users WHERE tg_id=?", (user["tg_id"],)).fetchone())
        return _profile(conn, user)


class BioIn(BaseModel):
    bio: str = Field(max_length=1000)


@app.post("/api/profile/bio")
def save_bio(body: BioIn, user=Depends(current_user)):
    """A few words about yourself; empty removes them."""
    bio = _clean_about(body.bio)
    if len(bio) > BIO_MAX:
        raise HTTPException(400, f"Описание: не длиннее {BIO_MAX} символов")
    with db.session() as conn:
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
async def upload_avatar(request: Request, user=Depends(current_user)):
    """A photo of your own instead of the Telegram one; the body is the image itself."""
    token = await _save_photo(request)
    with db.session() as conn:
        return _set_avatar(conn, user, token)


@app.delete("/api/profile/avatar")
def remove_avatar(user=Depends(current_user)):
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
async def schedule(start: date, end: date, user=Depends(current_user)):
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
def list_reminders(user=Depends(current_user)):
    with db.session() as conn:
        rows = conn.execute(
            "SELECT * FROM reminders WHERE tg_id=? AND sent_at IS NULL ORDER BY remind_at", (user["tg_id"],)
        ).fetchall()
    return [_reminder_out(r) for r in rows]


@app.post("/api/reminders")
def add_reminder(body: ReminderIn, user=Depends(current_user)):
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
def delete_reminder(rid: int, user=Depends(current_user)):
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
def get_settings(user=Depends(current_user)):
    with db.session() as conn:
        return _settings(conn, user)


@app.post("/api/settings")
def save_settings(body: SettingsIn, user=Depends(current_user)):
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
async def refresh(user=Depends(current_user)):
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
def notifications(user=Depends(current_user)):
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
def notifications_unread(user=Depends(current_user)):
    """Just the number for the red badge on the bell."""
    with db.session() as conn:
        return {"unread": _unread(conn, user["tg_id"])}


@app.post("/api/notifications/read")
def notifications_read(user=Depends(current_user)):
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
        "WHERE u.tg_id=?", (tg_id,)).fetchone()
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
def friends(user=Depends(current_user)):
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
def find_user(username: str, user=Depends(current_user)):
    name = username.strip().lstrip("@").lower()
    if not 3 <= len(name) <= 32 or not all(ch.isalnum() or ch == "_" for ch in name):
        raise HTTPException(400, "Введите тег Telegram, например @ivan_petrov")
    with db.session() as conn:
        found = conn.execute(
            "SELECT tg_id FROM users WHERE lower(username)=? AND real_name IS NOT NULL AND group_id IS NOT NULL "
            "ORDER BY updated_at DESC LIMIT 1", (name,)).fetchone()
        if not found:
            return {"user": None, "relation": None}
        return {"user": _card(conn, found["tg_id"]), "relation": _relation(conn, user["tg_id"], found["tg_id"])}


@app.post("/api/friends/{other}")
def add_friend(other: int, user=Depends(current_user)):
    """Send a request; if they already asked you, this accepts it."""
    me = user["tg_id"]
    with db.session() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE tg_id=? AND real_name IS NOT NULL", (other,)).fetchone():
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
def accept_friend(other: int, user=Depends(current_user)):
    me = user["tg_id"]
    with db.session() as conn:
        n = conn.execute("UPDATE friendships SET status='accepted' WHERE requester=? AND addressee=? AND status='pending'",
                         (other, me)).rowcount
        if not n:
            raise HTTPException(404, "Заявки уже нет")
        _notify(conn, other, "friend_accept", me)
        return {"relation": "friend"}


@app.delete("/api/friends/{other}")
def remove_friend(other: int, user=Depends(current_user)):
    """Decline a request, cancel your own, or remove a friend: the link goes in both directions."""
    me = user["tg_id"]
    with db.session() as conn:
        conn.execute("DELETE FROM friendships WHERE (requester=? AND addressee=?) OR (requester=? AND addressee=?)",
                     (me, other, other, me))
        conn.execute("DELETE FROM flame_taps WHERE (tapper=? AND friend=?) OR (tapper=? AND friend=?)",
                     (me, other, other, me))
    return {"relation": "none"}


@app.post("/api/friends/{other}/flame")
def press_flame(other: int, user=Depends(current_user)):
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
async def friend_schedule(other: int, start: date, end: date, user=Depends(current_user)):
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
            "members": _club_size(conn, club["id"])}


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
def clubs(user=Depends(current_user)):
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
def club(club_id: int, user=Depends(current_user)):
    with db.session() as conn:
        return _club_view(conn, _club_row(conn, club_id), user["tg_id"])


@app.post("/api/clubs")
def create_club(body: ClubIn, user=Depends(current_user)):
    """Found a club and become its owner; a student owns at most CLUB_OWN_MAX clubs."""
    me = user["tg_id"]
    with db.session() as conn:
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
def club_settings(club_id: int, body: ClubIn, user=Depends(current_user)):
    me = user["tg_id"]
    with db.session() as conn:
        _club_row(conn, club_id)
        _require_role(conn, club_id, me, "owner", "admin")
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
async def club_avatar(club_id: int, request: Request, user=Depends(current_user)):
    with db.session() as conn:
        _club_row(conn, club_id)
        _require_role(conn, club_id, user["tg_id"], "owner", "admin")
    return _set_club_avatar(club_id, user["tg_id"], await _save_photo(request))


@app.delete("/api/clubs/{club_id}/avatar")
def remove_club_avatar(club_id: int, user=Depends(current_user)):
    with db.session() as conn:
        _club_row(conn, club_id)
        _require_role(conn, club_id, user["tg_id"], "owner", "admin")
    return _set_club_avatar(club_id, user["tg_id"], None)


@app.post("/api/clubs/{club_id}/join")
def join_club(club_id: int, user=Depends(current_user)):
    """Join an open club, or accept an invitation."""
    me = user["tg_id"]
    with db.session() as conn:
        club = _club_row(conn, club_id)
        if not _member_role(conn, club_id, me):
            if not (_invited(conn, club_id, me) or _open_to(conn, club, me)):
                raise HTTPException(403, "В этот клуб вступают только друзья владельца" if club["visibility"] == "friends"
                                    else "В этот клуб вступают по заявке" if club["visibility"] == "closed"
                                    else "В этот клуб вступают только по приглашению")
            conn.execute("INSERT INTO club_members(club_id, tg_id, role) VALUES(?, ?, 'member')", (club_id, me))
            conn.execute("DELETE FROM club_invites WHERE club_id=? AND invitee=?", (club_id, me))
            conn.execute("DELETE FROM club_requests WHERE club_id=? AND tg_id=?", (club_id, me))
        return _club_view(conn, club, me)


@app.post("/api/clubs/{club_id}/leave")
def leave_club(club_id: int, user=Depends(current_user)):
    me = user["tg_id"]
    with db.session() as conn:
        _club_row(conn, club_id)
        if _require_role(conn, club_id, me, "owner", "admin", "member") == "owner":
            raise HTTPException(400, "Сначала передайте права владельца другому участнику" if _club_size(conn, club_id) > 1
                                else "Вы единственный участник: клуб можно только удалить")
        conn.execute("DELETE FROM club_members WHERE club_id=? AND tg_id=?", (club_id, me))
    return {"left": True}


@app.delete("/api/clubs/{club_id}")
def delete_club(club_id: int, user=Depends(current_user)):
    """Only the owner, and only once nobody else is left: a club with members is handed over, not deleted."""
    with db.session() as conn:
        club = _club_row(conn, club_id)
        _require_role(conn, club_id, user["tg_id"], "owner")
        if _club_size(conn, club_id) > 1:
            raise HTTPException(400, "В клубе есть участники, поэтому удалить его нельзя. "
                                     "Можно передать права владельца другому участнику.")
        photos = [r["photo"] for r in conn.execute("SELECT photo FROM club_posts WHERE club_id=? AND photo IS NOT NULL", (club_id,))]
        for r in conn.execute("SELECT id FROM club_posts WHERE club_id=?", (club_id,)).fetchall():
            _drop_post(conn, r["id"])
        conn.execute("DELETE FROM club_invites WHERE club_id=?", (club_id,))
        conn.execute("DELETE FROM club_requests WHERE club_id=?", (club_id,))
        conn.execute("DELETE FROM notifications WHERE club_id=?", (club_id,))
        conn.execute("DELETE FROM club_members WHERE club_id=?", (club_id,))
        conn.execute("DELETE FROM clubs WHERE id=?", (club_id,))
    for token in photos:
        (POSTS / f"{token}.jpg").unlink(missing_ok=True)
    if club["avatar"]:
        (AVATARS / f"{club['avatar']}.jpg").unlink(missing_ok=True)
    return {"deleted": True}


@app.post("/api/clubs/{club_id}/invites/{other}")
def invite_to_club(club_id: int, other: int, user=Depends(current_user)):
    me = user["tg_id"]
    with db.session() as conn:
        _club_row(conn, club_id)
        _require_role(conn, club_id, me, "owner", "admin")
        if not conn.execute("SELECT 1 FROM users WHERE tg_id=? AND real_name IS NOT NULL AND group_id IS NOT NULL",
                            (other,)).fetchone():
            raise HTTPException(404, "Такого студента нет в приложении")
        if _member_role(conn, club_id, other):
            raise HTTPException(409, "Этот человек уже в клубе")
        if conn.execute("INSERT OR IGNORE INTO club_invites(club_id, invitee, inviter) VALUES(?, ?, ?)",
                        (club_id, other, me)).rowcount:
            _notify(conn, other, "club_invite", me, club_id)
        return _club_view(conn, _club_row(conn, club_id), me)


@app.post("/api/clubs/{club_id}/request")
def request_to_join(club_id: int, user=Depends(current_user)):
    """Ask to join a club that takes members by request; its owner and admins hear about it."""
    me = user["tg_id"]
    with db.session() as conn:
        club = _club_row(conn, club_id)
        if _member_role(conn, club_id, me):
            raise HTTPException(409, "Вы уже в клубе")
        if club["visibility"] != "closed":
            raise HTTPException(400, "В этот клуб заявки не подают")
        if conn.execute("INSERT OR IGNORE INTO club_requests(club_id, tg_id) VALUES(?, ?)", (club_id, me)).rowcount:
            for r in conn.execute("SELECT tg_id FROM club_members WHERE club_id=? AND role IN ('owner', 'admin')", (club_id,)).fetchall():
                _notify(conn, r["tg_id"], "club_request", me, club_id)
        return _club_view(conn, club, me)


@app.delete("/api/clubs/{club_id}/request")
def cancel_request(club_id: int, user=Depends(current_user)):
    me = user["tg_id"]
    with db.session() as conn:
        club = _club_row(conn, club_id)
        conn.execute("DELETE FROM club_requests WHERE club_id=? AND tg_id=?", (club_id, me))
        # the owner and admins need not hear about a request that is gone, if they have not seen it yet
        conn.execute("DELETE FROM notifications WHERE kind='club_request' AND actor=? AND club_id=? AND read_at IS NULL",
                     (me, club_id))
        return _club_view(conn, club, me)


@app.post("/api/clubs/{club_id}/requests/{other}/accept")
def accept_request(club_id: int, other: int, user=Depends(current_user)):
    """The owner or an admin lets the student in."""
    me = user["tg_id"]
    with db.session() as conn:
        _require_role(conn, club_id, me, "owner", "admin")
        if not conn.execute("DELETE FROM club_requests WHERE club_id=? AND tg_id=?", (club_id, other)).rowcount:
            raise HTTPException(404, "Заявки уже нет")
        conn.execute("INSERT OR IGNORE INTO club_members(club_id, tg_id, role) VALUES(?, ?, 'member')", (club_id, other))
        conn.execute("DELETE FROM club_invites WHERE club_id=? AND invitee=?", (club_id, other))
        _notify(conn, other, "request_accept", me, club_id)
        return _club_view(conn, _club_row(conn, club_id), me)


@app.delete("/api/clubs/{club_id}/requests/{other}")
def decline_request(club_id: int, other: int, user=Depends(current_user)):
    me = user["tg_id"]
    with db.session() as conn:
        _require_role(conn, club_id, me, "owner", "admin")
        conn.execute("DELETE FROM club_requests WHERE club_id=? AND tg_id=?", (club_id, other))
        return _club_view(conn, _club_row(conn, club_id), me)


@app.delete("/api/clubs/{club_id}/invites/{other}")
def drop_club_invite(club_id: int, other: int, user=Depends(current_user)):
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
def set_club_role(club_id: int, other: int, body: RoleIn, user=Depends(current_user)):
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
def club_member_contact(club_id: int, other: int, user=Depends(current_user)):
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
def transfer_club(club_id: int, other: int, user=Depends(current_user)):
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
def remove_club_member(club_id: int, other: int, user=Depends(current_user)):
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
def club_posts(club_id: int, before: int | None = None, user=Depends(current_user)):
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
def shared_feed(before: int | None = None, user=Depends(current_user)):
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
async def create_post(club_id: int, body: PostIn, user=Depends(current_user)):
    """The owner and admins post text, a photo, or both."""
    me = user["tg_id"]
    with db.session() as conn:
        _club_row(conn, club_id)
        role = _require_role(conn, club_id, me, "owner", "admin")
    text = _clean_about(body.body)
    if len(text) > POST_MAX:
        raise HTTPException(400, f"Запись: не длиннее {POST_MAX} символов")
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
def delete_post(club_id: int, post_id: int, user=Depends(current_user)):
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
def react(club_id: int, post_id: int, body: ReactionIn, user=Depends(current_user)):
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
def comments(club_id: int, post_id: int, user=Depends(current_user)):
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
def add_comment(club_id: int, post_id: int, body: CommentIn, user=Depends(current_user)):
    """Every member may comment, unless the post was published with comments off."""
    me = user["tg_id"]
    with db.session() as conn:
        role = _require_role(conn, club_id, me, "owner", "admin", "member")
        post = _club_post(conn, club_id, post_id)
        if post["comments_off"]:
            raise HTTPException(403, "К этой записи комментарии отключены")
        text = _clean_about(body.body)
        if not text:
            raise HTTPException(400, "Напишите комментарий")
        if len(text) > COMMENT_MAX:
            raise HTTPException(400, f"Комментарий: не длиннее {COMMENT_MAX} символов")
        cur = conn.execute("INSERT INTO post_comments(post_id, author, body) VALUES(?, ?, ?)", (post_id, me, text))
        _notify(conn, post["author"], "comment", me, club_id, post_id, text)
        return _comment_card(conn, conn.execute("SELECT * FROM post_comments WHERE id=?", (cur.lastrowid,)).fetchone(), me, role)


@app.delete("/api/clubs/{club_id}/posts/{post_id}/comments/{comment_id}")
def delete_comment(club_id: int, post_id: int, comment_id: int, user=Depends(current_user)):
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


@app.get("/api/avatar")
async def avatar(user=Depends(current_user)):
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


app.mount("/avatars", StaticFiles(directory=AVATARS), name="avatars")
app.mount("/posts", StaticFiles(directory=POSTS), name="posts")
app.mount("/", StaticFiles(directory=ROOT / "webapp", html=True), name="webapp")
