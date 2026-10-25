"""HTTP API + static Mini App."""
import asyncio
import hashlib
import html
import logging
import os
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

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
DEV_AUTH = os.getenv("DEV_AUTH") == "1"
AVATARS = ROOT / "data" / "avatars"   # uploaded profile photos, named by a random token
AVATARS.mkdir(parents=True, exist_ok=True)
AVATAR_SIZE = 256
AVATAR_MAX_BYTES = 8 * 1024 * 1024
NICK_MAX = 32
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


@app.post("/api/profile/avatar")
async def upload_avatar(request: Request, user=Depends(current_user)):
    """A photo of your own instead of the Telegram one; the body is the image itself."""
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
    card = {"tg_id": u["tg_id"], "name": _display_name(u), "photo_url": _photo(u),
            "group": u["group_name"], "course": u["group_course"],
            "faculty": u["faculty"], "is_master": bool(u["is_master"])}
    if with_now:
        card["now"] = _now_status(conn, u["group_id"], datetime.now(timezone.utc))
    return card


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
        elif rel == "none":
            conn.execute("INSERT INTO friendships(requester, addressee) VALUES(?, ?)", (me, other))
        return {"relation": _relation(conn, me, other)}


@app.post("/api/friends/{other}/accept")
def accept_friend(other: int, user=Depends(current_user)):
    me = user["tg_id"]
    with db.session() as conn:
        n = conn.execute("UPDATE friendships SET status='accepted' WHERE requester=? AND addressee=? AND status='pending'",
                         (other, me)).rowcount
        if not n:
            raise HTTPException(404, "Заявки уже нет")
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
        conn.execute("INSERT OR IGNORE INTO flame_taps(tapper, friend, day) VALUES(?, ?, ?)",
                     (me, other, datetime.now(MSK).date().isoformat()))
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
app.mount("/", StaticFiles(directory=ROOT / "webapp", html=True), name="webapp")
