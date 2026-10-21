"""SQLite storage: faculties, groups, lessons and Telegram-bound users."""
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "msu.sqlite3"

SCHEMA = """
CREATE TABLE IF NOT EXISTS faculties (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    is_master   INTEGER NOT NULL DEFAULT 0,
    sort        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    faculty_id  INTEGER NOT NULL REFERENCES faculties(id),
    course      INTEGER NOT NULL,
    synced_at   TEXT
);
CREATE TABLE IF NOT EXISTS lessons (
    group_id    INTEGER NOT NULL REFERENCES groups(id),
    date        TEXT NOT NULL,          -- ISO yyyy-mm-dd
    pair        INTEGER NOT NULL,
    start       TEXT NOT NULL,          -- HH:MM
    end         TEXT NOT NULL,
    subject     TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT '',
    room        TEXT NOT NULL DEFAULT '',
    teacher     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (group_id, date, pair, subject, teacher)
);
CREATE INDEX IF NOT EXISTS lessons_by_group_date ON lessons(group_id, date);
CREATE TABLE IF NOT EXISTS users (
    tg_id       INTEGER PRIMARY KEY,
    tg_first    TEXT NOT NULL DEFAULT '',
    tg_last     TEXT NOT NULL DEFAULT '',
    username    TEXT NOT NULL DEFAULT '',
    photo_url   TEXT NOT NULL DEFAULT '',
    real_name   TEXT,
    faculty_id  INTEGER REFERENCES faculties(id),
    course      INTEGER,
    group_id    INTEGER REFERENCES groups(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id       INTEGER NOT NULL REFERENCES users(tg_id),
    date        TEXT NOT NULL,          -- ISO yyyy-mm-dd
    start       TEXT NOT NULL,          -- HH:MM, Moscow time
    end         TEXT NOT NULL,
    subject     TEXT NOT NULL,
    room        TEXT NOT NULL DEFAULT '',
    remind_at   TEXT NOT NULL,          -- UTC ISO
    sent_at     TEXT,
    UNIQUE (tg_id, date, start, subject)
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(sent_at, remind_at);
CREATE TABLE IF NOT EXISTS open_buttons (
    chat_id     INTEGER NOT NULL,       -- the bot's messages carrying an "open the app" button
    message_id  INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS meta (
    key         TEXT PRIMARY KEY,
    value       TEXT
);
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def session():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# columns added after the first release; init() adds whichever an existing database lacks
MIGRATIONS = {
    "users": [
        ("remind_all", "INTEGER NOT NULL DEFAULT 0"),    # bot reminds about every pair
        ("remind_lead", "INTEGER NOT NULL DEFAULT 10"),  # minutes before the pair
        ("digest_time", "TEXT"),                         # HH:MM of the morning summary, NULL = off
        ("digest_sent_on", "TEXT"),                      # ISO date of the last summary sent
        ("cal_token", "TEXT"),                           # secret of the calendar subscription link
    ],
    "reminders": [
        ("lead", "INTEGER NOT NULL DEFAULT 10"),
        ("auto", "INTEGER NOT NULL DEFAULT 0"),          # made by "remind about every pair"
    ],
}


def init() -> None:
    with session() as conn:
        conn.executescript(SCHEMA)
        for table, columns in MIGRATIONS.items():
            have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            for name, decl in columns:
                if name not in have:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn, key, value):
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
