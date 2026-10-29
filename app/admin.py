"""The CRM: the developer's admin panel, a second Mini App at admin.sevstud.site opened from its own bot.

Only one Telegram account gets in: CRM_ADMIN (@ortikc). The panel's requests carry Telegram's initData signed
for the CRM bot (not the app's bot), and the first time that account shows up, by /start in the CRM bot or by
opening the panel, its Telegram id is locked in (meta crm_admin_id): from then on the id decides, so a new
owner of the @name gets nothing. The CRM bot also brings the admin alerts: a report, a message to the
developer, a failed backup or schedule sync.

What the panel does: everyone registered and their profiles, the app's stats, bans and mutes, moderation
(reports, the swearing log, posts and comments), clubs (freeze, badge, owner, rename, delete), broadcasts
through the app's bot, the schedule parser and the server, settings without a deploy, the inbox of messages
to the developer, and a journal of the admin's own actions, the reversible ones with «Отменить»."""
import asyncio
import json
import logging
import os
import re
import shutil
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import db, scraper
from . import main as m
from .auth import AuthError, validate_init_data

log = logging.getLogger("crm")

CRM_BOT_TOKEN = os.getenv("CRM_BOT_TOKEN", "")
CRM_ADMIN = os.getenv("CRM_ADMIN", "ortikc").lstrip("@").lower()
CRM_HOST = os.getenv("CRM_HOST", "admin.sevstud.site")
CRM_URL = f"https://{CRM_HOST}/"
STARTED = time.time()
PAGE = 50

router = APIRouter(prefix="/api/admin")
crm: "CrmBot | None" = None


# ---------- who gets in ----------

def _is_admin(tg_user: dict) -> bool:
    """The locked id; before there is one, the account named CRM_ADMIN, whose id is then locked."""
    uid = tg_user.get("id")
    with db.session() as conn:
        locked = db.get_meta(conn, "crm_admin_id")
        if locked:
            return str(uid) == locked
        if uid and (tg_user.get("username") or "").lower() == CRM_ADMIN:
            db.set_meta(conn, "crm_admin_id", str(uid))
            log.info("CRM admin locked to %s (@%s)", uid, CRM_ADMIN)
            return True
    return False


def _admin_chat() -> int | None:
    with db.session() as conn:
        v = db.get_meta(conn, "crm_admin_id")
    return int(v) if v else None


def admin_user(request: Request) -> dict:
    init_data = request.headers.get("X-Init-Data", "")
    if init_data and CRM_BOT_TOKEN:
        try:
            user = validate_init_data(init_data, CRM_BOT_TOKEN)
        except AuthError as e:
            log.warning("CRM auth rejected: %s", e)
            raise HTTPException(401, "Telegram не подтвердил вход")
        if _is_admin(user):
            return user
        log.warning("CRM: refused %s (@%s)", user.get("id"), user.get("username"))
        raise HTTPException(403, "Доступ закрыт")
    host = (request.headers.get("host") or "").split(":")[0]
    if m.DEV_AUTH and host in ("localhost", "127.0.0.1"):
        return {"id": 0, "first_name": "Админ", "username": CRM_ADMIN}
    raise HTTPException(401, "Откройте панель через бота")


# ---------- small helpers ----------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _today() -> date:
    return datetime.now(m.MSK).date()


def _journal(conn, action: str, target: str = "", undo: dict | None = None):
    conn.execute("INSERT INTO admin_log(action, target, undo) VALUES(?, ?, ?)",
                 (action, target, json.dumps(undo, ensure_ascii=False) if undo else None))


USER_SQL = ("SELECT u.*, g.name AS gname, f.name AS fname, f.is_master FROM users u "
            "LEFT JOIN groups g ON g.id = u.group_id LEFT JOIN faculties f ON f.id = u.faculty_id")


def _restrictions(conn) -> dict:
    """{(tg_id, kind): row} of every ban and mute in force."""
    return {(r["tg_id"], r["kind"]): dict(r) for r in conn.execute(
        "SELECT * FROM restrictions WHERE until IS NULL OR until > ?", (_now(),))}


def _person(u, limits: dict | None = None) -> dict:
    limits = limits or {}
    tg_id = u["tg_id"]
    return {"tg_id": tg_id, "name": m._display_name(u), "real_name": u["real_name"], "nickname": u["nickname"],
            "tg_name": " ".join(x for x in (u["tg_first"], u["tg_last"]) if x), "username": u["username"],
            "photo_url": m._photo(u), "group": u["gname"], "faculty": u["fname"], "course": u["course"],
            "master": bool(u["is_master"]), "created_at": u["created_at"], "seen_at": u["updated_at"],
            "consent": bool(u["consent_at"]), "ban": limits.get((tg_id, "ban")), "mute": limits.get((tg_id, "mute"))}


def _person_by_id(conn, tg_id: int, limits=None) -> dict | None:
    u = conn.execute(USER_SQL + " WHERE u.tg_id=?", (tg_id,)).fetchone()
    return _person(u, limits) if u else None


def _who(conn, tg_id: int) -> str:
    p = _person_by_id(conn, tg_id)
    return f"{p['name']}" + (f" (@{p['username']})" if p and p["username"] else "") if p else f"id {tg_id}"


async def _send_from_app_bot(tg_id: int, text: str):
    if not m.bot:
        raise HTTPException(503, "Бот приложения сейчас не запущен")
    try:
        await m.bot.call("sendMessage", chat_id=tg_id, text=text)
    except RuntimeError as e:
        raise HTTPException(409, f"Telegram не доставил сообщение: {e}")


# ---------- the panel's own account ----------

@router.get("/me")
def whoami(admin=Depends(admin_user)):
    with db.session() as conn:
        unread = conn.execute("SELECT COUNT(*) FROM feedback WHERE read_at IS NULL").fetchone()[0]
        reports = conn.execute("SELECT COUNT(*) FROM reports WHERE status='open'").fetchone()[0]
    return {"name": admin.get("first_name") or CRM_ADMIN, "username": admin.get("username"),
            "photo_url": admin.get("photo_url", ""), "unread": unread, "reports": reports}


@router.get("/catalog")
def catalog(admin=Depends(admin_user)):
    return m.catalog()


# ---------- stats ----------

@router.get("/stats")
def stats(admin=Depends(admin_user)):
    today = _today()
    day = lambda n: (today - timedelta(days=n)).isoformat()   # noqa: E731
    with db.session() as conn:
        one = lambda sql, *a: conn.execute(sql, a).fetchone()[0]   # noqa: E731
        registered = "real_name IS NOT NULL AND consent_at IS NOT NULL AND tg_id > 1"
        users = one(f"SELECT COUNT(*) FROM users WHERE {registered}")
        created = lambda n: one(f"SELECT COUNT(*) FROM users WHERE {registered} AND date(created_at, '+3 hours') >= ?", day(n))  # noqa: E731
        active = lambda n: one("SELECT COUNT(DISTINCT tg_id) FROM activity WHERE day >= ?", day(n))  # noqa: E731

        dau_rows = dict(conn.execute("SELECT day, COUNT(DISTINCT tg_id) FROM activity WHERE day >= ? GROUP BY day",
                                     (day(29),)).fetchall())
        reg_rows = dict(conn.execute(f"SELECT date(created_at, '+3 hours') AS d, COUNT(*) FROM users WHERE {registered} "
                                     "AND d >= ? GROUP BY d", (day(29),)).fetchall())
        days = [day(n) for n in range(29, -1, -1)]

        # came back N days after signing up, of those who signed up at least N days ago
        cohort = conn.execute("SELECT date(u.created_at, '+3 hours') AS c, MAX(a.day) AS last FROM users u "
                              "LEFT JOIN activity a ON a.tg_id = u.tg_id WHERE u.real_name IS NOT NULL "
                              "AND u.consent_at IS NOT NULL AND u.tg_id > 1 GROUP BY u.tg_id").fetchall()
        retention = []
        for n in (1, 7, 30):
            base = [r for r in cohort if r["c"] and r["c"] <= day(n)]
            back = [r for r in base if r["last"] and r["last"] >= (date.fromisoformat(r["c"]) + timedelta(days=n)).isoformat()]
            retention.append({"days": n, "base": len(base), "back": len(back)})

        by_faculty = [dict(r) for r in conn.execute(
            f"SELECT f.name AS name, f.is_master AS master, COUNT(*) AS n FROM users u JOIN faculties f ON f.id = u.faculty_id "
            f"WHERE u.real_name IS NOT NULL AND u.consent_at IS NOT NULL AND u.tg_id > 1 GROUP BY f.id ORDER BY n DESC")]
        by_course = [dict(r) for r in conn.execute(
            "SELECT u.course AS course, COUNT(*) AS n FROM users u WHERE u.real_name IS NOT NULL AND u.consent_at IS NOT NULL "
            "AND u.tg_id > 1 AND u.course IS NOT NULL GROUP BY u.course ORDER BY u.course")]
        by_group = [dict(r) for r in conn.execute(
            "SELECT g.name AS name, f.name AS faculty, COUNT(*) AS n FROM users u JOIN groups g ON g.id = u.group_id "
            "JOIN faculties f ON f.id = g.faculty_id WHERE u.real_name IS NOT NULL AND u.consent_at IS NOT NULL AND u.tg_id > 1 "
            "GROUP BY g.id ORDER BY n DESC LIMIT 12")]
        hours = [0] * 24
        for h, n in conn.execute("SELECT hour, COUNT(DISTINCT tg_id) FROM activity WHERE day >= ? GROUP BY hour", (day(13),)):
            hours[h] = n

        funnel = [
            {"label": "Зарегистрировались", "n": users},
            {"label": "Бот предложил приложение", "n": one(f"SELECT COUNT(*) FROM users WHERE {registered} AND app_offer IS NOT NULL")},
            {"label": "Открыли ссылку «Скачать»", "n": one(f"SELECT COUNT(*) FROM users WHERE {registered} AND app_offer IN ('opened', 'installed')")},
            {"label": "Вошли с главного экрана", "n": one("SELECT COUNT(DISTINCT tg_id) FROM devices")},
        ]
        clubs = {
            "total": one("SELECT COUNT(*) FROM clubs"),
            "members": one("SELECT COUNT(DISTINCT tg_id) FROM club_members"),
            "posts_7d": one("SELECT COUNT(*) FROM club_posts WHERE created_at >= datetime('now', '-7 days')"),
            "comments_7d": one("SELECT COUNT(*) FROM post_comments WHERE created_at >= datetime('now', '-7 days')"),
            "active_7d": one("SELECT COUNT(DISTINCT club_id) FROM club_posts WHERE created_at >= datetime('now', '-7 days')"),
            "top": [dict(r) for r in conn.execute(
                "SELECT c.id, c.name, COUNT(p.id) AS posts FROM clubs c JOIN club_posts p ON p.club_id = c.id "
                "WHERE p.created_at >= datetime('now', '-7 days') GROUP BY c.id ORDER BY posts DESC LIMIT 5")],
        }
        features = {
            "friends": one("SELECT COUNT(*) FROM friendships WHERE status='accepted'"),
            "remind_all": one(f"SELECT COUNT(*) FROM users WHERE {registered} AND remind_all=1"),
            "digest": one(f"SELECT COUNT(*) FROM users WHERE {registered} AND digest_time IS NOT NULL"),
            "calendar": one(f"SELECT COUNT(*) FROM users WHERE {registered} AND cal_token IS NOT NULL"),
            "flames_today": one("SELECT COUNT(*) FROM flame_taps WHERE day=?", today.isoformat()),
        }
        return {
            "users": users, "unfinished": one("SELECT COUNT(*) FROM users WHERE tg_id > 1") - users,
            "new": {"today": created(0), "week": created(6), "month": created(29)},
            "active": {"dau": active(0), "wau": active(6), "mau": active(29)},
            "series": [{"day": d, "dau": dau_rows.get(d, 0), "new": reg_rows.get(d, 0)} for d in days],
            "retention": retention, "by_faculty": by_faculty, "by_course": by_course, "by_group": by_group,
            "hours": hours, "funnel": funnel, "clubs": clubs, "features": features,
            "banned": one("SELECT COUNT(*) FROM restrictions WHERE kind='ban' AND (until IS NULL OR until > ?)", _now()),
            "reports": one("SELECT COUNT(*) FROM reports WHERE status='open'"),
            "unread": one("SELECT COUNT(*) FROM feedback WHERE read_at IS NULL"),
        }


# ---------- people ----------

USER_FILTERS = ("all", "new", "active", "inactive", "banned", "muted", "devices", "unfinished")


@router.get("/users")
def users(q: str = "", filter: str = "all", faculty: int | None = None, course: int | None = None,
          group: int | None = None, offset: int = 0, admin=Depends(admin_user)):
    """Everyone the app knows, newest first; search by name, nick, @tag or id (SQLite cannot fold Cyrillic
    case, so the search runs here)."""
    if filter not in USER_FILTERS:
        raise HTTPException(400, "Нет такого фильтра")
    today = _today()
    where, args = ["u.tg_id > 1"], []
    if filter != "unfinished":
        where.append("u.real_name IS NOT NULL AND u.consent_at IS NOT NULL")
    else:
        where.append("(u.real_name IS NULL OR u.consent_at IS NULL)")
    if filter == "new":
        where.append("date(u.created_at, '+3 hours') >= ?"); args.append((today - timedelta(days=6)).isoformat())
    if filter == "active":
        where.append("u.tg_id IN (SELECT tg_id FROM activity WHERE day >= ?)"); args.append((today - timedelta(days=6)).isoformat())
    if filter == "inactive":
        where.append("u.tg_id NOT IN (SELECT tg_id FROM activity WHERE day >= ?)"); args.append((today - timedelta(days=29)).isoformat())
    if filter in ("banned", "muted"):
        where.append("u.tg_id IN (SELECT tg_id FROM restrictions WHERE kind=? AND (until IS NULL OR until > ?))")
        args += ["ban" if filter == "banned" else "mute", _now()]
    if filter == "devices":
        where.append("u.tg_id IN (SELECT tg_id FROM devices)")
    for col, val in (("u.faculty_id", faculty), ("u.course", course), ("u.group_id", group)):
        if val is not None:
            where.append(f"{col}=?"); args.append(val)
    with db.session() as conn:
        limits = _restrictions(conn)
        rows = conn.execute(f"{USER_SQL} WHERE {' AND '.join(where)} ORDER BY u.created_at DESC", args).fetchall()
        needle = q.strip().lstrip("@").casefold()
        if needle:
            rows = [u for u in rows if needle == str(u["tg_id"]) or any(
                needle in (u[k] or "").casefold() for k in ("real_name", "nickname", "username", "tg_first", "tg_last"))]
        return {"total": len(rows), "users": [_person(u, limits) for u in rows[offset:offset + PAGE]],
                "more": len(rows) > offset + PAGE}


@router.get("/users/{tg_id}")
def user_card(tg_id: int, admin=Depends(admin_user)):
    today = _today()
    with db.session() as conn:
        u = conn.execute(USER_SQL + " WHERE u.tg_id=?", (tg_id,)).fetchone()
        limits = _restrictions(conn)
        if not u:
            # a deleted account may still carry a ban
            ban, mute = limits.get((tg_id, "ban")), limits.get((tg_id, "mute"))
            if ban or mute:
                return {"gone": True, "tg_id": tg_id, "ban": ban, "mute": mute}
            raise HTTPException(404, "Такого пользователя нет")
        one = lambda sql, *a: conn.execute(sql, a).fetchone()[0]   # noqa: E731
        active_days = {r[0] for r in conn.execute("SELECT DISTINCT day FROM activity WHERE tg_id=? AND day >= ?",
                                                  (tg_id, (today - timedelta(days=29)).isoformat()))}
        clubs = [dict(r) for r in conn.execute(
            "SELECT c.id, c.name, m.role FROM club_members m JOIN clubs c ON c.id = m.club_id WHERE m.tg_id=? "
            "ORDER BY m.role = 'owner' DESC, c.name", (tg_id,))]
        posts = [dict(r) for r in conn.execute(
            "SELECT p.id, p.body, p.photo IS NOT NULL AS photo, p.public, p.created_at, c.name AS club FROM club_posts p "
            "JOIN clubs c ON c.id = p.club_id WHERE p.author=? ORDER BY p.id DESC LIMIT 10", (tg_id,))]
        comments = [dict(r) for r in conn.execute(
            "SELECT cm.id, cm.body, cm.created_at, c.name AS club FROM post_comments cm JOIN club_posts p ON p.id = cm.post_id "
            "JOIN clubs c ON c.id = p.club_id WHERE cm.author=? ORDER BY cm.id DESC LIMIT 10", (tg_id,))]
        return {
            **_person(u, limits), "bio": u["bio"], "custom_avatar": bool(u["avatar"]), "consent_at": u["consent_at"],
            "settings": {"remind_all": bool(u["remind_all"]), "remind_lead": u["remind_lead"], "digest_time": u["digest_time"],
                         "show_club": bool(u["show_club"]), "calendar": bool(u["cal_token"]), "app_offer": u["app_offer"]},
            "counts": {
                "friends": one("SELECT COUNT(*) FROM friendships WHERE status='accepted' AND (requester=?1 OR addressee=?1)", tg_id),
                "requests": one("SELECT COUNT(*) FROM friendships WHERE status='pending' AND (requester=?1 OR addressee=?1)", tg_id),
                "posts": one("SELECT COUNT(*) FROM club_posts WHERE author=?", tg_id),
                "comments": one("SELECT COUNT(*) FROM post_comments WHERE author=?", tg_id),
                "reminders": one("SELECT COUNT(*) FROM reminders WHERE tg_id=? AND sent_at IS NULL", tg_id),
                "reports_on": one("SELECT COUNT(*) FROM reports WHERE kind='user' AND target=?", tg_id),
                "reports_by": one("SELECT COUNT(*) FROM reports WHERE reporter=?", tg_id),
            },
            "activity": [(today - timedelta(days=n)).isoformat() in active_days for n in range(29, -1, -1)],
            "clubs": clubs, "posts": posts, "comments": comments,
            "devices": [dict(r) for r in conn.execute("SELECT name, created_at, seen_at FROM devices WHERE tg_id=? ORDER BY seen_at DESC", (tg_id,))],
            "swearing": [dict(r) for r in conn.execute("SELECT place, body, blocked, created_at FROM profanity_log WHERE tg_id=? ORDER BY id DESC LIMIT 10", (tg_id,))],
        }


class RestrictIn(BaseModel):
    kind: str
    days: int | None = Field(None, ge=1, le=3650)   # None = until lifted
    reason: str = Field("", max_length=300)
    notify: bool = True


def _set_restriction(conn, tg_id: int, kind: str, row: dict | None):
    if row:
        conn.execute("INSERT OR REPLACE INTO restrictions(tg_id, kind, until, reason, created_at) VALUES(?, ?, ?, ?, ?)",
                     (tg_id, kind, row["until"], row["reason"], row.get("created_at") or _now()))
    else:
        conn.execute("DELETE FROM restrictions WHERE tg_id=? AND kind=?", (tg_id, kind))


@router.post("/users/{tg_id}/restrict")
async def restrict(tg_id: int, body: RestrictIn, admin=Depends(admin_user)):
    """A ban (no app, the bot answers only with the ban) or a mute (reads, but writes nothing others see)."""
    if body.kind not in ("ban", "mute"):
        raise HTTPException(400, "Нет такого ограничения")
    if tg_id == _admin_chat():
        raise HTTPException(400, "Себя ограничить нельзя")
    until = (datetime.now(timezone.utc) + timedelta(days=body.days)).isoformat(timespec="seconds") if body.days else None
    reason = m._clean_line(body.reason)
    with db.session() as conn:
        prev = _restrictions(conn).get((tg_id, body.kind))
        _set_restriction(conn, tg_id, body.kind, {"until": until, "reason": reason})
        what = "Бан" if body.kind == "ban" else "Запрет публикаций"
        term = f"на {body.days} дн." if body.days else "бессрочно"
        _journal(conn, f"{what} {term}" + (f": {reason}" if reason else ""), _who(conn, tg_id),
                 {"type": "restrict", "tg_id": tg_id, "kind": body.kind, "prev": prev})
    if body.notify and m.bot:
        text = (f"Ваш аккаунт в «Расписании» заблокирован {m._until_text(until)}." if body.kind == "ban"
                else f"Администратор ограничил вам публикации в «Расписании» {m._until_text(until)}: "
                     "записи, комментарии, клубы и изменения профиля.")
        try:
            await m.bot.call("sendMessage", chat_id=tg_id, text=text + (f"\nПричина: {reason}" if reason else ""))
        except Exception as e:
            log.info("restriction notice to %s not sent: %s", tg_id, e)
    return user_card(tg_id, admin)


@router.delete("/users/{tg_id}/restrict/{kind}")
def lift(tg_id: int, kind: str, admin=Depends(admin_user)):
    with db.session() as conn:
        prev = _restrictions(conn).get((tg_id, kind))
        if prev:
            _set_restriction(conn, tg_id, kind, None)
            _journal(conn, "Снят бан" if kind == "ban" else "Снят запрет публикаций", _who(conn, tg_id),
                     {"type": "restrict", "tg_id": tg_id, "kind": kind, "prev": prev})
    return user_card(tg_id, admin)


class ResetIn(BaseModel):
    field: str


@router.post("/users/{tg_id}/reset")
def reset_profile(tg_id: int, body: ResetIn, admin=Depends(admin_user)):
    """Takes away a nick, «о себе» or an uploaded photo that breaks the rules."""
    labels = {"nickname": "Сброшен ник", "bio": "Удалено «о себе»", "avatar": "Удалено фото"}
    if body.field not in labels:
        raise HTTPException(400, "Нечего сбрасывать")
    with db.session() as conn:
        u = conn.execute("SELECT * FROM users WHERE tg_id=?", (tg_id,)).fetchone()
        if not u:
            raise HTTPException(404, "Такого пользователя нет")
        prev = u[body.field]
        if prev:
            conn.execute(f"UPDATE users SET {body.field}=NULL WHERE tg_id=?", (tg_id,))
            if body.field == "avatar":
                (m.AVATARS / f"{prev}.jpg").unlink(missing_ok=True)
            _journal(conn, labels[body.field] + (f": «{prev}»" if body.field != "avatar" else ""), _who(conn, tg_id),
                     None if body.field == "avatar" else {"type": "profile", "tg_id": tg_id, "field": body.field, "prev": prev})
    return user_card(tg_id, admin)


class MessageIn(BaseModel):
    text: str = Field(max_length=3500)


@router.post("/users/{tg_id}/message")
async def message_user(tg_id: int, body: MessageIn, admin=Depends(admin_user)):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Напишите сообщение")
    await _send_from_app_bot(tg_id, text)
    with db.session() as conn:
        _journal(conn, f"Сообщение через бота: «{text[:80]}»", _who(conn, tg_id))
    return {"ok": True}


# ---------- clubs ----------

def _club_out(conn, c, limits=None) -> dict:
    owner = conn.execute("SELECT tg_id FROM club_members WHERE club_id=? AND role='owner'", (c["id"],)).fetchone()
    one = lambda sql, *a: conn.execute(sql, a).fetchone()[0]   # noqa: E731
    return {"id": c["id"], "name": c["name"], "about": c["about"], "category": c["category"], "visibility": c["visibility"],
            "photo_url": f"/avatars/{c['avatar']}.jpg" if c["avatar"] else "", "created_at": c["created_at"],
            "frozen": bool(c["frozen"]), "official": bool(c["official"]), "chat_url": c["chat_url"],
            "members": one("SELECT COUNT(*) FROM club_members WHERE club_id=?", c["id"]),
            "posts": one("SELECT COUNT(*) FROM club_posts WHERE club_id=?", c["id"]),
            "posts_7d": one("SELECT COUNT(*) FROM club_posts WHERE club_id=? AND created_at >= datetime('now', '-7 days')", c["id"]),
            "last_post": conn.execute("SELECT MAX(created_at) FROM club_posts WHERE club_id=?", (c["id"],)).fetchone()[0],
            "reports": one("SELECT COUNT(*) FROM reports WHERE kind='club' AND target=? AND status='open'", c["id"]),
            "owner": _person_by_id(conn, owner["tg_id"], limits) if owner else None}


@router.get("/clubs")
def clubs(admin=Depends(admin_user)):
    with db.session() as conn:
        limits = _restrictions(conn)
        out = [_club_out(conn, c, limits) for c in conn.execute("SELECT * FROM clubs").fetchall()]
    out.sort(key=lambda c: (-c["posts_7d"], -c["members"], c["name"].casefold()))
    return out


@router.get("/clubs/{club_id}")
def club_card(club_id: int, admin=Depends(admin_user)):
    with db.session() as conn:
        c = m._club_row(conn, club_id)
        limits = _restrictions(conn)
        members = []
        for r in conn.execute("SELECT tg_id, role FROM club_members WHERE club_id=? ORDER BY joined_at", (club_id,)).fetchall():
            p = _person_by_id(conn, r["tg_id"], limits)
            if p:
                members.append({**p, "role": r["role"]})
        members.sort(key=lambda x: m.ROLE_ORDER[x["role"]])
        posts = [{**dict(r), "author": m._display_name(r)} for r in conn.execute(
            "SELECT p.id, p.body, p.photo, p.public, p.created_at, u.nickname, u.real_name, u.tg_first, u.tg_last, "
            "(SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) AS comments "
            "FROM club_posts p LEFT JOIN users u ON u.tg_id = p.author WHERE p.club_id=? ORDER BY p.id DESC LIMIT 15", (club_id,))]
        return {**_club_out(conn, c, limits), "member_list": members,
                "post_list": [{k: v for k, v in p.items() if k not in ("nickname", "real_name", "tg_first", "tg_last")}
                              | {"photo_url": f"/posts/{p['photo']}.jpg" if p["photo"] else ""} for p in posts]}


class ClubEditIn(BaseModel):
    name: str | None = Field(None, max_length=200)
    frozen: bool | None = None
    official: bool | None = None


@router.post("/clubs/{club_id}")
def edit_club(club_id: int, body: ClubEditIn, admin=Depends(admin_user)):
    with db.session() as conn:
        c = m._club_row(conn, club_id)
        changes = {}
        if body.name is not None:
            changes.update(m._club_fields(conn, m.ClubIn(name=body.name), club_id))
        if body.frozen is not None:
            changes["frozen"] = int(body.frozen)
        if body.official is not None:
            changes["official"] = int(body.official)
        changes = {k: v for k, v in changes.items() if c[k] != v}
        if changes:
            conn.execute(f"UPDATE clubs SET {', '.join(f'{k}=?' for k in changes)} WHERE id=?", (*changes.values(), club_id))
            words = {"name": f"Переименован в «{changes.get('name')}»",
                     "frozen": "Заморожен" if changes.get("frozen") else "Разморожен",
                     "official": "Отмечен как официальный" if changes.get("official") else "Снята отметка «официальный»"}
            _journal(conn, "Клуб: " + ", ".join(words[k] for k in changes), f"«{c['name']}»",
                     {"type": "club", "id": club_id, "fields": {k: c[k] for k in changes}})
    return club_card(club_id, admin)


class OwnerIn(BaseModel):
    tg_id: int


def _make_owner(conn, club_id: int, new_owner: int):
    old = conn.execute("SELECT tg_id FROM club_members WHERE club_id=? AND role='owner'", (club_id,)).fetchone()
    if old and old["tg_id"] == new_owner:
        return None
    if not m._member_role(conn, club_id, new_owner):
        raise HTTPException(400, "Владельцем можно сделать только участника клуба")
    if old:
        conn.execute("UPDATE club_members SET role='admin' WHERE club_id=? AND tg_id=?", (club_id, old["tg_id"]))
    conn.execute("UPDATE club_members SET role='owner' WHERE club_id=? AND tg_id=?", (club_id, new_owner))
    return old["tg_id"] if old else None


@router.post("/clubs/{club_id}/owner")
def transfer_owner(club_id: int, body: OwnerIn, admin=Depends(admin_user)):
    with db.session() as conn:
        c = m._club_row(conn, club_id)
        old = _make_owner(conn, club_id, body.tg_id)
        if old is not None:
            _journal(conn, f"Клуб передан: {_who(conn, old)} → {_who(conn, body.tg_id)}", f"«{c['name']}»",
                     {"type": "owner", "id": club_id, "prev": old})
    return club_card(club_id, admin)


@router.delete("/clubs/{club_id}")
def delete_club(club_id: int, admin=Depends(admin_user)):
    """The club and everything in it: posts, photos, comments, members, invitations."""
    with db.session() as conn:
        c = m._club_row(conn, club_id)
        size = m._club_size(conn, club_id)
        files = m._erase_club(conn, club_id)
        _journal(conn, f"Клуб удалён (участников: {size})", f"«{c['name']}»")
    for f in files:
        f.unlink(missing_ok=True)
    return {"deleted": True}


# ---------- moderation ----------

def _report_out(conn, r, limits) -> dict:
    """A report with whom it is about, so the panel can act on the author right away."""
    out = {**dict(r), "reporter": _person_by_id(conn, r["reporter"], limits), "exists": False, "author": None, "club": None}
    if r["kind"] == "post":
        p = conn.execute("SELECT p.author, p.club_id, c.name FROM club_posts p JOIN clubs c ON c.id = p.club_id WHERE p.id=?",
                         (r["target"],)).fetchone()
        if p:
            out.update(exists=True, author=_person_by_id(conn, p["author"], limits), club={"id": p["club_id"], "name": p["name"]})
    elif r["kind"] == "comment":
        p = conn.execute("SELECT cm.author, p.club_id, c.name FROM post_comments cm JOIN club_posts p ON p.id = cm.post_id "
                         "JOIN clubs c ON c.id = p.club_id WHERE cm.id=?", (r["target"],)).fetchone()
        if p:
            out.update(exists=True, author=_person_by_id(conn, p["author"], limits), club={"id": p["club_id"], "name": p["name"]})
    elif r["kind"] == "user":
        p = _person_by_id(conn, r["target"], limits)
        out.update(exists=bool(p), author=p)
    else:
        c = conn.execute("SELECT id, name FROM clubs WHERE id=?", (r["target"],)).fetchone()
        if c:
            owner = conn.execute("SELECT tg_id FROM club_members WHERE club_id=? AND role='owner'", (c["id"],)).fetchone()
            out.update(exists=True, club=dict(c), author=_person_by_id(conn, owner["tg_id"], limits) if owner else None)
    return out


@router.get("/reports")
def reports(status: str = "open", admin=Depends(admin_user)):
    with db.session() as conn:
        limits = _restrictions(conn)
        rows = conn.execute("SELECT * FROM reports WHERE (? = 'all' OR status=?) ORDER BY id DESC LIMIT 200", (status, status)).fetchall()
        return [_report_out(conn, r, limits) for r in rows]


class ResolveIn(BaseModel):
    status: str


@router.post("/reports/{report_id}")
def resolve_report(report_id: int, body: ResolveIn, admin=Depends(admin_user)):
    if body.status not in ("done", "dismissed", "open"):
        raise HTTPException(400, "Нет такого решения")
    with db.session() as conn:
        r = conn.execute("SELECT * FROM reports WHERE id=?", (report_id,)).fetchone()
        if not r:
            raise HTTPException(404, "Жалобы нет")
        # every open report on the same thing is settled together
        conn.execute("UPDATE reports SET status=?, resolved_at=? WHERE kind=? AND target=? AND status='open'",
                     (body.status, _now(), r["kind"], r["target"]))
        if body.status == "open":
            conn.execute("UPDATE reports SET status='open', resolved_at=NULL WHERE id=?", (report_id,))
    return {"ok": True}


@router.get("/profanity")
def profanity(admin=Depends(admin_user)):
    with db.session() as conn:
        limits = _restrictions(conn)
        return [{**dict(r), "who": _person_by_id(conn, r["tg_id"], limits)}
                for r in conn.execute("SELECT * FROM profanity_log ORDER BY id DESC LIMIT 150").fetchall()]


@router.get("/content")
def content(kind: str = "posts", before: int | None = None, admin=Depends(admin_user)):
    """The newest posts or comments across all clubs, to look through and delete."""
    with db.session() as conn:
        limits = _restrictions(conn)
        if kind == "comments":
            rows = conn.execute("SELECT cm.id, cm.body, cm.created_at, cm.author, cm.post_id, c.id AS club_id, c.name AS club "
                                "FROM post_comments cm JOIN club_posts p ON p.id = cm.post_id JOIN clubs c ON c.id = p.club_id "
                                "WHERE cm.id < ? ORDER BY cm.id DESC LIMIT ?", (before or 2 ** 62, PAGE + 1)).fetchall()
        else:
            rows = conn.execute("SELECT p.id, p.body, p.photo, p.public, p.created_at, p.author, c.id AS club_id, c.name AS club "
                                "FROM club_posts p JOIN clubs c ON c.id = p.club_id WHERE p.id < ? ORDER BY p.id DESC LIMIT ?",
                                (before or 2 ** 62, PAGE + 1)).fetchall()
        items = []
        for r in rows[:PAGE]:
            item = {**dict(r), "who": _person_by_id(conn, r["author"], limits)}
            if kind != "comments":
                item["photo_url"] = f"/posts/{r['photo']}.jpg" if r["photo"] else ""
            items.append(item)
        return {"items": items, "more": len(rows) > PAGE}


@router.delete("/posts/{post_id}")
def delete_post(post_id: int, admin=Depends(admin_user)):
    with db.session() as conn:
        p = conn.execute("SELECT p.*, c.name FROM club_posts p JOIN clubs c ON c.id = p.club_id WHERE p.id=?", (post_id,)).fetchone()
        if not p:
            raise HTTPException(404, "Записи уже нет")
        m._drop_post(conn, post_id)
        conn.execute("UPDATE reports SET status='done', resolved_at=? WHERE kind='post' AND target=? AND status='open'", (_now(), post_id))
        _journal(conn, f"Удалена запись в «{p['name']}»: «{(p['body'] or '[фото]')[:80]}»", _who(conn, p["author"]))
    if p["photo"]:
        (m.POSTS / f"{p['photo']}.jpg").unlink(missing_ok=True)
    return {"deleted": True}


@router.delete("/comments/{comment_id}")
def delete_comment(comment_id: int, admin=Depends(admin_user)):
    with db.session() as conn:
        cm = conn.execute("SELECT * FROM post_comments WHERE id=?", (comment_id,)).fetchone()
        if not cm:
            raise HTTPException(404, "Комментария уже нет")
        conn.execute("DELETE FROM post_comments WHERE id=?", (comment_id,))
        conn.execute("UPDATE reports SET status='done', resolved_at=? WHERE kind='comment' AND target=? AND status='open'", (_now(), comment_id))
        _journal(conn, f"Удалён комментарий: «{cm['body'][:80]}»", _who(conn, cm["author"]))
    return {"deleted": True}


# ---------- broadcasts ----------

def _recipients(conn, seg: dict) -> list[int]:
    sql = (f"SELECT tg_id FROM users WHERE real_name IS NOT NULL AND consent_at IS NOT NULL AND tg_id > 1 "
           f"AND tg_id NOT IN {m.BANNED}")
    args = []
    for key, col in (("faculty_id", "faculty_id"), ("course", "course"), ("group_id", "group_id")):
        if seg.get(key):
            sql += f" AND {col}=?"
            args.append(int(seg[key]))
    if seg.get("active"):
        sql += " AND tg_id IN (SELECT tg_id FROM activity WHERE day >= ?)"
        args.append((_today() - timedelta(days=int(seg["active"]) - 1)).isoformat())
    if seg.get("inactive"):
        sql += " AND tg_id NOT IN (SELECT tg_id FROM activity WHERE day >= ?)"
        args.append((_today() - timedelta(days=int(seg["inactive"]) - 1)).isoformat())
    return [r[0] for r in conn.execute(sql, args)]


def _segment_text(conn, seg: dict) -> str:
    parts = []
    if seg.get("faculty_id"):
        f = conn.execute("SELECT name FROM faculties WHERE id=?", (seg["faculty_id"],)).fetchone()
        parts.append(f["name"] if f else "направление")
    if seg.get("course"):
        parts.append(f"{seg['course']} курс")
    if seg.get("group_id"):
        g = conn.execute("SELECT name FROM groups WHERE id=?", (seg["group_id"],)).fetchone()
        parts.append(f"группа {g['name']}" if g else "группа")
    if seg.get("active"):
        parts.append(f"заходили за {seg['active']} дн.")
    if seg.get("inactive"):
        parts.append(f"не заходили {seg['inactive']} дн.")
    return " · ".join(parts) or "Все пользователи"


class BroadcastIn(BaseModel):
    body: str = Field(max_length=3500)
    segment: dict = {}
    button: bool = True
    send_at: str | None = None    # "2026-11-01T18:00", Moscow time; empty = now
    dry_run: bool = False


@router.get("/broadcasts")
def broadcasts(admin=Depends(admin_user)):
    with db.session() as conn:
        return [{**dict(r), "segment_text": _segment_text(conn, json.loads(r["segment"]))}
                for r in conn.execute("SELECT * FROM broadcasts ORDER BY id DESC LIMIT 50").fetchall()]


@router.post("/broadcasts")
def create_broadcast(body: BroadcastIn, admin=Depends(admin_user)):
    seg = {k: v for k, v in body.segment.items() if k in ("faculty_id", "course", "group_id", "active", "inactive") and v}
    with db.session() as conn:
        count = len(_recipients(conn, seg))
        if body.dry_run:
            return {"count": count, "segment_text": _segment_text(conn, seg)}
        text = body.body.strip()
        if not text:
            raise HTTPException(400, "Напишите текст рассылки")
        if not count:
            raise HTTPException(400, "Под эти условия никто не подходит")
        if body.send_at:
            try:
                at = datetime.fromisoformat(body.send_at).replace(tzinfo=m.MSK).astimezone(timezone.utc)
            except ValueError:
                raise HTTPException(400, "Не понял время отправки")
        else:
            at = datetime.now(timezone.utc)
        cur = conn.execute("INSERT INTO broadcasts(body, segment, button, send_at, total) VALUES(?, ?, ?, ?, ?)",
                           (text, json.dumps(seg), int(body.button), at.isoformat(timespec="seconds"), count))
        _journal(conn, f"Рассылка #{cur.lastrowid} ({count} чел.): «{text[:60]}»", _segment_text(conn, seg))
    return broadcasts(admin)


@router.post("/broadcasts/{bid}/cancel")
def cancel_broadcast(bid: int, admin=Depends(admin_user)):
    with db.session() as conn:
        if not conn.execute("UPDATE broadcasts SET status='cancelled', finished_at=? WHERE id=? AND status IN ('scheduled', 'sending')",
                            (_now(), bid)).rowcount:
            raise HTTPException(409, "Эту рассылку уже не остановить")
        _journal(conn, f"Рассылка #{bid} отменена")
    return broadcasts(admin)


async def _send_due_broadcast():
    if not m.bot:
        return
    with db.session() as conn:
        b = conn.execute("SELECT * FROM broadcasts WHERE status='scheduled' AND send_at <= ? ORDER BY send_at LIMIT 1",
                         (_now(),)).fetchone()
        if not b:
            return
        ids = _recipients(conn, json.loads(b["segment"]))
        conn.execute("UPDATE broadcasts SET status='sending', total=? WHERE id=?", (len(ids), b["id"]))
    extra = {"reply_markup": m.bot.open_button()} if b["button"] and m.bot.webapp_url else {}
    sent = failed = 0
    cancelled = False
    for i, tg_id in enumerate(ids):
        try:
            await m.bot.call("sendMessage", chat_id=tg_id, text=b["body"], **extra)
            sent += 1
        except Exception:
            failed += 1   # blocked the bot, or never started it
        if i % 20 == 19:
            with db.session() as conn:
                conn.execute("UPDATE broadcasts SET sent=?, failed=? WHERE id=?", (sent, failed, b["id"]))
                cancelled = conn.execute("SELECT status FROM broadcasts WHERE id=?", (b["id"],)).fetchone()[0] == "cancelled"
            if cancelled:
                break
        await asyncio.sleep(0.05)   # well under Telegram's 30 messages a second
    with db.session() as conn:
        conn.execute("UPDATE broadcasts SET sent=?, failed=?, status=CASE status WHEN 'cancelled' THEN 'cancelled' ELSE 'done' END, "
                     "finished_at=? WHERE id=?", (sent, failed, _now(), b["id"]))
    await alert(f"Рассылка #{b['id']} {'остановлена' if cancelled else 'завершена'}: доставлено {sent} из {len(ids)}"
                + (f", не дошло {failed}" if failed else ""))


async def broadcast_loop():
    while True:
        await asyncio.sleep(15)
        try:
            await _send_due_broadcast()
        except Exception as e:
            log.warning("broadcast: %s", e)


# ---------- schedule and server ----------

_syncing = {"all": False}


@router.get("/schedule")
def schedule(admin=Depends(admin_user)):
    today = _today().isoformat()
    with db.session() as conn:
        groups = [dict(r) for r in conn.execute(
            "SELECT g.id, g.name, g.course, g.synced_at, g.sync_error, f.name AS faculty, f.is_master AS master, "
            "(SELECT COUNT(*) FROM users u WHERE u.group_id = g.id AND u.consent_at IS NOT NULL) AS students, "
            "(SELECT COUNT(*) FROM lessons l WHERE l.group_id = g.id AND l.date >= ?) AS lessons "
            "FROM groups g JOIN faculties f ON f.id = g.faculty_id ORDER BY g.sync_error IS NULL, f.is_master, f.sort, g.course, g.name",
            (today,))]
        changes = [{**dict(r), "details": json.loads(r["details"])} for r in conn.execute(
            "SELECT s.*, g.name AS group_name FROM schedule_changes s LEFT JOIN groups g ON g.id = s.group_id "
            "ORDER BY s.id DESC LIMIT 60")]
        return {"all_synced_at": db.get_meta(conn, "all_synced_at"), "catalog_synced_at": db.get_meta(conn, "catalog_synced_at"),
                "syncing": _syncing["all"], "groups": groups, "changes": changes}


class SyncIn(BaseModel):
    group_id: int | None = None


async def _sync_everything():
    _syncing["all"] = True
    try:
        await scraper.sync_all()
    except Exception as e:
        log.warning("manual full sync failed: %s", e)
    finally:
        _syncing["all"] = False


@router.post("/schedule/sync")
async def force_sync(body: SyncIn, admin=Depends(admin_user)):
    """One group right now (the answer waits for it), or every group in the background."""
    if body.group_id:
        await m._refresh_group(body.group_id)
        with db.session() as conn:
            g = conn.execute("SELECT name, sync_error FROM groups WHERE id=?", (body.group_id,)).fetchone()
            _journal(conn, "Обновлено расписание группы", g["name"] if g else str(body.group_id))
        if g and g["sync_error"]:
            raise HTTPException(502, f"Сайт расписания не ответил: {g['sync_error']}")
        return schedule(admin)
    if not _syncing["all"]:
        asyncio.create_task(_sync_everything())
        with db.session() as conn:
            _journal(conn, "Запущено обновление расписания всех групп")
    return schedule(admin)


def _dir_size(path: Path) -> tuple[int, int]:
    files = [p for p in path.glob("*") if p.is_file()] if path.exists() else []
    return sum(p.stat().st_size for p in files), len(files)


def _app_version() -> str:
    try:
        text = (m.ROOT / "webapp" / "app.js").read_text(encoding="utf-8")
        found = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', text)
        return found.group(1) if found else ""
    except OSError:
        return ""


@router.get("/server")
def server(admin=Depends(admin_user)):
    data = m.ROOT / "data"
    disk = shutil.disk_usage(data)
    mem = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, v = line.split(":", 1)
            if k in ("MemTotal", "MemAvailable"):
                mem[k] = int(v.split()[0]) * 1024
    except OSError:
        pass
    try:
        boot = float(Path("/proc/uptime").read_text().split()[0])
    except OSError:
        boot = None
    backups = sorted(m.BACKUPS.glob("msu-*.sqlite3")) if m.BACKUPS.exists() else []
    db_size = sum(p.stat().st_size for p in data.glob("msu.sqlite3*") if p.is_file())
    avatars, posts = _dir_size(m.AVATARS), _dir_size(m.POSTS)
    with db.session() as conn:
        tables = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                  for t in ("users", "lessons", "club_posts", "post_comments", "notifications", "reminders", "activity")}
        broken = conn.execute("SELECT COUNT(*) FROM groups WHERE sync_error IS NOT NULL").fetchone()[0]
    return {
        "version": _app_version(), "python": sys.version.split()[0],
        "app_uptime": int(time.time() - STARTED), "system_uptime": int(boot) if boot else None,
        "load": os.getloadavg() if hasattr(os, "getloadavg") else None,
        "memory": {"total": mem.get("MemTotal"), "available": mem.get("MemAvailable")},
        "disk": {"total": disk.total, "free": disk.free},
        "db_size": db_size, "avatars": {"bytes": avatars[0], "files": avatars[1]}, "posts": {"bytes": posts[0], "files": posts[1]},
        "backups": [{"name": b.name, "size": b.stat().st_size,
                     "at": datetime.fromtimestamp(b.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")}
                    for b in reversed(backups[-6:])],
        "bot": bool(m.bot and m.bot.username), "bot_name": m.bot.username if m.bot else None,
        "crm_bot": bool(crm and crm.username), "broken_groups": broken, "tables": tables,
    }


# ---------- settings without a deploy ----------

class ConfigIn(BaseModel):
    semester: dict | None = None
    features: dict | None = None
    banner: str | None = Field(None, max_length=300)


@router.get("/config")
def get_config(admin=Depends(admin_user)):
    with db.session() as conn:
        return {**m.app_config(conn), "labels": m.FEATURES}


@router.post("/config")
def set_config(body: ConfigIn, admin=Depends(admin_user)):
    with db.session() as conn:
        prev = db.get_meta(conn, "app_config")
        cfg = json.loads(prev or "{}")
        said = []
        if body.semester is not None:
            sem = {}
            for k in ("start", "session"):
                try:
                    sem[k] = date.fromisoformat(body.semester.get(k, "")).isoformat()
                except ValueError:
                    raise HTTPException(400, "Даты семестра указаны неверно")
            if sem["start"] >= sem["session"]:
                raise HTTPException(400, "Сессия должна начинаться позже семестра")
            cfg["semester"] = sem
            said.append(f"семестр {sem['start']} – {sem['session']}")
        if body.features is not None:
            feats = cfg.get("features", {})
            for k, v in body.features.items():
                if k in m.FEATURES:
                    feats[k] = bool(v)
                    said.append(f"{m.FEATURES[k].lower()}: {'вкл' if v else 'выкл'}")
            cfg["features"] = feats
        if body.banner is not None:
            cfg["banner"] = m._clean_line(body.banner)
            said.append(f"баннер «{cfg['banner']}»" if cfg["banner"] else "баннер убран")
        db.set_meta(conn, "app_config", json.dumps(cfg, ensure_ascii=False))
        if said:
            _journal(conn, "Настройки: " + ", ".join(said), "", {"type": "config", "prev": prev})
        return {**m.app_config(conn), "labels": m.FEATURES}


# ---------- messages to the developer ----------

@router.get("/feedback")
def feedback(admin=Depends(admin_user)):
    with db.session() as conn:
        limits = _restrictions(conn)
        rows = [{**dict(r), "who": _person_by_id(conn, r["tg_id"], limits)}
                for r in conn.execute("SELECT * FROM feedback ORDER BY id DESC LIMIT 200").fetchall()]
        conn.execute("UPDATE feedback SET read_at=? WHERE read_at IS NULL", (_now(),))
    return rows


class ReplyIn(BaseModel):
    text: str = Field(max_length=3500)


@router.post("/feedback/{fid}/reply")
async def reply(fid: int, body: ReplyIn, admin=Depends(admin_user)):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Напишите ответ")
    with db.session() as conn:
        f = conn.execute("SELECT * FROM feedback WHERE id=?", (fid,)).fetchone()
    if not f:
        raise HTTPException(404, "Сообщения нет")
    await _send_from_app_bot(f["tg_id"], f"Ответ разработчика на ваше сообщение:\n«{f['body'][:300]}»\n\n{text}")
    with db.session() as conn:
        conn.execute("UPDATE feedback SET reply=?, replied_at=? WHERE id=?", (text, _now(), fid))
        _journal(conn, f"Ответ на сообщение: «{text[:80]}»", _who(conn, f["tg_id"]))
    return feedback(admin)


# ---------- the journal ----------

@router.get("/log")
def journal(admin=Depends(admin_user)):
    with db.session() as conn:
        return [{"id": r["id"], "at": r["at"], "action": r["action"], "target": r["target"],
                 "can_undo": bool(r["undo"]) and not r["undone_at"], "undone_at": r["undone_at"]}
                for r in conn.execute("SELECT * FROM admin_log ORDER BY id DESC LIMIT 300").fetchall()]


@router.post("/log/{entry_id}/undo")
def undo(entry_id: int, admin=Depends(admin_user)):
    with db.session() as conn:
        e = conn.execute("SELECT * FROM admin_log WHERE id=?", (entry_id,)).fetchone()
        if not e or not e["undo"] or e["undone_at"]:
            raise HTTPException(409, "Это действие нельзя отменить")
        u = json.loads(e["undo"])
        if u["type"] == "restrict":
            _set_restriction(conn, u["tg_id"], u["kind"], u["prev"])
        elif u["type"] == "profile":
            conn.execute(f"UPDATE users SET {u['field']}=? WHERE tg_id=?", (u["prev"], u["tg_id"]))
        elif u["type"] == "club":
            if not conn.execute("SELECT 1 FROM clubs WHERE id=?", (u["id"],)).fetchone():
                raise HTTPException(409, "Клуба уже нет")
            fields = u["fields"]
            conn.execute(f"UPDATE clubs SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?", (*fields.values(), u["id"]))
        elif u["type"] == "owner":
            _make_owner(conn, u["id"], u["prev"])
        elif u["type"] == "config":
            db.set_meta(conn, "app_config", u["prev"] or "{}")
        conn.execute("UPDATE admin_log SET undone_at=? WHERE id=?", (_now(), entry_id))
        _journal(conn, f"Отменено: {e['action']}", e["target"])
    return journal(admin)


# ---------- the CRM bot: the way in and the alerts ----------

class CrmBot:
    def __init__(self, token: str):
        self.api = f"https://api.telegram.org/bot{token}"
        self.client = httpx.AsyncClient(timeout=40)
        self.username = None

    async def call(self, method, **params):
        r = await self.client.post(f"{self.api}/{method}", json=params)
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError(f"{method}: {data.get('description')}")
        return data["result"]

    async def setup(self):
        self.username = (await self.call("getMe")).get("username")
        await self.call("setMyCommands", commands=[{"command": "start", "description": "Открыть панель"}])
        log.info("CRM bot @%s", self.username)
        chat = _admin_chat()
        if chat:
            await self._menu(chat)

    async def _menu(self, chat: int):
        await self.call("setChatMenuButton", chat_id=chat, menu_button={
            "type": "web_app", "text": "Панель", "web_app": {"url": CRM_URL}})

    async def poll(self):
        offset = 0
        while True:
            try:
                for u in await self.call("getUpdates", offset=offset, timeout=30, allowed_updates=["message"]):
                    offset = u["update_id"] + 1
                    await self.handle(u.get("message") or {})
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("CRM polling: %s", e)
                await asyncio.sleep(5)

    async def handle(self, msg):
        chat = msg.get("chat", {}).get("id")
        if not chat or msg.get("chat", {}).get("type") != "private":
            return
        if not _is_admin(msg.get("from", {})):
            await self.call("sendMessage", chat_id=chat, text="Это служебный бот. Доступ закрыт.")
            return
        await self._menu(chat)
        await self.call("sendMessage", chat_id=chat, text=(
            "Панель администратора «Расписания».\nСюда же приходят уведомления: жалобы, сообщения разработчику, "
            "сбои резервной копии и расписания."),
            reply_markup={"inline_keyboard": [[{"text": "Открыть панель", "web_app": {"url": CRM_URL}}]]})


_said: dict[str, float] = {}


async def alert(text: str):
    """A note to the admin in the CRM bot; the same note at most once in ten minutes."""
    chat = _admin_chat()
    if not crm or not chat:
        return
    now = time.time()
    if now - _said.get(text, 0) < 600:
        return
    _said[text] = now
    try:
        await crm.call("sendMessage", chat_id=chat, text=text[:4000],
                       reply_markup={"inline_keyboard": [[{"text": "Открыть панель", "web_app": {"url": CRM_URL}}]]})
    except Exception as e:
        log.warning("CRM alert not sent: %s", e)


async def start() -> list:
    """Run from the app's lifespan: the broadcasts, and the CRM bot when it has a token. A broadcast the
    server was stopped in the middle of is closed with what it managed."""
    global crm
    with db.session() as conn:
        conn.execute("UPDATE broadcasts SET status='done', finished_at=? WHERE status='sending'", (_now(),))
    tasks = [asyncio.create_task(broadcast_loop())]
    if CRM_BOT_TOKEN:
        crm = CrmBot(CRM_BOT_TOKEN)
        try:
            await crm.setup()
            tasks.append(asyncio.create_task(crm.poll()))
        except Exception as e:
            log.warning("CRM bot setup failed: %s", e)
    return tasks
