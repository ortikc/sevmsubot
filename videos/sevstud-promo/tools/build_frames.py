"""Writes the eight frame sub-compositions of the promo from shared pieces (fonts, the phone, the type ramp).
python build_frames.py <project dir>
Every frame: one <template>, root #root with data-composition-id = frame id, a black ground clip, a stage clip,
one paused GSAP timeline registered at window.__timelines[id] inside an IIFE. Times are seconds on the music grid:
beat B = 0.48387, bar = 1.93548."""
import sys
from pathlib import Path

proj = Path(sys.argv[1])
out = proj / "compositions" / "frames"
out.mkdir(parents=True, exist_ok=True)
FONTS = (proj / "assets" / "fonts" / "fonts.css").read_text(encoding="utf-8")
GSAP = '<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>'
ACCENT = "#4DA3FF"
B = 0.48387
BAR = 1.93548

BASE_CSS = f"""
{FONTS}
#root {{ position: absolute; inset: 0; width: 1080px; height: 1920px; overflow: hidden; color: #FFFFFF;
  font-family: "Inter", sans-serif; -webkit-font-smoothing: antialiased; }}
.ground {{ position: absolute; inset: 0; background: #000000; }}
.stage {{ position: absolute; inset: 0; }}
.h {{ position: absolute; left: 70px; right: 70px; top: 160px; font-weight: 800; font-size: 96px; line-height: 0.98;
  letter-spacing: -0.03em; }}
.h .w {{ display: inline-block; }}
.acc {{ color: {ACCENT}; }}
.label {{ font-family: "IBM Plex Mono", monospace; font-weight: 600; font-size: 30px; letter-spacing: 0.12em;
  text-transform: uppercase; }}
.chip {{ position: absolute; font-size: 28px; padding: 14px 20px; background: #000000; border: 2px solid {ACCENT}; border-radius: 6px;
  color: #FFFFFF; white-space: nowrap; }}
.glow {{ position: absolute; border-radius: 50%; background: radial-gradient(circle, rgba(77,163,255,0.34) 0%,
  rgba(77,163,255,0.10) 38%, rgba(77,163,255,0) 68%); }}
.phone {{ position: absolute; left: 230px; top: 585px; width: 620px; height: 1307px; border-radius: 78px;
  background: #0B0B0D; box-shadow: 0 0 0 2px #282826; }}
.screen {{ position: absolute; left: 15px; top: 15px; width: 590px; height: 1277px; border-radius: 64px;
  overflow: hidden; background: #000000; }}
.screen img {{ position: absolute; left: 0; top: 0; width: 590px; height: 1277px; }}
.box {{ position: absolute; border: 3px solid {ACCENT}; border-radius: 30px; }}
.num {{ font-variant-numeric: tabular-nums; }}
"""

# screen coordinates: CSS px of the 390-wide app → canvas (screen origin 245,600; scale 590/390)
S = 590 / 390
def cx(x): return round(245 + x * S)
def cy(y): return round(600 + y * S)


def words(text, cls="w"):
    """'вся <неделя>' → spans, <...> marks the accent word"""
    out = []
    for w in text.split(" "):
        acc = w.startswith("<") and w.endswith(">")
        w = w.strip("<>")
        out.append(f'<span class="{cls}{" acc" if acc else ""}">{w}</span>')
    return " ".join(out)


def phone(imgs):
    tags = "".join(f'<img class="scr scr-{name}" src="assets/{name}.png" alt="">' for name in imgs)
    return f'<div class="phone"><div class="screen">{tags}</div></div>'


def frame(fid, duration, css, body, js):
    return f"""<template>
  <style>{BASE_CSS}{css}
  </style>
  <div id="root" data-composition-id="{fid}" data-width="1080" data-height="1920">
    <div id="f{fid[:2]}-ground" class="ground clip" data-start="0" data-duration="{duration}" data-track-index="0"></div>
    <div id="f{fid[:2]}-stage" class="stage clip" data-start="0" data-duration="{duration}" data-track-index="1">
{body}
    </div>
  </div>
  {GSAP}
  <script>
    (() => {{
      const all = document.querySelectorAll('[data-composition-id="{fid}"]');
      const root = all[all.length - 1];
      const $ = (s) => root.querySelector(s);
      const $$ = (s) => Array.from(root.querySelectorAll(s));
      const tl = gsap.timeline({{ paused: true }});
{js}
      window.__timelines = window.__timelines || {{}};
      window.__timelines["{fid}"] = tl;
    }})();
  </script>
</template>
"""


def wordsin(sel, t, stagger=0.08):
    return (f'tl.fromTo($$("{sel} .w"), {{ y: 44, opacity: 0 }}, {{ y: 0, opacity: 1, duration: 0.5, '
            f'ease: "power3.out", stagger: {stagger} }}, {t:.3f});')


def scale_swap(a, b, t):
    """scale-swap: the old screen shrinks and fades as the new one arrives at the same centre"""
    return (f'tl.to($(".scr-{a}"), {{ scale: 0.94, opacity: 0, duration: 0.28, ease: "power2.in" }}, {t - 0.08:.3f});'
            f'tl.fromTo($(".scr-{b}"), {{ scale: 1.06, opacity: 0 }}, {{ scale: 1, opacity: 1, duration: 0.42, ease: "power3.out" }}, {t:.3f});')


def count(sel, to, t, dur=0.75):
    return (f'(() => {{ const el = $("{sel}"); const o = {{ v: 0 }};'
            f'tl.fromTo(o, {{ v: 0 }}, {{ v: {to}, duration: {dur}, ease: "power2.out", onUpdate: () => {{ el.textContent = Math.round(o.v); }} }}, {t:.3f});'
            f'tl.fromTo(el, {{ scale: 0.72 }}, {{ scale: 1, duration: {dur}, ease: "power2.out" }}, {t:.3f}); }})();')


D = 3.871
frames = {}

# ---------- 01 hook: three questions on the beat, then the emblem ----------
frames["01-hook"] = (D, f"""
.q {{ position: absolute; left: 50px; right: 50px; top: 760px; text-align: center; font-weight: 800; font-size: 108px;
  line-height: 1.0; letter-spacing: -0.035em; }}
.q3 {{ font-size: 122px; }}
.ul {{ position: relative; display: inline-block; }}
.ul i {{ position: absolute; left: 0; right: 0; bottom: -10px; height: 8px; background: {ACCENT}; transform-origin: 0 50%; }}
.emb {{ position: absolute; left: 390px; top: 560px; width: 300px; height: 300px; border-radius: 66px; }}
.wm {{ position: absolute; left: 60px; right: 60px; top: 920px; text-align: center; font-weight: 800; font-size: 80px;
  line-height: 1.02; letter-spacing: -0.03em; }}
.wm .w {{ display: inline-block; }}
.g1 {{ left: 90px; top: 260px; width: 900px; height: 900px; }}
""", f"""
      <div class="glow g1"></div>
      <div class="q q1" id="hook-q1">какая <span class="ul acc">пара<i></i></span>?</div>
      <div class="q q2" id="hook-q2">какая <span class="ul acc">аудитория<i></i></span>?</div>
      <div class="q q3" id="hook-q3">сколько <span class="ul acc">осталось<i></i></span>?</div>
      <img class="emb" src="assets/emblem.png" alt="">
      <div class="wm">{words("Расписание МГУ Севастополь")}</div>
""", f"""
      const q = [$("#hook-q1"), $("#hook-q2"), $("#hook-q3")];
      const at = [0, {2 * B:.3f}, {4 * B:.3f}];
      tl.set([q[1], q[2]], {{ opacity: 0 }}, 0);
      q.forEach((el, i) => {{
        if (i === 0) tl.fromTo(el, {{ scale: 1.05 }}, {{ scale: 1, duration: 0.16, ease: "power3.out" }}, 0);  // on screen from the very first frame: it is the thumbnail
        else tl.fromTo(el, {{ opacity: 0, scale: 1.05 }}, {{ opacity: 1, scale: 1, duration: 0.16, ease: "power3.out", immediateRender: false }}, at[i]);
        tl.fromTo(el.querySelector("i"), {{ scaleX: 0 }}, {{ scaleX: 1, duration: 0.35, ease: "power3.out" }}, at[i] + 0.12);
        if (i < 2) tl.set(el, {{ opacity: 0 }}, at[i + 1]);
      }});
      // the last question streaks away, the emblem rises out of the glow
      tl.to(q[2], {{ opacity: 0, scale: 1.08, filter: "blur(14px)", duration: 0.24, ease: "power2.in" }}, {6 * B:.3f});
      tl.fromTo($(".g1"), {{ opacity: 0, scale: 0.6 }}, {{ opacity: 1, scale: 1, duration: 0.9, ease: "power3.out" }}, {6 * B:.3f});
      tl.fromTo($(".emb"), {{ opacity: 0, scale: 0.62, y: 40 }}, {{ opacity: 1, scale: 1, y: 0, duration: 0.6, ease: "power3.out" }}, {6 * B + 0.06:.3f});
      {wordsin(".wm", 6 * B + 0.1, 0.06)}
""")

# ---------- 02 day: the phone lands on the drop, three callouts on the beats ----------
lead = (20, 358, 350, 245)
frames["02-day"] = (D, f"""
.g2 {{ left: 90px; top: 760px; width: 900px; height: 900px; }}
.c1 {{ left: 40px; top: {cy(288) - 34}px; }}
.c2 {{ left: 40px; top: {cy(482) - 34}px; }}
.c3 {{ left: 820px; top: {cy(551) - 34}px; }}
.lead {{ left: {cx(lead[0]) - 6}px; top: {cy(lead[1]) - 6}px; width: {round(lead[2] * S) + 12}px; height: {round(lead[3] * S) + 12}px; }}
""", f"""
      <div class="glow g2"></div>
      <div data-layout-allow-overlap class="h" id="day-h">{words("твоё расписание —")}<br>{words("прямо в <Telegram>")}</div>
      {phone(["s01-day"])}
      <div class="box lead"></div>
      <div class="chip label c1">сейчас 10:12</div>
      <div class="chip label c2">ауд. 205</div>
      <div class="chip label c3">ещё 18 мин</div>
""", f"""
      tl.fromTo($(".phone"), {{ y: 900 }}, {{ y: 0, duration: 0.7, ease: "expo.out" }}, 0);
      tl.fromTo($(".g2"), {{ opacity: 0, scale: 0.7 }}, {{ opacity: 1, scale: 1, duration: 1.0, ease: "power3.out" }}, 0.05);
      {wordsin("#day-h", 0.3)}
      tl.fromTo($(".c1"), {{ opacity: 0, x: -40 }}, {{ opacity: 1, x: 0, duration: 0.4, ease: "power3.out" }}, {3 * B:.3f});
      tl.fromTo($(".c2"), {{ opacity: 0, x: -40 }}, {{ opacity: 1, x: 0, duration: 0.4, ease: "power3.out" }}, {4 * B:.3f});
      tl.fromTo($(".c3"), {{ opacity: 0, x: 40 }}, {{ opacity: 1, x: 0, duration: 0.4, ease: "power3.out" }}, {5 * B:.3f});
      tl.fromTo($(".lead"), {{ opacity: 0, scale: 1.04 }}, {{ opacity: 1, scale: 1, duration: 0.35, ease: "power3.out" }}, {5 * B:.3f});
""")

# ---------- 03 week → statistics ----------
frames["03-week"] = (D, f"""
.hb {{ opacity: 0; }}
.tue {{ left: {cx(0) + 6}px; top: {cy(296)}px; width: {round(390 * S) - 12}px; height: {round(66 * S)}px; border-radius: 18px; }}
.stat {{ position: absolute; left: 70px; top: 300px; display: flex; align-items: baseline; gap: 26px; opacity: 0; }}
.stat b {{ font-weight: 900; font-size: 190px; line-height: 0.9; letter-spacing: -0.04em; color: {ACCENT}; transform-origin: 0 100%; display: inline-block; }}
.stat span {{ color: #FFFFFF; }}
""", f"""
      <div data-layout-allow-overlap class="h ha" id="week-ha">{words("вся <неделя>")}</div>
      <div data-layout-allow-overlap class="h hb" id="week-hb">и <span class="acc">статистика</span></div>
      <div class="stat"><b class="num" id="week-n">0</b><span class="label">пар<br>за неделю</span></div>
      {phone(["s02-week", "s03-stats"])}
      <div class="box tue"></div>
""", f"""
      tl.set($(".scr-s03-stats"), {{ opacity: 0 }}, 0);
      {wordsin("#week-ha", 0.05)}
      tl.fromTo($(".tue"), {{ opacity: 0, scaleX: 0.2 }}, {{ opacity: 1, scaleX: 1, duration: 0.4, ease: "power3.out" }}, {2 * B:.3f});
      tl.to($(".tue"), {{ opacity: 0, duration: 0.2 }}, {BAR - 0.1:.3f});
      {scale_swap("s02-week", "s03-stats", BAR)}
      tl.set($("#week-ha"), {{ opacity: 0 }}, {BAR:.3f});
      tl.fromTo($("#week-hb"), {{ opacity: 0, y: 22 }}, {{ opacity: 1, y: 0, duration: 0.3, ease: "power3.out", immediateRender: false }}, {BAR:.3f});
      tl.fromTo($(".stat"), {{ opacity: 0 }}, {{ opacity: 1, duration: 0.2 }}, {5 * B:.3f});
      {count("#week-n", 25, 5 * B)}
""")

# ---------- 04 friends → Maxim's card and the flame ----------
FLAME = ('<svg viewBox="0 0 24 24"><path fill="#FF9F0A" d="M12 21.5C8.4 21.5 5.5 18.9 5.5 15.3c0-2.4 1.2-4.4 2.8-6 .2 1.4.9 2.5 2 3-.4-3.7 1.3-7 4.1-9.7.1 3.2 1.6 5 2.9 6.8.9 1.4 1.2 3.2 1.2 5.9 0 3.6-2.9 6.2-6.5 6.2Z"/>'
         '<path fill="#FFD60A" d="M12 21.5c-1.6 0-2.6-1.2-2.6-2.7 0-1.6 1.2-2.8 2.2-4 .3 1.2 1 1.8 1.8 2.1.8.4 1.2 1.1 1.2 1.9 0 1.5-1 2.7-2.6 2.7Z"/></svg>')
frames["04-friends"] = (D, f"""
.hb {{ opacity: 0; }}
.ring {{ left: {cx(295) - 14}px; top: {cy(320) - 16}px; width: {round(61 * S) + 28}px; height: {round(38 * S) + 32}px; border-radius: 40px; }}
.fl {{ position: absolute; left: 70px; top: 300px; display: flex; align-items: center; gap: 22px; opacity: 0; }}
.fl svg {{ width: 150px; height: 150px; }}
.fl b {{ font-weight: 900; font-size: 170px; line-height: 0.9; letter-spacing: -0.04em; color: #FF9F0A; display: inline-block; transform-origin: 0 60%; }}
""", f"""
      <div data-layout-allow-overlap class="h ha" id="fr-ha">{words("друзья <рядом>")}</div>
      <div data-layout-allow-overlap class="h hb" id="fr-hb">огонёк <span class="acc">с друзьями</span></div>
      <div class="fl">{FLAME}<b class="num" id="fr-n">0</b><span class="label">дней<br>подряд</span></div>
      {phone(["s04-friends", "s05-friend"])}
      <div class="box ring"></div>
""", f"""
      tl.set($(".scr-s05-friend"), {{ opacity: 0 }}, 0);
      {wordsin("#fr-ha", 0.05)}
      tl.fromTo($(".ring"), {{ opacity: 0, scale: 0.6 }}, {{ opacity: 1, scale: 1, duration: 0.4, ease: "power3.out" }}, {2 * B:.3f});
      tl.to($(".ring"), {{ opacity: 0, duration: 0.18 }}, {BAR - 0.1:.3f});
      tl.to($(".scr-s04-friends"), {{ opacity: 0, duration: 0.3, ease: "power2.in" }}, {BAR - 0.05:.3f});
      tl.fromTo($(".scr-s05-friend"), {{ opacity: 0, y: 90 }}, {{ opacity: 1, y: 0, duration: 0.45, ease: "expo.out" }}, {BAR:.3f});
      tl.set($("#fr-ha"), {{ opacity: 0 }}, {BAR:.3f});
      tl.fromTo($("#fr-hb"), {{ opacity: 0, y: 22 }}, {{ opacity: 1, y: 0, duration: 0.3, ease: "power3.out", immediateRender: false }}, {BAR:.3f});
      tl.fromTo($(".fl"), {{ opacity: 0, x: -30 }}, {{ opacity: 1, x: 0, duration: 0.45, ease: "power3.out" }}, {5 * B:.3f});
      {count("#fr-n", 14, 5 * B)}
""")

# ---------- 05 clubs → the club's feed, reactions fly out ----------
rx, ry = cx(36), cy(723 + 16)
frames["05-clubs"] = (D, f"""
.big {{ position: absolute; left: 70px; top: 150px; font-weight: 900; font-size: 150px; line-height: 0.9; letter-spacing: -0.045em; }}
.tags {{ position: absolute; left: 74px; top: 330px; color: #FFFFFF; }}
.tags .w {{ display: inline-block; margin-right: 18px; }}
.tags .dot {{ color: {ACCENT}; }}
.rb {{ position: absolute; left: {rx}px; top: {ry - 60}px; width: 120px; height: 120px; border-radius: 50%; background: #141518;
  border: 2px solid {ACCENT}; display: flex; align-items: center; justify-content: center; font-size: 62px; line-height: 1; }}
""", f"""
      <div data-layout-allow-overlap class="big">студ<span class="acc">клубы</span></div>
      <div class="tags label"><span class="w">лента</span><span class="w dot">/</span><span class="w">реакции</span><span class="w dot">/</span><span class="w">комментарии</span></div>
      {phone(["s07-clubs", "s08-club"])}
      <div class="rb rb1">👍</div><div class="rb rb2">❤️</div><div class="rb rb3">🔥</div>
""", f"""
      tl.set($(".scr-s08-club"), {{ opacity: 0 }}, 0);
      tl.fromTo($(".big"), {{ opacity: 0, x: -60 }}, {{ opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }}, 0.0);
      tl.fromTo($$(".tags .w"), {{ opacity: 0, y: 20 }}, {{ opacity: 1, y: 0, duration: 0.3, ease: "power3.out", stagger: {B / 2:.3f} }}, {2 * B:.3f});
      {scale_swap("s07-clubs", "s08-club", BAR)}
      const targets = [[600, -470], [640, -680], [560, -880]];
      $$(".rb").forEach((el, i) => {{
        const t = {5 * B:.3f} + i * {B / 2:.3f};
        tl.fromTo(el, {{ x: 40 + i * 110, y: 0, scale: 0.3, opacity: 0 }}, {{ x: targets[i][0], y: targets[i][1], scale: 1, opacity: 1, duration: 0.55, ease: "expo.out" }}, t);
        tl.to(el, {{ y: targets[i][1] - 26, duration: 1.2, ease: "sine.inOut" }}, t + 0.55);
      }});
""")

# ---------- 06 the bot reminds, then the bell ----------
frames["06-bot"] = (D, f"""
.hb {{ opacity: 0; }}
.msg {{ position: absolute; left: 60px; right: 60px; top: 760px; display: flex; gap: 22px; align-items: flex-end; transform-origin: 50% 0; }}
.msg img {{ width: 120px; height: 120px; border-radius: 50%; flex: none; }}
.bub {{ flex: 1; padding: 30px 34px 26px; background: #1C1D22; border-radius: 34px 34px 34px 10px; }}
.bub .from {{ color: {ACCENT}; font-weight: 700; font-size: 34px; }}
.bub .t1 {{ margin-top: 12px; font-weight: 700; font-size: 50px; line-height: 1.18; letter-spacing: -0.01em; }}
.bub .t2 {{ margin-top: 12px; font-size: 38px; color: #B9BEC6; }}
.bub .time {{ margin-top: 8px; text-align: right; font-size: 30px; color: #8B929C; }}
.hl {{ left: {cx(12)}px; top: {cy(418)}px; width: {round(196 * S)}px; height: {round(66 * S)}px; border-radius: 22px; }}
""", f"""
      <div data-layout-allow-overlap class="h ha" id="bot-ha">{words("бот <напомнит>")}<br>{words("о паре")}</div>
      <div data-layout-allow-overlap class="h hb" id="bot-hb">и всё <span class="acc">новое</span></div>
      {phone(["s10-bell"])}
      <div class="box hl"></div>
      <div class="msg"><img src="assets/emblem.png" alt="">
        <div class="bub"><div class="from">Расписание МГУ</div>
          <div class="t1">⏰ Через 10 минут: Зарубежная литература</div>
          <div class="t2">🕘 10:40–12:10 · 📍 ауд. 205</div>
          <div class="time">10:30</div></div></div>
""", f"""
      {wordsin("#bot-ha", 0.0)}
      tl.fromTo($(".msg"), {{ opacity: 0, x: 160 }}, {{ opacity: 1, x: 0, duration: 0.6, ease: "power3.out" }}, {B:.3f});
      tl.fromTo($(".phone"), {{ y: 1400 }}, {{ y: 0, duration: 0.6, ease: "expo.out" }}, {BAR:.3f});
      tl.to($(".msg"), {{ y: -475, scale: 0.76, duration: 0.55, ease: "power3.inOut" }}, {BAR - 0.05:.3f});
      tl.to($$(".bub .from, .bub .time"), {{ opacity: 0, duration: 0.25, ease: "power2.out" }}, {BAR - 0.05:.3f});
      tl.set($("#bot-ha"), {{ opacity: 0 }}, {BAR:.3f});
      tl.fromTo($("#bot-hb"), {{ opacity: 0, y: 22 }}, {{ opacity: 1, y: 0, duration: 0.3, ease: "power3.out", immediateRender: false }}, {BAR:.3f});
      tl.fromTo($(".hl"), {{ opacity: 0, scale: 1.08 }}, {{ opacity: 1, scale: 1, duration: 0.35, ease: "power3.out" }}, {6 * B:.3f});
""")

# ---------- 07 install → offline, the camera pushes into «Нет сети» ----------
pill = (68, 735, 254, 33)
pcx, pcy = cx(pill[0] + pill[2] / 2), cy(pill[1] + pill[3] / 2)
PLANE = '<svg viewBox="0 0 24 24" width="30" height="30"><path fill="#4DA3FF" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5Z"/></svg>'
frames["07-offline"] = (D, f"""
.h {{ z-index: 3; }}
.hb {{ opacity: 0; }}
.cam {{ position: absolute; inset: 0; transform-origin: {pcx}px {pcy}px; }}
.steps {{ left: {cx(16)}px; top: {cy(462)}px; width: {round(358 * S)}px; height: {round(190 * S)}px; border-radius: 24px; }}
.shade {{ position: absolute; left: 0; right: 0; top: 0; height: 640px; z-index: 2;
  background: linear-gradient(#000000 0%, #000000 62%, rgba(0,0,0,0) 100%); }}
.air {{ left: 70px; top: 400px; display: flex; align-items: center; gap: 12px; z-index: 3; opacity: 0; }}
""", f"""
      <div data-layout-allow-overlap class="h ha" id="off-ha">{words("ставится на")}<br>{words("<главный> <экран>")}</div>
      <div data-layout-allow-overlap class="h hb" id="off-hb">и работает<br><span class="acc">без интернета</span></div>
      <div class="chip label air">{PLANE}<span>режим полёта</span></div>
      <div class="shade"></div>
      <div class="cam">{phone(["s13-install", "s11-offline"])}<div class="box steps"></div></div>
""", f"""
      tl.set($(".scr-s11-offline"), {{ opacity: 0 }}, 0);
      {wordsin("#off-ha", 0.05)}
      tl.fromTo($(".steps"), {{ opacity: 0, scale: 1.05 }}, {{ opacity: 1, scale: 1, duration: 0.35, ease: "power3.out" }}, {2 * B:.3f});
      tl.to($(".steps"), {{ opacity: 0, duration: 0.18 }}, {BAR - 0.1:.3f});
      {scale_swap("s13-install", "s11-offline", BAR)}
      tl.set($("#off-ha"), {{ opacity: 0 }}, {BAR:.3f});
      tl.fromTo($("#off-hb"), {{ opacity: 0, y: 22 }}, {{ opacity: 1, y: 0, duration: 0.3, ease: "power3.out", immediateRender: false }}, {BAR:.3f});
      tl.fromTo($(".air"), {{ opacity: 0, x: -30 }}, {{ opacity: 1, x: 0, duration: 0.35, ease: "power3.out" }}, {5 * B:.3f});
      tl.fromTo($(".shade"), {{ opacity: 0 }}, {{ opacity: 1, duration: 0.3 }}, {5 * B:.3f});
      // the push into the «no network» pill builds with the snare roll and breaks on the drop
      tl.fromTo($(".cam"), {{ scale: 1, y: 0 }}, {{ scale: 1.75, y: -560, duration: {D - 5 * B:.3f}, ease: "power2.in" }}, {5 * B:.3f});
""")

# ---------- 08 call to action ----------
D8 = 4.903
frames["08-cta"] = (D8, f"""
.g8 {{ left: 40px; top: 160px; width: 1000px; height: 1000px; }}
.emb {{ position: absolute; left: 320px; top: 420px; width: 440px; height: 440px; border-radius: 98px; }}
.wm {{ position: absolute; left: 50px; right: 50px; top: 930px; text-align: center; font-weight: 800; font-size: 96px;
  line-height: 1.0; letter-spacing: -0.035em; }}
.wm .w {{ display: inline-block; }}
.cta {{ position: absolute; left: 0; right: 0; top: 1210px; text-align: center; }}
.cta span {{ display: inline-block; padding: 30px 56px; border-radius: 999px; background: {ACCENT}; color: #000000;
  font-weight: 800; font-size: 54px; letter-spacing: -0.01em; }}
.url {{ position: absolute; left: 0; right: 0; top: 1380px; text-align: center; color: #B4BAC3; font-size: 34px; }}
""", f"""
      <div class="glow g8"></div>
      <img class="emb" src="assets/emblem.png" alt="">
      <div class="wm">{words("Расписание")}<br>{words("МГУ Севастополь")}</div>
      <div class="cta"><span>Открой @sevmsubot</span></div>
      <div class="url label">sevstud.site</div>
""", f"""
      tl.fromTo($(".g8"), {{ opacity: 0, scale: 0.5 }}, {{ opacity: 1, scale: 1, duration: 1.1, ease: "power3.out" }}, 0);
      tl.fromTo($(".emb"), {{ opacity: 0, scale: 0.4 }}, {{ opacity: 1, scale: 1, duration: 0.7, ease: "expo.out" }}, 0);
      {wordsin(".wm", 0.7, 0.12)}
      tl.fromTo($(".cta span"), {{ opacity: 0, y: 40, scale: 0.92 }}, {{ opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "power3.out" }}, {3 * B:.3f});
      tl.fromTo($(".url"), {{ opacity: 0, y: 20 }}, {{ opacity: 1, y: 0, duration: 0.4, ease: "power3.out" }}, {4 * B:.3f});
      tl.fromTo($(".stage"), {{ opacity: 1 }}, {{ opacity: 0, duration: 0.5, ease: "power1.in" }}, 4.4);
""")

for fid, (dur, css, body, js) in frames.items():
    (out / f"{fid}.html").write_text(frame(fid, dur, css, body, js), encoding="utf-8")
    print(fid, dur)
