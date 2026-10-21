"use strict";

const tg = window.Telegram?.WebApp;
const inTelegram = Boolean(tg?.initData);
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
  ob: null,             // onboarding draft
  reminders: new Map(), // "date|start|subject" -> reminder
  liveSig: "",          // which pair the lead card shows, to know when to redraw
};

/* ---------- time (Sevastopol lives on Moscow time) ---------- */

function now() {
  const forced = new URLSearchParams(location.search).get("now"); // ?now=2026-10-21T10:12 for demos
  if (forced) return parseLocal(forced);
  const s = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Moscow" });
  return parseLocal(s.replace(" ", "T"));
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
};

/* ---------- subjects: one colour and one drawn mark per discipline ----------
   The mark is a small line drawing of the discipline's own sign (an integral, a triangle in a circle,
   an hourglass), drawn in the subject's colour; the colour stays the same for that subject all week. */

const SUBJECT_MARKS = {
  analysis: '<path d="M14.5 3.5c-1.9 0-2.5 1.5-2.8 3.5L10.2 17c-.3 2-.9 3.5-2.7 3.5"/><path d="M14 14.5c.9-1.6 1.8-1.6 2.7 0s1.8 1.6 2.8 0"/>',
  geometry: '<path d="M12 4 20.5 19h-17Z"/><circle cx="12" cy="14" r="3"/>',
  algorithms: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M8.2 6h7.6M7.2 7.9l3.6 8.2M16.8 7.9l-3.6 8.2"/>',
  code: '<path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5M13.5 5.5l-3 13"/>',
  history: '<path d="M7 3.5h10M7 20.5h10M8 3.5c0 5 8 5.5 8 8.5s-8 3.5-8 8.5M16 3.5c0 5-8 5.5-8 8.5s8 3.5 8 8.5"/>',
  sport: '<path d="M7.5 12h9"/><rect x="4.5" y="7" width="3" height="10" rx="1.2"/><rect x="16.5" y="7" width="3" height="10" rx="1.2"/><path d="M2.5 10v4M21.5 10v4"/>',
  language: '<path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-8l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5Z"/><path d="M9.5 13.5 12 7.5l2.5 6M10.4 11.4h3.2"/>',
  safety: '<path d="M12 3.5 5 6.5v5c0 4.3 2.9 7.5 7 9 4.1-1.5 7-4.7 7-9v-5Z"/><path d="M12 9v6M9 12h6"/>',
  physics: '<circle cx="12" cy="12" r="1.4"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/>',
  economics: '<path d="M4 20h16M7 16.5v-4M12 16.5V8.5M17 16.5V5.5"/>',
  psychology: '<path d="M12 4v16M7 6v3.5a5 5 0 0 0 10 0V6M9.5 20h5"/>',
  literature: '<path d="M3.5 6c3-1 5.8-.8 8.5 1 2.7-1.8 5.5-2 8.5-1v12.5c-3-1-5.8-.8-8.5 1-2.7-1.8-5.5-2-8.5-1Z"/><path d="M12 7v12.5"/>',
  media: '<path d="M4 5h12.5v14H6a2 2 0 0 1-2-2Z"/><path d="M16.5 9H20v8a2 2 0 0 1-2 2M7 9h6.5M7 12h6.5M7 15h4"/>',
  geography: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.4 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.4-3.5-8.5s1.1-6.1 3.5-8.5Z"/>',
  law: '<path d="M12 4v16M8 20h8M5 7h14M5 7l-2.5 6a2.5 2.5 0 0 0 5 0ZM19 7l-2.5 6a2.5 2.5 0 0 0 5 0Z"/>',
  chance: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r=".6"/><circle cx="15" cy="15" r=".6"/><circle cx="15" cy="9" r=".6"/><circle cx="9" cy="15" r=".6"/>',
  book: '<path d="M6 4h12v16H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M4 17.5A2 2 0 0 1 6 15.5h12M9 8h6"/>',
};

// first match wins, so the specific disciplines come before the broad ones
const SUBJECT_RULES = [
  [/физическ\S* культур|спорт|элективн/, "sport", "orange"],
  [/алгоритм|дискретн|граф/, "algorithms", "green"],
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
const markSvg = (name, cls = "mark") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${SUBJECT_MARKS[subjectStyle(name).mark]}</svg>`;

/* ---------- api ---------- */

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (inTelegram) headers["X-Init-Data"] = tg.initData;
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
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
  if (!inTelegram) return;
  try {
    const res = await fetch("/api/avatar", { headers: { "X-Init-Data": tg.initData } });
    if (res.ok) avatarUrl = URL.createObjectURL(await res.blob());
  } catch (_) {}
}
function avatarHtml(me) {
  const ini = esc(initials(me.real_name || `${me.first_name} ${me.last_name}`));
  const img = avatarUrl ? `<img src="${esc(avatarUrl)}" alt="" onerror="this.parentNode.textContent=this.parentNode.dataset.i">` : "";
  return `<span class="avatar" data-i="${ini}" aria-hidden="true">${img || ini}</span>`;
}

/* ---------- shell ---------- */

/* ---------- slide tabs: the SlideTabs component (React + framer-motion) ported to plain JS ---------- */

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

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
    if (fromUser && changed) this.onSelect?.(this.tabs[i], i);
  }
  place() { this.cursorTo(this.selected, true); }
}

const TABS = ["schedule", "clubs", "profile"];
const tabbarTabs = new SlideTabs(tabbar, (tab) => {
  haptic();
  state.tab = tab.dataset.tab;
  if (state.tab === "schedule") { state.selected = now().iso; state.weekStart = mondayOf(state.selected); }
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
  const y = window.scrollY, d = y - lastScrollY;
  if (Math.abs(d) < 8) return;
  tabbar.classList.toggle("away", d > 0 && y > 80);
  lastScrollY = y;
}, { passive: true });
function placeTabs() {
  tabbarTabs.place();
  if (profileTabs?.root.isConnected) profileTabs.place();
  if (schedTabs?.root.isConnected) schedTabs.place();
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

function renderLoading() {
  showTabbar(false);
  app.innerHTML = `
    <div class="skeleton" aria-label="Загружаем расписание">
      <i style="width:62%;height:26px"></i>
      <i style="width:44%;height:16px;margin-top:8px"></i>
      <i style="width:100%;height:64px;margin-top:28px;border-radius:14px"></i>
      <i style="width:100%;height:10px;margin-top:24px"></i>
      <i style="width:100%;height:190px;margin-top:30px;border-radius:20px"></i>
    </div>`;
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
    lead = "Настоящие имя и фамилия. Их видите только вы, в своём профиле.";
    body = `
      <div class="field">
        <label for="name">Имя и фамилия</label>
        <input id="name" name="name" autocomplete="name" autocapitalize="words" enterkeyhint="done" maxlength="80"
               placeholder="Например, Анна Ковалёва" value="${esc(ob.name)}">
        <p class="err" id="name-err" hidden></p>
      </div>
      <p class="summary">Группа <b>${esc(ob.group?.name)}</b>, ${courseLabel(ob.course, ob.faculty.is_master)}<br>${esc(ob.faculty.name)}</p>`;
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
  const btn = document.getElementById("ob-done");
  btn.disabled = true;
  btn.textContent = "Сохраняем…";
  try {
    const changedGroup = state.me.group?.id !== ob.group.id;
    state.me = await api("/api/profile", { method: "POST", body: JSON.stringify({ real_name: name, group_id: ob.group.id }) });
    if (changedGroup) { state.lessons.clear(); state.loadedWeeks.clear(); }
    const wasEditing = ob.editing;
    state.ob = null;
    haptic("success");
    state.tab = wasEditing && !changedGroup ? "profile" : "schedule";
    await openSchedule();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = ob.editing ? "Сохранить" : "Готово";
    err.textContent = "Не получилось сохранить. Проверьте интернет и нажмите ещё раз.";
    err.hidden = false;
    haptic("error");
  }
}

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
  render();
  // the next pair after today may sit in next week
  loadWeek(addDays(mondayOf(now().iso), 7)).then(() => { if (!state.ob && state.tab === "schedule") renderSchedule(); }).catch(() => {});
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
    <div class="strip" role="img" aria-label="Пары с ${span}" data-from="${from}" data-to="${to}">
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
    const progress = nxt.running ? `<div class="lead-progress" aria-hidden="true"><i id="lead-bar" style="width:${progressOf(nxt, t)}%"></i></div>` : "";
    lead = `
      <article class="lead-card pressable" style="${hueVar(l.subject)}" data-date="${iso}" data-pair="${leadSlot.pair}" data-idx="0" role="button" tabindex="0">
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
  const rows = listSlots.map((s) => {
    const prev = slots[slots.indexOf(s) - 1]; // the whole day, so a break after the lead pair still shows
    const pause = prev ? toMin(s.start) - toMin(prev.end) : 0;
    const gap = pause >= 30 ? `<li class="gap"><span class="num">${clock(prev.end)}–${clock(s.start)}</span> · перерыв ${duration(pause)}</li>` : "";
    return gap + s.items.map((l, j) => `
      <li class="pair pressable ${isPast(s) ? "past" : ""}" style="${hueVar(l.subject)}" data-date="${iso}" data-pair="${s.pair}" data-idx="${j}" role="button" tabindex="0">
        <span class="t">${clock(s.start)}<br>${clock(s.end)}</span>
        <div>
          <h3>${esc(l.subject)}</h3>
          <p>${esc(kindName(l.kind))}${l.room ? ` · <b>ауд. ${esc(l.room)}</b>` : ""}${l.teacher ? ` · ${esc(shortName(l.teacher))}` : ""}${state.reminders.has(remKey(iso, l.start, l.subject)) ? ` · <span class="reminded">напомню</span>` : ""}</p>
        </div>
        ${markSvg(l.subject)}
      </li>`).join("");
  }).join("");

  let body;
  if (!slots.length) body = emptyDay(iso, t, nxt);
  else if (isToday && !leadSlot) body = `<div class="done"><h2>На сегодня всё</h2><p>${nextLine(nxt)}</p></div><h2 class="section-title">Пары сегодня</h2><ul class="pairs">${rows}</ul>`;
  else body = `${lead}${rows ? `<h2 class="section-title">${leadSlot ? "Остальные пары" : "Пары"}</h2><ul class="pairs">${rows}</ul>` : ""}`;

  const slide = dir ? (dir > 0 ? "slide-next" : "slide-prev") : "";
  scheduleHost().innerHTML = `${header}${weekPicker(t)}<div class="day-body ${slide}">${strip}${body}${sourceLine()}</div>`;
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
    const open = () => openPairSheet(el.dataset.date, Number(el.dataset.pair), Number(el.dataset.idx));
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
  try {
    await loadWeek(ws);
  } catch (_) {
    tg?.showAlert?.("Не удалось загрузить неделю. Проверьте интернет.");
    return;
  }
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
      <div class="slide-tabs segmented sched-switch" role="tablist" aria-label="Вид расписания">
        <span class="slide-cursor" aria-hidden="true"></span>
        ${SCHEDULE_VIEWS.map(([id, label]) => `<button role="tab" data-sview="${id}" aria-selected="${state.scheduleView === id}">${label}</button>`).join("")}
      </div>
      <div id="sched-body"></div>`;
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

function renderWeek({ dir = 0 } = {}) {
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
          <span class="wk-name">${esc(shortSubject(l.subject))}</span>
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
      <div class="wk-scroll">
        <div class="wk-table" style="--cols:${maxPair}" role="grid" aria-label="Расписание на неделю">${head}${rows}</div>
      </div>
      <p class="wk-key"><i class="wk-swatch" aria-hidden="true"></i>нет пары</p>
      ${sourceLine()}
    </div>`;

  bindStats(); // the week arrows
  app.querySelectorAll(".wk-cell.pressable").forEach((el) => {
    el.addEventListener("click", () => openPairSheet(el.dataset.date, Number(el.dataset.pair), Number(el.dataset.idx)));
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
    center.innerHTML = s
      ? `<div class="donut-text swap"><span>${esc(s.label)}</span><b class="num">${s.value}</b><small class="num">${unit(s.value)} · ${Math.round((s.value / total) * 100)}%</small></div>`
      : `<div class="donut-text swap"><span>${esc(centerLabel)}</span><b class="num">${centerValue}</b></div>`;
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
    <section class="stat-card">
      <div class="stat-head"><h2>Пройдено</h2><p class="num">${st.done} из ${pairs(pairsTotal)}</p></div>
      <div class="week-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${pairsTotal}" aria-valuenow="${st.done}">
        <i style="width:${(st.done / pairsTotal) * 100}%"></i>
      </div>
    </section>` : "";

  scheduleHost().innerHTML = `${header}
    <div class="day-body ${slide}">
      <dl class="kpis">
        <div><dt>Пар</dt><dd class="num">${pairsTotal}</dd></div>
        <div><dt>Академ. часов</dt><dd class="num">${hoursText(acad)}</dd><small>по 45 мин</small></div>
        <div><dt>Обычных часов</dt><dd class="num">${hoursText(hours)}</dd><small>по 60 мин</small></div>
      </dl>

      <section class="stat-card">
        <div class="stat-head"><h2>Каких пар больше</h2><p>Нажмите на предмет</p></div>
        ${donutHtml(subjectSegs, { centerLabel: "Всего пар", centerValue: pairsTotal })}
        <ul class="legend">${legend}</ul>
      </section>

      <section class="stat-card">
        <div class="stat-head"><h2>Лекции и практика</h2></div>
        <div class="kind-bar" aria-hidden="true">${kindBar}</div>
        <div class="kind-legend">${kindLegend}</div>
      </section>

      <section class="stat-card">
        <div class="stat-head"><h2>Нагрузка по дням</h2></div>
        <div class="load">${load}</div>
      </section>

      ${progress}

      <section class="stat-card">
        <div class="stat-head"><h2>Факты недели</h2></div>
        <ul class="rows facts-list">${facts}</ul>
      </section>
      ${sourceLine()}
    </div>`;

  const card = scheduleHost().querySelector(".stat-card .donut").closest(".stat-card");
  bindDonut(card, subjectSegs, card.querySelector(".legend"), {
    centerLabel: "Всего пар", centerValue: pairsTotal, unit: pairUnit,
  });
  bindStats();
}

function bindStats() {
  document.getElementById("wk-prev")?.addEventListener("click", () => shiftWeek(-7));
  document.getElementById("wk-next")?.addEventListener("click", () => shiftWeek(7));
}

/* ---------- bottom sheet ---------- */

const sheet = document.getElementById("sheet");
function openSheet(html, bind) {
  const panel = sheet.querySelector(".sheet-panel");
  panel.innerHTML = `<div class="grabber" aria-hidden="true"></div>${html}`;
  sheet.classList.remove("closing");
  sheet.hidden = false;
  setBack(closeSheet);
  bind?.(panel);
}
function closeSheet() {
  if (sheet.hidden || sheet.classList.contains("closing")) return;
  sheet.classList.add("closing");
  setBack(null);
  setTimeout(() => { sheet.hidden = true; sheet.classList.remove("closing"); }, reduceMotion.matches ? 0 : 200);
}
sheet.addEventListener("click", (e) => { if (e.target.hasAttribute("data-close")) closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

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

function openPairSheet(date, pair, idx) {
  const l = findLesson(date, pair, idx);
  if (!l) return;
  if (sheet.hidden) haptic();
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
        ? `<button class="btn secondary" id="remind">Не напоминать</button>`
        : `<button class="btn" id="remind">Напомнить за 10 минут</button>`}
      <button class="btn secondary" id="copy">Скопировать</button>
    </div>
    <p class="btn-note" id="sheet-note" aria-live="polite">${note}</p>`, (panel) => {
    const noteEl = panel.querySelector("#sheet-note");
    panel.querySelector("#copy").addEventListener("click", async () => {
      const text = `${when} — ${l.subject}${kind ? ` (${kind.toLowerCase()})` : ""}${l.room ? `, ауд. ${l.room}` : ""}${l.teacher ? `, ${l.teacher}` : ""}`;
      const ok = await copyText(text);
      noteEl.textContent = ok ? "Скопировано." : "Не получилось скопировать.";
      haptic(ok ? "success" : "error");
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
        }
        haptic("success");
        openPairSheet(date, pair, idx);
        if (state.tab === "schedule") renderSchedule();
      } catch (err) {
        btn.disabled = false;
        noteEl.textContent = err instanceof HttpError && err.status === 400
          ? "Пара уже началась." : "Не получилось. Проверьте интернет и попробуйте ещё раз.";
        haptic("error");
      }
    });
  });
}

/* ---------- empty states: one line drawing each, in the same hand as the subject marks ---------- */

const ART = {
  clubs: '<path d="M30 30 60 14l30 16M28 30h64M36 34v22M48 34v22M72 34v22M84 34v22M26 62h68M56 62V52a4 4 0 0 1 8 0v10M60 14V4"/><path class="hi" d="M60 4h11l-3 3.5 3 3.5H60"/>',
  friends: '<circle cx="46" cy="24" r="9"/><path d="M28 62c2-12 9-19 18-19s16 7 18 19"/><circle cx="74" cy="29" r="7"/><path d="M66 47c2.4-3 5-4.5 8-4.5 7 0 12 6 14 17"/><path class="hi" d="M98 14v12M92 20h12"/>',
  free: '<circle class="hi" cx="60" cy="32" r="11"/><path class="hi" d="M60 10V5M37 32h-5M88 32h-5M44 16l-3.5-3.5M76 16l3.5-3.5"/><path d="M18 52c5-4 10-4 15 0s10 4 15 0 10-4 15 0 10 4 15 0 10-4 15 0 10 4 15 0"/><path d="M28 62c5-4 10-4 15 0s10 4 15 0 10-4 15 0 10 4 15 0 10-4 15 0"/>',
};
const emptyState = (art, title, text) => `
  <div class="empty-state">
    <svg class="art" viewBox="0 0 120 72" aria-hidden="true">${ART[art]}</svg>
    <strong>${title}</strong><p>${text}</p>
  </div>`;

/* ---------- screen: clubs ---------- */

function renderClubs() {
  app.innerHTML = `
    <header class="clubs-head"><h1>Студклубы</h1></header>
    <p class="clubs-sub">Клубы по интересам студентов филиала: найдите своих или соберите новый.</p>
    ${emptyState("clubs", "Клубов пока нет", "Скоро здесь можно будет создать свой клуб, вступить в чужие и следить за встречами.")}
    <div style="margin-top:20px">
      <button class="btn" disabled aria-describedby="club-soon">Создать клуб</button>
      <p class="btn-note" id="club-soon">Появится в следующем обновлении</p>
    </div>`;
}

/* ---------- screen: profile ---------- */

const PROFILE_VIEWS = [
  ["settings", "Настройки", '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'],
  ["profile", "Профиль", '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.6 3.8-5.5 7-5.5s5.8 1.9 7 5.5"/>'],
  ["friends", "Друзья", '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.9-3 3-4.6 5.5-4.6s4.6 1.6 5.5 4.6M15.5 5.6a3 3 0 0 1 0 5.8M17 14.9c1.8.4 3 1.9 3.6 4.6"/>'],
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
  document.getElementById("edit-profile")?.addEventListener("click", () => { haptic(); startOnboarding(true); });
  app.querySelectorAll("[data-theme-pref]").forEach((b) => b.addEventListener("click", (e) => {
    haptic();
    switchTheme(b.dataset.themePref, e.clientX, e.clientY);
  }));

  // notifications: each control saves itself
  const st = state.settings;
  app.querySelector('[data-set="remind_all"]')?.addEventListener("click", () => { haptic(); saveSetting({ remind_all: !st.remind_all }); });
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
  document.getElementById("report")?.addEventListener("click", () => {
    haptic();
    const url = `https://t.me/${DEVELOPER}`;
    if (tg?.openTelegramLink && inTelegram) tg.openTelegramLink(url); else window.open(url, "_blank");
  });
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
  try {
    state.settings = await api("/api/settings", { method: "POST", body: JSON.stringify(patch) });
  } catch (_) {
    state.settings = before;
    tg?.showAlert?.("Не получилось сохранить настройку. Проверьте интернет и попробуйте ещё раз.");
  }
  updateProfileBody();
}

const switchRow = (id, label, hint, on) => `
  <li><button data-set="${id}" role="switch" aria-checked="${on}">
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

function settingsView() {
  const pref = themePref();
  const opts = [
    ["dark", "Тёмная", "Чёрный фон"],
    ["light", "Светлая", "Белый фон"],
    ["auto", "Как в Telegram", `Сейчас ${systemTheme() === "light" ? "светлая" : "тёмная"}`],
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

    <h2 class="group-label">Тема оформления</h2>
    <ul class="options" role="radiogroup" aria-label="Тема оформления">
      ${opts.map(([id, label, hint]) => `
        <li><button role="radio" data-theme-pref="${id}" aria-checked="${pref === id}">
          <span>${label}<small>${hint}</small></span><span class="check">${icon.check}</span>
        </button></li>`).join("")}
    </ul>

    <h2 class="group-label">Помощь</h2>
    <ul class="options">
      <li><button id="report"><span>Сообщить об ошибке<small>Написать разработчику @${DEVELOPER}</small></span>${icon.right}</button></li>
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
  const t = document.startViewTransition(swap);
  t.ready.then(() => document.documentElement.animate(
    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
    { duration: 560, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
  )).catch(() => {});
}

function profileView() {
  const me = state.me, g = me.group;
  return `
    <div class="profile-head">
      ${avatarHtml(me)}
      <div>
        <h1>${esc(me.real_name)}</h1>
        <p>${me.username ? `@${esc(me.username)} · ` : ""}аккаунт Telegram</p>
      </div>
    </div>
    <ul class="rows">
      <li><span>Направление</span><b>${esc(g.faculty)}${g.is_master ? ", магистратура" : ""}</b></li>
      <li><span>Курс</span><b class="num">${g.course}</b></li>
      <li><span>Группа</span><b>${esc(g.name)}</b></li>
    </ul>
    <button class="btn secondary" id="edit-profile">Изменить учебные данные</button>`;
}

function friendsView() {
  return `
    <h1 class="view-title">Друзья</h1>
    ${emptyState("friends", "Друзей пока нет", "Скоро здесь можно будет добавить однокурсников и посмотреть, где у них пары.")}`;
}

/* ---------- boot ---------- */

async function boot() {
  applyTheme();
  setupTelegram();
  renderLoading();
  try {
    const [me, catalog] = await Promise.all([api("/api/me"), api("/api/catalog")]);
    state.me = me;
    state.catalog = catalog;
    await resolveAvatar(me);
    state.scheduleView = viewPref();
    if (!me.onboarded) startOnboarding(false);
    else await openSchedule();
  } catch (e) {
    console.error(e);
    renderError(e, boot);
  }
}

// keep "now" honest while the app stays open: tick the lead card, redraw when the pair changes
setInterval(() => {
  if (state.ob || state.tab !== "schedule" || state.scheduleView !== "day" || !state.selected) return;
  const t = now();
  const nxt = nextPair();
  if (liveSig(nxt) !== state.liveSig) {
    const y = window.scrollY;
    renderSchedule();
    window.scrollTo(0, y);
    return;
  }
  const status = document.getElementById("lead-status");
  if (status && nxt) status.querySelector("span").textContent = statusText(nxt);
  const bar = document.getElementById("lead-bar");
  if (bar && nxt?.running) bar.style.width = `${progressOf(nxt, t)}%`;
  const strip = app.querySelector(".strip");
  const line = app.querySelector(".now-line"), label = app.querySelector(".now-label");
  if (strip && line && label) {
    const from = Number(strip.dataset.from), to = Number(strip.dataset.to);
    const p = ((t.min - from) / (to - from)) * 100;
    line.style.left = `${p}%`;
    label.style.left = `${Math.min(94, Math.max(6, p))}%`;
    label.textContent = hm(t.min);
  }
}, 10 * 1000);

boot();
