"""Scraper for https://raspisanie.sev.msu.ru/time-table/group (faculty -> course -> group form)."""
import asyncio
import logging
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
