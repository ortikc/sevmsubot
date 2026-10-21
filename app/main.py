"""HTTP API + static Mini App."""
import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db, scraper
from .auth import AuthError, validate_init_data
from .bot import Bot

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
DEV_AUTH = os.getenv("DEV_AUTH") == "1"
FULL_SYNC_EVERY = timedelta(hours=6)
GROUP_STALE_AFTER = timedelta(hours=2)
MSK = timezone(timedelta(hours=3))  # Sevastopol keeps Moscow time, no DST
REMIND_BEFORE = timedelta(minutes=10)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("app")

bot: Bot | None = None
_group_locks: dict[int, asyncio.Lock] = {}


async def full_sync_loop():
    while True:
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


async def reminder_loop():
    """Send every due reminder through the bot, once."""
    while True:
        await asyncio.sleep(20)
        if not bot:
            continue
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with db.session() as conn:
            due = [dict(r) for r in conn.execute(
                "SELECT * FROM reminders WHERE sent_at IS NULL AND remind_at <= ? ORDER BY remind_at", (now,))]
        for r in due:
            text = f"Через 10 минут: {r['subject']}\n{_clock(r['start'])}–{_clock(r['end'])}"
            if r["room"]:
                text += f" · ауд. {r['room']}"
            try:
                await bot.call("sendMessage", chat_id=r["tg_id"], text=text)
            except Exception as e:  # the student may have blocked the bot; never retry forever
                log.warning("reminder %s not sent: %s", r["id"], e)
            with db.session() as conn:
                conn.execute("UPDATE reminders SET sent_at=? WHERE id=?",
                             (datetime.now(timezone.utc).isoformat(timespec="seconds"), r["id"]))


@asynccontextmanager
async def lifespan(_app):
    global bot
    db.init()
    tasks = [asyncio.create_task(full_sync_loop()), asyncio.create_task(reminder_loop())]
    if BOT_TOKEN:
        bot = Bot(BOT_TOKEN, os.getenv("WEBAPP_URL", ""), ROOT / "data" / "webapp_url.txt")
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
        "photo_url": user["photo_url"],
        "real_name": user["real_name"],
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
    if (end - start).days > 62:
        raise HTTPException(400, "Слишком длинный период")
    gid = user["group_id"]
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


app.mount("/", StaticFiles(directory=ROOT / "webapp", html=True), name="webapp")
