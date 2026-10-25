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
CREATE TABLE IF NOT EXISTS friendships (
    requester   INTEGER NOT NULL REFERENCES users(tg_id),
    addressee   INTEGER NOT NULL REFERENCES users(tg_id),
    status      TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (requester, addressee)
);
CREATE INDEX IF NOT EXISTS friendships_by_addressee ON friendships(addressee, status);
CREATE TABLE IF NOT EXISTS flame_taps (
    tapper      INTEGER NOT NULL REFERENCES users(tg_id),  -- who pressed the flame
    friend      INTEGER NOT NULL REFERENCES users(tg_id),  -- on whose row
    day         TEXT NOT NULL,                             -- ISO date, Moscow time
    PRIMARY KEY (tapper, friend, day)
);
CREATE TABLE IF NOT EXISTS clubs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    about       TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL DEFAULT 'other',
    visibility  TEXT NOT NULL DEFAULT 'public',    -- public | friends (the owner's) | invite
    chat_url    TEXT,                               -- the club's Telegram chat, shown to members as a button
    avatar      TEXT,                               -- file name (no extension) of the club photo in data/avatars
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS club_members (
    club_id     INTEGER NOT NULL REFERENCES clubs(id),
    tg_id       INTEGER NOT NULL REFERENCES users(tg_id),
    role        TEXT NOT NULL DEFAULT 'member',                -- owner | admin | member
    joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (club_id, tg_id)
);
CREATE INDEX IF NOT EXISTS club_members_by_user ON club_members(tg_id);
CREATE TABLE IF NOT EXISTS club_posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id     INTEGER NOT NULL REFERENCES clubs(id),
    author      INTEGER NOT NULL REFERENCES users(tg_id),
    body        TEXT NOT NULL DEFAULT '',
    photo       TEXT,                                          -- file name (no extension) in data/posts
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS club_posts_by_club ON club_posts(club_id, id);
CREATE TABLE IF NOT EXISTS post_reactions (
    post_id     INTEGER NOT NULL REFERENCES club_posts(id),
    tg_id       INTEGER NOT NULL REFERENCES users(tg_id),
    emoji       TEXT NOT NULL,
    PRIMARY KEY (post_id, tg_id)                               -- one reaction per member per post
);
CREATE TABLE IF NOT EXISTS post_comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id     INTEGER NOT NULL REFERENCES club_posts(id),
    author      INTEGER NOT NULL REFERENCES users(tg_id),
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS post_comments_by_post ON post_comments(post_id, id);
CREATE TABLE IF NOT EXISTS club_invites (
    club_id     INTEGER NOT NULL REFERENCES clubs(id),
    invitee     INTEGER NOT NULL REFERENCES users(tg_id),
    inviter     INTEGER NOT NULL REFERENCES users(tg_id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (club_id, invitee)
);
CREATE TABLE IF NOT EXISTS club_requests (
    club_id     INTEGER NOT NULL REFERENCES clubs(id),
    tg_id       INTEGER NOT NULL REFERENCES users(tg_id),     -- asks to join a club that takes members by request
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (club_id, tg_id)
);
CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id       INTEGER NOT NULL REFERENCES users(tg_id),     -- who gets it
    kind        TEXT NOT NULL,                                -- friend_request, club_post, comment, ...
    actor       INTEGER,                                      -- who did it
    club_id     INTEGER,
    post_id     INTEGER,
    text        TEXT NOT NULL DEFAULT '',                     -- a short preview of a post or comment
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    read_at     TEXT
);
CREATE INDEX IF NOT EXISTS notifications_by_user ON notifications(tg_id, id);
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
        ("nickname", "TEXT"),                            # the name friends see, NULL = the real name
        ("avatar", "TEXT"),                              # file name (no extension) of an uploaded photo in data/avatars
        ("bio", "TEXT"),                                 # a few words about oneself, seen by friends and club members
        ("show_club", "INTEGER NOT NULL DEFAULT 0"),     # friends see your club next to your name; off until you turn it on
    ],
    "club_posts": [
        ("comments_off", "INTEGER NOT NULL DEFAULT 0"),  # the author closed the post to comments
        ("public", "INTEGER NOT NULL DEFAULT 0"),        # anyone who may open the club reads it, not just members
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
        _many_clubs_each(conn)


def _many_clubs_each(conn) -> None:
    """club_members was first keyed by the student alone (one club each); now by club and student.
    SQLite cannot change a primary key, so the table is rebuilt with its rows."""
    key = [r["name"] for r in sorted(conn.execute("PRAGMA table_info(club_members)"), key=lambda r: r["pk"]) if r["pk"]]
    if key != ["tg_id"]:
        return
    conn.executescript("""
        CREATE TABLE club_members_new (
            club_id     INTEGER NOT NULL REFERENCES clubs(id),
            tg_id       INTEGER NOT NULL REFERENCES users(tg_id),
            role        TEXT NOT NULL DEFAULT 'member',
            joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (club_id, tg_id)
        );
        INSERT INTO club_members_new(club_id, tg_id, role, joined_at) SELECT club_id, tg_id, role, joined_at FROM club_members;
        DROP TABLE club_members;
        ALTER TABLE club_members_new RENAME TO club_members;
        CREATE INDEX IF NOT EXISTS club_members_by_user ON club_members(tg_id);
    """)


def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn, key, value):
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
