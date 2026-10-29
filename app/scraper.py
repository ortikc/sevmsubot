"""Scraper for https://raspisanie.sev.msu.ru/time-table/group (faculty -> course -> group form)."""
import asyncio
import logging
import json
import re
from datetime import date, datetime, timedelta, timezone

import httpx
from bs4 import BeautifulSoup

from . import db

log = logging.getLogger("scraper")

BASE = "https://raspisanie.sev.msu.ru"
FORM_URL = f"{BASE}/time-table/group?type=0"
HEADERS = {"User-Agent": "MSU-Sevastopol-MiniApp/0.1 (+student schedule bot)"}
POLITE_DELAY = 0.4  # seconds between requests to the university site

MASTER_PREFIX = "Маг_"
MSK = timezone(timedelta(hours=3))  # Sevastopol keeps Moscow time
WEEKS_AHEAD = 5                      # the current week plus four more


def week_window(today: date | None = None):
    """From this week's Monday to the end of the window. The site hides past days unless asked for them
    with dateStart, so we always ask from Monday: the whole current week stays in the database."""
    today = today or datetime.now(MSK).date()
    monday = today - timedelta(days=today.weekday())
    return monday, monday + timedelta(days=7 * WEEKS_AHEAD - 1)


class Session:
    """Keeps cookies and the rotating CSRF token the Yii form requires."""

    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self.token = None

    async def open(self):
        r = await self.client.get(FORM_URL)
        r.raise_for_status()
        self._take_token(r.text)
        return r.text

    def _take_token(self, html):
        m = re.search(r'name="_csrf-frontend" value="([^"]+)"', html)
        if m:
            self.token = m.group(1)

    async def post(self, faculty_id="", course="", group_id="", extra=None):
        if self.token is None:
            await self.open()
        data = {
            "_csrf-frontend": self.token,
            "TimeTableForm[facultyId]": str(faculty_id),
            "TimeTableForm[course]": str(course),
            "TimeTableForm[groupId]": str(group_id),
        }
        if extra:
            data.update(extra)
        await asyncio.sleep(POLITE_DELAY)
        r = await self.client.post(FORM_URL, data=data)
        r.raise_for_status()
        self._take_token(r.text)
        return r.text


def _options(html, select_id):
    soup = BeautifulSoup(html, "html.parser")
    sel = soup.find("select", id=select_id)
    if not sel:
        return []
    out = []
    for opt in sel.find_all("option"):
        value = (opt.get("value") or "").strip()
        if value:
            out.append((value, opt.get_text(strip=True)))
    return out


def _clean_faculty(name):
    is_master = name.startswith(MASTER_PREFIX)
    return (name[len(MASTER_PREFIX):] if is_master else name).strip(), is_master


def parse_timetable(html):
    """Return a list of lesson dicts from the timetable table."""
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", id="timeTable")
    if not table:
        return []
    lessons = []
    for tr in table.find_all("tr"):
        head = tr.find("th", class_="headcol")
        if not head:
            continue
        pair_txt = head.find("span", class_="lesson")
        start = head.find("span", class_="start")
        end = head.find("span", class_="end")
        if not (pair_txt and start and end):
            continue
        m = re.search(r"\d+", pair_txt.get_text())
        pair = int(m.group()) if m else 0
        for pop in tr.find_all(attrs={"data-toggle": "popover"}):
            title = pop.get("title", "")
            dm = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", title)
            if not dm:
                continue
            date = f"{dm.group(3)}-{dm.group(2)}-{dm.group(1)}"
            parts = [p.strip() for p in re.split(r"<br\s*/?>", pop.get("data-content", ""))]
            parts = [BeautifulSoup(p, "html.parser").get_text(" ", strip=True) for p in parts]
            if not parts:
                continue
            km = re.match(r"^(.*?)\s*\[(.*?)\]\s*$", parts[0])
            subject, kind = (km.group(1), km.group(2)) if km else (parts[0], "")
            if not subject.strip():
                continue  # "Отмена с …" placeholders carry no lesson
            rest = [p for p in parts[1:] if p and not re.match(r"^(Добавлено|Изменено)", p)]
            room = ""
            if rest and rest[0].lower().startswith("ауд"):
                room = re.sub(r"^ауд\.?\s*", "", rest.pop(0), flags=re.I).strip()
            teacher = rest[-1] if len(rest) >= 2 else ""
            lessons.append({
                "date": date,
                "pair": pair,
                "start": start.get_text(strip=True),
                "end": end.get_text(strip=True),
                "subject": subject.strip(),
                "kind": kind.strip(),
                "room": room,
                "teacher": teacher,
            })
    return lessons


def _client():
    return httpx.AsyncClient(headers=HEADERS, timeout=30, follow_redirects=True)


async def sync_catalog():
    """Faculties, courses and groups."""
    async with _client() as client:
        s = Session(client)
        html = await s.open()
        faculties = [(fid, name) for fid, name in _options(html, "timetableform-facultyid")
                     if name.strip(" .")]
        found_groups = []
        for fid, _ in faculties:
            courses = _options(await s.post(fid), "timetableform-course")
            for course, _ in courses:
                groups = _options(await s.post(fid, course), "timetableform-groupid")
                found_groups += [(int(gid), gname, int(fid), int(course)) for gid, gname in groups]
    with db.session() as conn:
        for sort, (fid, name) in enumerate(faculties):
            clean, is_master = _clean_faculty(name)
            conn.execute(
                "INSERT INTO faculties(id, name, is_master, sort) VALUES(?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET name=excluded.name, is_master=excluded.is_master, sort=excluded.sort",
                (int(fid), clean, int(is_master), sort),
            )
        for gid, gname, fid, course in found_groups:
            conn.execute(
                "INSERT INTO groups(id, name, faculty_id, course) VALUES(?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET name=excluded.name, faculty_id=excluded.faculty_id, course=excluded.course",
                (gid, gname, fid, course),
            )
        db.set_meta(conn, "catalog_synced_at", _now())
    log.info("catalog: %d faculties, %d groups", len(faculties), len(found_groups))
    return len(found_groups)


async def sync_group(group_id: int, client=None):
    """One group's visible weeks from the site. A failure is noted on the group (the admin panel shows it)
    and raised on; a success clears the note."""
    try:
        count = await _sync_group(group_id, client)
    except Exception as e:
        with db.session() as conn:
            conn.execute("UPDATE groups SET sync_error=? WHERE id=?", (f"{type(e).__name__}: {e}"[:300], group_id))
        raise
    with db.session() as conn:
        conn.execute("UPDATE groups SET sync_error=NULL WHERE id=?", (group_id,))
    return count


def _lesson_line(sign, date_iso, start, subject, room):
    d = date_iso.split("-")
    return f"{sign} {d[2]}.{d[1]} {start} {subject}" + (f" (ауд. {room})" if room else "")


def _note_changes(conn, group_id, window, lessons):
    """What changed on the days the group already had in the base, for the admin panel's log. A week that
    shows up for the first time is not a change, so only days up to the last one already known are compared."""
    if not window:
        return
    marks = ",".join("?" * len(window))
    old = {(r["date"], r["start"], r["subject"], r["room"]) for r in conn.execute(
        f"SELECT date, start, subject, room FROM lessons WHERE group_id=? AND date IN ({marks})", (group_id, *window))}
    if not old:
        return
    known_until = max(d for d, *_ in old)
    new = {(l["date"], l["start"], l["subject"], l["room"]) for l in lessons if l["date"] <= known_until}
    old = {x for x in old if x[0] <= known_until}
    added, removed = sorted(new - old), sorted(old - new)
    if not added and not removed:
        return
    details = [_lesson_line("−", *x) for x in removed[:6]] + [_lesson_line("+", *x) for x in added[:6]]
    conn.execute("INSERT INTO schedule_changes(group_id, added, removed, details) VALUES(?, ?, ?, ?)",
                 (group_id, len(added), len(removed), json.dumps(details, ensure_ascii=False)))
    conn.execute("DELETE FROM schedule_changes WHERE id <= (SELECT MAX(id) FROM schedule_changes) - 2000")


async def _sync_group(group_id: int, client=None):
    with db.session() as conn:
        g = conn.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    if not g:
        raise ValueError(f"unknown group {group_id}")
    own = client is None
    client = client or _client()
    monday, last = week_window()
    try:
        s = Session(client)
        await s.open()
        html = await s.post(g["faculty_id"], g["course"], g["id"], extra={
            "TimeTableForm[dateStart]": monday.strftime("%d.%m.%Y"),
            "TimeTableForm[dateEnd]": last.strftime("%d.%m.%Y"),
        })
    finally:
        if own:
            await client.aclose()
    lessons = parse_timetable(html)
    dates = sorted({l["date"] for l in lessons})
    # the visible window: replace every date the site showed with what it shows now
    window = _visible_dates(html) or dates
    with db.session() as conn:
        _note_changes(conn, group_id, window, lessons)
        if window:
            conn.execute(
                f"DELETE FROM lessons WHERE group_id=? AND date IN ({','.join('?' * len(window))})",
                (group_id, *window),
            )
        conn.executemany(
            "INSERT OR REPLACE INTO lessons(group_id, date, pair, start, end, subject, kind, room, teacher) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            [(group_id, l["date"], l["pair"], l["start"], l["end"], l["subject"], l["kind"], l["room"], l["teacher"])
             for l in lessons],
        )
        conn.execute("UPDATE groups SET synced_at=? WHERE id=?", (_now(), group_id))
        # last week is over: it goes as a whole, never day by day
        conn.execute("DELETE FROM lessons WHERE group_id=? AND date < ?", (group_id, monday.isoformat()))
    return len(lessons)


def prune_past_weeks():
    """Lessons and sent reminders from before this week's Monday."""
    monday, _ = week_window()
    with db.session() as conn:
        lessons = conn.execute("DELETE FROM lessons WHERE date < ?", (monday.isoformat(),)).rowcount
        reminders = conn.execute(
            "DELETE FROM reminders WHERE sent_at IS NOT NULL AND date < ?", (monday.isoformat(),)).rowcount
    if lessons or reminders:
        log.info("pruned %d lessons and %d reminders from past weeks", lessons, reminders)


def _visible_dates(html):
    """Dates of open (not past) columns: past columns are rendered as td.closed."""
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", id="timeTable")
    if not table:
        return []
    out = set()
    rows = table.find_all("tr")
    for i, tr in enumerate(rows):
        if not tr.find("th", class_="headday"):
            continue
        dates = []
        for th in tr.find_all("th", class_="headdate"):
            m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", th.get_text())
            dates.append(f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None)
        nxt = rows[i + 1] if i + 1 < len(rows) else None
        tds = nxt.find_all("td") if nxt else []
        for d, td in zip(dates, tds):
            if d and "closed" not in (td.get("class") or []):
                out.add(d)
    return sorted(out)


async def sync_all():
    prune_past_weeks()
    await sync_catalog()
    with db.session() as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM groups ORDER BY faculty_id, course, name")]
    ok = 0
    async with _client() as client:
        for gid in ids:
            try:
                await sync_group(gid, client)
                ok += 1
            except Exception as e:  # keep going: one broken group must not stop the rest
                log.warning("group %s failed: %s", gid, e)
    with db.session() as conn:
        db.set_meta(conn, "all_synced_at", _now())
    log.info("synced %d/%d groups", ok, len(ids))


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
