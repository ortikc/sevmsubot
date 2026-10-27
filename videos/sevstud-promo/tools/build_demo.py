"""A demo base for the promo video: the real public schedule, invented students, clubs and posts.
python build_demo.py <demo dir>   (the real base is only read)"""
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

demo = Path(sys.argv[1])
sys.path.insert(0, str(demo))
from app import db  # noqa: E402  (the demo copy: its DB_PATH is <demo>/data/msu.sqlite3)
from app.main import CONSENT_VERSION  # noqa: E402

REAL = "file:C:/Users/Строновка/msu/data/msu.sqlite3?mode=ro"
TODAY = date(2026, 10, 27)
db.DB_PATH.unlink(missing_ok=True)
db.init()
c = db.connect()
real = sqlite3.connect(REAL, uri=True)
for t in ("faculties", "groups", "lessons", "meta"):
    rows = real.execute(f"SELECT * FROM {t}").fetchall()
    if rows:
        c.executemany(f"INSERT INTO {t} VALUES({','.join('?' * len(rows[0]))})", rows)
c.commit()
real.close()

# groups with a full Tuesday, the busiest first
groups = c.execute("SELECT g.id, g.name, g.course, g.faculty_id, f.name AS fac, count(*) n FROM lessons l "
                   "JOIN groups g ON g.id=l.group_id JOIN faculties f ON f.id=g.faculty_id "
                   "WHERE l.date=? AND f.is_master=0 GROUP BY g.id ORDER BY n DESC", (TODAY.isoformat(),)).fetchall()
print("busiest Tuesday:", [(g["name"], g["fac"], g["n"]) for g in groups[:6]])
mine = next((g for g in groups if 3 <= g["n"] <= 5), groups[0])
others = [g for g in groups if g["id"] != mine["id"]][:6]

people = [  # tg_id, first, last, group
    (1, "Анна", "Ковалёва", mine), (101, "Максим", "Орлов", mine), (102, "Дарья", "Лебедева", others[0]),
    (103, "Илья", "Соколов", others[1]), (104, "Полина", "Морозова", others[2]), (105, "Егор", "Волков", others[3]),
    (106, "Софья", "Новикова", others[4]), (107, "Артём", "Зайцев", others[5]), (108, "Вероника", "Павлова", mine),
]
bios = {1: "Люблю матанализ и шахматы. Помогу с программированием.", 101: "Шахматы, блиц и кофе после пар",
        102: "Киноман, рисую скетчи", 104: "Волонтёрю и учу испанский"}
for tg, first, last, g in people:
    c.execute("INSERT INTO users(tg_id, tg_first, tg_last, username, real_name, faculty_id, course, group_id, bio, "
              "show_club, consent_at, consent_version, app_offer) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'installed')",
              (tg, first, last, f"demo_{tg}", f"{first} {last}", g["faculty_id"], g["course"], g["id"],
               bios.get(tg), 1, "2026-10-20T10:00:00+00:00", CONSENT_VERSION))

for other in (101, 102, 103, 104):
    c.execute("INSERT INTO friendships(requester, addressee, status) VALUES(1, ?, 'accepted')", (other,))
c.execute("INSERT INTO friendships(requester, addressee, status) VALUES(106, 101, 'accepted')")


def taps(a, b, days, a_today=True, b_today=True):
    for i in range(days):
        d = (TODAY - timedelta(days=i)).isoformat()
        if i or a_today:
            c.execute("INSERT INTO flame_taps VALUES(?,?,?)", (a, b, d))
        if i or b_today:
            c.execute("INSERT INTO flame_taps VALUES(?,?,?)", (b, a, d))


taps(1, 101, 14)                    # lit today by both: 14
taps(1, 102, 6, a_today=False)      # the friend pressed today, your turn
taps(1, 104, 3, b_today=False)      # you pressed, waiting

clubs = [  # name, about, category, visibility, owner, members
    ("Киноклуб «Кадр»", "Смотрим и обсуждаем кино каждую пятницу. Выбираем фильм вместе.", "art", "public", 1, [102, 105, 106, 104]),
    ("Шахматный клуб", "Играем по четвергам в 18:00, ауд. 312. Новичкам рады, научим.", "games", "public", 101, [1, 103, 104, 107]),
    ("IT-клуб СФ МГУ", "Олимпиадные задачи, хакатоны и пет-проекты.", "it", "public", 107, [101, 103, 108, 1]),
    ("Волонтёры филиала", "Помогаем городу и друг другу. Вступление по заявке.", "volunteer", "closed", 104, [106, 108]),
    ("Английский разговорный", "Говорим по-английски за чаем, уровень любой.", "language", "public", 106, [102, 105]),
]
club_id = {}
for name, about, cat, vis, owner, members in clubs:
    cur = c.execute("INSERT INTO clubs(name, about, category, visibility) VALUES(?,?,?,?)", (name, about, cat, vis))
    club_id[name] = cur.lastrowid
    c.execute("INSERT INTO club_members(club_id, tg_id, role) VALUES(?,?, 'owner')", (cur.lastrowid, owner))
    for m in members:
        c.execute("INSERT INTO club_members(club_id, tg_id, role) VALUES(?,?, 'member')", (cur.lastrowid, m))
c.execute("UPDATE club_members SET role='admin' WHERE club_id=? AND tg_id=102", (club_id["Киноклуб «Кадр»"],))


def post(club, author, body, ago_h, reactions, comments=()):
    cur = c.execute("INSERT INTO club_posts(club_id, author, body, created_at, public) VALUES(?,?,?, datetime('now', ?), 1)",
                    (club_id[club], author, body, f"-{ago_h} hours"))
    for who, emo in reactions:
        c.execute("INSERT INTO post_reactions VALUES(?,?,?)", (cur.lastrowid, who, emo))
    for who, text, h in comments:
        c.execute("INSERT INTO post_comments(post_id, author, body, created_at) VALUES(?,?,?, datetime('now', ?))",
                  (cur.lastrowid, who, text, f"-{h} hours"))
    return cur.lastrowid


post("Шахматный клуб", 101, "Турнир по блицу в четверг! Записывайтесь в комментариях, победителю — шоколадка.", 20,
     [(1, "🔥"), (103, "🔥"), (104, "👍"), (107, "👍")], [(103, "Я в деле", 19), (1, "Записываюсь!", 18)])
kino = post("Киноклуб «Кадр»", 1, "В пятницу смотрим «Интерстеллар». 18:00, ауд. 205. Приходите с друзьями, будет попкорн.", 3,
            [(102, "❤️"), (105, "🔥"), (106, "👍"), (104, "❤️"), (101, "🔥")],
            [(102, "Уже жду!", 2), (105, "А можно взять друга?", 2), (1, "Конечно, всех ждём", 1)])
post("IT-клуб СФ МГУ", 107, "Разбираем задачи с олимпиады по программированию. Ноутбук с собой.", 30,
     [(101, "👍"), (1, "🔥"), (108, "👍")])

for kind, actor, club, post_id, text in (("friend_accept", 104, None, None, ""), ("comment", 102, club_id["Киноклуб «Кадр»"], kino, "Уже жду!"),
                                         ("club_post", 101, club_id["Шахматный клуб"], None, "Турнир по блицу в четверг!"),
                                         ("flame", 102, None, None, "")):
    c.execute("INSERT INTO notifications(tg_id, kind, actor, club_id, post_id, text) VALUES(1,?,?,?,?,?)",
              (kind, actor, club, post_id, text))
c.commit()
print("me:", mine["name"], mine["fac"], mine["course"], "| users", c.execute("SELECT count(*) FROM users").fetchone()[0],
      "| clubs", c.execute("SELECT count(*) FROM clubs").fetchone()[0], "| lessons", c.execute("SELECT count(*) FROM lessons").fetchone()[0])
