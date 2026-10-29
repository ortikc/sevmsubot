"use strict";

const tg = window.Telegram?.WebApp;
const inTelegram = Boolean(tg?.initData);
// outside Telegram (the app on a phone's home screen) the server knows us by a key this device got at sign-in
const DEVICE_KEY = "msu.device";
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function deviceKey() {
  let key = "";
  try { key = localStorage.getItem(DEVICE_KEY) || ""; } catch (_) {}
  if (!key) {   // an iPhone copies the site's cookies, not its storage, into the app it puts on the home screen
    key = decodeURIComponent((document.cookie.match(/(?:^|; )msu_device=([^;]*)/) || [])[1] || "");
    if (key) try { localStorage.setItem(DEVICE_KEY, key); } catch (_) {}
  }
  return key;
}
function setDeviceKey(key) {
  try { if (key) localStorage.setItem(DEVICE_KEY, key); else localStorage.removeItem(DEVICE_KEY); } catch (_) {}
  document.cookie = `msu_device=${encodeURIComponent(key)}; path=/; max-age=${key ? 180 * 86400 : 0}; SameSite=Strict${location.protocol === "https:" ? "; Secure" : ""}`;
}
const app = document.getElementById("app");
const tabbar = document.getElementById("tabbar");

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const WD_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const KINDS = { "лк": "Лекция", "сем": "Семинар", "пз": "Практика", "лб": "Лабораторная", "лаб": "Лабораторная", "зач": "Зачёт", "экз": "Экзамен", "конс": "Консультация" };
const DAY_START = "09:00";
const DAY_END_MIN = "16:05";
const THEME_KEY = "msu.theme";

const state = {
  me: null,
  catalog: null,
  lessons: new Map(),   // iso date -> lessons[]
  loadedWeeks: new Set(),
  syncedAt: null,
  selected: null,       // iso date
  weekStart: null,      // iso date (Monday)
  tab: "schedule",
  profileView: "profile",
  scheduleView: "day",  // "day", "week" or "stats" inside the schedule tab
  settings: null,       // the bot's settings for this student, loaded with the settings view
  friends: null,        // { friends, incoming, outgoing }
  clubs: null,          // { my, invites, discover }
  clubView: null,       // inside the clubs tab: { kind: "club", id, data } or { kind: "form", ... }
  clubFilter: "all",    // the category chip picked above the list of clubs
  clubsTab: "clubs",    // the clubs tab shows the list of clubs or the shared feed
  sharedFeed: null,     // { posts, more }: open posts of every club you may open
  unread: 0,            // notifications not yet seen, for the badge on the bell
  ob: null,             // onboarding draft
  reminders: new Map(), // "date|start|subject" -> reminder
  liveSig: "",          // which pair the lead card shows, to know when to redraw
  offline: null,        // with no network: when the data on screen was saved (ISO)
  signingIn: false,     // the sign-in screen is up (outside Telegram, no device key yet)
};

/* ---------- time (Sevastopol lives on Moscow time) ---------- */

function now() {
  const forced = new URLSearchParams(location.search).get("now"); // ?now=2026-10-21T10:12 for demos
  if (forced) return parseLocal(forced);
  const s = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Moscow" });
  return parseLocal(s.replace(" ", "T"));
}
/** now() with the seconds in its minutes, so the running pair's bar moves every second, not in minute steps */
function nowPrecise() {
  const t = now();
  return new URLSearchParams(location.search).has("now") ? t : { ...t, min: t.min + new Date().getSeconds() / 60 };
}
function parseLocal(s) {
  const [d, t = "00:00"] = s.split("T");
  const [hh, mm] = t.split(":").map(Number);
  return { iso: d, min: hh * 60 + (mm || 0) };
}
const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
const clock = (hhmm) => hm(toMin(hhmm)); // "09:00" -> "9:00"
const isoOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const dateOf = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (iso, n) => { const d = dateOf(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const mondayOf = (iso) => { const d = dateOf(iso); return addDays(iso, -((d.getDay() + 6) % 7)); };

function duration(n) {
  if (n >= 60) {
    const h = Math.floor(n / 60), m = n % 60;
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  }
  return `${n} мин`;
}
function relativeDay(iso) {
  const today = now().iso;
  if (iso === today) return "Сегодня";
  if (iso === addDays(today, 1)) return "Завтра";
  if (iso === addDays(today, -1)) return "Вчера";
  return null;
}
function dayTitle(iso) {
  const d = dateOf(iso);
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/* ---------- text ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const kindName = (k) => KINDS[(k || "").toLowerCase()] || k || "";
function shortName(full) {
  const p = (full || "").trim().split(/\s+/);
  if (p.length < 2) return full || "";
  return `${p[0]} ${p.slice(1).map((w) => w[0] + ".").join(" ")}`; // initials never wrap away from the surname
}
const initials = (name) => (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return few;
  return many;
}
const pairs = (n) => `${n} ${plural(n, "пара", "пары", "пар")}`;
const courseLabel = (c, master) => `${c} курс${master ? " магистратуры" : ""}`;

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const icon = {
  left: svg('<path d="M14.5 5.5 8 12l6.5 6.5"/>'),
  right: svg('<path d="M9.5 5.5 16 12l-6.5 6.5"/>'),
  check: svg('<path d="M5 12.5 10 17.5 19 7"/>'),
  flag: svg('<path d="M5.5 21V4.5M5.5 4.5h11.5l-2.2 4 2.2 4H5.5"/>'),
  camera: svg('<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2L9 5h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z"/><circle cx="12" cy="12.6" r="3.2"/>'),
  lock: svg('<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
  smile: svg('<circle cx="12" cy="12" r="8.5"/><path d="M8.6 14.2c.9 1.2 2 1.8 3.4 1.8s2.5-.6 3.4-1.8M9.3 9.8h.01M14.7 9.8h.01"/>'),
  comment: svg('<path d="M20 11.6a7.6 7.6 0 0 1-11.2 6.7L4.5 19.5l1.3-4A7.6 7.6 0 1 1 20 11.6Z"/>'),
  send: svg('<path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5"/>'),
  pen: svg('<path d="M4.5 19.5h4l10.3-10.3a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4.5 15.5Z"/><path d="m13.5 6.5 4 4"/>'),
  trash: svg('<path d="M4.5 7h15M10 4h4M6.5 7l.8 12.1a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10 11v5.5M14 11v5.5"/>'),
  bell: svg('<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.6 2.2H4.4Z"/><path d="M10 20.6a2.1 2.1 0 0 0 4 0"/>'),
  globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5Z"/>'),
  plane: svg('<path d="M20.5 4.5 3.5 11.3l5.7 2.1 2.1 6.1 3.3-3.8 4.3 3.1Z"/><path d="m9.2 13.4 11.3-8.9"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>'),
  tick: svg('<path pathLength="1" d="M5 12.5 10 17.5 19 7"/>'),   // a check that draws itself (.btn-ico)
};

/* ---------- subjects: one colour and one drawn mark per discipline ----------
   The mark is a small line drawing of the discipline's own sign (an integral, a triangle in a circle,
   an hourglass), drawn in the subject's colour; the colour stays the same for that subject all week. */

// Each mark has named parts for the little scene it plays when its pair's sheet opens (or the mark is tapped):
// the integral writes itself, the atom spins, the hourglass turns over, the scales tip… (.mark.play, app.css).
// A part with pathLength="1" is one the scene draws.
const SUBJECT_MARKS = {
  analysis: '<path class="draw" pathLength="1" d="M14.5 3.5c-1.9 0-2.5 1.5-2.8 3.5L10.2 17c-.3 2-.9 3.5-2.7 3.5"/><path class="m-wave" d="M14 14.5c.9-1.6 1.8-1.6 2.7 0s1.8 1.6 2.8 0"/>',
  geometry: '<path class="draw" pathLength="1" d="M12 4 20.5 19h-17Z"/><circle class="m-pop" cx="12" cy="14" r="3"/>',
  algorithms: '<circle class="m-pop" cx="6" cy="6" r="2.2"/><circle class="m-pop p2" cx="18" cy="6" r="2.2"/><circle class="m-pop p3" cx="12" cy="18" r="2.2"/><path class="draw" pathLength="1" d="M8.2 6h7.6"/><path class="draw d2" pathLength="1" d="M16.8 7.9l-3.6 8.2"/><path class="draw d3" pathLength="1" d="M10.8 16.1 7.2 7.9"/>',
  code: '<path class="m-left" d="M8.5 7.5 4 12l4.5 4.5"/><path class="m-right" d="M15.5 7.5 20 12l-4.5 4.5"/><path class="m-slash" d="M13.5 5.5l-3 13"/>',
  history: '<g class="m-turn"><path d="M7 3.5h10M7 20.5h10M8 3.5c0 5 8 5.5 8 8.5s-8 3.5-8 8.5M16 3.5c0 5-8 5.5-8 8.5s8 3.5 8 8.5"/></g>',
  sport: '<g class="m-lift"><path d="M7.5 12h9"/><rect x="4.5" y="7" width="3" height="10" rx="1.2"/><rect x="16.5" y="7" width="3" height="10" rx="1.2"/><path d="M2.5 10v4M21.5 10v4"/></g>',
  language: '<g class="m-wobble"><path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-8l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5Z"/></g><path class="m-pop" d="M9.5 13.5 12 7.5l2.5 6M10.4 11.4h3.2"/>',
  safety: '<path class="m-pulse" d="M12 3.5 5 6.5v5c0 4.3 2.9 7.5 7 9 4.1-1.5 7-4.7 7-9v-5Z"/><path class="m-spin" d="M12 9v6M9 12h6"/>',
  physics: '<circle class="m-pop" cx="12" cy="12" r="1.4"/><g class="m-orbit"><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/></g>',
  economics: '<path d="M4 20h16"/><path class="m-bar" d="M7 16.5v-4"/><path class="m-bar b2" d="M12 16.5V8.5"/><path class="m-bar b3" d="M17 16.5V5.5"/>',
  psychology: '<path class="draw" pathLength="1" d="M12 4v16"/><path class="m-cup" d="M7 6v3.5a5 5 0 0 0 10 0V6"/><path d="M9.5 20h5"/>',
  literature: '<path d="M3.5 6c3-1 5.8-.8 8.5 1 2.7-1.8 5.5-2 8.5-1v12.5c-3-1-5.8-.8-8.5 1-2.7-1.8-5.5-2-8.5-1Z"/><path d="M12 7v12.5"/><path class="m-leaf" d="M12 7c2.7-1.8 5.5-2 8.5-1v12.5c-3-1-5.8-.8-8.5 1Z"/>',
  media: '<path d="M4 5h12.5v14H6a2 2 0 0 1-2-2Z"/><path d="M16.5 9H20v8a2 2 0 0 1-2 2"/><path class="draw" pathLength="1" d="M7 9h6.5"/><path class="draw d2" pathLength="1" d="M7 12h6.5"/><path class="draw d3" pathLength="1" d="M7 15h4"/>',
  geography: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path class="m-meridian" d="M12 3.5c2.4 2.4 3.5 5.4 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.4-3.5-8.5s1.1-6.1 3.5-8.5Z"/>',
  law: '<path d="M12 4v16M8 20h8"/><g class="m-tilt"><path d="M5 7h14M5 7l-2.5 6a2.5 2.5 0 0 0 5 0ZM19 7l-2.5 6a2.5 2.5 0 0 0 5 0Z"/></g>',
  chance: '<g class="m-roll"><rect x="4" y="4" width="16" height="16" rx="3.5"/><circle class="m-pop" cx="9" cy="9" r=".6"/><circle class="m-pop p2" cx="15" cy="15" r=".6"/><circle class="m-pop p3" cx="15" cy="9" r=".6"/><circle class="m-pop p4" cx="9" cy="15" r=".6"/></g>',
  book: '<g class="m-lift"><path d="M6 4h12v16H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M4 17.5A2 2 0 0 1 6 15.5h12"/></g><path class="draw" pathLength="1" d="M9 8h6"/>',
};

// first match wins, so the specific disciplines come before the broad ones
const SUBJECT_RULES = [
  [/физическ\S* культур|спорт|элективн/, "sport", "orange"],
  [/алгоритм|дискретн|(^|[\s(])граф/, "algorithms", "green"],   // «теория графов», not «география»
  [/эвм|программ|информат|компьютер|баз\S* данных|веб/, "code", "teal"],
  [/анализ|математ|дифференц|интеграл|исчислен/, "analysis", "blue"],
  [/алгебр|геометр|топологи/, "geometry", "yellow"],
  [/вероятн|статист/, "chance", "blue"],
  [/безопасн|охран|медицин/, "safety", "lime"],
  [/физик|механик|оптик|электр|квант/, "physics", "cyan"],
  [/истор|археолог/, "history", "red"],
  [/язык|английск|немецк|французск|лингв|перевод|риторик|культура речи/, "language", "pink"],
  [/литератур|филолог|словесн|фольклор/, "literature", "pink"],
  [/журналист|медиа|редакт|реклам|телевид/, "media", "orange"],
  [/психолог|педагог/, "psychology", "yellow"],
  [/эконом|финанс|менеджмент|бухгалт|маркетинг|аудит/, "economics", "green"],
  [/географ|геолог|картограф|климат|океан|эколог/, "geography", "teal"],
  [/прав|юрид|государств|муниципал|управлен|политолог/, "law", "red"],
];
const HUES = ["red", "green", "blue", "yellow", "orange", "cyan", "teal", "pink", "lime"];

const subjectCache = new Map();
function subjectStyle(name) {
  if (subjectCache.has(name)) return subjectCache.get(name);
  const low = (name || "").toLowerCase();
  const rule = SUBJECT_RULES.find(([re]) => re.test(low));
  let hash = 0;
  for (const ch of low) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const style = rule
    ? { mark: rule[1], hue: rule[2] }
    : { mark: "book", hue: HUES[hash % HUES.length] };
  subjectCache.set(name, style);
  return style;
}
const hueVar = (name) => `--c: var(--hue-${subjectStyle(name).hue})`;
const markSvg = (name, cls = "mark") => {
  const { mark } = subjectStyle(name);
  return `<svg class="${cls}" data-mark="${mark}" viewBox="0 0 24 24" aria-hidden="true">${SUBJECT_MARKS[mark]}</svg>`;
};
/** the mark plays its scene once more, even if it was already playing */
function playMark(svg) {
  if (!svg || reduceMotion.matches) return;
  svg.classList.remove("play");
  void svg.getBoundingClientRect();
  svg.classList.add("play");
}

/* ---------- api ---------- */

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const OFFLINE_TEXT = "Нет интернета. Это заработает, когда появится сеть.";
function authHeaders() {
  if (inTelegram) return { "X-Init-Data": tg.initData };
  const key = deviceKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}
async function api(path, opts = {}) {
  const headers = { "Content-Type": opts.body instanceof Blob ? opts.body.type || "application/octet-stream" : "application/json", ...authHeaders() };
  const write = Boolean(opts.method) && opts.method !== "GET";
  if (write && !navigator.onLine) throw new HttpError(0, OFFLINE_TEXT);
  const res = await fetch(path, { ...opts, headers });
  if (!write) noteSaved(res.headers.get("X-Saved-At"));
  if (res.status === 401 && !inTelegram && deviceKey()) {
    // signed out on another device, or the key is gone from the server
    await forgetDevice();
    renderSignIn("Вход на этом устройстве закончился. Войдите снова.");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    if (res.status === 403 && msg?.banned) {
      renderBanned(msg);
      throw new HttpError(403, "Аккаунт заблокирован");
    }
    throw new HttpError(res.status, msg);
  }
  return res.json();
}

/* ---------- theme ---------- */

function themePref() {
  try { return localStorage.getItem(THEME_KEY) || "auto"; } catch (_) { return "auto"; }
}
function systemTheme() {
  // outside Telegram the SDK reports "light" by default, so trust it only inside Telegram
  if (inTelegram && tg.colorScheme) return tg.colorScheme;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyTheme(pref = themePref()) {
  const mode = pref === "auto" ? systemTheme() : pref;
  document.documentElement.dataset.theme = mode;
  const ground = mode === "light" ? "#ffffff" : "#000000";
  document.querySelector('meta[name="theme-color"]').content = ground;
  try {
    tg?.setHeaderColor(ground);
    tg?.setBackgroundColor(ground);
    tg?.setBottomBarColor?.(ground);
  } catch (_) {}
}
function setTheme(pref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch (_) {}
  applyTheme(pref);
}

/* ---------- telegram chrome ---------- */

function setupTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  try { tg.disableVerticalSwipes?.(); } catch (_) {}
  tg.onEvent?.("themeChanged", () => { if (themePref() === "auto") applyTheme("auto"); });
}
const haptic = (kind = "select") => {
  try {
    if (kind === "select") tg?.HapticFeedback?.selectionChanged();
    else tg?.HapticFeedback?.notificationOccurred(kind);
  } catch (_) {}
};
let backHandler = null;
function setBack(fn) {
  if (!tg?.BackButton) return;
  if (backHandler) tg.BackButton.offClick(backHandler);
  backHandler = fn;
  try { if (fn) { tg.BackButton.onClick(fn); tg.BackButton.show(); } else tg.BackButton.hide(); } catch (_) {}
}

/* ---------- avatar ---------- */

let avatarUrl = null;
async function resolveAvatar(me) {
  if (me.photo_url) { avatarUrl = me.photo_url; return; }
  if (!inTelegram && !deviceKey()) return;
  try {
    const res = await fetch("/api/avatar", { headers: authHeaders() });
    if (res.ok) avatarUrl = URL.createObjectURL(await res.blob());
  } catch (_) {}
}
/** the name friends see: the nickname if there is one, else the real name */
const myName = (me) => me.nickname || me.real_name || [me.first_name, me.last_name].filter(Boolean).join(" ");
function avatarHtml(me, cls = "") {
  const ini = esc(initials(myName(me)));
  const img = avatarUrl ? `<img src="${esc(avatarUrl)}" alt="" onerror="this.parentNode.textContent=this.parentNode.dataset.i">` : "";
  return `<span class="avatar ${cls}" data-i="${ini}" aria-hidden="true">${img || ini}</span>`;
}

/* ---------- shell ---------- */

/* ---------- slide tabs: the SlideTabs component (React + framer-motion) ported to plain JS ---------- */

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** el shows text whose digits roll like a counter's drums from `from` (by default what el shows now): the stats
    count up from zero, the minutes left tick over. Text whose shape changes ("10 мин" → "9 мин") just swaps.
    The drums are tags of their own (x-…), so the page's rules for spans and the like never reach inside them. */
function rollTo(el, text, { from } = {}) {
  text = String(text);
  const shown = el.dataset.roll ?? el.textContent;
  if ((from ?? shown) === text) return;
  from ??= shown;
  el.dataset.roll = text;
  const shape = (s) => s.replace(/\d/g, "0");
  const roll = shape(from) === shape(text) && !reduceMotion.matches;
  const drums = [];
  let at = 0;
  const html = text.split(/(\d+)/).map((part, i) => {
    const start = at;
    at += part.length;
    if (i % 2 === 0) return esc(part);
    return `<x-drums>${[...part].map((d, j) => {
      drums.push(d);
      return `<x-drum><x-col style="--n:${roll ? from[start + j] : d};--k:${drums.length - 1}">${"0123456789".replace(/\d/g, "<x-d>$&</x-d>")}</x-col></x-drum>`;
    }).join("")}</x-drums>`;
  }).join("");
  el.innerHTML = `<x-sr>${esc(text)}</x-sr><x-roll aria-hidden="true">${html}</x-roll>`;
  if (!roll) return;
  // two frames: the drums must paint at their start before they turn
  requestAnimationFrame(() => requestAnimationFrame(() =>
    el.querySelectorAll("x-col").forEach((s, j) => s.style.setProperty("--n", drums[j]))));
}

/** a spring on the cursor's x and width: framer-motion's stiffness, a little more damping so it barely overshoots */
function spring(apply, { stiffness = 550, damping = 38, mass = 1 } = {}) {
  const v = { x: 0, w: 0, vx: 0, vw: 0, tx: 0, tw: 0 };
  let raf = 0, last = 0;
  const step = (time) => {
    let dt = Math.min(0.05, (time - last) / 1000);
    last = time;
    while (dt > 0) { // small fixed steps keep a stiff spring stable
      const h = Math.min(dt, 0.004);
      v.vx += ((-stiffness * (v.x - v.tx) - damping * v.vx) / mass) * h;
      v.vw += ((-stiffness * (v.w - v.tw) - damping * v.vw) / mass) * h;
      v.x += v.vx * h;
      v.w += v.vw * h;
      dt -= h;
    }
    const settled = Math.abs(v.x - v.tx) < 0.3 && Math.abs(v.w - v.tw) < 0.3 && Math.abs(v.vx) < 5 && Math.abs(v.vw) < 5;
    if (settled) { v.x = v.tx; v.w = v.tw; v.vx = v.vw = 0; raf = 0; }
    apply(v.x, v.w);
    if (!settled) raf = requestAnimationFrame(step);
  };
  return (x, w, instant = false) => {
    v.tx = x; v.tw = w;
    if (instant || reduceMotion.matches) {
      cancelAnimationFrame(raf); raf = 0;
      v.x = x; v.w = w; v.vx = v.vw = 0;
      apply(x, w);
    } else if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(step);
    }
  };
}

/** a row of tabs with one pill that springs to the tab you tap.
    fit: the pill hugs the tab's icon and name (the bottom bar) instead of filling the tab */
class SlideTabs {
  constructor(root, onSelect, { fit = false } = {}) {
    this.root = root;
    this.onSelect = onSelect;
    this.fit = fit;
    this.tabs = [...root.querySelectorAll('[role="tab"]')];
    const cursor = root.querySelector(".slide-cursor");
    this.move = spring((x, w) => {
      // the spring may overshoot; the pill never leaves the row
      const first = this.tabs[0], last = this.tabs[this.tabs.length - 1];
      const lo = first.offsetLeft, hi = last.offsetLeft + last.offsetWidth;
      w = Math.min(w, hi - lo);
      x = Math.max(lo, Math.min(x, hi - w));
      cursor.style.transform = `translateX(${x}px)`;
      cursor.style.width = `${w}px`;
    });
    this.selected = Math.max(0, this.tabs.findIndex((t) => t.getAttribute("aria-selected") === "true"));
    this.tabs.forEach((tab, i) => tab.addEventListener("click", () => this.select(i, { fromUser: true })));
    this.place();
    // the row can change width without a window resize: a scrollbar appearing under it, the font arriving,
    // the text zoom of the phone; the pill follows its tab whatever moved it
    if ("ResizeObserver" in window) {
      const watch = new ResizeObserver(() => this.place());
      [root, ...this.tabs].forEach((el) => watch.observe(el));
    }
  }
  /** where the pill goes for tab i: [x, width] in the row's coordinates */
  target(i) {
    const tab = this.tabs[i];
    if (!this.fit) return [tab.offsetLeft, tab.offsetWidth];
    const icon = tab.querySelector("svg").getBoundingClientRect().width;
    const label = tab.querySelector(".tab-label");
    const w = Math.min(this.root.clientWidth - 10, Math.ceil(icon + 8 + label.scrollWidth + 2 * 15));
    const center = tab.offsetLeft + tab.offsetWidth / 2;
    // an edge tab's pill stays inside the bar, and its content follows the pill
    const x = Math.max(5, Math.min(center - w / 2, this.root.clientWidth - 5 - w));
    this.tabs.forEach((t, j) => t.style.setProperty("--shift", j === i ? `${x + w / 2 - center}px` : "0px"));
    return [x, w];
  }
  cursorTo(i, instant = false) {
    const tab = this.tabs[i];
    if (!tab || !tab.offsetWidth) return; // hidden: nothing to measure yet
    const [x, w] = this.target(i);
    this.move(x, w, instant);
  }
  select(i, { fromUser = false, instant = false } = {}) {
    const changed = i !== this.selected;
    this.selected = i;
    this.tabs.forEach((t, j) => t.setAttribute("aria-selected", String(j === i)));
    this.cursorTo(i, instant);
    if (fromUser) this.play(i);
    if (fromUser && changed) this.onSelect?.(this.tabs[i], i);
  }
  place() { this.cursorTo(this.selected, true); }
  /** the tapped tab's icon plays its little scene (CSS, `[data-fx]`), once more even if it was already playing */
  play(i) {
    const tab = this.tabs[i];
    if (!tab.querySelector("svg")) return;
    tab.removeAttribute("data-fx");
    void tab.offsetWidth;
    tab.setAttribute("data-fx", "");
  }
}

const TABS = ["schedule", "clubs", "profile"];
const tabbarTabs = new SlideTabs(tabbar, (tab) => {
  haptic();
  state.tab = tab.dataset.tab;
  if (state.tab === "schedule") { state.selected = now().iso; state.weekStart = mondayOf(state.selected); enterNext = true; }
  if (state.tab === "clubs" && state.clubView?.kind === "club") { state.clubView.data = null; state.clubView.feed = null; }
  if (state.tab === "clubs") state.sharedFeed = null;
  render();
  window.scrollTo(0, 0);
}, { fit: true });
let profileTabs = null;

function showTabbar(on) {
  const wasHidden = tabbar.hidden;
  tabbar.hidden = !on;
  tabbar.classList.remove("away");
  if (on) tabbarTabs.select(TABS.indexOf(state.tab), { instant: wasHidden });
}

// the bar steps aside while you scroll down through the day and comes back as soon as you scroll up
let lastScrollY = 0;
addEventListener("scroll", () => {
  syncMiniHead();
  const y = window.scrollY, d = y - lastScrollY;
  if (Math.abs(d) < 8) return;
  tabbar.classList.toggle("away", d > 0 && y > 80);
  lastScrollY = y;
}, { passive: true });

/* the compact title: as the page's big title scrolls under the top edge it fades and shrinks, and a small copy
   of it settles into a blurred bar there (--p, 0 to 1, follows the scroll); a tap on the bar goes back up */
const miniHead = Object.assign(document.createElement("div"), { className: "mini-head", innerHTML: "<b></b>" });
miniHead.setAttribute("aria-hidden", "true");
document.body.append(miniHead);
miniHead.addEventListener("click", () => { haptic(); scrollTo({ top: 0, behavior: reduceMotion.matches ? "auto" : "smooth" }); });
let bigTitle = null;
function syncMiniHead() {
  if (!bigTitle?.isConnected) {
    bigTitle = app.querySelector("h1");
    miniHead.firstChild.textContent = bigTitle?.textContent.trim() || "";
  }
  const r = bigTitle?.getBoundingClientRect();
  // how far the title has gone under the bar since the page was at the top: a title that sits under the bar's
  // area to begin with (the clubs tab's) counts from there, so the bar never shows on a page nobody scrolled
  const bar = miniHead.offsetHeight;
  const under = r ? bar - r.top - Math.max(0, bar - (r.top + scrollY)) : 0;
  const p = r ? Math.min(1, Math.max(0, under / Math.max(1, r.height))) : 0;
  miniHead.style.setProperty("--p", p.toFixed(3));
  miniHead.classList.toggle("shown", p > 0);
  miniHead.classList.toggle("on", p > 0.6);
  if (bigTitle) {
    bigTitle.style.opacity = p ? String(1 - 0.85 * p) : "";
    bigTitle.style.transform = p ? `scale(${1 - 0.06 * p})` : "";
  }
}
// endless little loops (the running pair's pulse and sheen, the empty states' waves and flag) rest while their card
// is off the screen (.loop.off) or under a sheet (app.css)
const loopWatch = "IntersectionObserver" in window
  ? new IntersectionObserver((seen) => seen.forEach((e) => e.target.classList.toggle("off", !e.isIntersecting))) : null;
function watchLoops() {
  if (!loopWatch) return;
  loopWatch.disconnect();   // the cards of the screen before are gone: only today's are watched
  app.querySelectorAll(".loop").forEach((el) => loopWatch.observe(el));
}
// a new screen brings a new big title, and maybe new loops
new MutationObserver(() => { bigTitle = null; requestAnimationFrame(() => { syncMiniHead(); watchLoops(); }); }).observe(app, { childList: true, subtree: true });
function placeTabs() {
  tabbarTabs.place();
  if (profileTabs?.root.isConnected) profileTabs.place();
  if (schedTabs?.root.isConnected) schedTabs.place();
  if (clubTabs?.root.isConnected) clubTabs.place();
  if (clubsTabs?.root.isConnected) clubsTabs.place();
}
addEventListener("resize", placeTabs);
document.fonts?.ready.then(placeTabs); // label widths change once Inter arrives

function render() {
  if (state.ob) return renderOnboarding();
  showTabbar(true);
  setBack(null);
  if (state.tab === "clubs") renderClubs();
  else if (state.tab === "profile") renderProfile();
  else renderSchedule();
}

/** grey shapes of the day screen while it loads, a light running across them all at once */
function renderLoading() {
  showTabbar(false);
  app.innerHTML = `
    <div class="skeleton" role="status" aria-label="Загружаем расписание">
      <div class="sk-row"><i class="sk" style="flex:1;height:46px;border-radius:999px"></i><i class="sk" style="width:46px;height:46px;border-radius:50%"></i></div>
      <i class="sk" style="width:62%;height:28px;margin-top:22px"></i>
      <i class="sk" style="width:44%;height:16px;margin-top:10px"></i>
      <div class="sk-row" style="margin-top:22px">${'<i class="sk" style="flex:1;height:64px;border-radius:14px"></i>'.repeat(6)}</div>
      ${daySkeleton()}
    </div>`;
}
/** the body of a day while its week loads: the time strip, the lead card, two pairs */
const daySkeleton = () => `
  <i class="sk" style="width:100%;height:8px;margin-top:26px"></i>
  <i class="sk" style="width:100%;height:176px;margin-top:28px;border-radius:var(--radius-card)"></i>
  <i class="sk" style="width:40%;height:18px;margin-top:28px"></i>
  <i class="sk" style="width:100%;height:70px;margin-top:12px;border-radius:16px"></i>
  <i class="sk" style="width:100%;height:70px;margin-top:8px;border-radius:16px"></i>`;

/** the admin banned this account: nothing else opens, the bot says the same */
function renderBanned(ban) {
  state.banned = state.gone = true;
  showTabbar(false);
  try { closeSheet(true); } catch (_) {}
  const until = ban.until ? `до ${new Date(ban.until).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}` : "бессрочно";
  app.innerHTML = `<div class="center"><p><strong>Аккаунт заблокирован</strong>Администратор заблокировал ваш аккаунт ${until}.${
    ban.reason ? `<br>Причина: ${esc(ban.reason)}` : ""}</p>
    <button class="btn inline" id="banned-contact">Написать разработчику</button></div>`;
  document.getElementById("banned-contact").addEventListener("click", () => openOut(`https://t.me/${ban.contact || DEVELOPER}`));
}

function renderError(err, retry) {
  showTabbar(false);
  const denied = err instanceof HttpError && err.status === 401;
  app.innerHTML = denied && !inTelegram
    ? `<div class="center"><p><strong>Откройте через Telegram</strong>Приложение работает внутри Telegram: найдите бота и нажмите «Расписание».</p></div>`
    : denied
    ? `<div class="center"><p><strong>Не получилось войти</strong>Telegram не подтвердил вход. Закройте приложение и откройте его снова кнопкой «Расписание» в боте.</p><button class="btn inline" id="retry">Попробовать ещё раз</button></div>`
    : `<div class="center"><p><strong>Не получилось загрузить</strong>Проверьте интернет и попробуйте ещё раз.</p><button class="btn inline" id="retry">Повторить</button></div>`;
  document.getElementById("retry")?.addEventListener("click", retry);
}

/* ---------- the app outside Telegram: on a phone's home screen, signed in through the bot, working offline ----------
   Telegram cannot open the Mini App without the internet, so the offline app lives on the home screen.
   It signs in through the bot: a code in the t.me link, the student's "yes" there, and a key for this device. */

const DEV_HOSTS = ["localhost", "127.0.0.1"];   // python run.py --local: no worker, so every edit shows at once
function registerWorker() {
  if (!("serviceWorker" in navigator) || DEV_HOSTS.includes(location.hostname)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// with no network the worker answers from its saved copy and marks the answer with X-Saved-At
const offlinePill = Object.assign(document.createElement("div"), { className: "offline-pill", hidden: true });
offlinePill.setAttribute("role", "status");
document.body.append(offlinePill);
const savedText = (iso) => new Date(iso).toLocaleString("ru-RU",
  { timeZone: "Europe/Moscow", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
function noteSaved(savedAt) {
  const was = state.offline;
  state.offline = savedAt ? (was && was < savedAt ? was : savedAt) : null;   // the oldest data on screen
  if (state.offline === was) return;
  offlinePill.hidden = !state.offline;
  offlinePill.textContent = state.offline ? `Нет сети · данные от ${savedText(state.offline)}` : "";
}
// back online: fresh pairs and people instead of the saved ones
addEventListener("online", async () => {
  if (!state.offline || !state.me?.consent || state.ob || state.signingIn) return;
  state.loadedWeeks.clear();
  try { await loadWeek(state.weekStart || mondayOf(now().iso)); } catch (_) { return; }
  if (state.tab === "schedule") renderSchedule();
  loadFriends();
  loadClubs();
  loadUnread();
});

/** saves what the app may need without the internet: four weeks of pairs (as far as the statistics go)
    and each friend's week. The worker keeps every answer; inside Telegram nothing is saved. */
async function warmOffline() {
  if (inTelegram || !deviceKey() || !navigator.onLine) return;
  const monday = mondayOf(now().iso);
  for (let i = 0; i < 4; i++) await loadWeek(addDays(monday, i * 7)).catch(() => {});
  api("/api/settings").catch(() => {});
  const friends = state.friends?.friends || (await api("/api/friends").catch(() => null))?.friends || [];
  for (const f of friends) await api(`/api/friends/${f.tg_id}/schedule?start=${monday}&end=${addDays(monday, 6)}`).catch(() => {});
}

/* ---------- putting the app on the home screen: offered at the first launch in Telegram, and in the browser
   shown step by step for this very phone, with an arrow at the browser's own button ---------- */

let installPrompt = null;   // the browser's own install dialog (Chrome and its kin), held for our button
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; refreshInstall(); });
addEventListener("appinstalled", () => { installPrompt = null; refreshInstall(); });
const UA = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(UA);
// a browser inside another app (Telegram's own, VK, Instagram) cannot put a site on the home screen
const inOtherApp = !inTelegram && ((isIOS && !/Safari\//.test(UA)) || /Telegram|; wv\)|FBAN|FBAV|Instagram|VKClient/.test(UA));
const tgPhone = () => (/^android/.test(tg?.platform || "") ? "android" : tg?.platform === "ios" ? "ios" : null);

/** how this browser puts a site on the home screen; null when the app is there already, or in Telegram */
function installKind() {
  if (standalone || inTelegram) return null;
  if (inOtherApp) return isIOS ? "ios-app" : "android-app";
  if (isIOS) return "ios";
  if (installPrompt) return "button";
  return isAndroid ? "android" : null;
}
const IOS_STEPS = [
  "Нажмите <b>«•••»</b> справа от адреса внизу экрана. Если адрес вверху, нажмите значок <b>«Поделиться»</b>.",
  "Выберите <b>«Поделиться»</b>, пролистайте вниз и нажмите <b>«На экран „Домой“»</b>.",
  "Нажмите <b>«Добавить»</b> и откройте иконку «Расписание». Если попросит войти, нажмите «Войти через Telegram».",
];
const ANDROID_STEPS = [
  "Нажмите меню <b>⋮</b> в правом верхнем углу браузера.",
  "Выберите <b>«Установить приложение»</b> или <b>«Добавить на главный экран»</b>.",
  "Подтвердите: <b>«Установить»</b>. Иконка «Расписание» появится на главном экране.",
];
const INSTALL_STEPS = {
  ios: IOS_STEPS,
  "ios-app": ["Ссылка открылась внутри другого приложения, отсюда её не поставить. Откройте её в <b>Safari</b>: «Открыть в Safari» в меню этого окна или скопируйте ссылку кнопкой ниже.", ...IOS_STEPS],
  button: ["Нажмите <b>«Установить приложение»</b> ниже.", "Подтвердите: <b>«Установить»</b>. Иконка «Расписание» появится на главном экране."],
  android: ANDROID_STEPS,
  "android-app": ["Ссылка открылась внутри другого приложения. Откройте её в <b>Chrome</b>: меню <b>⋮</b> → «Открыть в Chrome» или скопируйте ссылку кнопкой ниже.", ...ANDROID_STEPS],
};
const stepsList = (steps) => `<ol class="install-steps">${steps.map((s) => `<li>${s}</li>`).join("")}</ol>`;
function installBlock(kind) {
  if (!kind) return "";
  const action = kind === "button" ? `<button class="btn" data-install-go>Установить приложение</button>`
    : kind.endsWith("-app") ? `<button class="btn secondary" data-copy-link>Скопировать ссылку</button><p class="btn-note" data-copy-note aria-live="polite"></p>`
    : "";
  return stepsList(INSTALL_STEPS[kind]) + action;
}
function bindInstall(root) {
  root.querySelectorAll("[data-install-go]").forEach((b) => b.addEventListener("click", async () => {
    if (!installPrompt) return;
    haptic();
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    refreshInstall();
  }));
  root.querySelectorAll("[data-copy-link]").forEach((b) => b.addEventListener("click", async () => {
    const ok = await copyText(location.href);
    const note = root.querySelector("[data-copy-note]");
    if (note) note.textContent = ok ? "Ссылка скопирована. Вставьте её в адресную строку браузера." : "Не получилось скопировать, выделите адрес вручную.";
    haptic(ok ? "success" : "error");
  }));
}
/** Chrome may offer its install dialog a moment after the page opens: redraw what depends on it */
function refreshInstall() {
  document.querySelectorAll("[data-install]").forEach((el) => { el.innerHTML = installBlock(installKind()); bindInstall(el); });
  if (document.querySelector(".install-pointer")) showPointer(installKind());
}

// the arrow at the browser's own button: Safari's «•••» at the bottom right, Chrome's ⋮ at the top right
const POINTER = { ios: "down", android: "up", "android-app": "up" };
function showPointer(kind) {
  hidePointer();
  if (!POINTER[kind]) return;
  const el = document.createElement("div");
  el.className = `install-pointer ${POINTER[kind]}`;
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = svg('<path d="M12 4v15M6 13l6 6 6-6"/>');
  document.body.append(el);
}
function hidePointer() {
  document.querySelector(".install-pointer")?.remove();
}

const GUIDE_KEY = "msu.installGuide";   // this browser has shown the guide by itself once
function openInstallGuide() {
  const kind = installKind();
  if (!kind) return;
  try { localStorage.setItem(GUIDE_KEY, "1"); } catch (_) {}
  haptic();
  openSheet(`
    <div class="sheet-head"><div>
      <h2 id="sheet-title">Поставьте расписание на главный экран</h2>
      <p>Иконка на телефоне: пары, статистика и друзья открываются даже без интернета.</p>
    </div></div>
    <div data-install>${installBlock(kind)}</div>
    <button class="btn-text" data-close>Позже</button>
    ${POINTER[kind] === "down" ? `<div class="pointer-room"></div>` : ""}`, (panel) => bindInstall(panel));
  showPointer(kind);
}
/** in a phone's browser the guide opens by itself: after the link from Telegram, and once on a first visit */
function maybeShowGuide(fromTelegram) {
  if (!installKind() || !(isIOS || isAndroid)) return;
  let shown = false;
  try { shown = Boolean(localStorage.getItem(GUIDE_KEY)); } catch (_) {}
  if (fromTelegram || !shown) setTimeout(() => { if (sheet.hidden && !state.signingIn) openInstallGuide(); }, 700);
}

/** a link from Telegram that opened inside another app's browser: the sign-in in it waits for Safari or Chrome */
function renderOpenOutside() {
  showTabbar(false);
  const where = isIOS ? "Safari" : "Chrome";
  app.innerHTML = `
    <section class="ob signin">
      <img class="signin-mark" src="icons/icon-192.png" alt="">
      <h1>Откройте ссылку в ${where}</h1>
      <p class="lead">Она открылась внутри другого приложения, а на главный экран «Расписание» ставится только из ${isIOS ? "Safari" : "браузера"}. Вход уже готов: он сработает там.</p>
      <div class="grow"></div>
      ${stepsList([isIOS
        ? "Нажмите <b>«Открыть в Safari»</b>: значок компаса или пункт в меню этого окна."
        : "Нажмите меню <b>⋮</b> и выберите <b>«Открыть в Chrome»</b> или «Открыть в браузере».",
        `Не получается? Скопируйте ссылку и вставьте её в адресную строку ${where}. Она работает 10 минут и входит в ваш аккаунт, никому её не пересылайте.`])}
      <button class="btn" data-copy-link>Скопировать ссылку</button>
      <p class="btn-note" data-copy-note aria-live="polite"></p>
    </section>`;
  bindInstall(app);
  showPointer(isIOS ? "" : "android-app");
}

/* the offer of the app for the phone comes from the bot, with «Скачать» and «Нет, не надо»: right after
   sign-up, and once to those who signed up before it existed. The server sends it, once per student */
function offerInstall() {
  if (inTelegram) api("/api/app-offer", { method: "POST" }).catch(() => {});
}

/** settings in Telegram: the site opens in the phone's browser already signed in, and these are the steps there */
async function openPhoneOffer() {
  haptic();
  const phone = tgPhone();
  const steps = phone === "ios"
    ? ["Нажмите <b>«Открыть в браузере»</b>: откроется сайт приложения, вход уже будет выполнен. Если он открылся внутри Telegram, перейдите в <b>Safari</b>.",
      "Внизу нажмите <b>«•••»</b> → <b>«Поделиться»</b> → <b>«На экран „Домой“»</b> → <b>«Добавить»</b>.",
      "Готово: иконка «Расписание» на экране «Домой»."]
    : phone === "android"
    ? ["Нажмите <b>«Открыть в браузере»</b>: откроется сайт приложения, вход уже будет выполнен.",
      "Нажмите <b>«Установить приложение»</b> и подтвердите. Если кнопки нет: меню <b>⋮</b> → «Добавить на главный экран».",
      "Готово: иконка «Расписание» на главном экране."]
    : ["Нажмите <b>«Открыть в браузере»</b> на телефоне, затем добавьте сайт на главный экран: в Safari через «Поделиться», в Chrome через «Установить приложение»."];
  const draw = (action) => openSheet(`
    <div class="sheet-head" id="phone-offer"><div>
      <h2 id="sheet-title">Расписание на главном экране</h2>
      <p>Поставьте приложение на телефон: пары, статистика и друзья будут открываться даже без интернета. Это займёт полминуты.</p>
    </div></div>
    ${stepsList(steps)}
    <div class="sheet-actions">${action}</div>
    <button class="btn-text" data-close>Позже</button>`, (panel) => {
    const b = panel.querySelector("#phone-open");
    b?.addEventListener("click", () => {
      haptic();
      tg.openLink(b.dataset.url);   // within the tap: Telegram opens links only in answer to one
      b.disabled = true;
      b.textContent = "Открыли в браузере";
    });
  });
  draw(`<button class="btn" disabled>Готовим ссылку…</button>`);
  let url;
  try {
    ({ url } = await api("/api/devices/handoff", { method: "POST" }));
  } catch (e) {
    if (document.getElementById("phone-offer")) draw(`<p class="note">${esc(errText(e))}</p>`);
    return;
  }
  if (!document.getElementById("phone-offer") || sheet.hidden) return;   // closed meanwhile
  draw(`<button class="btn" id="phone-open" data-url="${esc(url)}">Открыть в браузере</button>
    <p class="btn-note">Ссылка входит в ваш аккаунт: она работает один раз и 10 минут, никому её не пересылайте.</p>`);
}

let signIn = null;        // the sign-in waiting for a "yes" in the bot: { code, secret, link, at, waiting }
let signInTimer = null;
const SIGN_IN_FRESH = 9 * 60 * 1000;   // the server keeps a code for 10 minutes

function renderSignIn(note = "") {
  state.signingIn = true;
  clearInterval(liveTimer);
  liveTimer = null;
  closeSheet(true);
  showTabbar(false);
  setBack(null);
  window.scrollTo(0, 0);
  app.innerHTML = `
    <section class="ob signin">
      <img class="signin-mark" src="icons/icon-192.png" alt="">
      <h1>Расписание МГУ Севастополь</h1>
      <p class="lead">Войдите через Telegram: увидите свои пары, друзей и клубы, а расписание будет открываться даже без интернета.</p>
      <div class="grow"></div>
      <p class="note" id="signin-note" ${note ? "" : "hidden"}>${esc(note)}</p>
      <a class="btn" id="signin-go" href="#" target="_blank" rel="noopener" aria-disabled="true">Войти через Telegram</a>
      <p class="btn-note" id="signin-wait" aria-live="polite"></p>
      ${installKind() ? `<div class="signin-install"><h2 class="group-label">Как поставить на главный экран</h2><div data-install>${installBlock(installKind())}</div></div>` : ""}
      <p class="signin-foot">Ещё нет аккаунта? Откройте бота @sevmsubot в Telegram, нажмите «Расписание» и заполните профиль.</p>
      ${POINTER[installKind()] === "down" ? `<div class="pointer-room"></div>` : ""}
    </section>`;
  bindInstall(app);
  showPointer(installKind());
  document.getElementById("signin-go").addEventListener("click", (e) => {
    if (!signIn || Date.now() - signIn.at > SIGN_IN_FRESH) {
      e.preventDefault();
      if (signIn) { signInNote("Ссылка для входа обновилась, нажмите ещё раз."); newSignIn(); }
      return;
    }
    haptic();
    signIn.waiting = true;
    document.getElementById("signin-wait").textContent = "Подтвердите вход в боте и вернитесь сюда.";
    clearTimeout(signInTimer);
    signInTimer = setTimeout(pollSignIn, 2000);
  });
  newSignIn();
}
function signInNote(text) {
  const el = document.getElementById("signin-note");
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

async function newSignIn() {
  const go = document.getElementById("signin-go");
  signIn = null;
  go?.setAttribute("aria-disabled", "true");
  try {
    const r = await api("/api/login/start", { method: "POST" });
    signIn = { ...r, at: Date.now(), waiting: false };
    if (go?.isConnected) { go.href = r.link; go.removeAttribute("aria-disabled"); }
  } catch (e) {
    signInNote(errText(e, "Не получилось связаться с сервером. Проверьте интернет и откройте приложение ещё раз."));
  }
}

/** after the tap, ask every 2 seconds (and on coming back from Telegram) whether the bot got a "yes" */
async function pollSignIn() {
  clearTimeout(signInTimer);
  if (!state.signingIn || !signIn?.waiting) return;
  const wait = document.getElementById("signin-wait");
  let r;
  try {
    r = await api("/api/login/claim", { method: "POST", body: JSON.stringify({ code: signIn.code, secret: signIn.secret }) });
  } catch (_) {
    r = { status: "pending" };   // no network for a moment: ask again
  }
  if (r.status === "ok") return signedIn(r.key);
  if (r.status !== "pending" || Date.now() - signIn.at > SIGN_IN_FRESH) {
    signInNote(r.status === "denied" ? "Вход отменён в боте." : "Ссылка для входа устарела. Нажмите «Войти через Telegram» ещё раз.");
    if (wait) wait.textContent = "";
    return newSignIn();
  }
  if (document.visibilityState === "visible") signInTimer = setTimeout(pollSignIn, 2000);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.signingIn && signIn?.waiting) pollSignIn();
});

async function signedIn(key) {
  clearTimeout(signInTimer);
  signIn = null;
  await forgetDevice();   // nothing saved under another account may show
  setDeviceKey(key);
  location.replace("/");
}

/** the key and everything saved for offline leave this device */
async function forgetDevice() {
  setDeviceKey("");
  forgetGreeting();   // a signed-out phone greets no one by name
  try { await Promise.all(["data", "files"].map((c) => window.caches?.delete(c))); } catch (_) {}
}

/** «Приложение на телефон» in Telegram opens the site with #login=<code>.<secret>: sign in with it at once.
    null without such a link; { ok } or { note } with one */
async function takeHandoff() {
  if (location.hash === "#login=used") {   // the bot's «Скачать» link, opened a second time or after a day
    history.replaceState(null, "", location.pathname + location.search);
    return { note: "Эта ссылка из бота уже использована. Отправьте боту /app, и он пришлёт новую, или войдите через Telegram." };
  }
  const m = location.hash.match(/^#login=([\w-]+)\.([\w-]+)$/);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const r = await api("/api/login/claim", { method: "POST", body: JSON.stringify({ code: m[1], secret: m[2] }) });
    if (r.status === "ok") {
      await forgetDevice();
      setDeviceKey(r.key);
      return { ok: true };
    }
  } catch (_) {}
  return { note: "Ссылка для входа устарела или уже использована. Войдите через Telegram." };
}

async function signOutHere() {
  haptic();
  try { await api("/api/devices/current", { method: "DELETE" }); } catch (_) {}
  await forgetDevice();
  location.replace("/");
}

/** settings: the app on the phone, the devices signed in outside Telegram, signing out here */
function phoneSection() {
  const install = inTelegram || installKind()
    ? `<li><button id="phone-app"><span>${inTelegram ? "Установить на телефон" : "Установить на этот телефон"}<small>Иконка на главном экране, расписание и без интернета</small></span>${icon.right}</button></li>`
    : "";
  const out = !inTelegram && deviceKey()
    ? `<li><button class="danger" id="sign-out"><span>Выйти на этом устройстве<small>Сохранённые расписание и друзья сотрутся с телефона</small></span></button></li>`
    : "";
  return `
    <h2 class="group-label">Приложение на телефоне</h2>
    <ul class="options">
      ${install}
      <li><button id="open-devices"><span>Устройства<small>Где выполнен вход вне Telegram</small></span>${icon.right}</button></li>
      ${out}
    </ul>`;
}
function bindPhoneSection() {
  document.getElementById("phone-app")?.addEventListener("click", inTelegram ? openPhoneOffer : openInstallGuide);
  document.getElementById("open-devices")?.addEventListener("click", openDevicesSheet);
  const out = document.getElementById("sign-out");
  out?.addEventListener("click", () => {
    if (!out.dataset.sure) {
      haptic();
      out.dataset.sure = "1";
      out.querySelector("span").firstChild.textContent = "Точно выйти? Нажмите ещё раз";
      return;
    }
    signOutHere();
  });
}

async function openDevicesSheet() {
  haptic();
  const head = `
    <div class="sheet-head"><div>
      <h2 id="sheet-title">Устройства</h2>
      <p>Где вы вошли в приложение вне Telegram. Если устройство чужое или потерялось, выйдите на нём отсюда.</p>
    </div></div>`;
  openSheet(`${head}<p class="options-note">Загружаем…</p>`);
  let list;
  try {
    list = await api("/api/devices");
  } catch (e) {
    openSheet(`${head}<p class="note">${esc(errText(e))}</p>`);
    return;
  }
  const rows = list.map((d) => `
    <li>
      <div class="device-main">
        <b>${esc(d.name)}</b>${d.current ? `<em class="device-here">это устройство</em>` : ""}
        <small>Вход ${esc(postTime(d.created_at))} · заходили ${esc(postTime(d.seen_at))}</small>
      </div>
      <button class="btn-sm" data-device="${d.id}" data-current="${d.current}">Выйти</button>
    </li>`).join("");
  openSheet(`${head}${rows
    ? `<ul class="device-list">${rows}</ul>`
    : `<p class="note"><strong>Пока нигде</strong>Установите приложение на телефон, и устройство появится здесь.</p>`}`, (panel) => {
    panel.querySelectorAll("[data-device]").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.current === "true") return signOutHere();
      b.disabled = true;
      try {
        await api(`/api/devices/${b.dataset.device}`, { method: "DELETE" });
      } catch (e) {
        b.disabled = false;
        say(errText(e));
        return;
      }
      haptic("success");
      openDevicesSheet();
    }));
  });
}

/* ---------- onboarding: направление → курс → (группа) → имя ---------- */

function startOnboarding(editing = false) {
  const me = state.me, g = me.group;
  state.ob = {
    step: "faculty",
    editing,
    faculty: g ? state.catalog.find((f) => f.id === g.faculty_id) || null : null,
    course: g ? g.course : null,
    group: g ? { id: g.id, name: g.name } : null,
    name: me.real_name || [me.first_name, me.last_name].filter(Boolean).join(" "),
  };
  renderOnboarding();
}

function obSteps() {
  const ob = state.ob;
  const courses = ob.faculty ? ob.faculty.courses : state.catalog.flatMap((f) => f.courses);
  const course = courses.find((c) => c.course === ob.course);
  const needGroup = course ? course.groups.length > 1 : courses.some((c) => c.groups.length > 1);
  return needGroup ? ["faculty", "course", "group", "name"] : ["faculty", "course", "name"];
}
function obGo(step) {
  state.ob.step = step;
  renderOnboarding();
  window.scrollTo(0, 0);
}
function obBack() {
  const steps = obSteps();
  const i = steps.indexOf(state.ob.step);
  if (i > 0) obGo(steps[i - 1]);
  else if (state.ob.editing) { state.ob = null; render(); }
}

function renderOnboarding() {
  showTabbar(false);
  const ob = state.ob;
  const steps = obSteps();
  const idx = steps.indexOf(ob.step);
  const canBack = idx > 0 || ob.editing;
  setBack(canBack ? obBack : null);

  const progress = steps.map((_, i) => `<i class="${i <= idx ? "on" : ""}"></i>`).join("");
  const back = canBack && !inTelegram ? `<button class="ob-back" id="ob-back">${icon.left}Назад</button>` : "";

  let title = "", lead = "", body = "";
  if (ob.step === "faculty") {
    title = "С какого вы направления?";
    lead = ob.editing ? "Выберите заново, если перевелись или ошиблись."
      : `Привет, ${esc(state.me.first_name || "студент")}! Это нужно один раз: потом приложение сразу открывает ваше расписание.`;
    const list = (items) => `<ul class="choice">${items.map((f) => `
      <li><button data-fac="${f.id}" aria-pressed="${ob.faculty?.id === f.id}"><span>${esc(f.name)}</span>${icon.right}</button></li>`).join("")}</ul>`;
    const bach = state.catalog.filter((f) => !f.is_master);
    const mast = state.catalog.filter((f) => f.is_master);
    body = list(bach) + (mast.length ? `<h2 class="choice-label">Магистратура</h2>${list(mast)}` : "");
  } else if (ob.step === "course") {
    title = "На каком вы курсе?";
    lead = `${esc(ob.faculty.name)}${ob.faculty.is_master ? ", магистратура" : ""}`;
    body = `<div class="courses">${ob.faculty.courses.map((c) => `
      <button data-course="${c.course}" aria-label="${c.course} курс" aria-pressed="${ob.course === c.course}"><b>${c.course}</b><span>курс</span></button>`).join("")}</div>`;
  } else if (ob.step === "group") {
    const course = ob.faculty.courses.find((c) => c.course === ob.course);
    title = "Ваша группа";
    lead = `${esc(ob.faculty.name)}, ${courseLabel(ob.course, ob.faculty.is_master)}`;
    body = `<ul class="choice">${course.groups.map((g) => `
      <li><button data-group="${g.id}" aria-pressed="${ob.group?.id === g.id}"><span>${esc(g.name)}</span>${icon.right}</button></li>`).join("")}</ul>`;
  } else {
    title = "Как вас зовут?";
    lead = "Настоящие имя и фамилия. Их увидят друзья, а если хотите другое имя, задайте ник в профиле.";
    body = `
      <div class="field">
        <label for="name">Имя и фамилия</label>
        <input id="name" name="name" autocomplete="name" autocapitalize="words" enterkeyhint="done" maxlength="80"
               placeholder="Например, Анна Ковалёва" value="${esc(ob.name)}">
        <p class="err" id="name-err" hidden></p>
      </div>
      <p class="summary">Группа <b>${esc(ob.group?.name)}</b>, ${courseLabel(ob.course, ob.faculty.is_master)}<br>${esc(ob.faculty.name)}</p>
      ${state.me.consent ? "" : consentCheck(Boolean(ob.consent))}`;
  }

  app.innerHTML = `
    <section class="ob">
      <div class="ob-top">${back}<div class="ob-progress" aria-label="Шаг ${idx + 1} из ${steps.length}">${progress}</div></div>
      <h1>${title}</h1>
      <p class="lead">${lead}</p>
      <div class="ob-body">${body}</div>
      ${ob.step === "name" ? `<div class="grow"></div><button class="btn" id="ob-done">${ob.editing ? "Сохранить" : "Готово"}</button>` : ""}
    </section>`;

  document.getElementById("ob-back")?.addEventListener("click", obBack);
  app.querySelectorAll("[data-fac]").forEach((b) => b.addEventListener("click", () => {
    haptic();
    const f = state.catalog.find((x) => x.id === Number(b.dataset.fac));
    if (ob.faculty?.id !== f.id) { ob.course = null; ob.group = null; }
    ob.faculty = f;
    if (f.courses.length === 1) chooseCourse(f.courses[0].course); else obGo("course");
  }));
  app.querySelectorAll("[data-course]").forEach((b) => b.addEventListener("click", () => { haptic(); chooseCourse(Number(b.dataset.course)); }));
  app.querySelectorAll("[data-group]").forEach((b) => b.addEventListener("click", () => {
    haptic();
    const course = ob.faculty.courses.find((c) => c.course === ob.course);
    ob.group = course.groups.find((g) => g.id === Number(b.dataset.group));
    obGo("name");
  }));
  const input = document.getElementById("name");
  if (input) {
    input.addEventListener("input", () => { ob.name = input.value; document.getElementById("name-err").hidden = true; });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { input.blur(); submitOnboarding(); } });
    document.getElementById("ob-done").addEventListener("click", submitOnboarding);
    bindConsentCheck(app, () => Boolean(ob.consent), (v) => { ob.consent = v; document.getElementById("name-err").hidden = true; }, closeSheet);
  }
}

function chooseCourse(course) {
  const ob = state.ob;
  if (ob.course !== course) ob.group = null;
  ob.course = course;
  const c = ob.faculty.courses.find((x) => x.course === course);
  if (c.groups.length === 1) { ob.group = c.groups[0]; obGo("name"); } else obGo("group");
}

async function submitOnboarding() {
  const ob = state.ob;
  const name = ob.name.trim().replace(/\s+/g, " ");
  const err = document.getElementById("name-err");
  if (name.length < 2) {
    err.textContent = "Напишите имя, хотя бы две буквы.";
    err.hidden = false;
    haptic("error");
    return;
  }
  if (!state.me.consent && !ob.consent) {
    err.textContent = "Отметьте согласие: без него приложение не может сохранить ваши данные.";
    err.hidden = false;
    haptic("error");
    return;
  }
  const btn = document.getElementById("ob-done");
  btn.disabled = true;
  btn.textContent = "Сохраняем…";
  try {
    const changedGroup = state.me.group?.id !== ob.group.id;
    const newcomer = !state.me.consent;
    state.me = await api("/api/profile", { method: "POST",
      body: JSON.stringify({ real_name: name, group_id: ob.group.id, consent: Boolean(ob.consent) }) });
    if (changedGroup) { state.lessons.clear(); state.loadedWeeks.clear(); }
    const wasEditing = ob.editing;
    state.ob = null;
    haptic("success");
    state.tab = wasEditing && !changedGroup ? "profile" : "schedule";
    if (newcomer) await resolveAvatar(state.me);
    await openSchedule();
    startLive();   // a newcomer gets the bot's offer of the app for the phone: the server sends it on sign-up
  } catch (e) {
    btn.disabled = false;
    btn.textContent = ob.editing ? "Сохранить" : "Готово";
    err.textContent = errText(e, "Не получилось сохранить. Проверьте интернет и нажмите ещё раз.");
    err.hidden = false;
    haptic("error");
  }
}

/* ---------- the privacy policy and the consent: two pages that also open in a browser (/privacy, /consent);
   the app shows their #doc part in the bottom sheet ---------- */

const docs = {};
async function loadDoc(name) {
  if (!docs[name]) {
    const res = await fetch(`${name}.html`);
    if (!res.ok) throw new HttpError(res.status, res.statusText);
    docs[name] = new DOMParser().parseFromString(await res.text(), "text/html").getElementById("doc").innerHTML;
  }
  return docs[name];
}

/** a document in the sheet. onAccept adds «Принимаю», which ticks the consent;
    back returns to the sheet it was opened from; locked keeps it from being swiped away */
async function openDocSheet(name, { onAccept, back, locked = false } = {}) {
  haptic();
  const draw = (body) => openSheet(`
    <article class="doc doc-sheet">${body}</article>
    ${onAccept || back ? `<div class="sheet-actions doc-actions">
      ${onAccept ? `<button class="btn" id="doc-accept">Принимаю</button>` : ""}
      ${back ? `<button class="btn secondary" id="doc-back">Назад</button>` : ""}
    </div>` : ""}`, (panel) => {
    panel.scrollTop = 0;
    panel.querySelector("#doc-accept")?.addEventListener("click", () => { haptic("success"); onAccept(); });
    panel.querySelector("#doc-back")?.addEventListener("click", () => { haptic(); back(); });
    panel.querySelectorAll(".doc a").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      if (a.dataset.doc) openDocSheet(a.dataset.doc, { onAccept, back, locked });
      else openOut(a.href);
    }));
  }, { locked });
  draw(`<p class="options-note">Загружаем…</p>`);
  try {
    draw(await loadDoc(name));
  } catch (_) {
    draw(`<p class="note"><strong>Не получилось загрузить</strong>Проверьте интернет и попробуйте ещё раз.</p>`);
  }
}

/** the tick: «Даю согласие… и принимаю политику…»; each underlined part opens its document */
const consentCheck = (ticked) => `
  <div class="consent-check">
    <button type="button" class="tick" id="consent-tick" role="checkbox" aria-checked="${ticked}" aria-labelledby="consent-text">${icon.check}</button>
    <p id="consent-text">Даю <button type="button" class="doc-link" data-consent-doc="consent">согласие на обработку моих данных</button>
      и принимаю <button type="button" class="doc-link" data-consent-doc="privacy">политику конфиденциальности</button></p>
  </div>`;

/** wire the tick: a tap on it or on the plain words toggles it, a tap on an underlined part opens the document */
function bindConsentCheck(root, get, set, reopen) {
  const tick = root.querySelector("#consent-tick");
  if (!tick) return;
  const toggle = () => { haptic(); set(!get()); tick.setAttribute("aria-checked", String(get())); };
  tick.addEventListener("click", toggle);
  root.querySelector("#consent-text").addEventListener("click", (e) => { if (!e.target.closest("[data-consent-doc]")) toggle(); });
  root.querySelectorAll("[data-consent-doc]").forEach((b) => b.addEventListener("click", () =>
    openDocSheet(b.dataset.consentDoc, {
      onAccept: () => { set(true); tick.setAttribute("aria-checked", "true"); reopen(); },
      back: reopen, locked: reopen !== closeSheet })));
}

/* those who signed up before the consent was asked for, or before its new edition, confirm it once, in a sheet over the app */
const CONSENT_NEWS = "Появилось приложение на телефоне: в правилах описано, что хранится на устройствах, где вы вошли вне Telegram.";
function askConsent() {
  renderLoading();
  let ticked = false;
  const draw = () => openSheet(`
    <div class="sheet-head"><div>
      <h2 id="sheet-title">Обновили правила</h2>
      <p>${CONSENT_NEWS} Чтобы продолжить, подтвердите согласие.</p>
    </div></div>
    ${consentCheck(ticked)}
    <p class="err" id="consent-err" hidden></p>
    <button class="btn consent-go" id="consent-go">Продолжить</button>`, (panel) => {
    bindConsentCheck(panel, () => ticked, (v) => { ticked = v; panel.querySelector("#consent-err").hidden = true; }, draw);
    panel.querySelector("#consent-go").addEventListener("click", async (e) => {
      const err = panel.querySelector("#consent-err");
      if (!ticked) {
        err.textContent = "Отметьте согласие: без него приложение не может работать с вашими данными.";
        err.hidden = false;
        haptic("error");
        return;
      }
      e.currentTarget.disabled = true;
      try {
        state.me = await api("/api/consent", { method: "POST" });
      } catch (_) {
        e.currentTarget.disabled = false;
        err.textContent = "Не получилось сохранить. Проверьте интернет и нажмите ещё раз.";
        err.hidden = false;
        haptic("error");
        return;
      }
      haptic("success");
      closeSheet(true);
      await resolveAvatar(state.me);
      await openSchedule();
      startLive();
      warmOffline();
      offerInstall();
      maybeShowGuide(false);
    });
  }, { locked: true });
  draw();
}

/* withdrawing consent: the account and everything tied to it is erased */
function openDeleteSheet() {
  haptic();
  openSheet(`
    <div class="sheet-head"><div>
      <h2 id="sheet-title">Удалить аккаунт?</h2>
      <p>Это отзыв согласия на обработку данных. Сразу и навсегда сотрутся:</p>
    </div></div>
    <ul class="erase-list">
      <li>профиль: имя, ник, группа, фото и «о себе»;</li>
      <li>друзья, заявки и серии огонька;</li>
      <li>ваши записи, комментарии и реакции в клубах, а клубы, где вы одни, целиком;</li>
      <li>напоминания, утренняя сводка, неделя в чате с ботом и ссылка на календарь.</li>
    </ul>
    <p class="erase-note">Если вы владелец клуба, в котором есть участники, сначала передайте права владельца. Из резервных копий данные исчезнут в течение 14 дней.</p>
    <p class="err" id="erase-err" hidden></p>
    <div class="sheet-actions">
      <button class="btn danger" id="erase">Удалить навсегда</button>
      <button class="btn secondary" data-close>Отмена</button>
    </div>`, (panel) => {
    const b = panel.querySelector("#erase");
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.textContent = "Удаляем…";
      try {
        await api("/api/account", { method: "DELETE" });
      } catch (e) {
        haptic("error");
        b.disabled = false;
        b.textContent = "Удалить навсегда";
        const err = panel.querySelector("#erase-err");
        err.textContent = errText(e, "Не получилось удалить. Проверьте интернет и попробуйте ещё раз.");
        err.hidden = false;
        return;
      }
      haptic("success");
      closeSheet();
      renderDeleted();
    });
  });
}

function renderDeleted() {
  state.gone = true;
  clearInterval(liveTimer);
  forgetGreeting();
  if (!inTelegram) forgetDevice();
  document.querySelectorAll(".notice").forEach((n) => n.remove());
  showTabbar(false);
  setBack(null);
  window.scrollTo(0, 0);
  app.innerHTML = `
    <section class="ob">
      <h1>Аккаунт удалён</h1>
      <p class="lead">Ваши данные стёрты, согласие отозвано. Если захотите вернуться, просто откройте приложение снова.</p>
      <div class="grow"></div>
      <button class="btn" id="bye">${inTelegram ? "Закрыть приложение" : "Начать заново"}</button>
    </section>`;
  document.getElementById("bye").addEventListener("click", () => { if (inTelegram) tg.close(); else location.reload(); });
}

const consentNote = (me) => me.consent_at
  ? `Дано ${new Date(me.consent_at).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric" })}`
  : "Что именно вы разрешили";

/* ---------- schedule data ---------- */

async function loadWeek(monday) {
  if (state.loadedWeeks.has(monday)) return;
  const data = await api(`/api/schedule?start=${monday}&end=${addDays(monday, 6)}`);
  for (let i = 0; i < 7; i++) state.lessons.set(addDays(monday, i), []);
  for (const l of data.lessons) state.lessons.get(l.date)?.push(l);
  state.syncedAt = data.synced_at;
  state.loadedWeeks.add(monday);
}

async function loadReminders() {
  try {
    const list = await api("/api/reminders");
    state.reminders = new Map(list.map((r) => [remKey(r.date, r.start, r.subject), r]));
  } catch (_) {}
}
const remKey = (date, start, subject) => `${date}|${start}|${subject}`;

async function openSchedule() {
  state.selected = state.selected || now().iso;
  state.weekStart = mondayOf(state.selected);
  if (!state.loadedWeeks.has(state.weekStart)) renderLoading();
  await Promise.all([loadWeek(state.weekStart), loadReminders()]);
  enterNext = true;
  render();
  // the next pair after today may sit in next week; redraw only if it does, so the cascade plays out
  loadWeek(addDays(mondayOf(now().iso), 7)).then(() => {
    if (!state.ob && state.tab === "schedule" && liveSig(nextPair()) !== state.liveSig) renderSchedule();
  }).catch(() => {});
}

/** pairs of a day, subgroups sharing one slot */
function slotsOf(iso) {
  const slots = [];
  for (const l of state.lessons.get(iso) || []) {
    const last = slots[slots.length - 1];
    if (last && last.pair === l.pair) last.items.push(l);
    else slots.push({ pair: l.pair, start: l.start, end: l.end, items: [l] });
  }
  return slots;
}

/** the pair that matters now: running, or the next one ahead */
function nextPair() {
  const t = now();
  for (let i = 0; i < 14; i++) {
    const iso = addDays(t.iso, i);
    if (!state.lessons.has(iso)) return null;
    for (const s of slotsOf(iso)) {
      const a = toMin(s.start), b = toMin(s.end);
      if (i === 0 && t.min >= b) continue;
      const running = i === 0 && t.min >= a;
      return { iso, slot: s, running, left: running ? b - t.min : null, until: i === 0 && !running ? a - t.min : null };
    }
  }
  return null;
}

const statusText = (nxt) => nxt.running
  ? `Идёт ${nxt.slot.pair} пара · осталось ${duration(nxt.left)}`
  : `${nxt.slot.pair} пара начнётся через ${duration(nxt.until)}`;
const progressOf = (nxt, t) => Math.min(100, Math.max(0,
  ((t.min - toMin(nxt.slot.start)) / (toMin(nxt.slot.end) - toMin(nxt.slot.start))) * 100));
const liveSig = (nxt) => (nxt ? `${nxt.iso}|${nxt.slot.pair}|${nxt.running}` : "none");

/* ---------- screen: schedule ---------- */

// the day's cards rise one after another (.enter .rise) when the day is new on screen: another day, week or view,
// the tab just opened; not when the same day redraws itself
let enterNext = false;
const takeEnter = () => { const e = enterNext; enterNext = false; return e; };

function renderDay({ dir = 0, animateDay = false } = {}) {
  const me = state.me, g = me.group;
  const t = now();
  const iso = state.selected;
  const isToday = iso === t.iso;
  const slots = slotsOf(iso);
  const nxt = nextPair();
  const leadSlot = isToday && nxt && nxt.iso === iso ? nxt.slot : null;

  const rel = relativeDay(iso);
  const span = slots.length ? `${clock(slots[0].start)}–${clock(slots[slots.length - 1].end)}` : "";
  const sub = [rel, slots.length ? pairs(slots.length) : "Пар нет", span].filter(Boolean).join(" · ");

  const header = `
    <header class="title-row">
      <div><h1>${dayTitle(iso)}</h1><p class="sub num">${sub}</p></div>
      <span class="scope">${esc(g.name)}</span>
    </header>`;

  // the day as a time strip, pairs at their real length
  const from = toMin(DAY_START);
  const to = Math.max(toMin(DAY_END_MIN), ...slots.map((s) => toMin(s.end)));
  const pct = (m) => ((m - from) / (to - from)) * 100;
  const isPast = (s) => iso < t.iso || (isToday && t.min >= toMin(s.end));
  const isNow = (s) => isToday && t.min >= toMin(s.start) && t.min < toMin(s.end);
  const strip = slots.length ? `
    <div class="strip rise" style="--i:0" role="img" aria-label="Пары с ${span}" data-from="${from}" data-to="${to}">
      ${slots.map((s) => {
        const cls = isNow(s) ? "now" : isPast(s) ? "past" : "";
        return `<span class="bar ${cls}" style="${hueVar(s.items[0].subject)};left:${pct(toMin(s.start))}%;width:${pct(toMin(s.end)) - pct(toMin(s.start))}%"></span>
                <span class="bar-label num ${cls}" style="left:${pct(toMin(s.start))}%">${clock(s.start)}</span>`;
      }).join("")}
      ${isToday && t.min >= from && t.min <= to ? `<span class="now-line" style="left:${pct(t.min)}%"></span>
        <span class="now-label num" style="left:${Math.min(94, Math.max(6, pct(t.min)))}%">${hm(t.min)}</span>` : ""}
    </div>` : "";

  let lead = "";
  if (leadSlot) {
    const l = leadSlot.items[0];
    const status = `<p class="status num" id="lead-status"><i class="dot ${nxt.running ? "" : "later"}"></i><span>${statusText(nxt)}</span></p>`;
    const progress = nxt.running ? `<div class="lead-progress" aria-hidden="true"><i id="lead-bar" style="width:${progressOf(nxt, nowPrecise())}%"></i></div>` : "";
    lead = `
      <article class="lead-card pressable rise loop" style="${hueVar(l.subject)};--i:1" data-date="${iso}" data-pair="${leadSlot.pair}" data-idx="0" role="button" tabindex="0">
        ${markSvg(l.subject, "mark lead-mark")}
        <h2>${esc(l.subject)}</h2>
        <p class="who">${esc([kindName(l.kind), l.teacher].filter(Boolean).join(" · "))}</p>
        <dl class="facts">
          <div><dt>Аудитория</dt><dd>${esc(l.room || "—")}</dd></div>
          <div><dt>Время</dt><dd>${clock(leadSlot.start)}–${clock(leadSlot.end)}</dd></div>
        </dl>
        ${leadSlot.items.length > 1 ? `<p class="also">Также в это время: ${leadSlot.items.slice(1).map((x) => `${esc(x.subject)}, ауд. ${esc(x.room)}`).join("; ")}</p>` : ""}
        ${status}
        ${progress}
      </article>`;
  }

  const listSlots = slots.filter((s) => !leadSlot || s.pair !== leadSlot.pair);
  let k = 3;   // the cascade: strip 0, lead card 1, title 2, then the pairs
  const rows = listSlots.map((s) => {
    const prev = slots[slots.indexOf(s) - 1]; // the whole day, so a break after the lead pair still shows
    const pause = prev ? toMin(s.start) - toMin(prev.end) : 0;
    const gap = pause >= 30 ? `<li class="gap rise" style="--i:${k++}"><span class="num">${clock(prev.end)}–${clock(s.start)}</span> · перерыв ${duration(pause)}</li>` : "";
    return gap + s.items.map((l, j) => `
      <li class="pair pressable rise ${isPast(s) ? "past" : ""}" style="${hueVar(l.subject)};--i:${k++}" data-date="${iso}" data-pair="${s.pair}" data-idx="${j}" role="button" tabindex="0">
        <span class="t">${clock(s.start)}<br>${clock(s.end)}</span>
        <div>
          <h3>${esc(l.subject)}</h3>
          <p>${esc(kindName(l.kind))}${l.room ? ` · <b>ауд. ${esc(l.room)}</b>` : ""}${l.teacher ? ` · ${esc(shortName(l.teacher))}` : ""}${state.reminders.has(remKey(iso, l.start, l.subject)) ? ` · <span class="reminded ${freshReminder === remKey(iso, l.start, l.subject) ? "fresh" : ""}">напомню</span>` : ""}</p>
        </div>
        ${markSvg(l.subject)}
      </li>`).join("");
  }).join("");

  let body;
  if (!slots.length) body = emptyDay(iso, t, nxt);
  else if (isToday && !leadSlot) body = `<div class="done rise" style="--i:1"><h2>На сегодня всё</h2><p>${nextLine(nxt)}</p></div><h2 class="section-title rise" style="--i:2">Пары сегодня</h2><ul class="pairs">${rows}</ul>`;
  else body = `${lead}${rows ? `<h2 class="section-title rise" style="--i:2">${leadSlot ? "Остальные пары" : "Пары"}</h2><ul class="pairs">${rows}</ul>` : ""}`;

  const slide = dir ? (dir > 0 ? "slide-next" : "slide-prev") : "";
  const enter = Boolean(dir) || takeEnter();
  scheduleHost().innerHTML = `${header}${weekPicker(t)}<div class="day-body ${slide} ${enter ? "enter" : ""}">${strip}${body}${sourceLine()}</div>`;
  state.liveSig = liveSig(nxt);
  bindSchedule(animateDay);
}

function nextLine(nxt) {
  if (!nxt) return "Следующих пар в расписании пока нет.";
  const rel = relativeDay(nxt.iso);
  const d = dateOf(nxt.iso);
  const when = rel ? rel.toLowerCase() : `${WEEKDAYS[d.getDay()].toLowerCase()}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const l = nxt.slot.items[0];
  return `Следующая пара ${when} в ${clock(nxt.slot.start)}: ${esc(l.subject)}${l.room ? `, ауд. ${esc(l.room)}` : ""}.`;
}

function emptyDay(iso, t, nxt) {
  if (iso < t.iso) return emptyState("free", "Пар не было", "В этот день занятий не было.");
  const known = [...state.lessons.keys()].filter((d) => (state.lessons.get(d) || []).length).sort().pop();
  if (known && iso > known) return `<p class="note"><strong>Расписание ещё не опубликовано</strong>Университет выкладывает его примерно на месяц вперёд.</p>`;
  return emptyState("free", "Пар нет", iso === t.iso ? nextLine(nxt) : "Свободный день.");
}

function sourceLine() {
  if (!state.syncedAt) return "";
  const time = new Date(state.syncedAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
  return `<p class="source">По данным raspisanie.sev.msu.ru · обновлено ${esc(time)}</p>`;
}

function weekRange(ws, t) {
  const a = dateOf(ws), b = dateOf(addDays(ws, 5));
  const range = a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ${MONTHS[a.getMonth()]}`
    : `${a.getDate()} ${MONTHS_SHORT[a.getMonth()]} – ${b.getDate()} ${MONTHS_SHORT[b.getMonth()]}`;
  const thisWeek = mondayOf(t.iso);
  const name = ws === thisWeek ? "Эта неделя" : ws === addDays(thisWeek, 7) ? "Следующая неделя" : null;
  return { name, range };
}

function weekPicker(t) {
  const ws = state.weekStart;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const iso = addDays(ws, i);
    const n = slotsOf(iso).length;
    if (i === 6 && n === 0) continue; // Sunday only when it has pairs
    const d = dateOf(iso);
    days.push(`
      <button class="day ${iso === t.iso ? "today" : ""}" data-day="${iso}" aria-pressed="${iso === state.selected}"
              aria-label="${dayTitle(iso)}, ${pairs(n)}">
        ${WD_SHORT[d.getDay()]}<b class="num">${d.getDate()}</b><span class="dots">${"<i></i>".repeat(Math.min(n, 6))}</span>
      </button>`);
  }
  const { name, range } = weekRange(ws, t);
  const thisWeek = mondayOf(t.iso);
  return `
    <nav class="week" aria-label="Дни недели">
      <div class="week-head">
        <span>${name ? `${name} · ${range}` : range}</span>
        <div class="week-arrows">
          <button class="icon-btn" id="wk-prev" aria-label="Предыдущая неделя" ${ws <= thisWeek ? "disabled" : ""}>${icon.left}</button>
          <button class="icon-btn" id="wk-next" aria-label="Следующая неделя" ${ws >= addDays(thisWeek, 21) ? "disabled" : ""}>${icon.right}</button>
        </div>
      </div>
      <div class="days" style="--n:${days.length}"><span class="day-cursor" aria-hidden="true"></span>${days.join("")}</div>
    </nav>`;
}

let dayPill = null; // where the week row's pill was, so the next render can spring from there

function bindSchedule(animateDay = false) {
  app.querySelectorAll("[data-day]").forEach((b) => b.addEventListener("click", () => selectDay(b.dataset.day)));
  document.getElementById("wk-prev")?.addEventListener("click", () => shiftWeek(-7));
  document.getElementById("wk-next")?.addEventListener("click", () => shiftWeek(7));
  app.querySelectorAll(".pressable[data-pair]").forEach((el) => {
    const open = () => openPairSheet(el.dataset.date, Number(el.dataset.pair), Number(el.dataset.idx), el);
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });

  const cur = app.querySelector(".day-cursor");
  const sel = app.querySelector('.day[aria-pressed="true"]');
  if (!cur) return;
  if (!sel) { cur.style.opacity = "0"; return; }
  const move = spring((x, w) => {
    cur.style.transform = `translateX(${x}px)`;
    cur.style.width = `${w}px`;
    dayPill = { x, w };
  });
  if (animateDay && dayPill) { move(dayPill.x, dayPill.w, true); move(sel.offsetLeft, sel.offsetWidth); }
  else move(sel.offsetLeft, sel.offsetWidth, true);
}

function selectDay(iso) {
  if (iso === state.selected) return;
  haptic();
  const dir = iso > state.selected ? 1 : -1;
  state.selected = iso;
  renderSchedule({ dir, animateDay: true });
}

async function shiftWeek(delta, selectIso) {
  haptic();
  const ws = addDays(state.weekStart, delta);
  // a week that takes a moment to load shows its skeleton instead of a screen that does not react
  let waiting = false;
  const slow = state.loadedWeeks.has(ws) ? 0 : setTimeout(() => {
    const body = app.querySelector("#sched-body .day-body");
    if (body) { waiting = true; body.innerHTML = `<div class="skeleton" role="status" aria-label="Загружаем неделю">${daySkeleton()}</div>`; }
  }, 160);
  try {
    await loadWeek(ws);
  } catch (_) {
    clearTimeout(slow);
    if (waiting) renderSchedule();
    say(state.offline ? "Эта неделя не сохранена на телефоне: чтобы её открыть, нужен интернет."
      : "Не удалось загрузить неделю. Проверьте интернет.");
    return;
  }
  clearTimeout(slow);
  state.weekStart = ws;
  const t = now();
  state.selected = selectIso || (ws === mondayOf(t.iso) ? t.iso : ws);
  renderSchedule({ dir: delta > 0 ? 1 : -1 });
}

// horizontal swipe between days on the schedule
let touch = null;
app.addEventListener("touchstart", (e) => {
  if (state.ob || state.tab !== "schedule") return;
  const p = e.touches[0];
  touch = { x: p.clientX, y: p.clientY };
}, { passive: true });
app.addEventListener("touchend", (e) => {
  if (!touch || state.ob || state.tab !== "schedule") return;
  const p = e.changedTouches[0];
  const dx = p.clientX - touch.x, dy = p.clientY - touch.y;
  touch = null;
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  if (state.scheduleView !== "day") {
    const ws = addDays(state.weekStart, dx < 0 ? 7 : -7);
    if (ws >= mondayOf(now().iso) && ws <= addDays(mondayOf(now().iso), 21)) shiftWeek(dx < 0 ? 7 : -7);
    return;
  }
  const next = addDays(state.selected, dx < 0 ? 1 : -1);
  const ws = mondayOf(next);
  if (ws === state.weekStart) return selectDay(next);
  if (ws < mondayOf(now().iso) || ws > addDays(mondayOf(now().iso), 21)) return;
  shiftWeek(dx < 0 ? 7 : -7, next);
}, { passive: true });

/* ---------- schedule tab: day, week table or week statistics ---------- */

const SCHEDULE_VIEWS = [["day", "День"], ["week", "Неделя"], ["stats", "Статистика"]];
let schedTabs = null;
/** the switch at the top of the schedule tab stays mounted, so its pill can travel; views render below it */
function scheduleHost() {
  let host = document.getElementById("sched-body");
  if (!host) {
    app.innerHTML = `
      <div class="sched-top">
        <div class="slide-tabs segmented sched-switch" role="tablist" aria-label="Вид расписания">
          <span class="slide-cursor" aria-hidden="true"></span>
          ${SCHEDULE_VIEWS.map(([id, label]) => `<button role="tab" data-sview="${id}" aria-selected="${state.scheduleView === id}">${label}</button>`).join("")}
        </div>
        ${bellButton()}
      </div>
      <div id="sched-body"></div>`;
    document.getElementById("bell").addEventListener("click", openNotifications);
    updateBell();
    schedTabs = new SlideTabs(app.querySelector(".sched-switch"), (tab) => {
      haptic();
      const order = SCHEDULE_VIEWS.map(([id]) => id);
      const dir = Math.sign(order.indexOf(tab.dataset.sview) - order.indexOf(state.scheduleView));
      state.scheduleView = tab.dataset.sview;
      renderSchedule({ dir });
    });
    host = document.getElementById("sched-body");
  }
  return host;
}

function renderSchedule(opts = {}) {
  if (state.scheduleView === "stats") renderStats(opts);
  else if (state.scheduleView === "week") renderWeek(opts);
  else renderDay(opts);
}

/* ---------- week table: days down, pairs across, so a missing pair is a visible hole ---------- */

// standard pair times, for a column no lesson this week fills
const PAIR_TIMES = { 1: ["09:00", "10:30"], 2: ["10:40", "12:10"], 3: ["12:55", "14:25"], 4: ["14:35", "16:05"], 5: ["16:15", "17:45"], 6: ["17:55", "19:25"] };
const SHORT_NAMES = [
  [/^математический анализ/i, "Матанализ"],
  [/^физическая культура/i, "Физ-ра"],
  [/^безопасность жизнедеятельности/i, "БЖД"],
  [/^иностранный язык/i, "Иностр. язык"],
  [/^алгоритмы и алгоритмические языки/i, "Алгоритмы"],
  [/^практикум на эвм/i, "Практикум ЭВМ"],
  [/^алгебра и геометрия/i, "Алгебра и геометрия"],
  [/^история россии/i, "История России"],
];
function shortSubject(name) {
  for (const [re, short] of SHORT_NAMES) if (re.test(name)) return short;
  return name.replace(/\s*\(.*?\)\s*/g, " ").trim();
}

// a week of five to seven pairs gives a cell a fifth to a seventh of the screen: names shrink further
const TINY_NAMES = [[/^математический анализ/i, "Матан"], [/^иностранный язык/i, "Ин. яз."]];
const MINOR_WORDS = new Set(["в", "во", "на", "по", "к", "ко", "с", "со", "о", "об", "для", "из", "от", "при"]);
/** a long word cut to its stem the Russian way, after a consonant and before a vowel: «Классическая» → «Класс.» */
function stem(word) {
  if (word.length <= 6 || word.endsWith(".")) return word;
  for (let i = 3; i < word.length - 2; i++) {
    if (!/[аеёиоуыэюяь]/i.test(word[i]) || /[аеёиоуыэюяйьъ]/i.test(word[i - 1])) continue;   // «Комп|ьютерное»
    if (!/^(без|под|над|про|при)$/i.test(word.slice(0, i))) return word.slice(0, i) + "."; // «без.» would read as "without"
  }
  return word;
}
/** a name of several words keeps their stems, without the prepositions (Опер. сист., Теория вер. и мат. стат.):
    unlike initials they read without knowing the course; a one-word name stays whole and hyphenates */
function tinySubject(name) {
  for (const [re, short] of TINY_NAMES) if (re.test(name)) return short;
  const short = shortSubject(name);
  const words = short.split(/\s+/).filter((w) => !MINOR_WORDS.has(w.toLowerCase()));
  return words.length >= 2 ? words.map(stem).join(" ") : short;
}

/** soft hyphens at the syllable joints of long words (Пси-хо-ло-гия, Клас-си-чес-кая), so a narrow cell breaks
    a word the Russian way in every browser, with or without a hyphenation dictionary */
function syllables(text) {
  const V = /[аеёиоуыэюя]/i, C = /[бвгджзклмнпрстфхцчшщ]/i, X = /[йьъ]/i;
  return text.replace(/[а-яё]{5,}/gi, (w) => {
    let out = "", from = 0;
    for (let p = 2; p <= w.length - 2; p++) {
      const a = w[p - 1], b = w[p];
      if (X.test(b) || !V.test(w.slice(from, p)) || !V.test(w.slice(p))) continue;
      const joint = (X.test(a) && C.test(b))                    // конь-ки
        || (V.test(a) && C.test(b) && V.test(w[p + 1]))         // ма-ма
        || (C.test(a) && C.test(b))                             // мас-са
        || (V.test(a) && V.test(b));                            // ди-алог
      if (joint) { out += w.slice(from, p) + "\u00ad"; from = p; }
    }
    return out + w.slice(from);
  });
}

function renderWeek({ dir = 0 } = {}) {
  takeEnter();   // the table appears whole, no cascade
  const t = now();
  const ws = state.weekStart;
  const { name, range } = weekRange(ws, t);
  const thisWeek = mondayOf(t.iso);
  const slide = dir ? (dir > 0 ? "slide-next" : "slide-prev") : "";

  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i))
    .map((iso) => ({ iso, slots: slotsOf(iso) }))
    .filter((d, i) => i < 6 || d.slots.length); // Sunday only when it has pairs
  const all = days.flatMap((d) => d.slots);
  const maxPair = Math.max(4, ...all.map((s) => s.pair));
  const times = {};
  for (const s of all) times[s.pair] = [s.start, s.end];
  const cols = Array.from({ length: maxPair }, (_, i) => i + 1);
  const narrow = maxPair >= 5, dense = maxPair >= 6;
  const subject = (name) => (narrow ? syllables(tinySubject(name)) : shortSubject(name));

  const head = `<div class="wk-corner"></div>${cols.map((p) => {
    const [a] = times[p] || PAIR_TIMES[p] || ["", ""];
    return `<div class="wk-h"><b>${p}</b><span class="num">${a ? clock(a) : ""}</span></div>`;
  }).join("")}`;

  const rows = days.map(({ iso, slots }) => {
    const d = dateOf(iso);
    const isToday = iso === t.iso;
    const label = `<div class="wk-day ${isToday ? "today" : ""}"><b>${WD_SHORT[d.getDay()]}</b><span class="num">${d.getDate()}</span></div>`;
    const cells = cols.map((p) => {
      const s = slots.find((x) => x.pair === p);
      if (!s) return `<div class="wk-cell empty ${isToday ? "today" : ""}" aria-label="${p} пара: нет пары"></div>`;
      const l = s.items[0];
      const past = iso < t.iso || (isToday && t.min >= toMin(s.end));
      const running = isToday && t.min >= toMin(s.start) && t.min < toMin(s.end);
      const more = s.items.length > 1 ? `<span class="wk-more">+${s.items.length - 1}</span>` : "";
      return `
        <button class="wk-cell pressable ${past ? "past" : ""} ${running ? "now" : ""}" style="${hueVar(l.subject)}"
                data-date="${iso}" data-pair="${p}" data-idx="0"
                aria-label="${WEEKDAYS[d.getDay()]}, ${p} пара: ${esc(l.subject)}${l.room ? `, аудитория ${esc(l.room)}` : ""}">
          <span class="wk-name">${esc(subject(l.subject))}</span>
          ${l.room ? `<span class="wk-room num">${esc(l.room)}</span>` : ""}${more}
        </button>`;
    }).join("");
    return label + cells;
  }).join("");

  scheduleHost().innerHTML = `
    <header class="title-row">
      <div><h1>Неделя</h1><p class="sub">${name ? `${name} · ${range}` : range}</p></div>
      <div class="week-arrows">
        <button class="icon-btn" id="wk-prev" aria-label="Предыдущая неделя" ${ws <= thisWeek ? "disabled" : ""}>${icon.left}</button>
        <button class="icon-btn" id="wk-next" aria-label="Следующая неделя" ${ws >= addDays(thisWeek, 21) ? "disabled" : ""}>${icon.right}</button>
      </div>
    </header>
    <div class="day-body ${slide}">
      <div class="wk-wrap">
        <div class="wk-table ${narrow ? "narrow" : ""} ${dense ? "dense" : ""}" style="--cols:${maxPair}" role="grid" aria-label="Расписание на неделю">${head}${rows}</div>
      </div>
      <p class="wk-key"><i class="wk-swatch" aria-hidden="true"></i>нет пары</p>
      ${sourceLine()}
    </div>`;

  bindStats(); // the week arrows
  app.querySelectorAll(".wk-cell.pressable").forEach((el) => {
    el.addEventListener("click", () => openPairSheet(el.dataset.date, Number(el.dataset.pair), Number(el.dataset.idx), el));
  });
}



/* ---------- donut chart: the DonutChart component (React + framer-motion) ported to SVG + CSS ---------- */

/** segments: [{ label, value, color }]; returns the markup, then call bindDonut on its root */
function donutHtml(segments, { size = 216, stroke = 26, centerLabel, centerValue }) {
  const r = size / 2 - stroke / 2;
  const C = 2 * Math.PI * r;
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  let cum = 0;
  const circles = segments.map((s, i) => {
    const frac = s.value / total;
    const off = -cum * C;
    cum += frac;
    return { v: s.value, i, html: `<circle class="seg" data-i="${i}" data-v="${s.value}" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"
      stroke-dasharray="${Math.max(0.01, frac * C)} ${C}" style="--c:${s.color};--d:${i * 50}ms;stroke-dashoffset:${C}" data-off="${off}"></circle>` };
  })
    // drawn largest first: each smaller subject's round end dips into its larger neighbour, as in the reference
    .sort((a, b) => b.v - a.v || a.i - b.i)
    .map((c) => c.html).join("");
  return `
    <div class="donut" style="width:${size}px;height:${size}px" data-total="${total}">
      <svg class="donut-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
        <circle class="donut-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"></circle>
        ${circles}
      </svg>
      <div class="donut-center" style="inset:${stroke * 1.25}px" aria-live="polite">
        <div class="donut-text"><span>${esc(centerLabel)}</span><b class="num">${centerValue}</b></div>
      </div>
    </div>`;
}

/** sweeps the segments in, and lets a segment or its legend row take the centre */
function bindDonut(root, segments, legend, { centerLabel, centerValue, unit }) {
  const donut = root.querySelector(".donut");
  const segs = [...donut.querySelectorAll(".seg")];
  const svg = donut.querySelector("svg");
  // the picked subject comes to the top of the stack; otherwise smaller subjects sit over larger ones
  const restack = (i) => {
    const order = [...segs].sort((a, b) => Number(b.dataset.v) - Number(a.dataset.v) || Number(a.dataset.i) - Number(b.dataset.i));
    const picked = order.findIndex((c) => Number(c.dataset.i) === i);
    if (picked >= 0) order.push(order.splice(picked, 1)[0]);
    order.forEach((c) => svg.appendChild(c));
  };
  const rows = [...legend.querySelectorAll("[data-i]")];
  const center = donut.querySelector(".donut-center");
  const total = Number(donut.dataset.total);
  let active = -1;

  requestAnimationFrame(() => requestAnimationFrame(() => {
    segs.forEach((c) => { c.style.strokeDashoffset = c.dataset.off; c.classList.add("in"); });
  }));

  const show = (i) => {
    if (i === active) return;
    active = i;
    restack(i);
    donut.classList.toggle("has-active", i >= 0);
    segs.forEach((c) => c.classList.toggle("active", Number(c.dataset.i) === i));
    rows.forEach((r) => r.classList.toggle("active", Number(r.dataset.i) === i));
    const s = segments[i];
    const was = center.querySelector("b")?.dataset.roll;
    center.innerHTML = s
      ? `<div class="donut-text swap"><span>${esc(s.label)}</span><b class="num">${s.value}</b><small class="num">${unit(s.value)} · ${Math.round((s.value / total) * 100)}%</small></div>`
      : `<div class="donut-text swap"><span>${esc(centerLabel)}</span><b class="num">${centerValue}</b></div>`;
    const b = center.querySelector("b");
    if (was) rollTo(b, b.textContent, { from: was });
  };
  const pick = (i) => { haptic(); show(active === i ? -1 : i); };
  segs.forEach((c) => {
    const i = Number(c.dataset.i);
    c.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") show(i); });
    c.addEventListener("click", () => pick(i));
  });
  donut.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") show(-1); });
  rows.forEach((r) => {
    const i = Number(r.dataset.i);
    r.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") show(i); });
    r.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") show(-1); });
    r.addEventListener("click", () => pick(i));
  });
}

/* ---------- week statistics ---------- */

const ACADEMIC_HOUR = 45; // minutes
const HUE_OF_KIND = { "Лекция": "blue", "Семинар": "green", "Практика": "yellow", "Лабораторная": "pink" };
const WEEKDAYS_IN = ["в воскресенье", "в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу"];

function weekStats(ws, t) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const byDay = days.map((iso) => ({ iso, slots: slotsOf(iso) }));
  const slots = byDay.flatMap((d) => d.slots.map((s) => ({ ...s, iso: d.iso })));
  const minutes = slots.reduce((a, s) => a + toMin(s.end) - toMin(s.start), 0);

  const count = (key) => {
    const m = new Map();
    for (const s of slots) { const k = key(s); if (k) m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
  };
  const subjects = count((s) => s.items[0].subject);
  const kinds = count((s) => kindName(s.items[0].kind) || "Другое");
  const teachers = count((s) => s.items[0].teacher);

  const workdays = byDay.filter((d) => d.slots.length);
  const most = Math.max(0, ...workdays.map((d) => d.slots.length));
  const least = Math.min(...workdays.map((d) => d.slots.length));
  const busiest = workdays.filter((d) => d.slots.length === most);  // ties are all named
  const lightest = workdays.filter((d) => d.slots.length === least);

  // a window is a missed pair number between two pairs of the same day
  const windows = [];
  for (const d of byDay) {
    for (let i = 1; i < d.slots.length; i++) {
      const missed = d.slots[i].pair - d.slots[i - 1].pair - 1;
      if (missed > 0) windows.push({ iso: d.iso, missed });
    }
  }

  const earliest = slots.reduce((a, s) => (!a || toMin(s.start) < toMin(a.start) ? s : a), null);
  const latest = slots.reduce((a, s) => (!a || toMin(s.end) > toMin(a.end) ? s : a), null);
  const done = slots.filter((s) => s.iso < t.iso || (s.iso === t.iso && t.min >= toMin(s.end))).length;

  return { byDay, slots, minutes, subjects, kinds, teachers, busiest, lightest, windows, earliest, latest, done };
}

/** "Среда · 4 пары", or "ср, чт, пт · 4 пары" when several days tie */
const daysText = (days) => `${days.length > 1 ? days.map((d) => weekdayShort(d.iso)).join(", ") : WEEKDAYS[dateOf(days[0].iso).getDay()]} · ${pairs(days[0].slots.length)}`;
const hoursText = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".", ","));
const weekdayShort = (iso) => WD_SHORT[dateOf(iso).getDay()].toLowerCase();

function renderStats({ dir = 0 } = {}) {
  const t = now();
  const ws = state.weekStart;
  const { name, range } = weekRange(ws, t);
  const st = weekStats(ws, t);
  const thisWeek = mondayOf(t.iso);
  const slide = dir ? (dir > 0 ? "slide-next" : "slide-prev") : "";

  const header = `
    <header class="title-row">
      <div><h1>Статистика недели</h1><p class="sub">${name ? `${name} · ${range}` : range}</p></div>
      <div class="week-arrows">
        <button class="icon-btn" id="wk-prev" aria-label="Предыдущая неделя" ${ws <= thisWeek ? "disabled" : ""}>${icon.left}</button>
        <button class="icon-btn" id="wk-next" aria-label="Следующая неделя" ${ws >= addDays(thisWeek, 21) ? "disabled" : ""}>${icon.right}</button>
      </div>
    </header>`;

  if (!st.slots.length) {
    scheduleHost().innerHTML = `${header}<div class="day-body ${slide}">${emptyState("free", "На этой неделе пар нет",
      "Свободная неделя.")}</div>`;
    bindStats();
    return;
  }

  const pairsTotal = st.slots.length;
  const acad = st.minutes / ACADEMIC_HOUR;
  const hours = st.minutes / 60;
  const pairUnit = (n) => plural(n, "пара", "пары", "пар");

  const subjectSegs = st.subjects.map(([label, value]) => ({ label, value, color: `var(--hue-${subjectStyle(label).hue})` }));
  const legend = subjectSegs.map((s, i) => `
    <li><button data-i="${i}" style="--c:${s.color}">
      <i></i><span>${esc(s.label)}</span><b class="num">${s.value}</b>
    </button></li>`).join("");

  const kindTotal = st.kinds.reduce((a, [, v]) => a + v, 0);
  const kindBar = st.kinds.map(([k, v]) => `<i style="--c:var(--hue-${HUE_OF_KIND[k] || "orange"});flex:${v}" title="${esc(k)}: ${v}"></i>`).join("");
  const kindLegend = st.kinds.map(([k, v]) => `
    <span style="--c:var(--hue-${HUE_OF_KIND[k] || "orange"})"><i></i>${esc(k)} <b class="num">${v}</b> <small class="num">${Math.round((v / kindTotal) * 100)}%</small></span>`).join("");

  const loadDays = st.byDay.filter((d, i) => i < 6 || d.slots.length);
  const maxLoad = Math.max(1, ...loadDays.map((d) => d.slots.length));
  const load = loadDays.map((d) => {
    const n = d.slots.length;
    const top = st.busiest.some((b) => b.iso === d.iso);
    return `
      <div class="load-col ${top ? "top" : ""} ${d.iso === t.iso ? "today" : ""}" title="${dayTitle(d.iso)}: ${pairs(n)}">
        <span class="n num">${n}</span>
        <i style="height:${(n / maxLoad) * 100}%"></i>
        <span class="d">${WD_SHORT[dateOf(d.iso).getDay()]}</span>
      </div>`;
  }).join("");

  const [topTeacher, topTeacherPairs] = st.teachers[0] || [];
  const windowsText = st.windows.length
    ? `${st.windows.reduce((a, w) => a + w.missed, 0)} · ${[...new Set(st.windows.map((w) => weekdayShort(w.iso)))].join(", ")}`
    : "Нет";
  const facts = [
    st.busiest.length && [st.busiest.length > 1 ? "Самые загруженные дни" : "Самый загруженный день", daysText(st.busiest)],
    st.lightest.length && st.lightest[0].slots.length !== st.busiest[0].slots.length
      && [st.lightest.length > 1 ? "Самые лёгкие дни" : "Самый лёгкий день", daysText(st.lightest)],
    ["Окна между парами", windowsText],
    st.earliest && ["Раньше всего", `${clock(st.earliest.start)} ${WEEKDAYS_IN[dateOf(st.earliest.iso).getDay()]}`],
    st.latest && ["Позже всего", `до ${clock(st.latest.end)} ${WEEKDAYS_IN[dateOf(st.latest.iso).getDay()]}`],
    st.teachers.length && ["Преподавателей", String(st.teachers.length)],
    topTeacher && ["Чаще всех ведёт", `${shortName(topTeacher)} · ${pairs(topTeacherPairs)}`],
  ].filter(Boolean).map(([k, v]) => `<li><span>${k}</span><b class="num">${esc(v.replace(/(\d) /g, "$1 "))}</b></li>`).join(""); // "4 пары" never splits

  const progress = ws === thisWeek ? `
    <section class="stat-card rise" style="--i:4">
      <div class="stat-head"><h2>Пройдено</h2><p class="num">${st.done} из ${pairs(pairsTotal)}</p></div>
      <div class="week-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${pairsTotal}" aria-valuenow="${st.done}">
        <i style="width:${(st.done / pairsTotal) * 100}%"></i>
      </div>
    </section>` : "";

  scheduleHost().innerHTML = `${header}
    <div class="day-body ${slide} ${dir || takeEnter() ? "enter" : ""}">
      <dl class="kpis rise" style="--i:0">
        <div><dt>Пар</dt><dd class="num">${pairsTotal}</dd></div>
        <div><dt>Академ. часов</dt><dd class="num">${hoursText(acad)}</dd><small>по 45 мин</small></div>
        <div><dt>Обычных часов</dt><dd class="num">${hoursText(hours)}</dd><small>по 60 мин</small></div>
      </dl>

      <section class="stat-card rise" style="--i:1">
        <div class="stat-head"><h2>Каких пар больше</h2><p>Нажмите на предмет</p></div>
        ${donutHtml(subjectSegs, { centerLabel: "Всего пар", centerValue: pairsTotal })}
        <ul class="legend">${legend}</ul>
      </section>

      <section class="stat-card rise" style="--i:2">
        <div class="stat-head"><h2>Лекции и практика</h2></div>
        <div class="kind-bar" aria-hidden="true">${kindBar}</div>
        <div class="kind-legend">${kindLegend}</div>
      </section>

      <section class="stat-card rise" style="--i:3">
        <div class="stat-head"><h2>Нагрузка по дням</h2></div>
        <div class="load">${load}</div>
      </section>

      ${progress}

      <section class="stat-card rise" style="--i:5">
        <div class="stat-head"><h2>Факты недели</h2></div>
        <ul class="rows facts-list">${facts}</ul>
      </section>
      ${sourceLine()}
    </div>`;

  const card = scheduleHost().querySelector(".stat-card .donut").closest(".stat-card");
  bindDonut(card, subjectSegs, card.querySelector(".legend"), {
    centerLabel: "Всего пар", centerValue: pairsTotal, unit: pairUnit,
  });
  scheduleHost().querySelectorAll(".kpis dd, .load-col .n, .donut-text b").forEach((el) =>
    rollTo(el, el.textContent, { from: el.textContent.replace(/\d/g, "0") }));
  bindStats();
}

function bindStats() {
  document.getElementById("wk-prev")?.addEventListener("click", () => shiftWeek(-7));
  document.getElementById("wk-next")?.addEventListener("click", () => shiftWeek(7));
}

/* ---------- bottom sheet ---------- */

/* The sheet slides up over the page, and the page steps back under it (#app shrinks a little, --sheet-p).
   A sheet opened from a pair's card grows out of that card and folds back into it on close (a view
   transition morphs the one into the other); the card's place stays empty while the sheet is up.
   The panel follows a finger pulling it down from its top: a flick or a long pull lets it go, a short one
   springs back; a locked sheet only gives a little. */

const sheet = document.getElementById("sheet");
const sheetPanel = sheet.querySelector(".sheet-panel");
const sheetScrim = sheet.querySelector(".sheet-scrim");
let backBeforeSheet = null; // what Telegram's back button did before the sheet took it over
let sheetFrom = null;       // the card a pair sheet grew out of, as a selector: a re-render may replace the element
let closeTimer = 0;
const canMorph = () => Boolean(document.startViewTransition) && !reduceMotion.matches;
const onScreen = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.height > 0; };

/** p = 1: the page sits back under an open sheet; 0: in place; a drag passes through the values between */
function pageBack(p) {
  const root = document.documentElement;
  if (p > 0 && !root.classList.contains("sheet-open")) root.style.setProperty("--sheet-origin", `${scrollY + innerHeight / 2 - app.offsetTop}px`);
  root.classList.toggle("sheet-open", p > 0);
  root.style.setProperty("--sheet-p", String(p));
}

/** one view transition: the card becomes the sheet's panel (open), or the panel the card */
function morph(card, update, open) {
  const root = document.documentElement;
  root.classList.add("vt-morph");
  card.classList.toggle("lifted", !open);   // folding back, the card is not on the page until the panel lands
  (open ? card : sheetPanel).style.viewTransitionName = "pair-card";
  // the corners morph too: the card's all round, the panel's only on top
  const cardR = getComputedStyle(card).borderRadius, panelR = getComputedStyle(sheetPanel).borderRadius;
  const t = document.startViewTransition(() => {
    (open ? card : sheetPanel).style.viewTransitionName = "";
    update();
    (open ? sheetPanel : card).style.viewTransitionName = "pair-card";
    card.classList.toggle("lifted", open);
  });
  // the box clips what it shows with its own corners (clip-path: it holds wherever overflow on the box does not);
  // the screen's picture, the page in it, steps back or forward by the page's scale under a sheet (#app, 0.95)
  const box = (r) => `inset(0 round ${r})`;
  const timing = { duration: 460, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "both" };
  let anims = [];
  t.ready.then(() => {
    anims = [
      root.animate({ clipPath: open ? [box(cardR), box(panelR)] : [box(panelR), box(cardR)] },
        { ...timing, pseudoElement: "::view-transition-group(pair-card)" }),
      root.animate({ transform: open ? [`scale(${1 / 0.95})`, "none"] : ["scale(0.95)", "none"] },
        { ...timing, pseudoElement: "::view-transition-new(root)" }),
    ];
  }).catch(() => {});
  t.finished.finally(() => {
    anims.forEach((a) => a.cancel());   // they outlive their pictures otherwise, and would steer the next morph
    root.classList.remove("vt-morph");
    card.style.viewTransitionName = "";
    sheetPanel.style.viewTransitionName = "";
  });
}

/** from: the card the sheet grows out of (a pair's) */
function openSheet(html, bind, { locked = false, from = null } = {}) {
  hidePointer();
  const fresh = sheet.hidden || sheet.classList.contains("closing");
  const fill = (slide) => {
    clearTimeout(closeTimer);
    sheetPanel.innerHTML = `<div class="grabber" aria-hidden="true"></div>${html}`;
    sheetPanel.style.transform = sheetPanel.style.transition = "";
    sheetScrim.style.opacity = sheetScrim.style.transition = "";
    sheet.classList.remove("closing");
    sheet.classList.toggle("locked", locked);
    if (slide) sheet.classList.add("entering");
    sheet.hidden = false;
    if (fresh) pageBack(1);
    if (slide) { void sheetPanel.offsetHeight; sheet.classList.remove("entering"); }
    if (backHandler !== closeSheet) backBeforeSheet = backHandler;
    setBack(locked ? null : closeSheet);
    bind?.(sheetPanel);
  };
  if (!fresh) return fill(false);
  sheetFrom = null;
  if (from?.isConnected && canMorph() && onScreen(from)) {
    sheetFrom = `[data-date="${from.dataset.date}"][data-pair="${from.dataset.pair}"][data-idx="${from.dataset.idx}"]`;
    return morph(from, () => fill(false), true);
  }
  fill(true);
}

/** force: close a locked sheet too (its own button does that); fling: the finger's speed, px/ms, when it threw the sheet away */
function closeSheet(force, { fling = 0 } = {}) {
  if (sheet.hidden || sheet.classList.contains("closing")) return;
  if (sheet.classList.contains("locked") && force !== true) return;
  hidePointer();
  sheet.classList.remove("locked");
  setBack(backBeforeSheet);
  backBeforeSheet = null;
  const card = sheetFrom && app.querySelector(sheetFrom);
  sheetFrom = null;
  const done = () => { sheet.hidden = true; sheet.classList.remove("closing"); };
  if (card && !fling && canMorph() && onScreen(card)) return morph(card, () => { done(); pageBack(0); }, false);
  app.querySelectorAll(".lifted").forEach((el) => el.classList.remove("lifted"));
  pageBack(0);
  let ms = 260;
  if (fling) {   // it keeps the speed it was thrown with
    const left = sheetPanel.offsetHeight - (new DOMMatrix(getComputedStyle(sheetPanel).transform).m42 || 0);
    ms = Math.round(Math.min(320, Math.max(140, left / Math.max(fling, 1.2))));
    sheetPanel.style.transition = `transform ${ms}ms cubic-bezier(0.25, 0.6, 0.4, 1)`;
    sheetScrim.style.transition = `opacity ${ms}ms linear`;
  }
  sheetPanel.style.transform = sheetScrim.style.opacity = "";
  sheet.classList.add("closing");
  clearTimeout(closeTimer);
  closeTimer = setTimeout(done, reduceMotion.matches ? 0 : ms);
}
sheet.addEventListener("click", (e) => { if (e.target.hasAttribute("data-close")) closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

let sheetDrag = null;
sheetPanel.addEventListener("touchstart", (e) => {
  sheetDrag = e.touches.length === 1 && sheetPanel.scrollTop <= 0 && !sheet.classList.contains("closing")
    ? { y0: e.touches[0].clientY, dy: 0, on: false, track: [] } : null;
}, { passive: true });
sheetPanel.addEventListener("touchmove", (e) => {
  const d = sheetDrag;
  if (!d) return;
  const y = e.touches[0].clientY;
  if (!d.on) {
    if (y - d.y0 < -4) { sheetDrag = null; return; }   // upward: the panel scrolls its own content
    if (y - d.y0 < 8) return;
    d.on = true;
    d.y0 = y;
    sheetPanel.style.transition = sheetScrim.style.transition = "none";
    document.documentElement.classList.add("sheet-dragging");
  }
  e.preventDefault();
  const pull = Math.max(0, y - d.y0);
  d.dy = sheet.classList.contains("locked") ? 36 * Math.log1p(pull / 36) : pull;
  const t = performance.now();
  d.track.push([t, d.dy]);
  while (d.track.length > 2 && t - d.track[0][0] > 90) d.track.shift();
  const p = 1 - Math.min(1, d.dy / sheetPanel.offsetHeight);
  sheetPanel.style.transform = `translateY(${d.dy}px)`;
  sheetScrim.style.opacity = String(p);
  document.documentElement.style.setProperty("--sheet-p", String(p));
}, { passive: false });
const releaseSheet = () => {
  const d = sheetDrag;
  sheetDrag = null;
  if (!d?.on) return;
  document.documentElement.classList.remove("sheet-dragging");
  const [t0, y0] = d.track[0], [t1, y1] = d.track[d.track.length - 1];
  const v = t1 > t0 ? (y1 - y0) / (t1 - t0) : 0;
  sheetPanel.style.transition = sheetScrim.style.transition = "";
  if (!sheet.classList.contains("locked") && (d.dy > sheetPanel.offsetHeight * 0.3 || (v > 0.45 && d.dy > 30))) {
    return closeSheet(false, { fling: Math.max(v, 0.01) });
  }
  sheetPanel.style.transform = sheetScrim.style.opacity = "";   // back up: the panel's own transition carries it
  document.documentElement.style.setProperty("--sheet-p", "1");
};
sheetPanel.addEventListener("touchend", releaseSheet);
sheetPanel.addEventListener("touchcancel", releaseSheet);

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
  const ta = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
  ta.style.cssText = "position:fixed;opacity:0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) {}
  ta.remove();
  return ok;
}

function findLesson(date, pair, idx) {
  return (state.lessons.get(date) || []).filter((l) => l.pair === pair)[idx] || null;
}

/* ---------- pair details ---------- */

/** a button's label swaps with a fade, and its icon plays the scene of `mode` (.btn-ico.ok, .done) */
function btnState(btn, label, mode) {
  const lbl = btn.querySelector(".lbl");
  lbl.textContent = label;
  lbl.classList.remove("swap-in");
  void lbl.offsetWidth;
  lbl.classList.add("swap-in");
  btn.classList.remove("ok", "done");
  if (mode) btn.classList.add(mode);
}
let freshReminder = null;   // the reminder just set: its tag on the card pops in

/** from: the card it was opened from, which grows into the sheet */
function openPairSheet(date, pair, idx, from = null) {
  const l = findLesson(date, pair, idx);
  if (!l) return;
  const fresh = sheet.hidden;
  if (fresh) haptic();
  const t = now();
  const started = date < t.iso || (date === t.iso && t.min >= toMin(l.start));
  const ended = date < t.iso || (date === t.iso && t.min >= toMin(l.end));
  const rem = state.reminders.get(remKey(date, l.start, l.subject));
  const d = dateOf(date);
  const when = `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}, ${clock(l.start)}–${clock(l.end)}`;
  const kind = kindName(l.kind);
  const note = ended ? "Пара уже прошла." : started ? "Пара уже идёт."
    : rem ? "Бот напишет вам в Telegram за 10 минут до начала." : "";
  openSheet(`
    <div class="sheet-head" style="${hueVar(l.subject)}">
      ${markSvg(l.subject, "mark sheet-mark")}
      <div><h2 id="sheet-title">${esc(l.subject)}</h2><p>${esc([kind, `${pair} пара`].filter(Boolean).join(" · "))}</p></div>
    </div>
    <ul class="rows">
      <li><span>Когда</span><b class="num">${when}</b></li>
      <li><span>Аудитория</span><b>${esc(l.room || "—")}</b></li>
      <li><span>Преподаватель</span><b>${esc(l.teacher || "—")}</b></li>
    </ul>
    <div class="sheet-actions">
      ${started ? "" : rem
        ? `<button class="btn secondary btn-ico" id="remind"><span class="ico">${icon.bell}</span><span class="lbl">Не напоминать</span></button>`
        : `<button class="btn btn-ico" id="remind"><span class="ico">${icon.bell}${icon.tick}</span><span class="lbl">Напомнить за 10 минут</span></button>`}
      <button class="btn secondary btn-ico" id="copy"><span class="ico">${icon.copy}${icon.tick}</span><span class="lbl">Скопировать</span></button>
    </div>
    <p class="btn-note" id="sheet-note" aria-live="polite">${note}</p>`, (panel) => {
    const noteEl = panel.querySelector("#sheet-note");
    // the subject's mark plays its scene as the sheet settles, and again when tapped
    const mark = panel.querySelector(".sheet-mark");
    if (fresh) setTimeout(() => playMark(mark), 300);
    mark.addEventListener("click", () => { haptic(); playMark(mark); });
    panel.querySelector("#copy").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const text = `${when} — ${l.subject}${kind ? ` (${kind.toLowerCase()})` : ""}${l.room ? `, ауд. ${l.room}` : ""}${l.teacher ? `, ${l.teacher}` : ""}`;
      const ok = await copyText(text);
      haptic(ok ? "success" : "error");
      if (!ok) { noteEl.textContent = "Не получилось скопировать."; return; }
      // the two sheets turn into a check for a moment
      btnState(btn, "Скопировано", "ok");
      clearTimeout(btn.timer);
      btn.timer = setTimeout(() => btnState(btn, "Скопировать", ""), 1800);
    });
    panel.querySelector("#remind")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const key = remKey(date, l.start, l.subject);
      try {
        const existing = state.reminders.get(key);
        if (existing) {
          await api(`/api/reminders/${existing.id}`, { method: "DELETE" });
          state.reminders.delete(key);
        } else {
          const r = await api("/api/reminders", { method: "POST", body: JSON.stringify({ date, start: l.start, subject: l.subject }) });
          state.reminders.set(key, r);
          freshReminder = key;   // the card's «напомню» pops in once the sheet is down
          // the bell rings and a check is drawn before the sheet turns into «Не напоминать»
          btnState(btn, "Напомню", "done");
          haptic("success");
          await new Promise((r) => setTimeout(r, reduceMotion.matches ? 0 : 1000));
        }
        haptic("success");
        if (!sheet.hidden && sheetPanel.contains(btn)) openPairSheet(date, pair, idx);
        if (state.tab === "schedule") renderSchedule();
        freshReminder = null;
      } catch (err) {
        btn.disabled = false;
        noteEl.textContent = err instanceof HttpError && err.status === 400
          ? "Пара уже началась." : "Не получилось. Проверьте интернет и попробуйте ещё раз.";
        haptic("error");
      }
    });
  }, { from });
}

/* ---------- empty states: one line drawing each, in the same hand as the subject marks ---------- */

// and each comes alive: the clubhouse is drawn and its flag waves, the two friends are drawn and the plus
// beckons, the sun rises over the waves and its rays turn (.art parts, app.css)
const ART = {
  clubs: '<path class="a-draw" pathLength="1" d="M30 30 60 14l30 16M28 30h64M36 34v22M48 34v22M72 34v22M84 34v22M26 62h68M56 62V52a4 4 0 0 1 8 0v10M60 14V4"/><path class="hi a-flag" d="M60 4h11l-3 3.5 3 3.5H60"/>',
  friends: '<circle class="a-draw" pathLength="1" cx="46" cy="24" r="9"/><path class="a-draw" pathLength="1" d="M28 62c2-12 9-19 18-19s16 7 18 19"/><circle class="a-draw d2" pathLength="1" cx="74" cy="29" r="7"/><path class="a-draw d2" pathLength="1" d="M66 47c2.4-3 5-4.5 8-4.5 7 0 12 6 14 17"/><path class="hi a-plus" d="M98 14v12M92 20h12"/>',
  free: '<circle class="hi a-sun" cx="60" cy="32" r="11"/><path class="hi a-rays" d="M60 10V5M37 32h-5M88 32h-5M44 16l-3.5-3.5M76 16l3.5-3.5"/><path class="a-wave" d="M18 52c5-4 10-4 15 0s10 4 15 0 10-4 15 0 10 4 15 0 10-4 15 0 10 4 15 0"/><path class="a-wave w2" d="M28 62c5-4 10-4 15 0s10 4 15 0 10-4 15 0 10 4 15 0 10-4 15 0"/>',
};
const emptyState = (art, title, text) => `
  <div class="empty-state loop">
    <svg class="art" viewBox="0 0 120 72" aria-hidden="true">${ART[art]}</svg>
    <strong>${title}</strong><p>${text}</p>
  </div>`;

/* ---------- notifications: the bell on the main screen and what it lists ---------- */

async function loadUnread() {
  try { state.unread = (await api("/api/notifications/unread")).unread; } catch (_) { return; }
  updateBell();
}
const bellButton = () => `
  <button class="bell" id="bell" aria-label="Уведомления">${icon.bell}<span class="bell-badge num" hidden></span></button>`;
let bellRung = 0;   // the count the bell last rang for: it rings for news, not every time it is drawn
function updateBell() {
  const bell = document.getElementById("bell");
  if (!bell) return;
  const badge = bell.querySelector(".bell-badge");
  badge.hidden = !state.unread;
  badge.textContent = state.unread > 99 ? "99+" : String(state.unread);
  if (state.unread > bellRung && !reduceMotion.matches) {
    bell.classList.remove("ring");
    void bell.offsetWidth;
    bell.classList.add("ring");
  }
  bellRung = state.unread;
  bell.setAttribute("aria-label", state.unread ? `Уведомления, новых: ${state.unread}` : "Уведомления");
}

/** what happened, in one sentence; the bold name is whoever did it */
function notificationText(n) {
  const who = `<b>${esc(n.actor?.name || "Кто-то")}</b>`;
  const club = n.club ? `«${esc(n.club.name)}»` : "клуб";
  const quote = n.text ? `: ${esc(n.text)}` : "";
  return {
    friend_request: `${who} хочет добавить вас в друзья`,
    friend_accept: `Вы теперь друзья с ${who}`,
    flame: `Огонёк от ${who}: зажгите свой, чтобы серия продолжилась`,
    club_invite: `${who} приглашает вас в клуб ${club}`,
    club_request: `${who} хочет вступить в ${club}`,
    request_accept: `Вашу заявку в ${club} приняли`,
    club_post: `Новая запись в ${club}${quote}`,
    comment: `Комментарий от ${who} к вашей записи в ${club}${quote}`,
    club_admin: `Вас сделали админом клуба ${club}`,
    club_owner: `Вам передали клуб ${club}, теперь вы владелец`,
    club_kicked: `Вас исключили из клуба ${club}`,
  }[n.kind] || "Новое уведомление";
}
const BY_CLUB = new Set(["club_post", "request_accept", "club_admin", "club_owner", "club_kicked"]);
const ntfAvatar = (n) => (BY_CLUB.has(n.kind) || !n.actor) && n.club ? clubAvatar(n.club, "ntf-avatar")
  : personAvatar(n.actor || { name: "?" }, "ntf-avatar");
const ntfHtml = (n) => `
  <li><button class="ntf ${n.read ? "" : "unread"}" data-ntf="${n.id}">
    ${ntfAvatar(n)}
    <span class="ntf-main"><span class="ntf-text">${notificationText(n)}</span><time>${postTime(n.created_at)}</time></span>
    ${n.read ? "" : `<i class="ntf-dot" aria-label="Новое"></i>`}
  </button></li>`;

async function openNotifications() {
  haptic();
  openSheet(`<div class="sheet-head"><div><h2 id="sheet-title">Уведомления</h2></div></div><p class="options-note" id="ntf-loading">Загружаем…</p>`);
  let data;
  try {
    data = await api("/api/notifications");
  } catch (_) {
    const wait = document.getElementById("ntf-loading");
    if (wait) wait.textContent = "Не получилось загрузить уведомления. Проверьте интернет.";
    return;
  }
  if (!document.getElementById("ntf-loading")) return;   // closed while loading
  openSheet(`
    <div class="sheet-head"><div><h2 id="sheet-title">Уведомления</h2><p>${data.unread ? `Новых: ${data.unread}` : "Всё прочитано"}</p></div></div>
    ${data.items.length ? `<ul class="ntf-list">${data.items.map(ntfHtml).join("")}</ul>`
      : `<p class="search-hint">Пока ничего нет. Здесь появятся заявки в друзья, приглашения, новые записи в ваших клубах и комментарии к вашим записям.</p>`}`, (panel) => {
    panel.querySelectorAll("[data-ntf]").forEach((b) => b.addEventListener("click", () =>
      openNotification(data.items.find((n) => n.id === Number(b.dataset.ntf)))));
  });
  if (data.unread) {
    state.unread = 0;
    updateBell();
    api("/api/notifications/read", { method: "POST" }).catch(() => {});
  }
}

/** a tap on a notification goes where it happened */
function openNotification(n) {
  if (!n) return;
  haptic();
  closeSheet();
  if (["friend_request", "friend_accept", "flame"].includes(n.kind)) {
    state.tab = "profile";
    state.profileView = "friends";
  } else {
    state.tab = "clubs";
    state.clubsTab = "clubs";
    state.clubView = n.club && n.kind !== "club_kicked"
      ? { kind: "club", id: n.club.id, data: null, section: n.kind === "club_request" ? "members" : "feed" }
      : null;
  }
  window.scrollTo(0, 0);
  render();
}

/* ---------- screen: clubs ----------
   A student may be in any number of clubs and own up to three. The list shows your clubs, the invitations
   and the clubs you may join; a club opens as its own page with its feed and members;
   founding a club and its settings share one form. */

const CLUB_CATS = {
  science: ["Наука", "blue"], it: ["IT", "cyan"], sport: ["Спорт", "green"], art: ["Творчество", "pink"],
  music: ["Музыка", "orange"], games: ["Игры", "red"], language: ["Языки", "teal"],
  volunteer: ["Волонтёрство", "lime"], other: ["Другое", "yellow"],
};
const CLUB_VIS = {
  public: ["Открытый", "Любой студент найдёт клуб в списке и вступит"],
  friends: ["Для друзей", "Клуб видят и вступают только друзья владельца"],
  closed: ["По заявкам", "Клуб виден всем, а вступают по заявке, которую одобряете вы или админы"],
  invite: ["По приглашениям", "Клуба нет в списке, вступить можно только по приглашению"],
};
const ROLE_NAME = { owner: "Владелец", admin: "Админ" };
const memberCount = (n) => `${n} ${plural(n, "участник", "участника", "участников")}`;
const clubMeta = (c) => [CLUB_CATS[c.category]?.[0], CLUB_VIS[c.visibility]?.[0], memberCount(c.members)].join(" · ");
const errText = (e, fallback = "Не получилось. Проверьте интернет и попробуйте ещё раз.") =>
  e instanceof HttpError && (e.status === 0 || (e.status >= 400 && e.status < 500)) && e.message ? e.message : fallback;
function say(msg) {
  if (inTelegram && tg.showAlert) tg.showAlert(msg); else alert(msg);
}
function openOut(url) {
  if (inTelegram && url.startsWith("https://t.me/")) tg.openTelegramLink(url);
  else if (inTelegram) tg.openLink(url);
  else window.open(url, "_blank", "noopener");
}

function clubAvatar(c, cls = "") {
  const hue = (CLUB_CATS[c.category] || CLUB_CATS.other)[1];
  const ini = esc(initials(c.name));
  const img = c.photo_url ? `<img src="${esc(c.photo_url)}" alt="" onerror="this.parentNode.textContent=this.parentNode.dataset.i">` : "";
  return `<span class="avatar club-avatar ${cls}" style="--c: var(--hue-${hue})" data-i="${ini}" aria-hidden="true">${img || ini}</span>`;
}
const officialMark = (c) => c.official
  ? `<span class="official" title="Официальный клуб" aria-label="Официальный клуб">${icon.check}</span>` : "";
const clubPill = (club) =>
  `<small class="club-pill" style="--c: var(--hue-${(CLUB_CATS[club.category] || CLUB_CATS.other)[1]})" title="Клуб">${esc(club.name)}</small>`;
function clubRow(c, trailing = "", sub = esc(clubMeta(c)), cls = "") {
  return `
    <li class="person ${cls}" role="button" tabindex="0" data-club="${c.id}">
      ${clubAvatar(c)}
      <div class="person-text"><b>${esc(c.name)}${officialMark(c)}</b><span>${sub}</span></div>
      ${trailing}
    </li>`;
}

let clubsSig = "";
async function loadClubs() {
  let data;
  try { data = await api("/api/clubs"); } catch (_) { return; }
  state.clubs = data;
  showClubNotice();
  const sig = JSON.stringify(data);
  if (sig === clubsSig) return;
  clubsSig = sig;
  if (state.tab === "clubs" && !state.clubView && state.clubsTab === "clubs" && !state.ob
      && !document.activeElement?.matches?.("input, textarea")) renderClubs();
}

const CLUBS_TABS = [["clubs", "Клубы"], ["feed", "Общая лента"]];
let clubsTabs = null;

/** the clubs tab: its switch stays mounted, so the pill can travel; the list or the shared feed renders below */
function renderClubs() {
  const v = state.clubView;
  if (v?.kind === "club") return renderClubPage();
  if (v?.kind === "form") return renderClubForm();
  setBack(null);
  const c = state.clubs;
  app.innerHTML = `
    <header class="clubs-head"><h1>Студклубы</h1>${c && c.owned < c.own_max ? `<button class="btn-sm primary" id="club-new">Создать</button>` : ""}</header>
    <div class="slide-tabs segmented clubs-switch" role="tablist" aria-label="Раздел клубов">
      <span class="slide-cursor" aria-hidden="true"></span>
      ${CLUBS_TABS.map(([id, label]) => `<button role="tab" data-ctab="${id}" aria-selected="${state.clubsTab === id}">${label}</button>`).join("")}
    </div>
    <div id="clubs-body"></div>`;
  app.querySelector("#club-new")?.addEventListener("click", () => openClubForm(null));
  clubsTabs = new SlideTabs(app.querySelector(".clubs-switch"), (tab) => {
    haptic();
    state.clubsTab = tab.dataset.ctab;
    if (state.clubsTab === "feed") state.sharedFeed = null;   // fresh every time it is opened
    renderClubsBody();
  });
  renderClubsBody();
}

function renderClubsBody() {
  const host = document.getElementById("clubs-body");
  if (!host) return;
  if (state.clubsTab === "feed") renderSharedFeed(host);
  else renderClubList(host);
}

function renderClubList(host) {
  const c = state.clubs;
  const sub = `<p class="clubs-sub">Клубы по интересам студентов филиала: найдите своих или соберите новый.</p>`;
  if (!c) {
    host.innerHTML = `${sub}<p class="options-note">Загружаем клубы…</p>`;
    loadClubs();
    return;
  }
  const seen = seenPosts();
  const my = c.my.length ? `
    <h2 class="group-label">Мои клубы · ${c.my.length}</h2>
    <ul class="people">${c.my.map((x) => clubRow(x,
      ROLE_NAME[x.role] ? `<span class="role-tag ${x.role}">${ROLE_NAME[x.role]}</span>` : `<span class="row-go">${icon.right}</span>`,
      `${esc(clubMeta(x))}${x.requests ? `<em class="person-now fresh">Заявки на вступление: ${x.requests}</em>` : ""}${
        x.last_post > (seen[x.id] || 0) ? `<em class="person-now fresh">Новые записи в ленте</em>` : ""}`)).join("")}</ul>
    ${c.owned >= c.own_max ? `<p class="search-hint">Своих клубов может быть не больше ${c.own_max}. Чтобы создать новый, передайте один из своих другому участнику.</p>` : ""}` : "";
  const invites = c.invites.length ? `
    <h2 class="group-label">Вас приглашают</h2>
    <ul class="people">${c.invites.map((x) => clubRow(x, `<div class="person-actions">
        <button class="btn-sm primary" data-invite-act="accept" data-id="${x.id}">Принять</button>
        <button class="btn-sm" data-invite-act="decline" data-id="${x.id}">Отклонить</button></div>`,
      `${esc(clubMeta(x))}<em class="person-now">Приглашение от ${esc(x.inviter)}</em>`, "with-actions")).join("")}</ul>` : "";
  const cats = [...new Set(c.discover.map((x) => x.category))];
  const filter = cats.includes(state.clubFilter) ? state.clubFilter : "all";
  const shown = c.discover.filter((x) => filter === "all" || x.category === filter);
  const chips = cats.length > 1 ? `
    <div class="club-filter" role="group" aria-label="Направленность">
      ${["all", ...cats].map((k) => `<button data-filter="${k}" aria-pressed="${filter === k}">${k === "all" ? "Все" : CLUB_CATS[k][0]}</button>`).join("")}
    </div>` : "";
  const list = c.discover.length ? `
    <h2 class="group-label">${c.my.length ? "Другие клубы" : "Можно вступить"} · ${c.discover.length}</h2>
    ${chips}
    <ul class="people">${shown.map((x) => clubRow(x, `<span class="row-go">${icon.right}</span>`)).join("")}</ul>` : "";
  const empty = !c.my.length && !c.invites.length && !c.discover.length ? `
    ${emptyState("clubs", "Клубов пока нет", "Создайте первый: придумайте название и решите, кто может вступить.")}
    <button class="btn" id="club-new-2">Создать клуб</button>` : "";
  host.innerHTML = sub + my + invites + list + empty;

  host.querySelector("#club-new-2")?.addEventListener("click", () => openClubForm(null));
  host.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
    haptic();
    state.clubFilter = b.dataset.filter;
    renderClubList(host);
  }));
  host.querySelectorAll("[data-club]").forEach((el) => {
    const open = () => openClub(Number(el.dataset.club));
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === el) open(); });
  });
  host.querySelectorAll("[data-invite-act]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    b.disabled = true;
    answerClubInvite(b.dataset.inviteAct === "accept", Number(b.dataset.id));
  }));
}

/* the shared feed: open posts of all the clubs you may open, each under its club's name */
async function renderSharedFeed(host) {
  if (!state.sharedFeed) {
    host.innerHTML = `<p class="options-note">Загружаем общую ленту…</p>`;
    try {
      state.sharedFeed = await api("/api/feed");
    } catch (_) {
      if (!host.isConnected) return;
      host.innerHTML = `<p class="note feed-empty"><strong>Лента не загрузилась</strong>Проверьте интернет и откройте её ещё раз.</p>`;
      return;
    }
    if (!host.isConnected || state.clubsTab !== "feed" || state.clubView) return;
  }
  const f = state.sharedFeed;
  host.innerHTML = `
    <p class="clubs-sub">Открытые записи всех клубов, которые вам доступны. Нажмите на название клуба, чтобы открыть его.</p>
    ${f.posts.length ? `<div class="feed">${f.posts.map(postHtml).join("")}</div>` : `
      <p class="note feed-empty"><strong>Открытых записей пока нет</strong>Когда клубы опубликуют что-нибудь для всех, записи появятся здесь.</p>`}
    ${f.more ? `<button class="btn-text" id="shared-more">Показать ещё</button>` : ""}`;
  f.posts.forEach((p) => bindPost(host.querySelector(`.post[data-post="${p.id}"]`), p));
  host.querySelector("#shared-more")?.addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = "Загружаем…";
    try {
      const older = await api(`/api/feed?before=${f.posts[f.posts.length - 1].id}`);
      state.sharedFeed = { posts: [...f.posts, ...older.posts], more: older.more };
      renderSharedFeed(host);
    } catch (_) {
      b.disabled = false;
      b.textContent = "Показать ещё";
      say("Не получилось загрузить записи. Проверьте интернет.");
    }
  });
}

async function answerClubInvite(accept, id) {
  haptic();
  let data = null;
  try {
    if (accept) data = await api(`/api/clubs/${id}/join`, { method: "POST" });
    else await api(`/api/clubs/${id}/invites/${state.me.tg_id}`, { method: "DELETE" });
    haptic("success");
  } catch (e) {
    haptic("error");
    say(errText(e));
  }
  await loadClubs();
  if (data && state.tab === "clubs") {
    state.clubView = { kind: "club", id, data };
    window.scrollTo(0, 0);
  }
  if (state.tab === "clubs") renderClubs();
}

/* the pop-up when someone invites you to a club */
const clubNoticeShown = new Set();
function showClubNotice() {
  if (state.ob || !state.clubs || document.querySelector(".notice")) return;
  const c = state.clubs.invites.find((x) => !clubNoticeShown.has(x.id));
  if (!c) return;
  clubNoticeShown.add(c.id);
  haptic("success");
  const el = document.createElement("div");
  el.id = "club-notice";
  el.className = "notice";
  el.setAttribute("role", "alertdialog");
  el.setAttribute("aria-label", "Приглашение в клуб");
  el.innerHTML = `
    <div class="notice-body">
      ${clubAvatar(c, "notice-avatar")}
      <div class="notice-text"><span>Вас пригласили в клуб</span><b>${esc(c.name)}</b><small>Приглашение от ${esc(c.inviter)}</small></div>
      <button class="notice-close" aria-label="Решить позже">${svg('<path d="M6 6l12 12M18 6 6 18"/>')}</button>
    </div>
    <div class="notice-actions">
      <button class="btn-sm primary" data-n="accept">Принять</button>
      <button class="btn-sm" data-n="decline">Отклонить</button>
    </div>`;
  document.body.append(el);
  const close = () => {
    el.classList.add("out");
    setTimeout(() => { el.remove(); showFriendNotice(); showClubNotice(); }, 260);
  };
  el.querySelector(".notice-close").addEventListener("click", close);
  el.querySelectorAll("[data-n]").forEach((b) => b.addEventListener("click", async () => {
    el.querySelectorAll("button").forEach((x) => (x.disabled = true));
    close();
    await answerClubInvite(b.dataset.n === "accept", c.id);
  }));
}

/* ---------- a club's page ---------- */

function openClub(id) {
  haptic();
  state.clubView = { kind: "club", id, data: null };
  window.scrollTo(0, 0);
  renderClubs();
}
function closeClubView() {
  const v = state.clubView;
  state.clubView = v?.kind === "form" && v.back ? v.back : null;
  window.scrollTo(0, 0);
  renderClubs();
}
function clubUpdated(data) {
  const v = state.clubView;
  if (v?.kind === "club") {
    if (v.data?.role !== data.role) v.feed = null;
    v.data = data;
  }
  loadClubs();
  renderClubs();
}
const backLink = (label) => inTelegram ? "" : `<div class="ob-top"><button class="ob-back" id="club-back">${icon.left}${label}</button></div>`;

const CLUB_SECTIONS = [["feed", "Лента"], ["members", "Участники"]];
let clubTabs = null;

function confirmTap(b, text) {
  if (b.dataset.sure) return true;
  b.dataset.sure = "1";
  b.textContent = text;
  haptic();
  return false;
}
async function clubAct(b, request, after) {
  b.disabled = true;
  try {
    const data = await request();
    haptic("success");
    after(data);
  } catch (e) {
    haptic("error");
    b.disabled = false;
    say(errText(e));
  }
}
/** joining (or asking to join): the button folds into a round check, the club's avatar hops and a ring spreads
    from it; then the page redraws as a member's */
async function clubJoin(b, request) {
  b.disabled = true;
  try {
    const data = await request();
    haptic("success");
    if (!reduceMotion.matches) {
      b.classList.add("joined");
      b.innerHTML = `<span class="ico">${icon.tick}</span>`;
      b.setAttribute("aria-label", "Готово");
      app.querySelector(".club-hero .avatar")?.classList.add("hop");
      await new Promise((r) => setTimeout(r, 1000));
    }
    clubUpdated(data);
  } catch (e) {
    haptic("error");
    b.disabled = false;
    say(errText(e));
  }
}
function clubToList() {
  state.clubView = null;
  window.scrollTo(0, 0);
  loadClubs();
  renderClubs();
}

async function renderClubPage() {
  const v = state.clubView;
  setBack(closeClubView);
  const bindBack = () => document.getElementById("club-back")?.addEventListener("click", closeClubView);
  if (!v.data) {
    app.innerHTML = `${backLink("Клубы")}<p class="options-note">Загружаем клуб…</p>`;
    bindBack();
    try {
      v.data = await api(`/api/clubs/${v.id}`);
    } catch (e) {
      if (state.clubView !== v) return;
      app.innerHTML = `${backLink("Клубы")}<p class="note"><strong>Клуб не открылся</strong>${
        e instanceof HttpError && e.status === 404 ? "Его удалили, или он вам больше недоступен." : "Проверьте интернет и попробуйте ещё раз."}</p>`;
      bindBack();
      return;
    }
    if (state.clubView !== v || state.tab !== "clubs") return;
  }
  const c = v.data;
  const manage = c.role === "owner" || c.role === "admin";
  const hero = `
    <div class="club-hero">
      ${clubAvatar(c, "big")}
      <h1>${esc(c.name)}${officialMark(c)}</h1>
      <p>${c.official ? "Официальный клуб · " : ""}${esc(clubMeta(c))}</p>
    </div>
    ${c.about ? `<p class="club-about">${esc(c.about)}</p>` : ""}
    ${c.frozen ? `<p class="note club-action"><strong>Клуб заморожен</strong>Администрация приостановила клуб: пока в нём нельзя публиковать, комментировать и вступать.</p>` : ""}`;
  const base = `/api/clubs/${c.id}`;

  v.section ||= "feed";
  const top = !c.role ? `
    ${c.can_join ? `<button class="btn club-action" id="club-join">${c.invited ? "Принять приглашение" : "Вступить в клуб"}</button>` : ""}
    ${c.invited ? `<button class="btn-text" id="club-decline">Отклонить приглашение</button>` : ""}
    ${c.can_request && !c.requested ? `<button class="btn club-action" id="club-request">Подать заявку</button>
      <p class="search-hint club-request-hint">В этот клуб вступают по заявке: её рассмотрят владелец или админы.</p>` : ""}
    ${c.can_request && c.requested ? `<p class="note club-action"><strong>Заявка отправлена</strong>Владелец или админы клуба рассмотрят её, и вам придёт уведомление.</p>
      <button class="btn-text" id="club-unrequest">Отменить заявку</button>` : ""}
    <p class="club-owner">Владелец: ${esc(c.owner)}</p>`
    : c.chat_url
    ? `<button class="btn chat-btn club-action" id="club-chat">${icon.plane}Открыть чат клуба</button>`
    : manage ? `<p class="search-hint club-action">Добавьте ссылку на чат в Telegram в настройках клуба, и у участников появится кнопка чата.</p>` : "";
  const tools = manage ? `
    <div class="club-tools">
      <button class="btn secondary" id="club-invite">Пригласить</button>
      <button class="btn secondary" id="club-edit">Настройки</button>
    </div>` : "";
  app.innerHTML = `${backLink("Клубы")}${hero}${top}${tools}
    <div class="slide-tabs segmented club-switch" role="tablist" aria-label="Раздел клуба">
      <span class="slide-cursor" aria-hidden="true"></span>
      ${CLUB_SECTIONS.map(([id, label]) => `<button role="tab" data-csec="${id}" aria-selected="${v.section === id}">${
        id === "members" ? `${label} · ${c.member_list.length}` : label}</button>`).join("")}
    </div>
    <div id="club-section"></div>`;
  bindBack();
  clubTabs = new SlideTabs(app.querySelector(".club-switch"), (tab) => {
    haptic();
    v.section = tab.dataset.csec;
    renderClubSection();
  });
  document.getElementById("club-join")?.addEventListener("click", (e) =>
    clubJoin(e.currentTarget, () => api(`${base}/join`, { method: "POST" })));
  document.getElementById("club-decline")?.addEventListener("click", (e) =>
    clubAct(e.currentTarget, () => api(`${base}/invites/${state.me.tg_id}`, { method: "DELETE" }), clubToList));
  document.getElementById("club-request")?.addEventListener("click", (e) =>
    clubJoin(e.currentTarget, () => api(`${base}/request`, { method: "POST" })));
  document.getElementById("club-unrequest")?.addEventListener("click", (e) =>
    clubAct(e.currentTarget, () => api(`${base}/request`, { method: "DELETE" }), clubUpdated));
  document.getElementById("club-chat")?.addEventListener("click", () => { haptic(); openOut(c.chat_url); });
  document.getElementById("club-invite")?.addEventListener("click", openInviteSheet);
  document.getElementById("club-edit")?.addEventListener("click", () => openClubForm(c));
  renderClubSection();
}

function renderClubSection() {
  const v = state.clubView;
  const host = document.getElementById("club-section");
  if (!host || !v?.data) return;
  if (v.section === "members") renderMembers(host, v.data);
  else renderFeed(host);
}

function renderMembers(host, c) {
  const role = c.role;
  const manage = role === "owner" || role === "admin";
  const requests = manage && c.requests?.length ? `
    <h2 class="group-label">Заявки на вступление · ${c.requests.length}</h2>
    <ul class="people">${c.requests.map((p) => personRow({ ...p, groupTag: true }, esc(dirLine(p)), `
      <button class="btn-sm primary" data-req-accept="${p.tg_id}">Принять</button>
      <button class="btn-sm" data-req-decline="${p.tg_id}">Отклонить</button>`, "", "with-actions")).join("")}</ul>
    <h2 class="group-label">Участники · ${c.member_list.length}</h2>` : "";
  const invites = manage && c.invites.length ? `
    <h2 class="group-label">Приглашены · ${c.invites.length}</h2>
    <ul class="people">${c.invites.map((p) => personRow(p, esc(dirLine(p)),
      `<button class="btn-sm" data-uninvite="${p.tg_id}">Отменить</button>`)).join("")}</ul>` : "";
  const exit = !role ? ""
    : role !== "owner"
    ? `<button class="btn-text danger" id="club-leave">Выйти из клуба</button>`
    : c.member_list.length === 1
    ? `<button class="btn-text danger" id="club-delete">Удалить клуб</button>`
    : `<p class="search-hint club-exit-note">Пока в клубе есть участники, удалить его нельзя, а владелец не может просто выйти. Можно передать права владельца другому участнику.</p>`;
  host.innerHTML = `${requests}
    <ul class="people">${c.member_list.map(memberRow).join("")}</ul>
    ${!role ? `<p class="search-hint">Нажмите на участника, чтобы добавить его в друзья. Написать ему в Telegram можно, когда вступите в клуб.</p>`
      : c.member_list.length > 1 ? `<p class="search-hint">Нажмите на участника, чтобы добавить его в друзья или написать ему в Telegram${
      role === "owner" ? ". Там же можно сделать его админом, передать права владельца или исключить."
      : role === "admin" ? ". Обычных участников там же можно исключить." : "."}</p>` : ""}
    ${invites}${exit}
    ${role !== "owner" ? `<button class="btn-text" id="club-report">Пожаловаться на клуб</button>` : ""}`;

  const base = `/api/clubs/${c.id}`;
  host.querySelector("#club-report")?.addEventListener("click", () => openReportSheet("club", c.id, "этим клубом"));
  host.querySelector("#club-leave")?.addEventListener("click", (e) => {
    if (confirmTap(e.currentTarget, "Точно выйти? Нажмите ещё раз")) clubAct(e.currentTarget, () => api(`${base}/leave`, { method: "POST" }), clubToList);
  });
  host.querySelector("#club-delete")?.addEventListener("click", (e) => {
    if (confirmTap(e.currentTarget, "Удалить навсегда? Нажмите ещё раз")) clubAct(e.currentTarget, () => api(base, { method: "DELETE" }), clubToList);
  });
  host.querySelectorAll("[data-req-accept]").forEach((b) => b.addEventListener("click", () =>
    clubAct(b, () => api(`${base}/requests/${b.dataset.reqAccept}/accept`, { method: "POST" }), clubUpdated)));
  host.querySelectorAll("[data-req-decline]").forEach((b) => b.addEventListener("click", () =>
    clubAct(b, () => api(`${base}/requests/${b.dataset.reqDecline}`, { method: "DELETE" }), clubUpdated)));
  host.querySelectorAll("[data-uninvite]").forEach((b) => b.addEventListener("click", () =>
    clubAct(b, async () => { await api(`${base}/invites/${b.dataset.uninvite}`, { method: "DELETE" }); return api(base); }, clubUpdated)));
  host.querySelectorAll("[data-member]").forEach((el) => {
    const open = () => openMemberSheet(c.member_list.find((m) => m.tg_id === Number(el.dataset.member)));
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  });
}

/* ---------- a club's feed: posts by the owner and admins, for members only ---------- */

const SEEN_KEY = "msu.clubSeen";   // per club, the newest post this device has shown, for the "new posts" line
function seenPosts() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch (_) { return {}; }
}
function markSeen(clubId, postId) {
  const seen = seenPosts();
  if (!postId || (seen[clubId] || 0) >= postId) return;
  seen[clubId] = postId;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (_) {}
}

/** "сегодня, 14:05", "вчера, 9:30" or "12 октября, 18:00", in Moscow time */
function postTime(utc) {
  const d = new Date(`${utc.replace(" ", "T")}Z`);
  const dayOf = (x) => x.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });
  const time = d.toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour: "numeric", minute: "2-digit" });
  if (dayOf(d) === dayOf(new Date())) return `сегодня, ${time}`;
  if (dayOf(d) === dayOf(new Date(Date.now() - 864e5))) return `вчера, ${time}`;
  return `${d.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long" })}, ${time}`;
}
const linkify = (text) => esc(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,:;!?)\]»"']/g, (url) => `<a href="${url}">${url}</a>`);

const REACTION_SET = ["👍", "❤️", "😂", "😮", "😢", "🔥"]; /* taste-skill-ignore: reactions are emoji by nature, the owner asked for them */

function postHtml(p) {
  const member = p.member;
  const reactions = p.reactions.map((r) => member ? `
    <button class="reaction ${p.mine === r.emoji ? "mine" : ""}" data-react="${r.emoji}" aria-pressed="${p.mine === r.emoji}"
            aria-label="${r.emoji}: ${r.count}">${r.emoji}<b class="num">${r.count}</b></button>`
    : `<span class="reaction" aria-label="${r.emoji}: ${r.count}">${r.emoji}<b class="num">${r.count}</b></span>`).join("");
  const talk = p.comments_off ? `<span class="comments-off">Комментарии выключены</span>`
    : member ? `<button class="comments-btn" data-comments>${icon.comment}${p.comments ? `<b class="num">${p.comments}</b>` : "Комментировать"}</button>`
    : p.comments ? `<button class="comments-btn" data-comments>${icon.comment}<b class="num">${p.comments}</b></button>` : "";
  return `
    <article class="post" data-post="${p.id}">
      <header class="post-head">${p.club ? `
        <button class="post-club" data-open-club="${p.club.id}" aria-label="Открыть клуб «${esc(p.club.name)}»">
          ${clubAvatar(p.club, "post-avatar")}
          <span class="post-who"><b>${esc(p.club.name)}</b><span class="post-meta">${esc(p.author.name)} · <time datetime="${esc(p.created_at)}Z">${postTime(p.created_at)}</time></span></span>
        </button>` : `
        ${personAvatar(p.author, "post-avatar")}
        <div class="post-who"><b>${esc(p.author.name)}</b><span class="post-meta"><time datetime="${esc(p.created_at)}Z">${postTime(p.created_at)}</time>${
          member && p.public ? `<span class="post-vis">${icon.globe}видна всем</span>` : ""}</span></div>`}
        ${p.can_delete ? `<button class="post-del" data-del aria-label="Удалить запись">${icon.trash}</button>`
          : `<button class="post-del post-flag" data-flag aria-label="Пожаловаться на запись">${icon.flag}</button>`}
      </header>
      ${p.body ? `<p class="post-body">${linkify(p.body)}</p>` : ""}
      ${p.photo_url ? `<button class="post-photo" data-photo aria-label="Открыть фото"><img src="${esc(p.photo_url)}" alt="" loading="lazy"></button>` : ""}
      <footer class="post-foot">
        <div class="reactions">${reactions}${member
          ? `<button class="reaction add" data-react-pick aria-label="Поставить реакцию" aria-expanded="false">${icon.smile}</button>` : ""}
        </div>
        ${talk}
      </footer>
      ${member ? `<div class="react-picker" role="group" aria-label="Реакции" hidden>
        ${REACTION_SET.map((e) => `<button data-react="${e}" aria-label="${e}">${e}</button>`).join("")}
      </div>` : ""}
    </article>`;
}

/** redraw one post in place (a reaction, a new comment count) without touching the rest of the feed */
function updatePost(p, popped = "") {
  const old = document.querySelector(`.post[data-post="${p.id}"]`);
  if (!old) return;
  old.outerHTML = postHtml(p);
  const fresh = document.querySelector(`.post[data-post="${p.id}"]`);
  if (popped) fresh.querySelector(`.reactions [data-react="${popped}"]`)?.classList.add("pop");
  bindPost(fresh, p);
}

/** a post left the server: take it out of every feed that holds it and off the screen */
function forgetPost(id) {
  const v = state.clubView;
  if (v?.feed) v.feed.posts = v.feed.posts.filter((x) => x.id !== id);
  if (state.sharedFeed) state.sharedFeed.posts = state.sharedFeed.posts.filter((x) => x.id !== id);
  document.querySelector(`.post[data-post="${id}"]`)?.remove();
}

function bindPost(article, p) {
  const c = { id: p.club_id };
  article.querySelector("[data-open-club]")?.addEventListener("click", () => openClub(p.club_id));
  const picker = article.querySelector(".react-picker");
  article.querySelector("[data-react-pick]")?.addEventListener("click", (e) => {
    haptic();
    picker.hidden = !picker.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!picker.hidden));
  });
  article.querySelectorAll("[data-react]").forEach((b) => b.addEventListener("click", async () => {
    haptic();
    b.disabled = true;
    try {
      Object.assign(p, await api(`/api/clubs/${c.id}/posts/${p.id}/reaction`, { method: "POST", body: JSON.stringify({ emoji: b.dataset.react }) }));
      updatePost(p, p.mine);
    } catch (e) {
      haptic("error");
      b.disabled = false;
      say(errText(e));
    }
  }));
  article.querySelector("[data-comments]")?.addEventListener("click", () => openComments(p));
  article.querySelector("[data-photo]")?.addEventListener("click", () => openPhoto(p.photo_url));
  article.querySelectorAll(".post-body a").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openOut(a.href); }));
  article.querySelector("[data-flag]")?.addEventListener("click", () => openReportSheet("post", p.id, "этой записью"));
  const del = article.querySelector("[data-del]");
  del?.addEventListener("click", async () => {
    if (!del.dataset.sure) {
      del.dataset.sure = "1";
      del.classList.add("sure");
      del.textContent = "Удалить?";
      haptic();
      return;
    }
    del.disabled = true;
    try {
      await api(`/api/clubs/${c.id}/posts/${p.id}`, { method: "DELETE" });
      haptic("success");
      forgetPost(p.id);
      loadClubs();
    } catch (e) {
      haptic("error");
      del.disabled = false;
      say(errText(e));
    }
  });
}

async function renderFeed(host) {
  const v = state.clubView;
  const c = v.data;
  const manage = c.role === "owner" || c.role === "admin";
  const compose = manage ? `<button class="btn secondary compose-btn" id="post-new">${icon.pen}Написать в ленту</button>` : "";
  const bindCompose = () => host.querySelector("#post-new")?.addEventListener("click", openComposer);
  if (!v.feed) {
    host.innerHTML = `${compose}<p class="options-note">Загружаем ленту…</p>`;
    bindCompose();
    try {
      v.feed = await api(`/api/clubs/${c.id}/posts`);
    } catch (_) {
      if (state.clubView !== v || !host.isConnected) return;
      host.innerHTML = `${compose}<p class="note feed-empty"><strong>Лента не загрузилась</strong>Проверьте интернет и откройте клуб ещё раз.</p>`;
      bindCompose();
      return;
    }
    if (state.clubView !== v || v.section !== "feed" || !host.isConnected) return;
  }
  const posts = v.feed.posts;
  if (c.role) markSeen(c.id, posts[0]?.id);
  host.innerHTML = `${compose}
    ${!c.role && posts.length ? `<p class="search-hint feed-visitor">Это открытые записи клуба. Вступите, чтобы читать всё, ставить реакции и комментировать.</p>` : ""}
    ${posts.length ? `<div class="feed">${posts.map(postHtml).join("")}</div>` : `
      <p class="note feed-empty"><strong>${c.role ? "Здесь пока пусто" : "Открытых записей пока нет"}</strong>${
        !c.role ? "Остальные записи видят только участники клуба."
        : manage ? "Напишите первую запись: новость, анонс встречи или что-нибудь смешное. Решите, видна она всем или только участникам."
        : "Когда владелец или админы что-нибудь напишут, записи появятся здесь."}</p>`}
    ${v.feed.more ? `<button class="btn-text" id="posts-more">Показать ещё</button>` : ""}`;
  bindCompose();
  posts.forEach((p) => bindPost(host.querySelector(`.post[data-post="${p.id}"]`), p));

  host.querySelector("#posts-more")?.addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = "Загружаем…";
    try {
      const older = await api(`/api/clubs/${c.id}/posts?before=${posts[posts.length - 1].id}`);
      v.feed = { ...v.feed, posts: [...posts, ...older.posts], more: older.more };
      renderFeed(host);
    } catch (_) {
      b.disabled = false;
      b.textContent = "Показать ещё";
      say("Не получилось загрузить записи. Проверьте интернет.");
    }
  });
}

/* comments open in a sheet: every member writes, oldest first like a chat, the field stays at the bottom */
const commentHtml = (cm) => `
  <div class="comment">
    ${personAvatar(cm.author, "comment-avatar")}
    <div class="comment-main">
      <div class="comment-who"><b>${esc(cm.author.name)}</b>${groupTag(cm.author.group)}<time>${postTime(cm.created_at)}</time></div>
      <p class="comment-body">${linkify(cm.body)}</p>
    </div>
    ${cm.can_delete ? `<button class="post-del" data-cdel="${cm.id}" aria-label="Удалить комментарий">${icon.trash}</button>`
      : `<button class="post-del post-flag" data-cflag="${cm.id}" aria-label="Пожаловаться на комментарий">${icon.flag}</button>`}
  </div>`;

function openComments(p) {
  const c = { id: p.club_id, role: p.member };
  haptic();
  let list = null;   // null while loading
  let draft = "";
  let note = "";
  const toBottom = (panel) => { panel.scrollTop = panel.scrollHeight; };
  const draw = () => openSheet(`
    <div class="sheet-head"><div>
      <h2 id="sheet-title">Комментарии${list ? ` · ${list.length}` : ""}</h2>
      ${p.body ? `<p>${esc(p.body.length > 90 ? `${p.body.slice(0, 90)}…` : p.body)}</p>` : ""}
    </div></div>
    <div class="comments" data-post="${p.id}">${list === null ? `<p class="options-note">Загружаем комментарии…</p>`
      : list.length ? list.map(commentHtml).join("") : `<p class="search-hint">Комментариев пока нет. Напишите первый.</p>`}</div>
    <p class="err" id="comment-err" ${note ? "" : "hidden"}>${esc(note)}</p>
    ${p.comments_off ? `<p class="search-hint">К этой записи комментарии выключены.</p>`
      : !c.role ? `<p class="search-hint">Комментировать могут участники клуба.</p>` : `
    <form class="comment-form" id="comment-form" autocomplete="off">
      <textarea id="comment-body" rows="1" maxlength="1000" placeholder="Написать комментарий" aria-label="Комментарий">${esc(draft)}</textarea>
      <button class="comment-send" type="submit" aria-label="Отправить">${icon.send}</button>
    </form>`}`, (panel) => {
    const field = panel.querySelector("#comment-body");
    const grow = () => { field.style.height = "auto"; field.style.height = `${Math.min(field.scrollHeight, 120)}px`; };
    if (field) { grow(); field.addEventListener("input", () => { draft = field.value; grow(); }); }
    panel.querySelector("#comment-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!draft.trim()) return;
      const send = panel.querySelector(".comment-send");
      send.disabled = true;
      try {
        const cm = await api(`/api/clubs/${c.id}/posts/${p.id}/comments`, { method: "POST", body: JSON.stringify({ body: draft }) });
        haptic("success");
        list = [...(list || []), cm];
        draft = "";
        note = "";
      } catch (err) {
        haptic("error");
        note = errText(err, "Не получилось отправить. Проверьте интернет.");
      }
      p.comments = list ? list.length : p.comments;
      updatePost(p);
      draw();
      toBottom(sheet.querySelector(".sheet-panel"));
    });
    panel.querySelectorAll("[data-cflag]").forEach((b) => b.addEventListener("click", () =>
      openReportSheet("comment", Number(b.dataset.cflag), "этим комментарием")));
    panel.querySelectorAll("[data-cdel]").forEach((b) => b.addEventListener("click", async () => {
      if (!b.dataset.sure) {
        b.dataset.sure = "1";
        b.classList.add("sure");
        b.textContent = "Удалить?";
        haptic();
        return;
      }
      b.disabled = true;
      try {
        await api(`/api/clubs/${c.id}/posts/${p.id}/comments/${b.dataset.cdel}`, { method: "DELETE" });
        haptic("success");
        list = list.filter((x) => x.id !== Number(b.dataset.cdel));
        p.comments = list.length;
        updatePost(p);
        draw();
      } catch (err) {
        haptic("error");
        b.disabled = false;
        say(errText(err));
      }
    }));
    panel.querySelectorAll(".comment-body a").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openOut(a.href); }));
  });
  draw();
  api(`/api/clubs/${c.id}/posts/${p.id}/comments`).then((r) => {
    list = r.comments;
    p.comments = list.length;
    updatePost(p);
  }).catch(() => {
    list = [];
    note = "Не получилось загрузить комментарии. Проверьте интернет.";
  }).finally(() => {
    if (sheet.hidden || !sheet.querySelector(`.comments[data-post="${p.id}"]`)) return;   // closed, or another sheet took its place
    draw();
    toBottom(sheet.querySelector(".sheet-panel"));
  });
}

/** a photo from the feed over everything; a tap or "back" closes it */
function openPhoto(url) {
  haptic();
  const before = backHandler;
  const el = document.createElement("div");
  el.className = "photo-view";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Фото");
  el.innerHTML = `<img src="${esc(url)}" alt="">`;
  document.body.append(el);
  const close = () => { el.remove(); setBack(before); };
  el.addEventListener("click", close);
  setBack(close);
}

/** a photo for the feed: its own shape, at most `max` on the long side */
async function scaledJpeg(file, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = fail;
      i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = Object.assign(document.createElement("canvas"),
      { width: Math.round(img.naturalWidth * k), height: Math.round(img.naturalHeight * k) });
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.86));
  } finally {
    URL.revokeObjectURL(url);
  }
}
const blobBase64 = (blob) => new Promise((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(",")[1]);
  r.onerror = fail;
  r.readAsDataURL(blob);
});

function openComposer() {
  const c = state.clubView?.data;
  if (!c) return;
  haptic();
  const draft = { body: "", photo: null, comments: true, public: false };   // photo: { blob, url }
  const audience = () => draft.public
    ? `Её увидят все, кто откроет клуб «${esc(c.name)}», даже не вступив.`
    : `Её увидят только участники клуба «${esc(c.name)}».`;
  const dropPhoto = () => { if (draft.photo) URL.revokeObjectURL(draft.photo.url); draft.photo = null; };
  const draw = (note = "") => openSheet(`
    <div class="sheet-head"><div>
      <h2 id="sheet-title">Новая запись</h2>
      <p id="post-audience">${audience()}</p>
    </div></div>
    <form class="field post-form" id="post-form" novalidate>
      <textarea id="post-body" maxlength="2000" rows="5" aria-label="Текст записи" placeholder="Новость, анонс встречи или что-нибудь смешное">${esc(draft.body)}</textarea>
      <p class="field-hint num"><span id="post-count">${draft.body.length}</span> из 2000</p>
      ${draft.photo ? `<div class="post-pick"><img src="${draft.photo.url}" alt="Выбранное фото"><button type="button" class="btn-sm" id="post-photo-drop">Убрать фото</button></div>` : ""}
      <div class="post-tools"><button type="button" class="btn-sm" id="post-photo-pick">${icon.camera}${draft.photo ? "Другое фото" : "Добавить фото"}</button></div>
      <input type="file" id="post-file" accept="image/*" hidden>
      <ul class="options post-options">
        ${switchRow("post-public", "Видна всем", "Запись увидят и те, кто ещё не вступил в клуб", draft.public)}
        ${switchRow("post-comments", "Комментарии", "Участники смогут обсуждать запись", draft.comments)}
      </ul>
      <p class="err" id="post-err" ${note ? "" : "hidden"}>${esc(note)}</p>
      <button class="btn" type="submit" id="post-send">Опубликовать</button>
    </form>`, (panel) => {
    const text = panel.querySelector("#post-body");
    text.addEventListener("input", () => {
      draft.body = text.value;
      panel.querySelector("#post-count").textContent = text.value.length;
      panel.querySelector("#post-err").hidden = true;
    });
    const file = panel.querySelector("#post-file");
    panel.querySelector("#post-photo-pick").addEventListener("click", () => { haptic(); file.click(); });
    file.addEventListener("change", async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        const blob = await scaledJpeg(f);
        dropPhoto();
        draft.photo = { blob, url: URL.createObjectURL(blob) };
        draw();
      } catch (_) {
        draw("Не получилось открыть это фото. Выберите другое.");
      }
    });
    panel.querySelector("#post-photo-drop")?.addEventListener("click", () => { haptic(); dropPhoto(); draw(); });
    const sw = panel.querySelector('[data-set="post-comments"]');
    sw.addEventListener("click", () => {
      haptic();
      draft.comments = !draft.comments;
      sw.setAttribute("aria-checked", String(draft.comments));
    });
    const open = panel.querySelector('[data-set="post-public"]');
    open.addEventListener("click", () => {
      haptic();
      draft.public = !draft.public;
      open.setAttribute("aria-checked", String(draft.public));
      panel.querySelector("#post-audience").innerHTML = audience();
    });
    panel.querySelector("#post-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!draft.body.trim() && !draft.photo) { haptic("error"); return draw("Напишите что-нибудь или добавьте фото."); }
      const send = panel.querySelector("#post-send");
      send.disabled = true;
      send.textContent = "Публикуем…";
      let post;
      try {
        post = await api(`/api/clubs/${c.id}/posts`, { method: "POST", body: JSON.stringify({
          body: draft.body, photo: draft.photo ? await blobBase64(draft.photo.blob) : null, comments_off: !draft.comments, public: draft.public }) });
      } catch (err) {
        haptic("error");
        return draw(errText(err, "Не получилось опубликовать. Проверьте интернет."));
      }
      haptic("success");
      dropPhoto();
      closeSheet();
      if (post.public) state.sharedFeed = null;
      const v = state.clubView;
      if (v?.data?.id === c.id) {
        if (v.feed) v.feed.posts.unshift(post);
        v.section = "feed";
        renderClubPage();
      }
      loadClubs();
    });
  });
  draw();
}

function memberRow(m) {
  const self = m.tg_id === state.me.tg_id;
  const tag = ROLE_NAME[m.role] ? `<span class="role-tag ${m.role}">${ROLE_NAME[m.role]}</span>` : "";
  return personRow({ ...m, name: self ? `${m.name} (вы)` : m.name, groupTag: true }, esc(dirLine(m)),
    tag + (self ? "" : `<span class="row-go">${icon.right}</span>`),
    self ? "" : `role="button" tabindex="0" data-member="${m.tg_id}"`);
}

/* a member's card: anyone in the club can ask them to be friends or write to them in Telegram;
   the owner and admins also manage them here. The @tag is fetched only for the chat link, never shown. */
function openMemberSheet(m) {
  const c = state.clubView?.data;
  if (!m || !c) return;
  haptic();
  const owner = c.role === "owner";
  const canManage = owner ? m.role !== "owner" : c.role === "admin" && m.role === "member";
  const rel = m.relation;
  const friendPart = rel === "friend" ? `<p class="member-rel">${icon.check}Вы друзья</p>`
    : rel === "outgoing" ? `<p class="member-rel">Заявка в друзья отправлена</p>`
    : `<button class="btn" data-f="${rel === "incoming" ? "accept" : "add"}">${rel === "incoming" ? "Принять заявку в друзья" : "Добавить в друзья"}</button>`;
  const dm = m.can_dm
    ? `<button class="btn chat-btn ${rel === "friend" || rel === "outgoing" ? "" : "secondary"}" data-dm>${icon.plane}Написать в Telegram</button>`
    : !c.role ? `<p class="search-hint">Написать участнику в Telegram можно, когда вступите в клуб.</p>`
    : `<p class="search-hint">У этого человека нет тега в Telegram, поэтому написать ему отсюда не получится.</p>`;
  // the chat link is asked for as the card opens, so the tap on "write" can open Telegram straight away
  const contact = m.can_dm ? api(`/api/clubs/${c.id}/members/${m.tg_id}/contact`).catch((e) => e) : null;
  openSheet(`
    <div class="sheet-head friend-head">
      ${personAvatar(m)}
      <div><h2 id="sheet-title">${esc(m.name)}</h2><p>${esc([ROLE_NAME[m.role] || "Участник", groupLine(m)].join(" · "))}</p></div>
    </div>
    ${m.bio ? `<p class="person-bio">${esc(m.bio)}</p>` : ""}
    <div class="sheet-actions">${friendPart}${dm}</div>
    ${canManage ? `
      <h3 class="group-label">Управление клубом</h3>
      ${owner ? `<div class="sheet-actions">
        <button class="btn secondary" data-m="role">${m.role === "admin" ? "Снять с админов" : "Сделать админом"}</button>
        <button class="btn secondary" data-m="transfer">Передать права владельца</button>
      </div>
      <p class="search-hint">Если передать права, этот человек станет владельцем, а вы останетесь в клубе админом.</p>` : ""}
      <button class="btn-text danger" data-m="kick">Исключить из клуба</button>` : ""}`, (panel) => {
    panel.querySelector("[data-f]")?.addEventListener("click", async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        const r = await api(`/api/friends/${m.tg_id}${b.dataset.f === "accept" ? "/accept" : ""}`, { method: "POST" });
        haptic("success");
        m.relation = r.relation;
        loadFriends();
        openMemberSheet(m);
      } catch (err) {
        haptic("error");
        b.disabled = false;
        say(errText(err));
      }
    });
    panel.querySelector("[data-dm]")?.addEventListener("click", async () => {
      const r = await contact;
      if (r instanceof Error || !r?.url) { haptic("error"); say(errText(r, "Не получилось открыть чат. Проверьте интернет.")); return; }
      haptic();
      openOut(r.url);
    });
    panel.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", async () => {
      const what = b.dataset.m;
      if (what !== "role" && !b.dataset.sure) {
        b.dataset.sure = "1";
        b.textContent = what === "transfer" ? "Точно передать? Нажмите ещё раз" : "Точно исключить? Нажмите ещё раз";
        haptic();
        return;
      }
      b.disabled = true;
      const base = `/api/clubs/${c.id}`;
      try {
        const data = what === "role"
          ? await api(`${base}/members/${m.tg_id}/role`, { method: "POST", body: JSON.stringify({ role: m.role === "admin" ? "member" : "admin" }) })
          : what === "transfer"
          ? await api(`${base}/transfer/${m.tg_id}`, { method: "POST" })
          : await api(`${base}/members/${m.tg_id}`, { method: "DELETE" });
        haptic("success");
        closeSheet();
        clubUpdated(data);
      } catch (e) {
        haptic("error");
        b.disabled = false;
        say(errText(e));
      }
    }));
  });
}

/* inviting: a friend from the list, or anyone by their exact @tag */
async function openInviteSheet() {
  haptic();
  if (!state.friends) await loadFriends();
  let found = null;   // the person found by tag, or "none"
  const draw = () => {
    const c = state.clubView?.data;
    if (!c) return;
    const inClub = new Set(c.member_list.map((m) => m.tg_id));
    const invited = new Set((c.invites || []).map((p) => p.tg_id));
    const status = (p) => p.tg_id === state.me.tg_id ? `<span class="person-state">Это вы</span>`
      : inClub.has(p.tg_id) ? `<span class="person-state">В клубе</span>`
      : invited.has(p.tg_id) ? `<span class="person-state">Отправлено</span>`
      : `<button class="btn-sm primary" data-invite="${p.tg_id}">Пригласить</button>`;
    const friends = state.friends?.friends || [];
    const result = found === "none"
      ? `<p class="note"><strong>Никого не нашли</strong>Проверьте тег. Найти можно только тех, кто уже открывал это приложение.</p>`
      : found ? `<ul class="people found">${personRow(found, esc(groupLine(found)), status(found))}</ul>` : "";
    openSheet(`
      <div class="sheet-head"><div>
        <h2 id="sheet-title">Пригласить в клуб</h2>
        <p>Приглашение появится у человека в разделе «Вступить».</p>
      </div></div>
      <form class="friend-search" id="invite-search" autocomplete="off">
        <input id="invite-q" name="q" type="search" autocapitalize="off" spellcheck="false" enterkeyhint="search"
               placeholder="@тег в Telegram" aria-label="Тег в Telegram">
        <button class="btn inline" type="submit">Найти</button>
      </form>
      ${result}
      ${friends.length ? `<h2 class="group-label">Ваши друзья</h2>
        <ul class="people invite-list">${friends.map((p) => personRow(p, esc(dirLine(p)), status(p))).join("")}</ul>`
        : `<p class="search-hint">Друзей пока нет, но пригласить можно любого студента по тегу.</p>`}`, (panel) => {
      panel.querySelector("#invite-search").addEventListener("submit", async (e) => {
        e.preventDefault();
        const q = e.currentTarget.q.value.trim();
        if (!q) return;
        try {
          found = (await api(`/api/users/find?username=${encodeURIComponent(q)}`)).user || "none";
        } catch (err) {
          haptic("error");
          say(errText(err, "Не получилось найти. Проверьте интернет."));
          return;
        }
        draw();
      });
      panel.querySelectorAll("[data-invite]").forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          state.clubView.data = await api(`/api/clubs/${c.id}/invites/${b.dataset.invite}`, { method: "POST" });
          haptic("success");
          renderClubs();
          draw();
        } catch (e) {
          haptic("error");
          b.disabled = false;
          say(errText(e));
        }
      }));
    });
  };
  draw();
}

/* ---------- founding a club, and its settings: one form ---------- */

function openClubForm(club) {
  haptic();
  state.clubView = {
    kind: "form",
    club,
    back: state.clubView,
    draft: {
      name: club?.name || "",
      about: club?.about || "",
      category: club?.category || "",
      visibility: club?.visibility || "public",
      chat_url: club?.chat_url ? club.chat_url.replace(/^https:\/\//, "") : "",
    },
    photo: null,   // { blob, url } of a picked photo, or "remove"
  };
  window.scrollTo(0, 0);
  renderClubs();
}

function renderClubForm() {
  const v = state.clubView, d = v.draft, editing = Boolean(v.club);
  setBack(closeClubView);
  const hasPhoto = v.photo?.url || (v.photo !== "remove" && v.club?.photo_url);
  const preview = v.photo?.url
    ? `<span class="avatar club-avatar big" style="--c: var(--hue-${(CLUB_CATS[d.category] || CLUB_CATS.other)[1]})"><img src="${v.photo.url}" alt=""></span>`
    : clubAvatar({ name: d.name.trim() || "Клуб", category: d.category || "other", photo_url: v.photo === "remove" ? "" : v.club?.photo_url || "" }, "big");
  app.innerHTML = `
    ${backLink(editing ? "Клуб" : "Клубы")}
    <h1 class="view-title">${editing ? "Настройки клуба" : "Новый клуб"}</h1>
    <form class="club-form" id="club-form" novalidate autocomplete="off">
      <div class="club-photo">
        ${preview}
        <div class="club-photo-actions">
          <button type="button" class="btn-sm" id="club-photo-pick">${hasPhoto ? "Сменить фото" : "Выбрать фото"}</button>
          ${hasPhoto ? `<button type="button" class="btn-sm" id="club-photo-drop">Убрать</button>` : ""}
        </div>
        <input type="file" id="club-photo-file" accept="image/*" hidden>
      </div>
      <div class="field">
        <label for="club-name">Название</label>
        <input id="club-name" maxlength="48" autocapitalize="sentences" enterkeyhint="next" placeholder="Например, Шахматный клуб" value="${esc(d.name)}">
      </div>
      <div class="field">
        <label for="club-about">Описание</label>
        <textarea id="club-about" maxlength="600" rows="4" placeholder="Чем занимаетесь, когда и где встречаетесь">${esc(d.about)}</textarea>
        <p class="field-hint num"><span id="about-count">${d.about.length}</span> из 600</p>
      </div>
      <div class="field">
        <span class="label" id="cat-label">Направленность</span>
        <div class="cat-chips" role="radiogroup" aria-labelledby="cat-label">${Object.entries(CLUB_CATS).map(([k, [label, hue]]) =>
          `<button type="button" role="radio" data-cat="${k}" aria-checked="${d.category === k}" style="--c: var(--hue-${hue})">${label}</button>`).join("")}</div>
      </div>
      <div class="field">
        <span class="label" id="vis-label">Кто может вступить</span>
        <ul class="options" role="radiogroup" aria-labelledby="vis-label">${Object.entries(CLUB_VIS).map(([k, [label, hint]]) => `
          <li><button type="button" role="radio" data-vis="${k}" aria-checked="${d.visibility === k}">
            <span>${label}<small>${hint}</small></span><span class="check">${icon.check}</span>
          </button></li>`).join("")}</ul>
      </div>
      <div class="field">
        <label for="club-chat">Чат в Telegram</label>
        <input id="club-chat" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="t.me/название_чата" value="${esc(d.chat_url)}">
        <p class="field-hint">Необязательно. Ссылку увидят только участники, у них появится кнопка «Открыть чат клуба».</p>
      </div>
      <p class="err" id="club-err" hidden></p>
      <button class="btn club-submit" type="submit" id="club-save">${editing ? "Сохранить" : "Создать клуб"}</button>
    </form>`;
  document.getElementById("club-back")?.addEventListener("click", closeClubView);

  const form = document.getElementById("club-form");
  const err = document.getElementById("club-err");
  const fail = (msg) => { err.textContent = msg; err.hidden = false; haptic("error"); };
  form.querySelector("#club-name").addEventListener("input", (e) => { d.name = e.target.value; err.hidden = true; });
  form.querySelector("#club-about").addEventListener("input", (e) => {
    d.about = e.target.value;
    document.getElementById("about-count").textContent = d.about.length;
  });
  form.querySelector("#club-chat").addEventListener("input", (e) => { d.chat_url = e.target.value; err.hidden = true; });
  form.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => {
    haptic();
    d.category = b.dataset.cat;
    form.querySelectorAll("[data-cat]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  }));
  form.querySelectorAll("[data-vis]").forEach((b) => b.addEventListener("click", () => {
    haptic();
    d.visibility = b.dataset.vis;
    form.querySelectorAll("[data-vis]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  }));
  const file = form.querySelector("#club-photo-file");
  form.querySelector("#club-photo-pick").addEventListener("click", () => { haptic(); file.click(); });
  file.addEventListener("change", async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      const blob = await squareJpeg(f);
      if (v.photo?.url) URL.revokeObjectURL(v.photo.url);
      v.photo = { blob, url: URL.createObjectURL(blob) };
      renderClubForm();
    } catch (_) {
      fail("Не получилось открыть это фото. Выберите другое.");
    }
  });
  form.querySelector("#club-photo-drop")?.addEventListener("click", () => {
    haptic();
    if (v.photo?.url) URL.revokeObjectURL(v.photo.url);
    v.photo = v.club?.photo_url ? "remove" : null;
    renderClubForm();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (d.name.trim().length < 2) return fail("Придумайте название, хотя бы два символа.");
    const btn = document.getElementById("club-save");
    btn.disabled = true;
    btn.textContent = "Сохраняем…";
    const body = JSON.stringify({ name: d.name, about: d.about, category: d.category || "other", visibility: d.visibility, chat_url: d.chat_url });
    let data;
    try {
      data = editing
        ? await api(`/api/clubs/${v.club.id}/settings`, { method: "POST", body })
        : await api("/api/clubs", { method: "POST", body });
    } catch (e) {
      btn.disabled = false;
      btn.textContent = editing ? "Сохранить" : "Создать клуб";
      return fail(errText(e));
    }
    let photoFailed = false;
    try {
      if (v.photo?.blob) data = await api(`/api/clubs/${data.id}/avatar`, { method: "POST", body: v.photo.blob });
      else if (v.photo === "remove") data = await api(`/api/clubs/${data.id}/avatar`, { method: "DELETE" });
    } catch (_) {
      photoFailed = true;
    }
    if (v.photo?.url) URL.revokeObjectURL(v.photo.url);
    haptic("success");
    state.clubView = { kind: "club", id: data.id, data };
    window.scrollTo(0, 0);
    loadClubs();
    renderClubs();
    if (photoFailed) say("Клуб сохранён, но фото не загрузилось. Попробуйте ещё раз в настройках клуба.");
  });
}

/* ---------- screen: profile ---------- */

// each glyph has named parts for the scene it plays when tapped: the sliders' knobs slide, the person twitches,
// the two friends hop one after the other
const PROFILE_VIEWS = [
  ["settings", "Настройки", '<path d="M4 7h16M4 17h16"/><circle class="knob" cx="15" cy="7" r="2.3"/><circle class="knob k2" cx="9" cy="17" r="2.3"/>'],
  ["profile", "Профиль", '<g class="me"><circle class="me-head" cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.6 3.8-5.5 7-5.5s5.8 1.9 7 5.5"/></g>'],
  ["friends", "Друзья", '<g class="fr"><circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.9-3 3-4.6 5.5-4.6s4.6 1.6 5.5 4.6"/></g><g class="fr f2"><path d="M15.5 5.6a3 3 0 0 1 0 5.8M17 14.9c1.8.4 3 1.9 3.6 4.6"/></g>'],
];

function renderProfile() {
  const v = state.profileView;
  app.innerHTML = `
    <div class="slide-tabs segmented" role="tablist" aria-label="Раздел профиля">
      <span class="slide-cursor" aria-hidden="true"></span>
      ${PROFILE_VIEWS.map(([id, label, glyph]) => `<button role="tab" data-view="${id}" aria-selected="${v === id}" aria-label="${label}">${svg(glyph)}</button>`).join("")}
    </div>
    <div id="profile-body">${profileBody()}</div>`;
  profileTabs = new SlideTabs(app.querySelector(".segmented"), (tab) => {
    haptic();
    state.profileView = tab.dataset.view;
    updateProfileBody();
  });
  bindProfileBody();
}

function profileBody() {
  const v = state.profileView;
  return v === "settings" ? settingsView() : v === "friends" ? friendsView() : profileView();
}
function updateProfileBody() {
  document.getElementById("profile-body").innerHTML = profileBody();
  bindProfileBody();
}
function bindProfileBody() {
  bindSemester();
  bindFriends();
  document.getElementById("edit-profile")?.addEventListener("click", () => { haptic(); startOnboarding(true); });
  document.getElementById("edit-nick")?.addEventListener("click", openNickSheet);
  document.getElementById("edit-bio")?.addEventListener("click", openBioSheet);
  document.getElementById("edit-avatar")?.addEventListener("click", openAvatarSheet);
  app.querySelectorAll("[data-theme-pref]").forEach((b) => b.addEventListener("click", (e) => {
    haptic();
    switchTheme(b.dataset.themePref, e.clientX, e.clientY);
  }));

  // notifications: each control saves itself
  const st = state.settings;
  app.querySelector('[data-set="remind_all"]')?.addEventListener("click", () => { haptic(); saveSetting({ remind_all: !st.remind_all }); });
  app.querySelector('[data-set="show_club"]')?.addEventListener("click", () => { haptic(); saveSetting({ show_club: !st.show_club }); });
  app.querySelectorAll("[data-lead]").forEach((b) => b.addEventListener("click", () => { haptic(); saveSetting({ remind_lead: Number(b.dataset.lead) }); }));
  app.querySelector('[data-set="digest"]')?.addEventListener("click", () => { haptic(); saveSetting({ digest_time: st.digest_time ? "off" : "07:30" }); });
  app.querySelectorAll("[data-digest]").forEach((b) => b.addEventListener("click", () => { haptic(); saveSetting({ digest_time: b.dataset.digest }); }));

  app.querySelectorAll("[data-view-pref]").forEach((b) => b.addEventListener("click", () => {
    haptic();
    setViewPref(b.dataset.viewPref);
    updateProfileBody();
  }));
  document.getElementById("open-calendar")?.addEventListener("click", openCalendarSheet);
  document.getElementById("refresh-now")?.addEventListener("click", refreshNow);
  app.querySelectorAll("[data-open-doc]").forEach((b) => b.addEventListener("click", () => openDocSheet(b.dataset.openDoc)));
  document.getElementById("delete-account")?.addEventListener("click", openDeleteSheet);
  bindPhoneSection();
  document.getElementById("report")?.addEventListener("click", openFeedbackSheet);
}

function openFeedbackSheet() {
  haptic();
  openSheet(`
    <div class="sheet-head"><div>
      <h2 id="sheet-title">Написать разработчику</h2>
      <p>Нашли ошибку, есть идея или вопрос? Напишите, ответ придёт в чат с ботом.</p>
    </div></div>
    <form class="field nick-form" id="fb-form" novalidate>
      <textarea id="fb-body" maxlength="2000" rows="5" aria-label="Сообщение" placeholder="Например, в среду у ПМ-201 не показывается третья пара"></textarea>
      <p class="err" id="fb-err" hidden></p>
      <button class="btn" type="submit">Отправить</button>
    </form>
    <button class="btn-text" id="fb-tg">Или напишите в Telegram: @${DEVELOPER}</button>`, (panel) => {
    const form = panel.querySelector("#fb-form");
    const err = panel.querySelector("#fb-err");
    panel.querySelector("#fb-tg").addEventListener("click", () => openOut(`https://t.me/${DEVELOPER}`));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector(".btn");
      btn.disabled = true;
      try {
        await api("/api/feedback", { method: "POST", body: JSON.stringify({ body: panel.querySelector("#fb-body").value }) });
        haptic("success");
        openSheet(`<div class="sheet-head"><div><h2 id="sheet-title">Отправлено</h2><p>Спасибо! Разработчик прочитает и ответит в чате с ботом.</p></div></div>
          <button class="btn" id="fb-done">Готово</button>`, (p) => p.querySelector("#fb-done").addEventListener("click", () => closeSheet()));
      } catch (e2) {
        btn.disabled = false;
        err.textContent = errText(e2, "Не получилось отправить. Проверьте интернет.");
        err.hidden = false;
        haptic("error");
      }
    });
  });
}

/* ---------- «Пожаловаться»: a post, a comment, a person or a club goes to the admin's queue ---------- */
const REPORT_REASONS = ["Спам", "Оскорбления", "Мат", "Неприемлемое", "Обман", "Другое"];
function openReportSheet(kind, target, what) {
  haptic();
  let reason = "";
  openSheet(`
    <div class="sheet-head"><div>
      <h2 id="sheet-title">Пожаловаться</h2>
      <p>Что не так с ${what}? Жалобу увидит только администратор, автор не узнает, кто её отправил.</p>
    </div></div>
    <ul class="options" role="radiogroup" aria-label="Причина">
      ${REPORT_REASONS.map((r) => `<li><button role="radio" data-reason="${r}" aria-checked="false"><span>${r}</span><span class="check">${icon.check}</span></button></li>`).join("")}
    </ul>
    <form class="field nick-form" id="rep-form" novalidate>
      <textarea id="rep-note" maxlength="500" rows="2" aria-label="Подробности" placeholder="Подробности, если нужно"></textarea>
      <p class="err" id="rep-err" hidden></p>
      <button class="btn" type="submit" disabled>Отправить жалобу</button>
    </form>`, (panel) => {
    const form = panel.querySelector("#rep-form");
    const btn = form.querySelector(".btn");
    const err = panel.querySelector("#rep-err");
    panel.querySelectorAll("[data-reason]").forEach((b) => b.addEventListener("click", () => {
      haptic();
      reason = b.dataset.reason;
      panel.querySelectorAll("[data-reason]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      btn.disabled = false;
    }));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!reason) return;
      btn.disabled = true;
      try {
        await api("/api/report", { method: "POST", body: JSON.stringify({ kind, target, reason, note: panel.querySelector("#rep-note").value }) });
        haptic("success");
        openSheet(`<div class="sheet-head"><div><h2 id="sheet-title">Жалоба отправлена</h2><p>Спасибо! Администратор посмотрит и примет меры.</p></div></div>
          <button class="btn" id="rep-done">Готово</button>`, (p) => p.querySelector("#rep-done").addEventListener("click", () => closeSheet()));
      } catch (e2) {
        btn.disabled = false;
        err.textContent = errText(e2, "Не получилось отправить. Проверьте интернет.");
        err.hidden = false;
        haptic("error");
      }
    });
  });
}

/* ---------- about yourself: a few words friends and club members see ---------- */

function openBioSheet() {
  haptic();
  const me = state.me;
  openSheet(`
    <div class="sheet-head"><div>
      <h2 id="sheet-title">О себе</h2>
      <p>Пара слов о вас: чем увлекаетесь, чем можете помочь. Это видят друзья и участники вашего клуба.</p>
    </div></div>
    <form class="field nick-form" id="bio-form" novalidate>
      <textarea id="bio" maxlength="200" rows="4" aria-label="О себе" placeholder="Например, играю в шахматы и могу помочь с матанализом">${esc(me.bio || "")}</textarea>
      <p class="field-hint num"><span id="bio-count">${(me.bio || "").length}</span> из 200</p>
      <p class="err" id="bio-err" hidden></p>
      <button class="btn" type="submit">Сохранить</button>
    </form>
    ${me.bio ? `<button class="btn-text" id="bio-clear">Убрать описание</button>` : ""}`, (panel) => {
    const form = panel.querySelector("#bio-form");
    const input = form.querySelector("#bio");
    const err = form.querySelector("#bio-err");
    const save = async (bio) => {
      const btn = form.querySelector(".btn");
      btn.disabled = true;
      try {
        state.me = await api("/api/profile/bio", { method: "POST", body: JSON.stringify({ bio }) });
        haptic("success");
        closeSheet();
        updateProfileBody();
      } catch (e) {
        btn.disabled = false;
        err.textContent = errText(e, "Не получилось сохранить. Проверьте интернет.");
        err.hidden = false;
        haptic("error");
      }
    };
    input.addEventListener("input", () => {
      err.hidden = true;
      panel.querySelector("#bio-count").textContent = input.value.length;
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      input.blur();
      save(input.value);
    });
    panel.querySelector("#bio-clear")?.addEventListener("click", () => save(""));
  });
}

/* ---------- nickname and photo: what friends see, changeable any time ---------- */

function openNickSheet() {
  haptic();
  const me = state.me;
  openSheet(`
    <div class="sheet-head"><div>
      <h2 id="sheet-title">Ник</h2>
      <p>Так вас видят друзья: в списке, в заявках и в карточке. Без ника видно ваше имя.</p>
    </div></div>
    <form class="field nick-form" id="nick-form" autocomplete="off" novalidate>
      <input id="nick" maxlength="32" autocapitalize="off" spellcheck="false" enterkeyhint="done" aria-label="Ник"
             placeholder="${esc(me.real_name || "Ваш ник")}" value="${esc(me.nickname || "")}">
      <p class="err" id="nick-err" hidden></p>
      <button class="btn" type="submit">Сохранить</button>
    </form>
    ${me.nickname ? `<button class="btn-text" id="nick-clear">Убрать ник и показывать имя</button>` : ""}`, (panel) => {
    const form = panel.querySelector("#nick-form");
    const input = form.querySelector("#nick");
    const err = form.querySelector("#nick-err");
    const save = async (nickname) => {
      const btn = form.querySelector(".btn");
      btn.disabled = true;
      try {
        state.me = await api("/api/profile/nickname", { method: "POST", body: JSON.stringify({ nickname }) });
        haptic("success");
        closeSheet();
        updateProfileBody();
      } catch (e) {
        btn.disabled = false;
        err.textContent = e instanceof HttpError && e.status === 400 ? e.message : "Не получилось сохранить. Проверьте интернет.";
        err.hidden = false;
        haptic("error");
      }
    };
    input.addEventListener("input", () => { err.hidden = true; });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const nick = input.value.trim().replace(/\s+/g, " ");
      if (nick.length === 1) { err.textContent = "Хотя бы два символа."; err.hidden = false; haptic("error"); return; }
      input.blur();
      save(nick);
    });
    panel.querySelector("#nick-clear")?.addEventListener("click", () => save(""));
  });
}

/** the middle square of a photo, as a JPEG small enough to send */
async function squareJpeg(file, size = 512) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = fail;
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
    canvas.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return await new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.9));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function openAvatarSheet() {
  haptic();
  let picked = null; // { blob, url }: the cropped photo waiting for "Сохранить"
  const forget = () => { if (picked) URL.revokeObjectURL(picked.url); picked = null; };
  const draw = (note = "") => {
    const me = state.me;
    const preview = picked
      ? `<span class="avatar big"><img src="${picked.url}" alt=""></span>`
      : avatarHtml(me, "big");
    openSheet(`
      <div class="sheet-head"><div>
        <h2 id="sheet-title">Фото профиля</h2>
        <p>Его видят друзья. Фото обрезается до круга по центру.</p>
      </div></div>
      <div class="avatar-preview">${preview}</div>
      <input type="file" id="avatar-file" accept="image/*" hidden>
      <p class="err avatar-err" ${note ? "" : "hidden"}>${esc(note)}</p>
      <div class="sheet-actions">
        ${picked
          ? `<button class="btn" id="avatar-save">Сохранить</button><button class="btn secondary" id="avatar-pick">Выбрать другое</button>`
          : `<button class="btn" id="avatar-pick">Выбрать фото</button>`}
      </div>
      ${!picked && me.custom_avatar ? `<button class="btn-text" id="avatar-reset">Вернуть фото из Telegram</button>` : ""}`, (panel) => {
      const file = panel.querySelector("#avatar-file");
      panel.querySelector("#avatar-pick").addEventListener("click", () => { haptic(); file.click(); });
      file.addEventListener("change", async () => {
        const f = file.files[0];
        if (!f) return;
        try {
          const blob = await squareJpeg(f);
          forget();
          picked = { blob, url: URL.createObjectURL(blob) };
          draw();
        } catch (_) {
          draw("Не получилось открыть это фото. Выберите другое.");
        }
      });
      panel.querySelector("#avatar-save")?.addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = "Сохраняем…";
        if (await saveAvatar(() => api("/api/profile/avatar", { method: "POST", body: picked.blob }), draw)) forget();
      });
      panel.querySelector("#avatar-reset")?.addEventListener("click", () =>
        saveAvatar(() => api("/api/profile/avatar", { method: "DELETE" }), draw));
    });
  };
  draw();
}

async function saveAvatar(request, redraw) {
  try {
    state.me = await request();
    avatarUrl = null;
    await resolveAvatar(state.me);
    haptic("success");
    closeSheet();
    updateProfileBody();
    return true;
  } catch (e) {
    haptic("error");
    redraw(e instanceof HttpError && e.status === 400 ? e.message : "Не получилось сохранить фото. Проверьте интернет.");
    return false;
  }
}

/* ---------- the flame: a streak of days on which both friends pressed it ---------- */

const FLAME_PATH = '<path class="outer" d="M12 21.5C8.4 21.5 5.5 18.9 5.5 15.3c0-2.4 1.2-4.4 2.8-6 .2 1.4.9 2.5 2 3-.4-3.7 1.3-7 4.1-9.7.1 3.2 1.6 5 2.9 6.8.9 1.4 1.2 3.2 1.2 5.9 0 3.6-2.9 6.2-6.5 6.2Z"/>'
  + '<path class="core" d="M12 21.5c-1.6 0-2.6-1.2-2.6-2.7 0-1.6 1.2-2.8 2.2-4 .3 1.2 1 1.8 1.8 2.1.8.4 1.2 1.1 1.2 1.9 0 1.5-1 2.7-2.6 2.7Z"/>';
const dayCount = (n) => `${n} ${plural(n, "день", "дня", "дней")}`;

function flameState(f) {
  if (!f) return "off";
  if (f.me_today && f.friend_today) return "lit";
  if (f.me_today) return "mine";
  if (f.friend_today) return "theirs";
  return f.streak > 0 ? "alive" : "off";
}

function flameText(f) {
  const st = flameState(f);
  const n = f?.streak || 0;
  return {
    lit: `Серия ${dayCount(n)}. Сегодня огонёк зажгли оба`,
    mine: n ? `Серия ${dayCount(n)}. Вы зажгли, ждём друга` : "Вы зажгли огонёк, ждём друга",
    theirs: "Друг уже зажёг огонёк, ваша очередь",
    alive: `Серия ${dayCount(n)}. Сегодня ещё не зажигали, погаснет в полночь`,
    off: "Зажгите огонёк, и если друг сделает то же сегодня, начнётся серия",
  }[st];
}

function flameButton(p, cls = "") {
  const f = p.flame || { streak: 0 };
  return `<button class="flame ${flameState(f)} ${cls}" data-flame="${p.tg_id}" aria-label="${esc(flameText(f))}">
    ${svg(FLAME_PATH)}${f.streak ? `<b class="num">${f.streak}</b>` : ""}</button>`;
}

async function pressFlame(id) {
  const p = state.friends?.friends.find((x) => x.tg_id === id);
  if (!p) return;
  const before = p.flame?.streak || 0;
  if (p.flame?.me_today) { haptic(); igniteButtons(id, false); return; } // already lit today: just a flicker
  haptic("success");
  try {
    p.flame = await api(`/api/friends/${id}/flame`, { method: "POST" });
  } catch (e) {
    haptic("error");
    say(errText(e, "Не получилось зажечь огонёк. Проверьте интернет."));
    return;
  }
  igniteButtons(id, p.flame.streak > before);
}

/** redraw every flame button for this friend (the list and the sheet) and play the ignite */
function igniteButtons(id, grew) {
  const p = state.friends.friends.find((x) => x.tg_id === id);
  document.querySelectorAll(`[data-flame="${id}"]`).forEach((b) => {
    const big = b.classList.contains("big");
    b.outerHTML = flameButton(p, `${big ? "big" : ""} ignite ${grew ? "grew" : ""}`);
  });
  document.querySelectorAll(`[data-flame-text="${id}"]`).forEach((el) => { el.textContent = flameText(p.flame); });
  bindFlames(document);
}

function bindFlames(root) {
  root.querySelectorAll("[data-flame]").forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = "1";
    b.addEventListener("click", (e) => { e.stopPropagation(); pressFlame(Number(b.dataset.flame)); });
    b.addEventListener("keydown", (e) => e.stopPropagation());
  });
}

/* ---------- friends ---------- */

const FRIENDS_POLL = 30 * 1000;
const noticeShown = new Set(); // requests already shown as a pop-up this session

async function loadFriends() {
  try {
    state.friends = await api("/api/friends");
  } catch (_) {
    return;
  }
  // a saved "at a pair right now" is stale by the time it is shown offline
  if (state.offline) for (const f of state.friends.friends || []) f.now = null;
  showFriendNotice();
  if (state.tab === "profile" && state.profileView === "friends" && !document.activeElement?.matches?.("#friend-q")) {
    updateProfileBody();
  }
}

function personAvatar(p, cls = "") {
  const ini = esc(initials(p.name));
  const img = p.photo_url ? `<img src="${esc(p.photo_url)}" alt="" onerror="this.parentNode.textContent=this.parentNode.dataset.i">` : "";
  return `<span class="avatar ${cls}" data-i="${ini}" aria-hidden="true">${img || ini}</span>`;
}
const direction = (p) => (p.faculty ? `${p.faculty}${p.is_master ? ", магистратура" : ""}` : "");
/** the direction and course, for lists; the full line with the group, for cards */
const dirLine = (p) => [direction(p), p.course ? `${p.course} курс` : ""].filter(Boolean).join(" · ");
const groupLine = (p) => [direction(p), p.group, p.course ? `${p.course} курс` : ""].filter(Boolean).join(" · ");

/** a friend's "right now", in one line */
function nowLine(n) {
  if (!n || n.state === "unknown") return "";
  if (n.state === "free") return "Сегодня пар нет";
  if (n.state === "done") return "Пары на сегодня закончились";
  const room = n.room ? ` · ауд. ${esc(n.room)}` : "";
  const dot = `<i class="now-dot" style="${hueVar(n.subject)}"></i>`;
  return n.state === "now"
    ? `${dot}Сейчас: ${esc(n.subject)}${room} · до ${clock(n.end)}`
    : `${dot}В ${clock(n.start)}: ${esc(n.subject)}${room}`;
}

/** a group's own hue, from its name: everyone from ПМ-101 wears the same colour, and it stays the same */
function groupHue(name) {
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 1000003;
  return Math.round((h * 137.508) % 360);
}
const groupTag = (name) => name ? `<small class="group-tag" style="--gh: ${groupHue(name)}">${esc(name)}</small>` : "";

function personRow(p, sub, actions = "", attrs = "", cls = "") {
  return `
    <li class="person ${cls}" ${attrs}>
      ${personAvatar(p)}
      <div class="person-text">${p.groupTag ? `<div class="person-name"><b>${esc(p.name)}</b>${groupTag(p.group)}</div>` : `<b>${esc(p.name)}</b>`}${p.clubs?.length ? `<div class="person-club">${p.clubs.slice(0, 2).map(clubPill).join("")}${
        p.clubs.length > 2 ? `<small class="club-more">+${p.clubs.length - 2}</small>` : ""}</div>` : ""}<span>${sub}</span></div>
      ${actions ? `<div class="person-actions">${actions}</div>` : ""}
    </li>`;
}

const actionButton = (act, id, label, kind = "") => `<button class="btn-sm ${kind}" data-act="${act}" data-id="${id}">${label}</button>`;

function friendsView() {
  const f = state.friends;
  const me = state.me;
  const hint = me.username
    ? `Ваш тег <b>@${esc(me.username)}</b>: по нему друзья найдут вас.`
    : "У вас нет тега в Telegram. Задайте его в настройках Telegram, иначе друзья не смогут вас найти.";
  const search = `
    <form class="friend-search" id="friend-search" autocomplete="off">
      <input id="friend-q" name="q" type="search" inputmode="text" autocapitalize="off" spellcheck="false"
             enterkeyhint="search" placeholder="@тег в Telegram" aria-label="Тег друга в Telegram">
      <button class="btn inline" type="submit">Найти</button>
    </form>
    <p class="search-hint">${hint}</p>
    <div id="friend-result" aria-live="polite"></div>`;

  if (!f) {
    loadFriends();
    return `<h1 class="view-title">Друзья</h1>${search}<p class="options-note">Загружаем друзей…</p>`;
  }
  const incoming = f.incoming.length ? `
    <h2 class="group-label">Хотят добавить вас</h2>
    <ul class="people">${f.incoming.map((p) => personRow(p, esc(groupLine(p)),
      actionButton("accept", p.tg_id, "Принять", "primary") + actionButton("decline", p.tg_id, "Отклонить"), "", "with-actions")).join("")}</ul>` : "";
  const friends = f.friends.length ? `
    <h2 class="group-label">Друзья · ${f.friends.length}</h2>
    <ul class="people">${f.friends.map((p) => personRow(p,
      `${esc(dirLine(p))}${nowLine(p.now) ? `<em class="person-now">${nowLine(p.now)}</em>` : ""}`, flameButton(p),
      `role="button" tabindex="0" data-friend="${p.tg_id}"`)).join("")}</ul>
    <p class="search-hint">Огонёк: нажимайте его каждый день, и если друг тоже нажмёт в тот же день, серия растёт. Пропустите день, и она погаснет.</p>` : "";
  const outgoing = f.outgoing.length ? `
    <h2 class="group-label">Вы отправили заявку</h2>
    <ul class="people">${f.outgoing.map((p) => personRow(p, esc(groupLine(p)),
      actionButton("cancel", p.tg_id, "Отменить"))).join("")}</ul>` : "";
  const empty = !f.friends.length && !f.incoming.length && !f.outgoing.length
    ? emptyState("friends", "Друзей пока нет", "Найдите однокурсника по тегу в Telegram, и после того как он примет заявку, вы увидите, где у него пары.")
    : "";
  return `<h1 class="view-title">Друзья</h1>${search}${incoming}${friends}${outgoing}${empty}`;
}

function bindFriends() {
  const form = document.getElementById("friend-search");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = form.q.value.trim();
    const out = document.getElementById("friend-result");
    if (!q) return;
    form.q.blur();
    out.innerHTML = `<p class="options-note">Ищем…</p>`;
    try {
      const r = await api(`/api/users/find?username=${encodeURIComponent(q)}`);
      if (!r.user) {
        out.innerHTML = `<p class="note"><strong>Никого не нашли</strong>Проверьте тег. Найти можно только тех, кто уже открывал это приложение.</p>`;
        return;
      }
      const p = r.user;
      const action = {
        none: actionButton("add", p.tg_id, "Добавить", "primary"),
        outgoing: `<span class="person-state">Заявка отправлена</span>`,
        incoming: actionButton("accept", p.tg_id, "Принять", "primary"),
        friend: `<span class="person-state">В друзьях</span>`,
        self: `<span class="person-state">Это вы</span>`,
      }[r.relation];
      out.innerHTML = `<ul class="people found">${personRow(p, esc(groupLine(p)), action)}</ul>`;
      bindPeopleActions(out);
    } catch (err) {
      out.innerHTML = `<p class="note">${err instanceof HttpError && err.status === 400 ? esc(err.message) : "Не получилось найти. Проверьте интернет."}</p>`;
    }
  });
  bindPeopleActions(app);
  bindFlames(app);
  app.querySelectorAll("[data-friend]").forEach((el) => {
    const open = () => openFriendSheet(state.friends.friends.find((p) => p.tg_id === Number(el.dataset.friend)));
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  });
}

function bindPeopleActions(root) {
  root.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const id = Number(b.dataset.id);
    b.disabled = true;
    await friendAction(b.dataset.act, id);
  }));
}

async function friendAction(act, id) {
  haptic();
  try {
    if (act === "add") await api(`/api/friends/${id}`, { method: "POST" });
    else if (act === "accept") await api(`/api/friends/${id}/accept`, { method: "POST" });
    else await api(`/api/friends/${id}`, { method: "DELETE" }); // decline, cancel or remove
    haptic("success");
  } catch (e) {
    haptic("error");
    say(errText(e));
  }
  await loadFriends();
  if (state.tab === "profile" && state.profileView === "friends") updateProfileBody();
}

/* the pop-up when someone wants to add you */
function showFriendNotice() {
  if (state.ob || !state.friends || document.querySelector(".notice")) return;
  const p = state.friends.incoming.find((x) => !noticeShown.has(x.tg_id));
  if (!p) return;
  noticeShown.add(p.tg_id);
  haptic("success");
  const el = document.createElement("div");
  el.id = "friend-notice";
  el.className = "notice";
  el.setAttribute("role", "alertdialog");
  el.setAttribute("aria-label", "Заявка в друзья");
  el.innerHTML = `
    <div class="notice-body">
      ${personAvatar(p, "notice-avatar")}
      <div class="notice-text"><span>Вас хочет добавить в друзья</span><b>${esc(p.name)}</b><small>${esc(groupLine(p))}</small></div>
      <button class="notice-close" aria-label="Решить позже">${svg('<path d="M6 6l12 12M18 6 6 18"/>')}</button>
    </div>
    <div class="notice-actions">
      <button class="btn-sm primary" data-n="accept">Принять</button>
      <button class="btn-sm" data-n="decline">Отклонить</button>
    </div>`;
  document.body.append(el);
  const close = () => {
    el.classList.add("out");
    setTimeout(() => { el.remove(); showFriendNotice(); showClubNotice(); }, 260);
  };
  el.querySelector(".notice-close").addEventListener("click", close);
  el.querySelectorAll("[data-n]").forEach((b) => b.addEventListener("click", async () => {
    el.querySelectorAll("button").forEach((x) => (x.disabled = true));
    close();
    await friendAction(b.dataset.n === "accept" ? "accept" : "decline", p.tg_id);
  }));
}

/* a friend's pairs, by day of the current week */
async function openFriendSheet(p) {
  if (!p) return;
  haptic();
  const t = now();
  const ws = mondayOf(t.iso);
  let selected = dateOf(t.iso).getDay() === 0 ? ws : t.iso; // on Sunday, start from Monday
  const head = () => {
    const cur = state.friends?.friends.find((x) => x.tg_id === p.tg_id) || p;
    return `
    <div class="sheet-head friend-head">
      ${personAvatar(p)}
      <div><h2 id="sheet-title">${esc(p.name)}</h2><p>${esc(groupLine(p))}</p>${cur.clubs?.length ? `<p class="sheet-club">${cur.clubs.map(clubPill).join("")}</p>` : ""}</div>
      ${flameButton(cur, "big")}
    </div>
    <p class="flame-line" data-flame-text="${p.tg_id}">${esc(flameText(cur.flame))}</p>
    ${cur.bio ? `<p class="person-bio">${esc(cur.bio)}</p>` : ""}`;
  };
  openSheet(`${head()}<p class="options-note">Загружаем расписание…</p>`);
  let lessons;
  try {
    lessons = (await api(`/api/friends/${p.tg_id}/schedule?start=${ws}&end=${addDays(ws, 6)}`)).lessons;
  } catch (_) {
    openSheet(`${head()}<p class="note">Не получилось загрузить расписание друга. Проверьте интернет.</p>`);
    return;
  }
  const byDay = (iso) => lessons.filter((l) => l.date === iso);
  const draw = () => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i)).filter((iso, i) => i < 6 || byDay(iso).length);
    const chips = days.map((iso) => {
      const d = dateOf(iso);
      return `<button class="fday ${iso === t.iso ? "today" : ""}" data-fday="${iso}" aria-pressed="${iso === selected}">
        ${WD_SHORT[d.getDay()]}<b class="num">${d.getDate()}</b></button>`;
    }).join("");
    const list = byDay(selected);
    const rows = list.length ? list.map((l) => {
      const past = selected < t.iso || (selected === t.iso && t.min >= toMin(l.end));
      const running = selected === t.iso && t.min >= toMin(l.start) && t.min < toMin(l.end);
      return `
        <li class="pair ${past ? "past" : ""} ${running ? "running" : ""}" style="${hueVar(l.subject)}">
          <span class="t">${clock(l.start)}<br>${clock(l.end)}</span>
          <div><h3>${esc(l.subject)}</h3><p>${esc(kindName(l.kind))}${l.room ? ` · <b>ауд. ${esc(l.room)}</b>` : ""}${running ? " · <b>идёт сейчас</b>" : ""}</p></div>
          ${markSvg(l.subject)}
        </li>`;
    }).join("") : "";
    openSheet(`${head()}
      <div class="fdays">${chips}</div>
      ${rows ? `<ul class="pairs">${rows}</ul>` : `<p class="note"><strong>Пар нет</strong>${dayTitle(selected)}: свободный день.</p>`}
      <button class="btn-text danger" id="unfriend">Удалить из друзей</button>
      <button class="btn-text" id="report-user">Пожаловаться</button>`, (panel) => {
      panel.querySelectorAll("[data-fday]").forEach((b) => b.addEventListener("click", () => { haptic(); selected = b.dataset.fday; draw(); }));
      panel.querySelector("#report-user").addEventListener("click", () => openReportSheet("user", p.tg_id, "этим пользователем"));
      bindFlames(panel);
      const un = panel.querySelector("#unfriend");
      un.addEventListener("click", async () => {
        if (!un.dataset.sure) { un.dataset.sure = "1"; un.textContent = "Точно удалить? Нажмите ещё раз"; return; }
        closeSheet();
        await friendAction("remove", p.tg_id);
      });
    });
  };
  draw();
}

/* ---------- settings ---------- */

const DEVELOPER = "ortikc";
const APP_VERSION = "1.2";
const VIEW_KEY = "msu.view";

function viewPref() {
  try { return localStorage.getItem(VIEW_KEY) === "week" ? "week" : "day"; } catch (_) { return "day"; }
}
function setViewPref(v) {
  try { localStorage.setItem(VIEW_KEY, v); } catch (_) {}
}

async function ensureSettings() {
  if (state.settings) return;
  try {
    state.settings = await api("/api/settings");
  } catch (_) {
    state.settings = { failed: true };
  }
  if (state.tab === "profile" && state.profileView === "settings") updateProfileBody();
}

/** optimistic: the switch moves at once, and moves back if the server says no */
async function saveSetting(patch) {
  const before = { ...state.settings };
  Object.assign(state.settings, patch, patch.digest_time === "off" ? { digest_time: null } : {});
  updateProfileBody();
  app.querySelector(`[role="switch"][data-set="${Object.keys(patch)[0]}"]`)?.classList.add("toggled");
  const shown = JSON.stringify(state.settings);
  try {
    state.settings = await api("/api/settings", { method: "POST", body: JSON.stringify(patch) });
  } catch (e) {
    state.settings = before;
    say(errText(e, "Не получилось сохранить настройку. Проверьте интернет и попробуйте ещё раз."));
  }
  // redrawn only if the server's answer differs, so the switch's own movement plays out
  if (JSON.stringify(state.settings) !== shown) updateProfileBody();
}
// a switch flipped in place (a post's options) squashes on its way too
document.addEventListener("click", (e) => e.target.closest?.('[role="switch"]')?.classList.add("toggled"), true);

const switchRow = (id, label, hint, on) => `
  <li><button type="button" data-set="${id}" role="switch" aria-checked="${on}">
    <span>${label}<small>${hint}</small></span><span class="switch" aria-hidden="true"></span>
  </button></li>`;
const chipsRow = (label, items) => `
  <li class="chips-row"><span>${label}</span><div class="chips">${items}</div></li>`;

function notificationsSection() {
  const st = state.settings;
  if (!st) { ensureSettings(); return `<ul class="options"><li class="options-note">Загружаем настройки…</li></ul>`; }
  if (st.failed) return `<ul class="options"><li class="options-note">Не получилось загрузить настройки бота. Откройте раздел ещё раз.</li></ul>`;
  const leads = st.leads.map((m) => `<button data-lead="${m}" aria-pressed="${st.remind_lead === m}">${m} мин</button>`).join("");
  const times = st.digest_times.map((t) => `<button class="num" data-digest="${t}" aria-pressed="${st.digest_time === t}">${clock(t)}</button>`).join("");
  return `
    <ul class="options">
      ${switchRow("remind_all", "Напоминать о каждой паре", "Бот напишет перед началом", st.remind_all)}
      ${st.remind_all ? chipsRow("Заранее", leads) : ""}
      ${switchRow("digest", "Утренняя сводка", "Пары на день; в дни без пар бот молчит", Boolean(st.digest_time))}
      ${st.digest_time ? chipsRow("Во сколько", times) : ""}
    </ul>`;
}

function friendsSettingsSection() {
  const st = state.settings;
  if (!st || st.failed) return "";
  const my = state.clubs?.my || [];
  return `
    <h2 class="group-label">Друзья</h2>
    <ul class="options">
      ${switchRow("show_club", "Показывать мои клубы друзьям", my.length === 1
        ? `Друзья увидят «${esc(my[0].name)}» рядом с вашим именем`
        : my.length ? "Друзья увидят ваши клубы рядом с вашим именем"
        : "Когда вступите в клубы, друзья увидят их рядом с вашим именем", st.show_club)}
    </ul>`;
}

function settingsView() {
  const pref = themePref();
  const opts = [
    ["dark", "Тёмная", "Чёрный фон"],
    ["light", "Светлая", "Белый фон"],
    ["auto", inTelegram ? "Как в Telegram" : "Как в системе", `Сейчас ${systemTheme() === "light" ? "светлая" : "тёмная"}`],
  ];
  const view = viewPref();
  const synced = state.syncedAt
    ? `Обновлено ${new Date(state.syncedAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
    : "С сайта raspisanie.sev.msu.ru";
  return `
    <h1 class="view-title">Настройки</h1>

    <h2 class="group-label">Уведомления от бота</h2>
    ${notificationsSection()}

    <h2 class="group-label">Расписание</h2>
    <ul class="options">
      ${chipsRow("Открывать сначала", `
        <button data-view-pref="day" aria-pressed="${view === "day"}">День</button>
        <button data-view-pref="week" aria-pressed="${view === "week"}">Неделя</button>`)}
      <li><button id="open-calendar"><span>Добавить в календарь<small>Google, Apple и другие календари</small></span>${icon.right}</button></li>
      <li><button id="refresh-now"><span>Обновить расписание<small id="synced-note">${esc(synced)}</small></span><span class="action-text" id="refresh-label">Обновить</span></button></li>
    </ul>

    ${friendsSettingsSection()}

    <h2 class="group-label">Тема оформления</h2>
    <ul class="options" role="radiogroup" aria-label="Тема оформления">
      ${opts.map(([id, label, hint]) => `
        <li><button role="radio" data-theme-pref="${id}" aria-checked="${pref === id}">
          <span>${label}<small>${hint}</small></span><span class="check">${icon.check}</span>
        </button></li>`).join("")}
    </ul>

    ${phoneSection()}

    <h2 class="group-label">Данные и конфиденциальность</h2>
    <ul class="options">
      <li><button data-open-doc="privacy"><span>Политика конфиденциальности<small>Что хранится и кто это видит</small></span>${icon.right}</button></li>
      <li><button data-open-doc="consent"><span>Согласие на обработку данных<small>${esc(consentNote(state.me))}</small></span>${icon.right}</button></li>
      <li><button class="danger" id="delete-account"><span>Удалить аккаунт<small>Отозвать согласие и стереть все свои данные</small></span></button></li>
    </ul>

    <h2 class="group-label">Помощь</h2>
    <ul class="options">
      <li><button id="report"><span>Написать разработчику<small>Ошибка, идея или вопрос: ответ придёт от бота</small></span>${icon.right}</button></li>
    </ul>
    <p class="source">Версия ${APP_VERSION} · расписание с raspisanie.sev.msu.ru</p>`;
}

async function refreshNow() {
  const btn = document.getElementById("refresh-now");
  const label = document.getElementById("refresh-label");
  if (!btn || btn.disabled) return;
  haptic();
  btn.disabled = true;
  label.textContent = "Обновляем…";
  try {
    const r = await api("/api/refresh", { method: "POST" });
    state.syncedAt = r.synced_at;
    state.lessons.clear();
    state.loadedWeeks.clear();
    await loadWeek(state.weekStart || mondayOf(now().iso));
    haptic("success");
    if (state.profileView === "settings") {
      updateProfileBody();
      document.getElementById("refresh-label").textContent = "Готово";
    }
  } catch (_) {
    haptic("error");
    btn.disabled = false;
    label.textContent = "Не вышло, ещё раз";
  }
}

function openCalendarSheet() {
  const url = state.settings?.calendar_url;
  if (!url) return;
  haptic();
  openSheet(`
    <div class="sheet-head">
      <svg class="mark sheet-mark" style="--c: var(--accent)" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18M7.5 14h3M13.5 14h3M7.5 17.5h3"/></svg>
      <div><h2 id="sheet-title">Пары в вашем календаре</h2><p>Календарь сам подтягивает изменения расписания</p></div>
    </div>
    <p class="link-box">${esc(url)}</p>
    <div class="sheet-actions">
      <button class="btn" id="cal-copy">Скопировать ссылку</button>
      <button class="btn secondary" id="cal-open">Открыть файл календаря</button>
    </div>
    <p class="btn-note" id="cal-note" aria-live="polite"></p>
    <ol class="steps">
      <li><b>Google Календарь.</b> На компьютере откройте calendar.google.com → «Другие календари» → «+» → «Добавить по URL» и вставьте ссылку.</li>
      <li><b>iPhone.</b> Настройки → Календарь → Учётные записи → Новая учётная запись → Другое → «Подписной календарь» и вставьте ссылку.</li>
    </ol>`, (panel) => {
    panel.querySelector("#cal-copy").addEventListener("click", async () => {
      const ok = await copyText(url);
      panel.querySelector("#cal-note").textContent = ok ? "Ссылка скопирована." : "Не получилось скопировать, выделите ссылку вручную.";
      haptic(ok ? "success" : "error");
    });
    panel.querySelector("#cal-open").addEventListener("click", () => {
      haptic();
      if (tg?.openLink && inTelegram) tg.openLink(url); else window.open(url, "_blank");
    });
  });
}

/** the new theme spreads in a circle from the finger, where the browser supports view transitions */
function switchTheme(pref, x, y) {
  const swap = () => { setTheme(pref); updateProfileBody(); };
  if (!document.startViewTransition || reduceMotion.matches) return swap();
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  document.documentElement.classList.add("vt-theme");
  const t = document.startViewTransition(swap);
  t.ready.then(() => document.documentElement.animate(
    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
    { duration: 560, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
  )).catch(() => {});
  t.finished.finally(() => document.documentElement.classList.remove("vt-theme"));
}

/* ---------- semester progress: one segment per week, green to yellow to red towards the session ----------
   The SegmentedProgress component (React) ported: segments fill one by one, the percentage counts up,
   segments near the mouse lift, and a tapped segment shows its week. */

// the autumn semester runs from 1 September to the winter session; change here when the dates change
let SEMESTER = { start: "2026-09-01", session: "2027-01-03" };   // the admin panel's «Настройки» override it (loadConfig)

/* ---------- what the admin sets without a deploy: the semester's dates and a banner over the app ---------- */
const CONFIG_KEY = "msu.config", BANNER_KEY = "msu.banner.closed";
function applyConfig(cfg) {
  if (!cfg) return;
  if (cfg.semester?.start && cfg.semester?.session) SEMESTER = { start: cfg.semester.start, session: cfg.semester.session };
  showBanner(cfg.banner || "");
}
async function loadConfig() {
  let cfg = null;
  try { cfg = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null"); } catch (_) {}
  applyConfig(cfg);   // the last one known first: offline, or before the answer
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      cfg = await res.json();
      try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (_) {}
      applyConfig(cfg);
    }
  } catch (_) {}
}
function showBanner(text) {
  let closed = "";
  try { closed = localStorage.getItem(BANNER_KEY) || ""; } catch (_) {}
  document.querySelector(".admin-banner")?.remove();
  if (!text || closed === text) return;
  const el = Object.assign(document.createElement("div"), { className: "admin-banner" });
  el.setAttribute("role", "status");
  el.innerHTML = `<p>${esc(text)}</p><button aria-label="Закрыть">${icon.close || "×"}</button>`;
  el.querySelector("button").addEventListener("click", () => {
    haptic();
    try { localStorage.setItem(BANNER_KEY, text); } catch (_) {}
    el.remove();
  });
  document.body.append(el);
}

function semesterInfo(t = now()) {
  const day = 86400000;
  const start = dateOf(SEMESTER.start), session = dateOf(SEMESTER.session), today = dateOf(t.iso);
  const total = Math.round((session - start) / day);
  const elapsed = Math.min(total, Math.max(0, Math.round((today - start) / day)));
  const weeks = Math.ceil(total / 7);
  return {
    total, elapsed, weeks,
    pct: (elapsed / total) * 100,
    week: Math.min(weeks, Math.floor(elapsed / 7) + 1),
    left: total - elapsed,
    started: today >= start,
  };
}

/** a week's colour: green at the start of the semester, yellow in the middle, red by the session */
function weekColour(i, n) {
  const t = n > 1 ? i / (n - 1) : 0;
  return t < 0.5
    ? `color-mix(in oklab, var(--hue-yellow) ${Math.round(t * 200)}%, var(--hue-green))`
    : `color-mix(in oklab, var(--hue-red) ${Math.round((t - 0.5) * 200)}%, var(--hue-yellow))`;
}

const shortDate = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

function weekRangeText(i) {
  const a = dateOf(addDays(SEMESTER.start, i * 7));
  const lastDay = addDays(SEMESTER.session, -1);
  const b = dateOf(addDays(SEMESTER.start, i * 7 + 6) < lastDay ? addDays(SEMESTER.start, i * 7 + 6) : lastDay);
  return a.getMonth() === b.getMonth() ? `${a.getDate()}–${b.getDate()} ${MONTHS[a.getMonth()]}` : `${shortDate(a)} – ${shortDate(b)}`;
}

function semesterSummary(s) {
  const session = shortDate(dateOf(SEMESTER.session));
  if (!s.started) return `Семестр начнётся ${shortDate(dateOf(SEMESTER.start))}`;
  if (s.left <= 0) return `Сессия началась ${session}`;
  return `До сессии ${s.left} ${plural(s.left, "день", "дня", "дней")} · она начнётся ${session}`;
}

function semesterCard() {
  const s = semesterInfo();
  const filled = Math.round((s.pct / 100) * s.weeks);
  const head = filled > 0 ? weekColour(filled - 1, s.weeks) : "var(--text)";
  const segments = Array.from({ length: s.weeks }, (_, i) =>
    `<i data-week="${i}" data-filled="${i < filled}" style="--seg:${weekColour(i, s.weeks)};--d:${i * 20}ms" aria-hidden="true"></i>`).join("");
  return `
    <section class="sem-card" aria-label="Прогресс семестра">
      <div class="sem-head"><span>Прогресс семестра${s.started && s.left > 0 ? ` <em class="sem-week num">неделя ${s.week} из ${s.weeks}</em>` : ""}</span><b class="num" id="sem-pct" style="color:${head}" data-value="${s.pct.toFixed(1)}">0%</b></div>
      <div class="sem-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(s.pct)}"
           aria-valuetext="${Math.round(s.pct)}%, ${s.week}-я неделя из ${s.weeks}">${segments}</div>
      <p class="sem-sub" id="sem-sub">${semesterSummary(s)}</p>
    </section>`;
}

function bindSemester() {
  const bar = app.querySelector(".sem-bar");
  if (!bar) return;
  const segs = [...bar.children];
  const pct = document.getElementById("sem-pct");
  const sub = document.getElementById("sem-sub");
  const summary = sub.innerHTML;
  const s = semesterInfo();
  const target = Number(pct.dataset.value);

  // fill one by one, and roll the percentage up from zero like a counter's drums
  requestAnimationFrame(() => segs.forEach((el) => el.classList.toggle("on", el.dataset.filled === "true")));
  const text = `${Math.round(target)}%`;
  rollTo(pct, text, { from: text.replace(/\d/g, "0") });

  // the mouse lifts the segment under it and, less, its neighbours
  const lift = (at) => segs.forEach((el, i) => {
    const d = at === null ? 99 : Math.abs(at - i);
    const k = d === 0 ? 1 : d <= 3 ? Math.cos((d / 3) * (Math.PI / 2)) : 0;
    el.style.transform = k ? `scaleY(${1 + (d === 0 ? 0.3 : 0.2 * k)}) translateY(${-(d === 0 ? 1 : 0.5 * k)}px)` : "";
  });
  segs.forEach((el, i) => el.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") lift(i); }));
  bar.addEventListener("pointerleave", () => lift(null));

  // a tap shows that week's dates; tapping it again goes back to the summary
  let picked = null;
  segs.forEach((el, i) => el.addEventListener("click", () => {
    haptic();
    picked = picked === i ? null : i;
    segs.forEach((x, j) => x.classList.toggle("picked", j === picked));
    if (picked === null) { sub.innerHTML = summary; return; }
    const state = i + 1 < s.week ? "прошла" : i + 1 === s.week && s.started && s.left > 0 ? "идёт сейчас" : "впереди";
    sub.innerHTML = `${i + 1}-я неделя · ${weekRangeText(i)} · ${state}`;
  }));
}

function profileView() {
  const me = state.me, g = me.group;
  return `
    <div class="profile-head">
      <button class="avatar-edit" id="edit-avatar" aria-label="Сменить фото профиля">
        ${avatarHtml(me)}<span class="avatar-badge" aria-hidden="true">${icon.camera}</span>
      </button>
      <div>
        <div class="profile-name"><h1>${esc(myName(me))}</h1>${groupTag(g?.name)}</div>
        <p>${me.username ? `@${esc(me.username)} · ` : ""}аккаунт Telegram</p>
      </div>
    </div>
    ${me.bio
      ? `<button class="profile-bio" id="edit-bio" aria-label="Изменить описание о себе">${esc(me.bio)}</button>`
      : `<button class="profile-bio empty" id="edit-bio">Расскажите о себе: чем увлекаетесь, чем можете помочь</button>`}
    <ul class="rows account">
      <li class="tap"><button id="edit-nick"><span>Ник</span>${me.nickname ? `<b>${esc(me.nickname)}</b>` : `<b class="unset">не задан</b>`}${icon.right}</button></li>
      <li class="locked"><span>Тег в Telegram</span><b>${me.username ? `@${esc(me.username)}` : "нет"}</b>${icon.lock}</li>
    </ul>
    <p class="search-hint">Ник, фото и описание видят друзья, менять их можно когда угодно. Тег меняется только в самом Telegram: по нему вас находят.</p>
    ${semesterCard()}
    <ul class="rows">
      <li><span>Имя</span><b>${esc(me.real_name)}</b></li>
      <li><span>Направление</span><b>${esc(g.faculty)}${g.is_master ? ", магистратура" : ""}</b></li>
      <li><span>Курс</span><b class="num">${g.course}</b></li>
      <li><span>Группа</span><b>${esc(g.name)}</b></li>
    </ul>
    <button class="btn secondary" id="edit-profile">Изменить учебные данные</button>`;
}



/* ---------- launch: instead of a loading screen, a greeting in the student's own direction ----------
   Over the loading app, a scene of the student's direction fills the screen and in a clearing in the middle the
   greeting decodes line by line out of that direction's own signs: «Приветствую, Анна», «Студент 1 курса», the
   direction. Maths: symbols raining in italic serif (RainingLetters + TextScramble, React, ported to a canvas).
   Journalism: tomorrow's paper typing itself. Geography: the globe turning to Sevastopol. Physics: the field of
   two charges. Economics: the market, live. Psychology: signals running through neurons. History: a ruler of
   years to today. Philology: Pushkin and Lermontov parsed in pencil. Public administration: the town hall and its
   town. State audit: the books checked. Any other direction: the sea off Sevastopol.
   The app loads underneath and comes up with its cascade once both are done; a tap skips. It knows whom to
   greet from the last launch (GREET_KEY), so it starts before the network answers. Each scene draws its still
   parts once on a hidden canvas; a frame adds only what moves. The scenes were chosen on intros/index.html. */

const GREET_KEY = "msu.greet";

/** a scene per direction: { signs the greeting decodes from, scene(ctx, w, h, dpr, colours) → frame(dt) } */
const LAUNCH = (() => {
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  /* ---------- maths: symbols raining ----------
     Each symbol is set in type once, dim and lit (with its glow), as a little picture; a frame only copies
     pictures, which a phone does far faster than setting 120 italic glyphs and their glow every frame. */
  const MATH_SYMBOLS = "∑∫∮∂∞πλθφΔ∇√≈≠≡≤≥±×÷∈∉∀∃∅ℝℕℤℚ⊂∪∩→⇔xyznkfg012345679()[]{}<>=+−^!";
  function mathScene(ctx, w, h, dpr, c) {
    const drops = Array.from({ length: Math.round((w * h) / 2600) }, () => ({
      ch: pick(MATH_SYMBOLS), x: Math.random() * w, y: Math.random() * h,
      v: h * (0.22 + Math.random() * 0.45), // px per second
    }));
    const sprites = new Map();
    const sprite = (ch, on) => {
      const key = (on ? "+" : "-") + ch;
      if (!sprites.has(key)) {
        const size = on ? 30 : 24, side = size * 2 + (on ? 28 : 4);
        const s = document.createElement("canvas");
        s.width = s.height = Math.ceil(side * dpr);
        const g = s.getContext("2d");
        g.scale(dpr, dpr);
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.font = `italic ${size}px "Cambria Math", "STIX Two Math", "Times New Roman", serif`;
        g.globalAlpha = on ? 1 : 0.38;
        g.fillStyle = on ? c.accent : c.faint;
        if (on) { g.shadowColor = c.accent; g.shadowBlur = 14; }
        g.fillText(ch, side / 2, side / 2);
        sprites.set(key, { s, half: side / 2 });
      }
      return sprites.get(key);
    };
    let lit = new Set(), t = 0, lastFlicker = -1e9;
    return (dt) => {
      t += dt * 1000;
      if (t - lastFlicker > 60) { // a few symbols light up at a time, as in the original
        lit = new Set(Array.from({ length: 3 + Math.floor(Math.random() * 4) }, () => Math.floor(Math.random() * drops.length)));
        lastFlicker = t;
      }
      ctx.clearRect(0, 0, w, h);
      drops.forEach((d, i) => {
        d.y += d.v * dt;
        if (d.y > h + 24) { d.y = -24; d.x = Math.random() * w; d.ch = pick(MATH_SYMBOLS); }
        const s = sprite(d.ch, lit.has(i));
        ctx.drawImage(s.s, d.x - s.half, d.y - s.half, s.half * 2, s.half * 2);
      });
    };
  }

  /* ---------- journalism: tomorrow's paper being written ----------
     The screen is a newspaper page in columns: headlines, paragraphs, a photo box. Everywhere at once the lines
     type themselves out behind a blinking blue caret, as if the whole newsroom were writing; now and then a
     rubric flashes over a headline in blue — СРОЧНО, ЭКСКЛЮЗИВ, РЕПОРТАЖ — and fades into the page.
     Finished lines are drawn once onto a hidden «paper» canvas: a frame copies it and adds only what moves. */
  function journalismScene(ctx, w, h, dpr, c) {
    const RUBRICS = ["СРОЧНО", "ЭКСКЛЮЗИВ", "РЕПОРТАЖ", "ИНТЕРВЬЮ", "МНЕНИЕ", "ФОТО", "ГЛАВНОЕ", "НОВОСТИ"];
    const pad = 14, gutter = 14, cols = w < 520 ? 3 : 4;
    const cw = (w - pad * 2 - gutter * (cols - 1)) / cols;
    const paper = document.createElement("canvas");
    paper.width = w * dpr; paper.height = h * dpr;
    const pg = paper.getContext("2d");
    pg.scale(dpr, dpr);

    // the page's layout: per column, headlines (two thick bars), paragraphs (thin lines, the first indented,
    // the last short) and now and then a photo box; each block starts typing at its own moment
    const blocks = [];
    for (let col = 0; col < cols; col++) {
      const x0 = pad + col * (cw + gutter);
      let y = 18 + rand(0, 10);
      while (y < h - 30) {
        const r = Math.random();
        const start = rand(0, 1500);
        if (r < 0.14) {
          blocks.push({ kind: "head", start, lines: [{ x: x0, y, len: cw * rand(0.75, 0.95), th: 7 }, { x: x0, y: y + 12, len: cw * rand(0.4, 0.7), th: 7 }] });
          y += 32;
        } else if (r < 0.22 && cw > 70) {
          const bh = cw * rand(0.55, 0.75);
          blocks.push({ kind: "photo", start, x: x0, y, bw: cw, bh });
          y += bh + 14;
        } else {
          const n = 3 + Math.floor(rand(0, 5)), lines = [];
          for (let i = 0; i < n; i++) {
            const indent = i === 0 ? 8 : 0;
            lines.push({ x: x0 + indent, y: y + i * 8, len: (i === n - 1 ? cw * rand(0.3, 0.7) : cw - indent) * rand(0.92, 1), th: 3 });
          }
          blocks.push({ kind: "text", start, lines });
          y += n * 8 + 10;
        }
      }
      // the thin rule between columns
      if (col) { pg.globalAlpha = 0.14; pg.fillStyle = c.faint; pg.fillRect(x0 - gutter / 2, 14, 1, h - 28); }
    }
    blocks.forEach((b) => { b.speed = rand(260, 420); b.line = 0; b.done = false; });

    // a rubric is set once as a little picture, then only faded in and out over a headline
    const stamps = new Map();
    const stamp = (word) => {
      if (!stamps.has(word)) {
        const s = document.createElement("canvas"), g = s.getContext("2d");
        g.font = "700 10px Inter, system-ui, sans-serif";
        const tw = Math.ceil(g.measureText(word).width + word.length * 1.2) + 10;
        s.width = tw * dpr; s.height = 16 * dpr;
        g.scale(dpr, dpr);
        g.font = "700 10px Inter, system-ui, sans-serif";
        g.fillStyle = c.accent;
        g.globalAlpha = 0.16; g.fillRect(0, 0, tw, 16);
        g.globalAlpha = 1;
        if ("letterSpacing" in g) g.letterSpacing = "1.2px";
        g.textBaseline = "middle";
        g.fillText(word, 5, 8.5);
        stamps.set(word, { s, tw });
      }
      return stamps.get(word);
    };
    const flashes = [];
    let nextFlash = 700, t = 0;

    const bar = (g, l, len, alpha) => { g.globalAlpha = alpha; g.fillRect(l.x, l.y, len, l.th); };
    const alphaOf = (b) => (b.kind === "head" ? 0.55 : 0.3);

    return (dt) => {
      t += dt * 1000;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.drawImage(paper, 0, 0, w, h);
      ctx.fillStyle = c.faint;
      for (const b of blocks) {
        if (b.done || t < b.start) continue;
        if (b.kind === "photo") {   // the photo box draws its frame and cross, then settles onto the paper
          const k = Math.min(1, (t - b.start) / 500);
          ctx.globalAlpha = 0.3 * k;
          ctx.strokeStyle = c.faint;
          ctx.lineWidth = 1;
          ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.bw - 1, (b.bh - 1) * k);
          if (k === 1) {
            pg.globalAlpha = 0.3; pg.strokeStyle = c.faint; pg.lineWidth = 1;
            pg.strokeRect(b.x + 0.5, b.y + 0.5, b.bw - 1, b.bh - 1);
            pg.beginPath(); pg.moveTo(b.x, b.y); pg.lineTo(b.x + b.bw, b.y + b.bh); pg.moveTo(b.x + b.bw, b.y); pg.lineTo(b.x, b.y + b.bh);
            pg.globalAlpha = 0.12; pg.stroke();
            b.done = true;
          }
          continue;
        }
        // a text block: its lines type out one after another
        const l = b.lines[b.line];
        l.typed = Math.min(l.len, (l.typed || 0) + b.speed * dt);
        ctx.fillStyle = c.faint;
        bar(ctx, l, l.typed, alphaOf(b));
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.accent;
        ctx.fillRect(l.x + l.typed + 1, l.y - (b.kind === "head" ? 1 : 3), 1.5, b.kind === "head" ? 9 : 8);   // the caret
        if (l.typed >= l.len) {
          pg.fillStyle = c.faint;
          bar(pg, l, l.len, alphaOf(b));
          if (++b.line === b.lines.length) b.done = true;
        }
      }
      // now and then a rubric flashes over a finished headline
      if (t > nextFlash) {
        const heads = blocks.filter((b) => b.kind === "head" && b.done && !b.flashed);
        if (heads.length) { const b = pick(heads); b.flashed = true; flashes.push({ b, word: pick(RUBRICS), at: t }); }
        nextFlash = t + rand(260, 520);
      }
      for (const f of flashes) {
        const age = t - f.at;
        if (age > 1400) continue;
        const a = age < 160 ? age / 160 : age > 900 ? Math.max(0, 1 - (age - 900) / 500) : 1;
        const s = stamp(f.word), l = f.b.lines[0];
        ctx.globalAlpha = a;
        ctx.drawImage(s.s, l.x - 2, l.y - 22, s.tw, 16);
      }
      ctx.globalAlpha = 1;
    };
  }

  /* ---------- geography: the globe turning to Sevastopol ----------
     A wireframe globe, tilted as the Earth is, turns behind the greeting. Sevastopol is a blue point with a
     ring that keeps leaving it; from it, one after another, routes arc out over the curve of the Earth to the
     world's cities, and each city answers with a ring when its route arrives. Only lines and dots: a frame
     is a few hundred points through the same projection. */
  function geographyScene(ctx, w, h, dpr, c) {
    const R = Math.min(w * 0.44, h * 0.3), cx = w / 2, cy = h / 2;
    const tilt = (23.4 * Math.PI) / 180, deg = Math.PI / 180;
    const HOME = [44.6, 33.5];   // Sevastopol
    const CITIES = [[55.75, 37.62], [48.86, 2.35], [40.71, -74.0], [35.68, 139.7], [30.04, 31.24], [-22.9, -43.2], [-33.87, 151.2], [28.61, 77.21], [-33.92, 18.42], [64.15, -21.94], [1.35, 103.82], [19.43, -99.13]];
    let rot = (-33.5 - 50) * deg;   // Sevastopol comes round to the front in about two seconds
    const speed = 24 * deg;         // per second
    let t = 0;

    const vec = (lat, lon) => [Math.cos(lat * deg) * Math.sin(lon * deg), Math.sin(lat * deg), Math.cos(lat * deg) * Math.cos(lon * deg)];
    // a point on (or, lifted, above) the sphere as it stands now: turned by rot, tilted, seen from the front
    const view = ([x, y, z], lift = 1) => {
      const xr = x * Math.cos(rot) + z * Math.sin(rot), zr = -x * Math.sin(rot) + z * Math.cos(rot);
      const yt = y * Math.cos(tilt) - zr * Math.sin(tilt), zt = y * Math.sin(tilt) + zr * Math.cos(tilt);
      return [cx + R * lift * xr, cy - R * lift * yt, zt];
    };
    const slerp = (a, b, s) => {
      const d = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
      if (d < 1e-6) return a;
      const k1 = Math.sin((1 - s) * d) / Math.sin(d), k2 = Math.sin(s * d) / Math.sin(d);
      return [a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2];
    };

    // the grid's points, made once: meridians every 20°, parallels every 20°
    const lines = [];
    for (let lon = 0; lon < 360; lon += 20) { const pts = []; for (let lat = -90; lat <= 90; lat += 6) pts.push(vec(lat, lon)); lines.push({ pts, eq: false }); }
    for (let lat = -60; lat <= 60; lat += 20) { const pts = []; for (let lon = 0; lon <= 360; lon += 6) pts.push(vec(lat, lon)); lines.push({ pts, eq: lat === 0 }); }

    // the soft light behind the globe, set once
    const glow = document.createElement("canvas");
    glow.width = glow.height = Math.ceil(R * 2.6 * dpr);
    { const g = glow.getContext("2d"), r = glow.width / 2, grad = g.createRadialGradient(r, r, R * 0.9 * dpr, r, r, r);
      grad.addColorStop(0, c.accent); grad.addColorStop(1, "transparent"); g.globalAlpha = 0.12; g.fillStyle = grad; g.fillRect(0, 0, glow.width, glow.height); }

    const home = vec(...HOME);
    const routes = CITIES.map((p, i) => ({ to: vec(...p), at: 600 + i * 330 }));

    const ring = (x, y, age, period, size) => {
      const k = (age % period) / period;
      ctx.globalAlpha = 0.7 * (1 - k);
      ctx.beginPath(); ctx.arc(x, y, 3 + size * k, 0, Math.PI * 2); ctx.stroke();
    };

    return (dt) => {
      t += dt * 1000;
      rot += speed * dt;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.drawImage(glow, cx - glow.width / dpr / 2, cy - glow.height / dpr / 2, glow.width / dpr, glow.height / dpr);
      // the grid, the far side faint, the near side clearer; one path each, stroked once
      const front = new Path2D(), back = new Path2D(), eq = new Path2D();
      for (const line of lines) {
        let prev = null;
        for (const p of line.pts) {
          const q = view(p);
          if (prev) {
            const path = line.eq && q[2] > 0 && prev[2] > 0 ? eq : q[2] > 0 && prev[2] > 0 ? front : back;
            path.moveTo(prev[0], prev[1]); path.lineTo(q[0], q[1]);
          }
          prev = q;
        }
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.faint;
      ctx.globalAlpha = 0.1; ctx.stroke(back);
      ctx.globalAlpha = 0.32; ctx.stroke(front);
      ctx.strokeStyle = c.accent; ctx.globalAlpha = 0.45; ctx.stroke(eq);
      // the rim
      ctx.strokeStyle = c.muted; ctx.globalAlpha = 0.45;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

      // routes from Sevastopol, lifted over the curve, drawn as they fly; the city rings when one lands
      ctx.strokeStyle = c.accent; ctx.fillStyle = c.accent; ctx.lineWidth = 1.5;
      for (const r of routes) {
        const age = t - r.at;
        if (age < 0) continue;
        const k = Math.min(1, age / 900), fade = age > 2600 ? Math.max(0, 1 - (age - 2600) / 600) : 1;
        if (fade <= 0) continue;
        const path = new Path2D();
        let started = false, head = null;
        for (let i = 0; i <= 24; i++) {
          const s = (i / 24) * k;
          const q = view(slerp(home, r.to, s), 1 + 0.16 * Math.sin(Math.PI * s));
          if (q[2] > -0.08) { started ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1]); started = true; head = q; }
          else started = false;
        }
        ctx.globalAlpha = 0.85 * fade; ctx.stroke(path);
        if (head && k < 1) { ctx.globalAlpha = fade; ctx.beginPath(); ctx.arc(head[0], head[1], 2.2, 0, Math.PI * 2); ctx.fill(); }
        if (k === 1) {
          const q = view(r.to);
          if (q[2] > 0) {
            ctx.globalAlpha = fade; ctx.beginPath(); ctx.arc(q[0], q[1], 2.2, 0, Math.PI * 2); ctx.fill();
            if (age < 1900) { ctx.lineWidth = 1; ring(q[0], q[1], age - 900, 1000, 10); ctx.lineWidth = 1.5; }
          }
        }
      }
      // home: a point with a ring that keeps leaving it
      const hq = view(home);
      if (hq[2] > 0) {
        ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(hq[0], hq[1], 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = 1.2; ring(hq[0], hq[1], t, 1600, 14);
      }
      ctx.globalAlpha = 1;
    };
  }

  /* ---------- physics: the field of two charges ----------
     The textbook figure: a positive and a negative charge, and between them the lines of force, drawn out of the
     plus and curving into the minus; then charges run along them, plus to minus, and the two poles breathe.
     The lines are worked out once, by stepping along the field; a frame moves only the running charges. */
  function physicsScene(ctx, w, h, dpr, c) {
    const Q = [{ x: w * 0.28, y: h * 0.26, q: 1 }, { x: w * 0.72, y: h * 0.74, q: -1 }];
    const field = (x, y) => {
      let ex = 0, ey = 0;
      for (const p of Q) { const dx = x - p.x, dy = y - p.y, r2 = dx * dx + dy * dy, r3 = r2 * Math.sqrt(r2); ex += (p.q * dx) / r3; ey += (p.q * dy) / r3; }
      return [ex, ey];
    };
    const N = 20, lines = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      let x = Q[0].x + Math.cos(a) * 14, y = Q[0].y + Math.sin(a) * 14;
      const pts = [[x, y]], lens = [0];
      for (let s = 0; s < 1400; s++) {
        const [ex, ey] = field(x, y), m = Math.hypot(ex, ey);
        if (!m) break;
        x += (ex / m) * 3; y += (ey / m) * 3;
        pts.push([x, y]); lens.push(lens[lens.length - 1] + 3);
        if (Math.hypot(x - Q[1].x, y - Q[1].y) < 14 || x < -80 || x > w + 80 || y < -80 || y > h + 80) break;
      }
      lines.push({ pts, lens, total: lens[lens.length - 1], dots: [rand(0, 1), rand(0, 1)] });
    }
    const at = (L, d) => {   // the point at distance d along a line
      let lo = 0, hi = L.lens.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; L.lens[mid] < d ? (lo = mid) : (hi = mid); }
      return L.pts[hi];
    };
    let t = 0;
    return (dt) => {
      t += dt * 1000;
      ctx.clearRect(0, 0, w, h);
      const grow = Math.min(1, t / 1000);
      // equipotential rings
      ctx.setLineDash([3, 5]); ctx.strokeStyle = c.faint; ctx.lineWidth = 1;
      for (const p of Q) for (const r of [30, 56, 86]) { ctx.globalAlpha = 0.16 * grow; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke(); }
      ctx.setLineDash([]);
      // the lines of force, drawn out of the plus
      ctx.strokeStyle = c.faint; ctx.globalAlpha = 0.38; ctx.lineWidth = 1.1;
      for (const L of lines) {
        const upto = L.total * grow;
        ctx.beginPath(); ctx.moveTo(L.pts[0][0], L.pts[0][1]);
        for (let i = 1; i < L.pts.length && L.lens[i] <= upto; i += 2) ctx.lineTo(L.pts[i][0], L.pts[i][1]);
        ctx.stroke();
      }
      // charges running along them
      if (t > 700) {
        ctx.fillStyle = c.accent;
        for (const L of lines) for (let j = 0; j < L.dots.length; j++) {
          L.dots[j] = (L.dots[j] + (dt * 130) / L.total) % 1;
          const [x, y] = at(L, L.dots[j] * L.total);
          ctx.globalAlpha = 0.9 * Math.min(1, (t - 700) / 400);
          ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
        }
      }
      // the two poles, breathing
      const pulse = 1 + 0.06 * Math.sin(t / 300);
      for (const p of Q) {
        ctx.globalAlpha = 0.18; ctx.fillStyle = p.q > 0 ? c.accent : c.faint;
        ctx.beginPath(); ctx.arc(p.x, p.y, 22 * pulse, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1; ctx.fillStyle = p.q > 0 ? c.accent : c.muted;
        ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = c.ground; ctx.fillRect(p.x - 6, p.y - 1.25, 12, 2.5);
        if (p.q > 0) ctx.fillRect(p.x - 1.25, p.y - 6, 2.5, 12);
      }
      ctx.globalAlpha = 1;
    };
  }

  /* ---------- philology: a sentence taken apart ----------
     Two classics write themselves above and below the greeting, word by word, in italic, as on a page; then the
     philologist's pencil goes over them with the marks every Russian school taught: one line under the subject,
     two under the predicate, dashes under the object, a wave under the attribute, dot-and-dash under the
     circumstance. Finished words and marks are laid down on a hidden page; a frame adds only what is appearing. */
  function philologyScene(ctx, w, h, dpr, c) {
    // Pushkin (1825) and Lermontov (1832); each word may carry its part of the sentence
    const VERSES = [
      { y: h * 0.08, lines: [["Я:1", "помню:2", "чудное:w", "мгновенье:o"], ["Передо:d", "мной:d", "явилась:2", "ты:1"], ["Как", "мимолётное:w", "виденье,"], ["Как", "гений", "чистой:w", "красоты."]] },
      { y: h * 0.66, lines: [["Белеет:2", "парус:1", "одинокой:w"], ["В:d", "тумане:d", "моря", "голубом!..:w"], ["Что:o", "ищет:2", "он:1", "в", "стране", "далёкой?"], ["Что", "кинул", "он", "в", "краю", "родном?.."]] },
    ];
    const font = "italic 17px Georgia, 'Times New Roman', serif", lh = 32, left = 24;
    const page = document.createElement("canvas");
    page.width = w * dpr; page.height = h * dpr;
    const pg = page.getContext("2d");
    pg.scale(dpr, dpr);
    pg.font = font;
    const space = pg.measureText(" ").width;
    const words = [];
    let order = 0;
    for (const v of VERSES) {
      v.lines.forEach((line, i) => {
        let x = left;
        for (const item of line) {
          const [text, part] = item.split(":");
          const wd = pg.measureText(text).width;
          words.push({ text, part, x, y: v.y + i * lh, w: wd, at: 120 + order++ * 55 });
          x += wd + space;
        }
      });
    }
    // a mark under a word, as a path of the pencil; dash patterns for the dotted kinds
    const mark = (g, wd, k) => {
      const y = wd.y + 7, x0 = wd.x, x1 = wd.x + wd.w * k;
      g.beginPath();
      if (wd.part === "w") {   // a wave
        for (let x = x0; x <= x1; x += 1) { const yy = y + 1.6 * Math.sin((x - x0) / 2.2); x === x0 ? g.moveTo(x, yy) : g.lineTo(x, yy); }
        g.setLineDash([]);
      } else {
        g.moveTo(x0, y); g.lineTo(x1, y);
        if (wd.part === "2") { g.moveTo(x0, y + 3.5); g.lineTo(x1, y + 3.5); }
        g.setLineDash(wd.part === "o" ? [4, 3] : wd.part === "d" ? [6, 2.5, 1.5, 2.5] : []);
      }
      g.stroke();
      g.setLineDash([]);
    };
    let t = 0;
    return (dt) => {
      t += dt * 1000;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.drawImage(page, 0, 0, w, h);
      ctx.font = font; ctx.textBaseline = "alphabetic";
      for (const wd of words) {
        if (wd.done || t < wd.at) continue;
        const k = Math.min(1, (t - wd.at) / 260);
        if (!wd.inked) {
          ctx.globalAlpha = 0.6 * k; ctx.fillStyle = c.faint;
          ctx.fillText(wd.text, wd.x, wd.y + (1 - k) * 4);
          if (k === 1) { pg.globalAlpha = 0.6; pg.fillStyle = c.faint; pg.fillText(wd.text, wd.x, wd.y); wd.inked = true; if (!wd.part) wd.done = true; }
          continue;
        }
        // the pencil: a mark drawn under it, in blue, a moment after the word
        const m = Math.min(1, Math.max(0, (t - wd.at - 420) / 320));
        if (m <= 0) continue;
        ctx.globalAlpha = 0.9; ctx.strokeStyle = c.accent; ctx.lineWidth = 1.3;
        mark(ctx, wd, m);
        if (m === 1) { pg.globalAlpha = 0.9; pg.strokeStyle = c.accent; pg.lineWidth = 1.3; mark(pg, wd, 1); wd.done = true; }
      }
      ctx.globalAlpha = 1;
    };
  }

  /* ---------- public administration: from the town hall to the town ----------
     Above the greeting a chart of government grows from the top: the administration, its three branches, the
     services under each. Below, the town as a plan of blocks and streets. Decisions run down from the services as
     blue sparks, and each block a decision reaches lights up for a moment. */
  function administrationScene(ctx, w, h, dpr, c) {
    const label = "500 10px Inter, system-ui, sans-serif";
    const root = { x: w / 2, y: h * 0.07, text: "Администрация", at: 0 };
    const branches = [["Экономика", ["Бюджет", "Налоги"]], ["Социальная сфера", ["Школы", "Больницы"]], ["Хозяйство", ["Транспорт", "ЖКХ"]]];
    const nodes = [root], links = [], leaves = [];
    branches.forEach(([name, kids], i) => {
      const b = { x: (w * (2 * i + 1)) / 6, y: h * 0.17, text: name, at: 350 + i * 120 };
      nodes.push(b); links.push([root, b]);
      kids.forEach((k, j) => {
        const leaf = { x: b.x + (j ? 1 : -1) * w * 0.085, y: h * 0.27, text: k, at: 750 + i * 120 + j * 60 };
        nodes.push(leaf); links.push([b, leaf]); leaves.push(leaf);
      });
    });
    ctx.font = label;
    nodes.forEach((n) => { n.w = ctx.measureText(n.text).width + 14; });

    // the town: blocks between streets, below the greeting
    const blocks = [];
    const top = h * 0.64, bottom = h * 0.93, cols = 6, rowsN = 5, gap = 9;
    const bw = (w - 32 - gap * (cols - 1)) / cols, bh = (bottom - top - gap * (rowsN - 1)) / rowsN;
    for (let r = 0; r < rowsN; r++) for (let q = 0; q < cols; q++) {
      if (Math.random() < 0.12) continue;   // a square, a park
      blocks.push({ x: 16 + q * (bw + gap), y: top + r * (bh + gap), lit: -1e9 });
    }
    const sparks = [];
    let t = 0, next = 1000;

    const box = (n, k) => {
      const x = n.x - n.w / 2, y = n.y - 10;
      ctx.globalAlpha = 0.5 * k; ctx.strokeStyle = c.faint; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, n.w, 20, 6) : ctx.rect(x, y, n.w, 20); ctx.stroke();
      ctx.globalAlpha = 0.75 * k; ctx.fillStyle = c.muted; ctx.fillText(n.text, n.x, n.y + 0.5);
    };
    return (dt) => {
      t += dt * 1000;
      ctx.clearRect(0, 0, w, h);
      ctx.font = label; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      // the chart: a link draws itself down to its node, then the node appears
      for (const [a, b] of links) {
        const k = Math.min(1, Math.max(0, (t - b.at + 300) / 300));
        if (k <= 0) continue;
        const ya = a.y + 10, yb = b.y - 10, ym = (ya + yb) / 2;
        ctx.globalAlpha = k < 1 ? 0.9 : 0.3; ctx.strokeStyle = k < 1 ? c.accent : c.faint; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.x, ya); ctx.lineTo(a.x, ya + (ym - ya) * Math.min(1, k * 3));
        if (k > 0.33) { ctx.lineTo(a.x + (b.x - a.x) * Math.min(1, (k - 0.33) * 3), ym); }
        if (k > 0.66) { ctx.lineTo(b.x, ym + (yb - ym) * Math.min(1, (k - 0.66) * 3)); }
        ctx.stroke();
      }
      for (const n of nodes) { const k = Math.min(1, Math.max(0, (t - n.at) / 250)); if (k > 0) box(n, k); }
      // the town
      for (const b of blocks) {
        const age = t - b.lit;
        ctx.globalAlpha = 0.22; ctx.strokeStyle = c.faint; ctx.lineWidth = 1;
        ctx.strokeRect(b.x + 0.5, b.y + 0.5, bw - 1, bh - 1);
        if (age < 1100) { ctx.globalAlpha = 0.35 * (1 - age / 1100); ctx.fillStyle = c.accent; ctx.fillRect(b.x, b.y, bw, bh); }
      }
      // decisions: from a service down to a block of the town
      if (t > next) {
        const from = pick(leaves), to = pick(blocks);
        sparks.push({ x0: from.x, y0: from.y + 10, x1: to.x + bw / 2, y1: to.y + bh / 2, to, k: 0 });
        next = t + rand(140, 260);
      }
      ctx.fillStyle = c.accent; ctx.strokeStyle = c.accent;
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.k += dt / 0.9;
        const k = Math.min(1, s.k), e = k * k * (3 - 2 * k);
        const x = s.x0 + (s.x1 - s.x0) * e, y = s.y0 + (s.y1 - s.y0) * e;
        ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
        if (k === 1) { s.to.lit = t; sparks.splice(i, 1); }
      }
      ctx.globalAlpha = 1; ctx.textAlign = "start";
    };
  }

  /* ---------- state audit: the books checked ----------
     A ledger fills the screen: articles of spending, the plan, the fact. A blue scan line goes down it; each row
     it passes gets its check, and here and there a fact that does not match its plan is ringed — found. At the
     foot the checked total counts up. The ledger is drawn once; a frame adds the line, the checks, the rings. */
  function auditScene(ctx, w, h, dpr, c) {
    const ITEMS = ["Зарплаты", "Закупки", "Аренда", "Ремонт", "Связь", "Транспорт", "Обучение", "Командировки", "Коммунальные", "Оборудование", "Связь", "Охрана", "Питание", "Типография"];
    const rowH = 25, top = 44, bottom = h - 112;
    const n = Math.floor((bottom - top) / rowH);
    const mono = "500 11px ui-monospace, 'SF Mono', Menlo, Consolas, monospace", sans = "500 11px Inter, system-ui, sans-serif";
    const colNo = 16, colItem = 44, colPlan = w - 150, colFact = w - 78, colOk = w - 22;
    const rows = Array.from({ length: n }, (_, i) => {
      const plan = Math.round(rand(40, 980)) * 1000, off = Math.random() < 0.14;
      return { y: top + i * rowH, item: ITEMS[i % ITEMS.length], plan, fact: off ? Math.round(plan * rand(1.08, 1.3) / 1000) * 1000 : plan, off };
    });
    const fmt = (v) => v.toLocaleString("ru-RU");
    const sheet = document.createElement("canvas");
    sheet.width = w * dpr; sheet.height = h * dpr;
    const g = sheet.getContext("2d");
    g.scale(dpr, dpr);
    g.textBaseline = "middle";
    g.fillStyle = c.faint;
    g.globalAlpha = 0.5; g.font = sans;
    g.fillText("№", colNo, top - 14); g.fillText("Статья", colItem, top - 14);
    g.textAlign = "right"; g.fillText("План", colPlan, top - 14); g.fillText("Факт", colFact, top - 14); g.textAlign = "left";
    for (const r of rows) {
      g.globalAlpha = 0.1; g.fillRect(12, r.y + rowH / 2, w - 24, 1);
      g.globalAlpha = 0.45; g.font = mono; g.fillText(String(rows.indexOf(r) + 1).padStart(2, "0"), colNo, r.y);
      g.font = sans; g.fillText(r.item, colItem, r.y);
      g.font = mono; g.textAlign = "right"; g.fillText(fmt(r.plan), colPlan, r.y); g.fillText(fmt(r.fact), colFact, r.y); g.textAlign = "left";
    }
    const RUN = 2300;
    let t = 0;
    return (dt) => {
      t += dt * 1000;
      const k = Math.min(1, t / RUN), scanY = top - rowH / 2 + (bottom - top + rowH) * k;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.drawImage(sheet, 0, 0, w, h);
      ctx.textBaseline = "middle";
      let total = 0;
      for (const r of rows) {
        if (r.y > scanY) break;
        total += r.fact;
        const age = Math.min(1, (scanY - r.y) / 40);
        ctx.globalAlpha = age; ctx.strokeStyle = c.accent; ctx.lineWidth = 1.6; ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.beginPath(); ctx.moveTo(colOk - 5, r.y); ctx.lineTo(colOk - 2, r.y + 3); ctx.lineTo(colOk + 4, r.y - 4); ctx.stroke();
        if (r.off) {   // a fact that does not match its plan: ringed
          ctx.globalAlpha = 0.9 * age; ctx.lineWidth = 1.3;
          ctx.beginPath(); ctx.ellipse(colFact - 26, r.y, 34, 10, -0.05, 0, Math.PI * 2 * age); ctx.stroke();
        }
      }
      // the scan line, glowing
      if (k < 1) {
        const grad = ctx.createLinearGradient(0, scanY - 14, 0, scanY);
        grad.addColorStop(0, "transparent"); grad.addColorStop(1, c.accent);
        ctx.globalAlpha = 0.18; ctx.fillStyle = grad; ctx.fillRect(0, scanY - 14, w, 14);
        ctx.globalAlpha = 0.9; ctx.fillStyle = c.accent; ctx.fillRect(0, scanY, w, 1.5);
      }
      // the checked total
      ctx.globalAlpha = 0.8; ctx.fillStyle = c.muted; ctx.font = sans; ctx.fillText("Проверено", colItem, h - 78);
      ctx.font = "600 13px ui-monospace, 'SF Mono', Menlo, Consolas, monospace"; ctx.textAlign = "right"; ctx.fillStyle = c.accent;
      ctx.fillText(`${fmt(total)} ₽`, colFact, h - 78); ctx.textAlign = "left";
      ctx.globalAlpha = 1;
    };
  }

  /* ---------- any other direction: the sea off Sevastopol ----------
     For a direction with no scene of its own yet: the sea the app's blue is named after. Waves roll in layers,
     the far ones slow and faint, the near ones faster; light glints on the crests; gulls glide over. */
  function seaScene(ctx, w, h, dpr, c) {
    const layers = Array.from({ length: 7 }, (_, i) => ({
      y: h * (0.6 + i * 0.05), amp: 3 + i * 1.6, len: 60 + i * 22, speed: 10 + i * 9, phase: rand(0, 6), alpha: 0.12 + i * 0.07,
    }));
    const gulls = Array.from({ length: 3 }, () => ({ x: rand(-60, w), y: rand(h * 0.12, h * 0.34), v: rand(14, 26), s: rand(1.3, 1.8), flap: rand(0, 6) }));
    const glints = [];
    const waveY = (L, x, t) => L.y + L.amp * Math.sin((x / L.len) * Math.PI * 2 + L.phase - (t * L.speed) / L.len * Math.PI * 2 / 2)
      + L.amp * 0.4 * Math.sin((x / (L.len * 0.43)) * Math.PI * 2 + t * 0.9);
    let t = 0;
    return (dt) => {
      t += dt;
      ctx.clearRect(0, 0, w, h);
      // a low sun behind the sea, a soft disc
      ctx.globalAlpha = 0.08; ctx.fillStyle = c.accent;
      ctx.beginPath(); ctx.arc(w * 0.72, h * 0.57, w * 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 1.2; ctx.strokeStyle = c.faint;
      for (const L of layers) {
        ctx.globalAlpha = L.alpha;
        ctx.beginPath();
        for (let x = -4; x <= w + 4; x += 6) { const y = waveY(L, x, t); x === -4 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        ctx.stroke();
      }
      // glints on the crests
      if (Math.random() < dt * 14) { const L = pick(layers.slice(2)); glints.push({ L, x: rand(0, w), at: t }); }
      ctx.strokeStyle = c.accent; ctx.lineWidth = 1.6;
      for (let i = glints.length - 1; i >= 0; i--) {
        const gl = glints[i], age = t - gl.at;
        if (age > 0.9) { glints.splice(i, 1); continue; }
        const y = waveY(gl.L, gl.x, t) - 2;
        ctx.globalAlpha = Math.sin((age / 0.9) * Math.PI);
        ctx.beginPath(); ctx.moveTo(gl.x - 5, y); ctx.lineTo(gl.x + 5, y); ctx.stroke();
      }
      // gulls: two arcs each, flapping
      ctx.strokeStyle = c.muted; ctx.lineWidth = 1.4; ctx.lineCap = "round";
      for (const g of gulls) {
        g.x += g.v * dt; if (g.x > w + 40) { g.x = -40; g.y = rand(h * 0.12, h * 0.34); }
        const f = Math.sin(t * 4 + g.flap) * 3 * g.s, span = 9 * g.s;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(g.x - span, g.y - f * 0.6); ctx.quadraticCurveTo(g.x - span / 2, g.y - 4 * g.s - f, g.x, g.y);
        ctx.quadraticCurveTo(g.x + span / 2, g.y - 4 * g.s - f, g.x + span, g.y - f * 0.6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
  }

  /* ---------- economics: the market, live ----------
     A candlestick chart runs across the screen: a new candle rises or falls at the right edge and the chart slides
     left, a moving average follows the prices, the last price sits in a blue tag on the right; a ticker of indices
     runs along the top. Up candles are blue, down ones grey, in the app's own colours. */
  function economicsScene(ctx, w, h, dpr, c) {
    const step = 13, body = 8, top = h * 0.14, bottom = h * 0.86;
    const candles = [];
    let price = 100;
    const make = () => {
      const o = price, move = rand(-2.2, 2.6);   // a drift upward, the market's hope
      price = Math.max(20, o + move);
      candles.push({ o, c: price, hi: Math.max(o, price) + rand(0, 1.6), lo: Math.min(o, price) - rand(0, 1.6) });
    };
    for (let i = 0; i < Math.ceil(w / step) + 2; i++) make();
    let lo = 0, hi = 0, scroll = 0;
    const fit = (snap) => {   // the price scale follows what is on screen, smoothly
      const seen = candles.slice(-Math.ceil(w / step) - 1);
      const l = Math.min(...seen.map((k) => k.lo)) - 3, u = Math.max(...seen.map((k) => k.hi)) + 3;
      lo = snap ? l : lo + (l - lo) * 0.08; hi = snap ? u : hi + (u - hi) * 0.08;
    };
    fit(true);
    const yOf = (p) => top + ((hi - p) / (hi - lo)) * (bottom - top);

    // the ticker, set once as a strip and slid along
    const TICKS = ["МОЕКС ▲ 1,24%", "РТС ▲ 0,87%", "ВВП ▲ 2,1%", "ИПЦ ▼ 0,3%", "НЕФТЬ ▲ 0,6%", "ЗОЛОТО ▲ 0,4%", "ОФЗ ▼ 0,1%"];
    const strip = document.createElement("canvas"), sg = strip.getContext("2d");
    const font = "500 11px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
    sg.font = font;
    const parts = TICKS.map((s) => s + "      ");
    const stripW = Math.ceil(parts.reduce((a, s) => a + sg.measureText(s).width, 0));
    strip.width = stripW * dpr; strip.height = 16 * dpr;
    sg.scale(dpr, dpr); sg.font = font; sg.textBaseline = "middle";
    let sx = 0;
    for (const s of parts) {
      for (const ch of s) { sg.fillStyle = ch === "▲" ? c.accent : c.faint; sg.fillText(ch, sx, 8.5); sx += sg.measureText(ch).width; }
    }
    let tick = 0;

    return (dt) => {
      scroll += 64 * dt;
      while (scroll >= step) { scroll -= step; candles.shift(); make(); }
      fit(false);
      ctx.clearRect(0, 0, w, h);
      // the grid
      ctx.globalAlpha = 0.1; ctx.fillStyle = c.faint;
      for (let y = top; y <= bottom; y += (bottom - top) / 6) ctx.fillRect(0, Math.round(y), w, 1);
      // the candles
      const x0 = w - (candles.length - 1) * step - scroll;
      candles.forEach((k, i) => {
        const x = x0 + i * step;
        if (x < -step || x > w + step) return;
        const up = k.c >= k.o;
        ctx.fillStyle = up ? c.accent : c.faint;
        ctx.globalAlpha = up ? 0.75 : 0.45;
        ctx.fillRect(Math.round(x), yOf(k.hi), 1, yOf(k.lo) - yOf(k.hi));
        const y1 = yOf(Math.max(k.o, k.c)), y2 = yOf(Math.min(k.o, k.c));
        ctx.fillRect(Math.round(x - body / 2), y1, body, Math.max(1, y2 - y1));
      });
      // the moving average over eight candles
      ctx.globalAlpha = 0.6; ctx.strokeStyle = c.accent; ctx.lineWidth = 1.5;
      ctx.beginPath();
      candles.forEach((k, i) => {
        if (i < 8) return;
        const avg = candles.slice(i - 8, i).reduce((a, q) => a + q.c, 0) / 8, x = x0 + i * step;
        i === 8 ? ctx.moveTo(x, yOf(avg)) : ctx.lineTo(x, yOf(avg));
      });
      ctx.stroke();
      // the last price: a dashed line and its tag
      const last = candles[candles.length - 1], ly = yOf(last.c);
      ctx.globalAlpha = 0.5; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(w - 46, ly); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 1; ctx.fillStyle = c.accent; ctx.fillRect(w - 46, ly - 9, 46, 18);
      ctx.fillStyle = c.ground; ctx.font = "600 11px ui-monospace, 'SF Mono', Menlo, Consolas, monospace"; ctx.textBaseline = "middle";
      ctx.fillText(last.c.toFixed(2).replace(".", ","), w - 41, ly + 0.5);
      // the ticker along the top
      tick = (tick + 38 * dt) % stripW;
      ctx.globalAlpha = 0.9;
      for (let x = -tick; x < w; x += stripW) ctx.drawImage(strip, x, 18, stripW, 16);
      ctx.globalAlpha = 1;
    };
  }

  /* ---------- psychology: a mind at work ----------
     A net of neurons fills the screen; signals run along its connections as blue sparks, and each neuron a spark
     reaches lights up and passes the signal on to one or two of its neighbours, so thoughts spread and branch.
     The net itself is drawn once; a frame adds only the sparks and the flashes. */
  function psychologyScene(ctx, w, h, dpr, c) {
    const nodes = [];
    for (let tries = 0; nodes.length < Math.round((w * h) / 8000) && tries < 4000; tries++) {
      const p = { x: rand(16, w - 16), y: rand(16, h - 16), links: [], flash: -1e9 };
      if (nodes.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 44)) nodes.push(p);
    }
    for (const p of nodes) {   // each to its nearest few
      nodes.filter((q) => q !== p).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))
        .slice(0, 3).forEach((q) => { if (!p.links.includes(q)) { p.links.push(q); q.links.push(p); } });
    }
    const net = document.createElement("canvas");
    net.width = w * dpr; net.height = h * dpr;
    const g = net.getContext("2d");
    g.scale(dpr, dpr);
    g.strokeStyle = c.faint; g.globalAlpha = 0.16; g.lineWidth = 1;
    g.beginPath();
    for (const p of nodes) for (const q of p.links) if (p.x < q.x) { g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); }
    g.stroke();
    g.fillStyle = c.faint; g.globalAlpha = 0.5;
    for (const p of nodes) { g.beginPath(); g.arc(p.x, p.y, 2, 0, Math.PI * 2); g.fill(); }

    const sparks = [];
    let t = 0, next = 0;
    const fire = (from, avoid) => {
      const ways = from.links.filter((q) => q !== avoid);
      for (const to of ways.sort(() => Math.random() - 0.5).slice(0, Math.random() < 0.35 ? 2 : 1)) {
        if (sparks.length < 46) sparks.push({ from, to, k: 0, len: Math.hypot(to.x - from.x, to.y - from.y) });
      }
    };
    return (dt) => {
      t += dt * 1000;
      if (t > next) { const p = pick(nodes); p.flash = t; fire(p); next = t + rand(160, 320); }
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.drawImage(net, 0, 0, w, h);
      ctx.fillStyle = c.accent; ctx.strokeStyle = c.accent;
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.k += (220 * dt) / s.len;
        const k = Math.min(1, s.k), tail = Math.max(0, k - 18 / s.len);
        ctx.globalAlpha = 0.9; ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(s.from.x + (s.to.x - s.from.x) * tail, s.from.y + (s.to.y - s.from.y) * tail);
        ctx.lineTo(s.from.x + (s.to.x - s.from.x) * k, s.from.y + (s.to.y - s.from.y) * k);
        ctx.stroke();
        if (s.k >= 1) {   // it arrives: the neuron lights and, most times, passes it on
          sparks.splice(i, 1);
          s.to.flash = t;
          if (Math.random() < 0.8) fire(s.to, s.from);
        }
      }
      for (const p of nodes) {
        const age = t - p.flash;
        if (age > 700) continue;
        const k = age / 700;
        ctx.globalAlpha = 1 - k;
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.6 * (1 - k); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, 3 + 12 * k, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
  }

  /* ---------- history: through the centuries to today ----------
     A ruler of years runs under the greeting from 862 to today, fast at first and slowing down, the year itself
     huge and faint above; the moments of Russian history, of Sevastopol and of Moscow University come past on
     it as blue marks with their names, and it settles on the present year. */
  function historyScene(ctx, w, h, dpr, c) {
    const FROM = 862, TO = new Date().getFullYear(), RUN = 2400, perYear = 6;
    const EVENTS = [[862, "Новгород"], [988, "Крещение Руси"], [1147, "Москва"], [1380, "Куликовская битва"],
      [1480, "Стояние на Угре"], [1612, "Ополчение"], [1703, "Петербург"], [1755, "Московский университет"],
      [1783, "Севастополь"], [1812, "Отечественная война"], [1855, "Оборона Севастополя"], [1961, "Гагарин"], [TO, "Сегодня"]];
    const rulerY = h * 0.73, mono = "500 11px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
    let t = 0;
    return (dt) => {
      t += dt * 1000;
      const k = Math.min(1, t / RUN), year = FROM + (TO - FROM) * (1 - Math.pow(1 - k, 3));   // ease-out: it slows into today
      ctx.clearRect(0, 0, w, h);
      // the year, huge and faint, above
      ctx.globalAlpha = 0.13; ctx.fillStyle = c.faint;
      ctx.font = "600 96px Inter, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(Math.floor(year)), w / 2, h * 0.2);
      // the ruler: a tick every five years, taller every ten, labelled every fifty
      const span = w / 2 / perYear + 10;
      ctx.fillStyle = c.faint; ctx.font = mono;
      ctx.globalAlpha = 0.35; ctx.fillRect(0, rulerY, w, 1);
      for (let y = Math.ceil((year - span) / 5) * 5; y <= year + span; y += 5) {
        const x = w / 2 + (y - year) * perYear;
        const big = y % 50 === 0, mid = y % 10 === 0;
        ctx.globalAlpha = big ? 0.6 : mid ? 0.4 : 0.22;
        ctx.fillRect(Math.round(x), rulerY, 1, big ? 16 : mid ? 10 : 6);
        if (big) { ctx.globalAlpha = 0.55; ctx.fillText(String(y), x, rulerY + 28); }
      }
      // the moments: a blue mark on the ruler, the name above it, brightest as it passes the middle
      ctx.font = "600 12px Inter, system-ui, sans-serif";
      for (const [y, name] of EVENTS) {
        const x = w / 2 + (y - year) * perYear;
        if (x < -120 || x > w + 120) continue;
        const near = Math.max(0, 1 - Math.abs(x - w / 2) / (w / 2));
        ctx.globalAlpha = 0.35 + 0.65 * near;
        ctx.fillStyle = c.accent;
        ctx.beginPath(); ctx.arc(x, rulerY, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillRect(Math.round(x), rulerY - 22, 1, 18);
        ctx.fillText(name, x, rulerY - 34);
        ctx.font = mono; ctx.fillStyle = c.muted; ctx.globalAlpha *= 0.8;
        ctx.fillText(String(y), x, rulerY - 50);
        ctx.font = "600 12px Inter, system-ui, sans-serif";
      }
      // now: a mark at the middle of the ruler
      ctx.globalAlpha = 1; ctx.fillStyle = c.text;
      ctx.beginPath(); ctx.moveTo(w / 2 - 5, rulerY + 38); ctx.lineTo(w / 2 + 5, rulerY + 38); ctx.lineTo(w / 2, rulerY + 32); ctx.fill();
      ctx.textAlign = "start";
    };
  }

  return {
    math: { scene: mathScene, signs: "∑∫∂∞π√≈≠≤≥∈∀∃ΔλθΩ<>{}[]=+−^" },
    journalism: { scene: journalismScene, signs: "«»—–…§¶№@#*“”„!?:;" },
    geography: { scene: geographyScene, signs: "0123456789°′″NSEW.,+−" },
    physics: { scene: physicsScene, signs: "+−±EqφΦε∇→" },
    economics: { scene: economicsScene, signs: "0123456789₽$€%▲▼+−.," },
    psychology: { scene: psychologyScene, signs: "ψΨ∞?!…○●◐◑◒◓" },
    history: { scene: historyScene, signs: "IVXLCDM·—" },
    philology: { scene: philologyScene, signs: "ѢѲѴІъ«»—…" },
    administration: { scene: administrationScene, signs: "→↓§№•▪◆" },
    audit: { scene: auditScene, signs: "0123456789✓∑%№" },
    sea: { scene: seaScene, signs: "~≈∽·°∘—" },
  };
})();

/** the scene for a direction's name; one with no scene of its own gets the sea */
function directionFx(faculty) {
  const name = (faculty || "").toLowerCase();
  const rules = [[/математик|информатик/, "math"], [/журналист/, "journalism"], [/географ/, "geography"], [/физик/, "physics"],
    [/экономик/, "economics"], [/психолог/, "psychology"], [/истори/, "history"], [/филолог/, "philology"],
    [/аудит/, "audit"], [/управлен/, "administration"]];
  return (rules.find(([re]) => re.test(name)) || [, "sea"])[1];
}

function rememberGreeting(me) {
  const g = me?.group;
  try {
    if (g) localStorage.setItem(GREET_KEY, JSON.stringify({
      name: (me.real_name || me.first_name || "").trim().split(/\s+/)[0], course: g.course, master: Boolean(g.is_master), faculty: g.faculty,
    }));
    else localStorage.removeItem(GREET_KEY);
  } catch (_) {}
}
const forgetGreeting = () => { try { localStorage.removeItem(GREET_KEY); } catch (_) {} };

/** the greeting over the loading app: { ready() } to call once the app is drawn underneath, or null (first
    launch, so nobody to greet yet, or the phone asks for less motion) */
function playLaunchIntro() {
  let who = null;
  try { who = JSON.parse(localStorage.getItem(GREET_KEY) || "null"); } catch (_) {}
  if (!who || reduceMotion.matches) return null;
  const key = directionFx(who.faculty), dir = LAUNCH[key];
  const lines = [
    who.name ? `Приветствую, ${who.name}` : "Приветствую",
    `Студент ${who.course} курса${who.master ? " магистратуры" : ""}`,
    who.faculty,
  ];
  const fx = document.createElement("div");
  fx.className = "fx-overlay";
  fx.dataset.fx = key;
  fx.innerHTML = `<canvas aria-hidden="true"></canvas>
    <div class="fx-greet" role="status" aria-label="${esc(lines.join(". "))}">
      <p class="fx-title" aria-hidden="true"></p><p class="fx-line" aria-hidden="true"></p><p class="fx-dir" aria-hidden="true"></p>
    </div>
    <p class="fx-hint">Нажмите, чтобы пропустить</p>`;
  document.body.append(fx);

  const css = getComputedStyle(document.documentElement);
  const colours = Object.fromEntries(["ground", "faint", "muted", "accent", "text"].map((k) => [k, css.getPropertyValue(`--${k}`).trim()]));
  const canvas = fx.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = innerWidth, h = innerHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  let frame = null;
  try { frame = dir.scene(ctx, w, h, dpr, colours); } catch (e) { console.error(e); }

  let last = performance.now(), raf = 0, done = false;
  const draw = (time) => {
    const dt = Math.min(0.05, (time - last) / 1000);
    last = time;
    try { frame?.(dt); } catch (e) { console.error(e); frame = null; }   // a scene that breaks leaves the greeting
    if (!done) raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);

  let shown = false, loaded = false;
  const finish = () => {
    if (done) return;
    done = true;
    fx.classList.add("out");
    setTimeout(() => { cancelAnimationFrame(raf); fx.remove(); }, 420);
    // the day underneath comes up with its cascade as the scene clears
    const body = app.querySelector(".day-body");
    if (body?.querySelector(".rise")) { body.classList.remove("enter", "slide-next", "slide-prev"); void body.offsetWidth; body.classList.add("enter"); }
  };
  const settle = () => { if (shown && loaded) finish(); };
  fx.addEventListener("click", () => { haptic(); finish(); });
  const [title, line, dirEl] = fx.querySelectorAll(".fx-greet p");
  Promise.all([scramble(title, lines[0], dir.signs), scramble(line, lines[1], dir.signs, 380), scramble(dirEl, lines[2], dir.signs, 640)])
    .then(() => setTimeout(() => { shown = true; settle(); }, 1200));
  setTimeout(finish, 6000); // never left covering the app, even if frames stall or the network hangs
  return { ready() { loaded = true; settle(); } };
}

/** TextScramble: each letter flickers through the direction's signs, then settles, at its own random moment,
    after `delay` ms */
function scramble(el, text, signs, delay = 0) {
  return new Promise((resolve) => {
    const queue = [...text].map((to) => {
      if (to === " ") return { to, start: 0, end: 0, ch: "" }; // spaces stay put, so the text wraps as it will settle
      const start = Math.floor(Math.random() * 28);
      return { to, start, end: start + 10 + Math.floor(Math.random() * 30), ch: "" };
    });
    const t0 = performance.now() + delay;
    const tick = () => {
      const frame = Math.floor((performance.now() - t0) / 16.7); // time, not painted frames: a slow device still finishes on time
      let out = "", complete = 0;
      for (const q of queue) {
        if (frame >= q.end) { complete++; out += esc(q.to); }
        else if (frame >= q.start) {
          if (!q.ch || Math.random() < 0.28) q.ch = signs[Math.floor(Math.random() * signs.length)];
          out += `<span class="dud">${esc(q.ch)}</span>`;
        } else out += q.to === " " ? " " : `<span class="wait">${esc(q.to)}</span>`;
      }
      el.innerHTML = out;
      if (complete === queue.length) return resolve();
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/* ---------- boot ---------- */

async function boot({ greet = true } = {}) {
  applyTheme();
  setupTelegram();
  registerWorker();
  renderLoading();
  const intro = greet ? playLaunchIntro() : null;   // the greeting covers the loading, then lets the app up
  try { await load(); } finally { intro?.ready(); }
}

async function load() {
  // inside another app's browser the one-time sign-in is kept for Safari or Chrome, where the app can be installed
  if (inOtherApp && /^#login=[\w-]+\.[\w-]+$/.test(location.hash)) return renderOpenOutside();
  const handoff = inTelegram ? null : await takeHandoff();
  try {
    const [me, catalog] = await Promise.all([api("/api/me"), api("/api/catalog"), loadConfig()]);
    state.me = me;
    state.catalog = catalog;
    state.scheduleView = viewPref();
    rememberGreeting(me.onboarded ? me : null);
    if (!me.onboarded) return startOnboarding(false);   // the consent tick waits on its last step
    if (!me.consent) return askConsent();              // signed up before the consent was asked for, or before its new edition
    await resolveAvatar(me);
    await openSchedule();
    startLive();
    warmOffline();
    offerInstall();
    maybeShowGuide(Boolean(handoff?.ok));
  } catch (e) {
    if (state.signingIn || state.banned) return;
    if (e instanceof HttpError && e.status === 401 && !inTelegram) return renderSignIn(handoff?.note || "");
    console.error(e);
    renderError(e, () => boot({ greet: false }));
  }
}

/** what keeps the app current once the student has consented: friends, clubs, the bell */
let liveTimer = null;
function startLive() {
  loadFriends();
  loadClubs();
  loadUnread();
  liveTimer ??= setInterval(() => {
    if (state.ob || state.gone || document.visibilityState !== "visible") return;
    loadFriends();
    loadClubs();
    loadUnread();
  }, FRIENDS_POLL);
}

// keep "now" honest while the app stays open: every second the running pair's bar creeps on and the now-line
// with it; the minutes left roll over on the lead card; the day redraws when the pair changes
setInterval(() => {
  if (state.ob || state.tab !== "schedule" || state.scheduleView !== "day" || !state.selected) return;
  if (document.visibilityState !== "visible") return;
  const t = nowPrecise();
  const nxt = nextPair();
  if (liveSig(nxt) !== state.liveSig) {
    const y = window.scrollY;
    renderSchedule();
    window.scrollTo(0, y);
    return;
  }
  const status = document.getElementById("lead-status");
  if (status && nxt) rollTo(status.querySelector("span"), statusText(nxt));
  const bar = document.getElementById("lead-bar");
  if (bar && nxt?.running) bar.style.width = `${progressOf(nxt, t).toFixed(2)}%`;   // no transition: see .now-line
  const strip = app.querySelector(".strip");
  const line = app.querySelector(".now-line"), label = app.querySelector(".now-label");
  if (strip && line && label) {
    const from = Number(strip.dataset.from), to = Number(strip.dataset.to);
    const p = ((t.min - from) / (to - from)) * 100;
    line.style.left = `${p.toFixed(2)}%`;
    label.style.left = `${Math.min(94, Math.max(6, p)).toFixed(2)}%`;
    const text = hm(Math.floor(t.min));
    if (label.textContent !== text) label.textContent = text;
  }
}, 1000);

boot();
