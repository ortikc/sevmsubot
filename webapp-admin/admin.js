/* The admin panel (CRM) of «Расписание МГУ Севастополь»: a Telegram Mini App opened from the CRM bot.
   Every request carries Telegram's initData; the server lets in only the admin's account (app/admin.py).
   Plain views, no motion: Обзор, Люди, Клубы, Модерация, and under «Ещё» the broadcasts, messages to the
   developer, the schedule, the server, settings and the journal. A person or a club opens in a sheet. */

const tg = window.Telegram?.WebApp;
const inTelegram = Boolean(tg?.initData);
const app = document.getElementById("app");
const sheet = document.getElementById("sheet");
const sheetBody = document.getElementById("sheet-body");
const state = { tab: "stats", sub: null, catalog: null, users: { q: "", filter: "all", faculty: "", course: "", group: "", offset: 0 },
  moder: "reports", reportStatus: "open" };

/* ---------- basics ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n = (x) => Number(x || 0).toLocaleString("ru-RU");
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function haptic(kind) {
  try { kind ? tg?.HapticFeedback?.notificationOccurred(kind) : tg?.HapticFeedback?.impactOccurred("light"); } catch (_) {}
}

/** the server's times are UTC: "2026-10-29 14:05:00" or ISO with an offset */
function toDate(s) {
  if (!s) return null;
  const iso = /[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
function when(s, withYear = false) {
  const d = toDate(s);
  if (!d) return "—";
  return d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit" });
}
function ago(s) {
  const d = toDate(s);
  if (!d) return "никогда";
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 2) return "только что";
  if (min < 60) return `${min} мин назад`;
  if (min < 60 * 24) return `${Math.round(min / 60)} ч назад`;
  if (min < 60 * 24 * 30) return `${Math.round(min / 1440)} дн назад`;
  return when(s, true);
}
function bytes(b) {
  if (b == null) return "—";
  const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i ? 1 : 0)} ${u[i]}`;
}
function duration(sec) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} дн ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`;
}
const initials = (name) => (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
function avatar(p, cls = "") {
  const img = p?.photo_url ? `<img src="${esc(p.photo_url)}" alt="" loading="lazy" onerror="this.remove()">` : "";
  return `<span class="avatar ${cls}" aria-hidden="true">${img || esc(initials(p?.name))}</span>`;
}
const groupLine = (p) => [p.group, p.course ? `${p.course} курс${p.master ? " маг." : ""}` : "", p.faculty].filter(Boolean).join(" · ");
function badges(p) {
  return (p.ban ? `<span class="tag red">бан</span>` : "") + (p.mute ? `<span class="tag yellow">без публикаций</span>` : "");
}
const KIND = { post: "Запись", comment: "Комментарий", user: "Пользователь", club: "Клуб" };
const PLACE = { post: "запись", comment: "комментарий", nickname: "ник", bio: "о себе", club: "клуб" };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(path, opts = {}) {
  const res = await fetch(`/api/admin${path}`, {
    ...opts, headers: { "Content-Type": "application/json", ...(inTelegram ? { "X-Init-Data": tg.initData } : {}) },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    if (res.status === 401 || res.status === 403) denied(res.status, msg);
    throw new HttpError(res.status, typeof msg === "string" ? msg : "Ошибка");
  }
  return res.json();
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });
const del = (path) => api(path, { method: "DELETE" });
const errText = (e) => (e instanceof HttpError && e.message ? e.message : "Не получилось. Проверьте интернет.");

function denied(status, msg) {
  document.getElementById("tabbar").hidden = true;
  closeSheet();
  app.innerHTML = `<div class="center"><p><strong>${status === 403 ? "Доступ закрыт" : "Не получилось войти"}</strong>${
    status === 403 ? "Эта панель только для администратора." : esc(msg || "Откройте панель кнопкой в боте.")}</p></div>`;
}

/** a button that asks once more before doing something that cannot be taken back */
function confirmTap(btn, text = "Точно? Нажмите ещё раз") {
  if (btn.dataset.sure) return true;
  btn.dataset.sure = "1";
  btn.dataset.was = btn.textContent;
  btn.textContent = text;
  haptic();
  setTimeout(() => { if (btn.isConnected && btn.dataset.sure) { delete btn.dataset.sure; btn.textContent = btn.dataset.was; } }, 4000);
  return false;
}
/** run an action from a button: it waits disabled, an error shows next to it */
async function act(btn, fn, okText) {
  btn.disabled = true;
  btn.parentElement.querySelector(".err")?.remove();
  try {
    const r = await fn();
    haptic("success");
    if (okText) { btn.textContent = okText; }
    return r;
  } catch (e) {
    haptic("error");
    btn.disabled = false;
    btn.insertAdjacentHTML("afterend", `<p class="err">${esc(errText(e))}</p>`);
    return undefined;
  }
}

/* ---------- charts: plain SVG bars ---------- */

function bars(series, { keys, colors, height = 120, labels }) {
  const w = 600, gap = 3, bw = (w - gap * (series.length - 1)) / series.length;
  const max = Math.max(1, ...series.map((s) => Math.max(...keys.map((k) => s[k] || 0))));
  const inner = series.map((s, i) => keys.map((k, j) => {
    const v = s[k] || 0, h = Math.max(v ? 2 : 0, (v / max) * (height - 4));
    const kw = bw / keys.length;
    return `<rect x="${(i * (bw + gap) + j * kw).toFixed(1)}" y="${(height - h).toFixed(1)}" width="${Math.max(1, kw - (keys.length > 1 ? 1 : 0)).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${colors[j]}"><title>${esc(s.title || "")}: ${v}</title></rect>`;
  }).join("")).join("");
  return `<div class="chart"><svg viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" style="height:${height}px">
    <rect x="0" y="${height - 1}" width="${w}" height="1" fill="var(--bar)"/>${inner}</svg>
    ${labels ? `<div class="axis">${labels.map((l) => `<span>${esc(l)}</span>`).join("")}</div>` : ""}</div>`;
}
function rows(items, total) {
  const max = Math.max(1, ...items.map((i) => i.n));
  return `<ul class="rows">${items.map((i) => `<li><span class="name">${esc(i.label)}</span>
    <span class="val">${n(i.n)}${total ? ` <span style="color:var(--faint);font-weight:400">· ${pct(i.n, total)}%</span>` : ""}</span>
    <span class="bar"><i style="width:${((i.n / max) * 100).toFixed(1)}%"></i></span></li>`).join("")}</ul>`;
}

/* ---------- sheet ---------- */

let sheetBack = null;
function openSheet(html, bind) {
  sheetBody.innerHTML = html;
  sheet.hidden = false;
  document.body.style.overflow = "hidden";
  if (tg?.BackButton) {
    tg.BackButton.show();
    if (!sheetBack) { sheetBack = () => closeSheet(); tg.BackButton.onClick(sheetBack); }
  }
  bind?.(sheetBody);
}
function closeSheet() {
  sheet.hidden = true;
  sheetBody.innerHTML = "";
  document.body.style.overflow = "";
  if (tg?.BackButton && sheetBack) { tg.BackButton.offClick(sheetBack); sheetBack = null; tg.BackButton.hide(); }
}
sheet.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });

/* ---------- tabs ---------- */

const TABS = { stats: renderStats, users: renderUsers, clubs: renderClubs, moder: renderModeration, more: renderMore };
const MORE = {
  broadcasts: ["Рассылки", "Сообщения всем или части студентов через бота", renderBroadcasts],
  feedback: ["Сообщения разработчику", "Что пишут из приложения, ответ уходит через бота", renderFeedback],
  schedule: ["Расписание", "Парсер по группам, ошибки, изменения", renderSchedule],
  server: ["Сервер", "Место, память, база, резервные копии, боты", renderServer],
  settings: ["Настройки", "Даты семестра, переключатели, баннер", renderSettings],
  log: ["Журнал действий", "Что вы делали в панели, с отменой", renderLog],
};
document.getElementById("tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  haptic();
  go(b.dataset.tab, null);
});
function go(tab, sub = null) {
  state.tab = tab;
  state.sub = sub;
  document.querySelectorAll("#tabbar [data-tab]").forEach((b) => b.toggleAttribute("aria-current", b.dataset.tab === tab));
  document.querySelectorAll("#tabbar [aria-current]").forEach((b) => b.setAttribute("aria-current", "page"));
  window.scrollTo(0, 0);
  (sub ? MORE[sub][2] : TABS[tab])();
}
const loading = (title) => { app.innerHTML = `<h1 class="view-title">${title}</h1>${'<i class="sk"></i>'.repeat(4)}`; };
const failed = (title, e, retry) => {
  if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return;
  app.innerHTML = `<h1 class="view-title">${title}</h1><div class="note"><strong>Не загрузилось</strong>${esc(errText(e))}</div>
    <button class="btn secondary" id="retry">Повторить</button>`;
  document.getElementById("retry").onclick = retry;
};
const backToMore = () => `<button class="back" id="back">‹ Ещё</button>`;
function bindBack() { document.getElementById("back")?.addEventListener("click", () => go("more")); }

async function refreshDots() {
  try {
    const me = await api("/me");
    document.getElementById("dot-moder").hidden = !me.reports;
    document.getElementById("dot-more").hidden = !me.unread;
    return me;
  } catch (_) { return null; }
}

/* ---------- Обзор ---------- */

async function renderStats() {
  loading("Обзор");
  let s;
  try { s = await api("/stats"); } catch (e) { return failed("Обзор", e, renderStats); }
  if (state.tab !== "stats") return;
  const series = s.series.map((d) => ({ ...d, title: new Date(d.day).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) }));
  const dayLabel = (i) => series[i] ? series[i].title : "";
  const retention = s.retention.map((r) => ({ label: `Вернулись через ${r.days} ${r.days === 1 ? "день" : "дней"} (из ${n(r.base)})`, n: r.back }));
  const hours = s.hours.map((v, h) => ({ v, title: `${h}:00` }));
  const peak = s.hours.indexOf(Math.max(...s.hours));
  app.innerHTML = `
    <h1 class="view-title">Обзор</h1>
    <p class="view-sub">Москва, ${new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}</p>
    <div class="kpis">
      <div class="kpi"><b>${n(s.users)}</b><span>пользователей</span></div>
      <div class="kpi"><b>${n(s.active.dau)}</b><span>заходили сегодня</span></div>
      <div class="kpi"><b>+${n(s.new.today)}</b><span>новых сегодня</span></div>
      <div class="kpi"><b>${n(s.active.wau)}</b><span>за 7 дней</span></div>
      <div class="kpi"><b>${n(s.active.mau)}</b><span>за 30 дней</span></div>
      <div class="kpi"><b>+${n(s.new.week)}</b><span>новых за неделю</span></div>
      <button class="kpi button ${s.reports ? "alert" : ""}" data-go="moder"><b>${n(s.reports)}</b><span>жалоб ждут</span></button>
      <button class="kpi button ${s.unread ? "alert" : ""}" data-go-more="feedback"><b>${n(s.unread)}</b><span>новых сообщений</span></button>
      <button class="kpi button" data-filter="banned"><b>${n(s.banned)}</b><span>заблокировано</span></button>
    </div>

    <h2 class="label">Активность за 30 дней</h2>
    <div class="card">
      ${bars(series, { keys: ["dau", "new"], colors: ["var(--accent)", "var(--green)"], labels: [dayLabel(0), dayLabel(10), dayLabel(20), dayLabel(29)] })}
      <div class="legend"><span><i style="background:var(--accent)"></i>заходили</span><span><i style="background:var(--green)"></i>зарегистрировались</span></div>
    </div>

    <h2 class="label">Удержание</h2>
    <div class="card">${rows(retention.map((r, i) => ({ ...r, n: r.n })), 0)}
      <p class="hint" style="margin:8px 0 0">Доля тех, кто открыл приложение хотя бы раз спустя N дней после регистрации: ${
        s.retention.map((r) => `${r.days} д. — ${pct(r.back, r.base)}%`).join(", ")}</p></div>

    <h2 class="label">Часы активности · 14 дней</h2>
    <div class="card">${bars(hours, { keys: ["v"], colors: ["var(--accent)"], height: 90, labels: ["0:00", "6:00", "12:00", "18:00", "23:00"] })}
      <p class="hint" style="margin:8px 0 0">${s.hours.some(Boolean) ? `Больше всего людей в ${peak}:00–${peak + 1}:00` : "Пока нет данных: они копятся с этой версии"}</p></div>

    <h2 class="label">Путь до приложения на телефоне</h2>
    <div class="card">${rows(s.funnel.map((f) => ({ label: f.label, n: f.n })), s.users)}</div>

    <h2 class="label">Направления</h2>
    <div class="card">${s.by_faculty.length ? rows(s.by_faculty.map((f) => ({ label: f.name + (f.master ? " (маг.)" : ""), n: f.n })), s.users) : `<p class="hint">Пока никого</p>`}</div>
    <h2 class="label">Курсы</h2>
    <div class="card">${s.by_course.length ? rows(s.by_course.map((c) => ({ label: `${c.course} курс`, n: c.n })), s.users) : `<p class="hint">Пока никого</p>`}</div>
    <h2 class="label">Самые большие группы</h2>
    <div class="card">${s.by_group.length ? rows(s.by_group.map((g) => ({ label: `${g.name} · ${g.faculty}`, n: g.n }))) : `<p class="hint">Пока никого</p>`}</div>

    <h2 class="label">Клубы</h2>
    <div class="kpis">
      <div class="kpi"><b>${n(s.clubs.total)}</b><span>клубов</span></div>
      <div class="kpi"><b>${n(s.clubs.members)}</b><span>человек в клубах</span></div>
      <div class="kpi"><b>${n(s.clubs.active_7d)}</b><span>писали за неделю</span></div>
      <div class="kpi"><b>${n(s.clubs.posts_7d)}</b><span>записей за неделю</span></div>
      <div class="kpi"><b>${n(s.clubs.comments_7d)}</b><span>комментариев</span></div>
      <div class="kpi"><b>${n(s.features.friends)}</b><span>пар друзей</span></div>
    </div>
    ${s.clubs.top.length ? `<div class="card">${rows(s.clubs.top.map((c) => ({ label: c.name, n: c.posts })))}<p class="hint" style="margin:8px 0 0">Записей за 7 дней</p></div>` : ""}

    <h2 class="label">Чем пользуются</h2>
    <div class="card">${rows([
      { label: "Напоминания о каждой паре", n: s.features.remind_all },
      { label: "Утренняя сводка", n: s.features.digest },
      { label: "Подписка на календарь", n: s.features.calendar },
      { label: "Огоньки сегодня", n: s.features.flames_today },
    ], s.users)}</div>
    ${s.unfinished ? `<p class="hint">Ещё ${n(s.unfinished)} открыли приложение, но не закончили регистрацию.</p>` : ""}`;
  app.querySelector("[data-go]")?.addEventListener("click", () => go("moder"));
  app.querySelector("[data-go-more]")?.addEventListener("click", () => go("more", "feedback"));
  app.querySelector("[data-filter]")?.addEventListener("click", () => { state.users = { ...state.users, filter: "banned", offset: 0 }; go("users"); });
}

/* ---------- Люди ---------- */

const USER_FILTERS = [["all", "Все"], ["new", "Новые"], ["active", "Активные"], ["inactive", "Не заходят"], ["banned", "Бан"],
  ["muted", "Без публикаций"], ["devices", "С телефоном"], ["unfinished", "Не закончили"]];

async function catalog() {
  state.catalog ||= await api("/catalog");
  return state.catalog;
}
function catalogSelects(sel, { faculty, course, group }) {
  const cat = state.catalog || [];
  const f = cat.find((x) => String(x.id) === String(faculty));
  const courses = f ? f.courses : [];
  const groups = f ? (course ? courses.filter((c) => String(c.course) === String(course)) : courses).flatMap((c) => c.groups) : [];
  return `<div class="selects">
    <select data-sel="faculty" aria-label="Направление"><option value="">Все направления</option>${cat.map((x) =>
      `<option value="${x.id}" ${String(x.id) === String(faculty) ? "selected" : ""}>${esc(x.name)}${x.is_master ? " (маг.)" : ""}</option>`).join("")}</select>
    <select data-sel="course" aria-label="Курс" ${f ? "" : "disabled"}><option value="">Все курсы</option>${courses.map((c) =>
      `<option value="${c.course}" ${String(c.course) === String(course) ? "selected" : ""}>${c.course} курс</option>`).join("")}</select>
    <select data-sel="group" aria-label="Группа" ${f ? "" : "disabled"}><option value="">Все группы</option>${groups.map((g) =>
      `<option value="${g.id}" ${String(g.id) === String(group) ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select>
  </div>`;
}
function bindCatalogSelects(root, target, redraw) {
  root.querySelectorAll("[data-sel]").forEach((s) => s.addEventListener("change", () => {
    target[s.dataset.sel] = s.value;
    if (s.dataset.sel === "faculty") { target.course = ""; target.group = ""; }
    if (s.dataset.sel === "course") target.group = "";
    redraw();
  }));
}
const personItem = (p, side = "") => `
  <li><button class="item" data-user="${p.tg_id}">
    ${avatar(p)}
    <span class="item-text"><b>${esc(p.name)}${badges(p)}</b><span>${p.username ? `@${esc(p.username)} · ` : ""}${esc(groupLine(p) || "без группы")}</span></span>
    <span class="item-side">${side}</span>
  </button></li>`;
function bindPeople(root) {
  root.querySelectorAll("[data-user]").forEach((b) => b.addEventListener("click", () => openUser(Number(b.dataset.user))));
}

async function renderUsers() {
  const u = state.users;
  try { await catalog(); } catch (e) { return failed("Люди", e, renderUsers); }
  app.innerHTML = `
    <h1 class="view-title">Люди</h1>
    <input class="search" type="search" id="q" placeholder="Имя, ник, @тег или ID" value="${esc(u.q)}" autocomplete="off">
    <div class="chips">${USER_FILTERS.map(([id, label]) => `<button class="chip" data-f="${id}" aria-pressed="${u.filter === id}">${label}</button>`).join("")}</div>
    ${catalogSelects("users", u)}
    <p class="hint" id="count"></p>
    <ul class="list" id="people"></ul>
    <button class="more" id="more" hidden>Показать ещё</button>`;
  let timer = 0;
  document.getElementById("q").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { u.q = e.target.value; u.offset = 0; loadPeople(); }, 300);
  });
  app.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => {
    haptic();
    u.filter = b.dataset.f;
    u.offset = 0;
    app.querySelectorAll("[data-f]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    loadPeople();
  }));
  bindCatalogSelects(app, u, () => { u.offset = 0; renderUsers(); });
  document.getElementById("more").addEventListener("click", () => { u.offset += 50; loadPeople(true); });
  loadPeople();
}
async function loadPeople(append = false) {
  const u = state.users;
  const list = document.getElementById("people");
  if (!append) list.innerHTML = '<li><i class="sk" style="margin:0"></i></li>';
  const params = new URLSearchParams({ q: u.q, filter: u.filter, offset: u.offset });
  for (const k of ["faculty", "course", "group"]) if (u[k]) params.set(k, u[k]);
  let r;
  try { r = await api(`/users?${params}`); } catch (e) { list.innerHTML = `<li class="item">${esc(errText(e))}</li>`; return; }
  if (state.tab !== "users") return;
  document.getElementById("count").textContent = `Найдено: ${n(r.total)}`;
  const html = r.users.map((p) => personItem(p, ago(p.seen_at))).join("");
  if (append) list.insertAdjacentHTML("beforeend", html); else list.innerHTML = html || `<li class="item"><span class="item-text"><span>Никого не нашлось</span></span></li>`;
  list.hidden = !list.innerHTML;
  document.getElementById("more").hidden = !r.more;
  bindPeople(list);
}

/* a person's card */
async function openUser(id) {
  haptic();
  openSheet('<i class="sk"></i><i class="sk"></i>');
  let p;
  try { p = await api(`/users/${id}`); } catch (e) { openSheet(`<div class="note"><strong>Не открылось</strong>${esc(errText(e))}</div>`); return; }
  drawUser(p);
}
function restrictionStatus(p) {
  const term = (r) => r.until ? `до ${when(r.until, true)}` : "бессрочно";
  return (p.ban ? `<div class="status red"><b>Заблокирован ${term(p.ban)}</b>${p.ban.reason ? esc(p.ban.reason) : "Без причины"}</div>` : "")
    + (p.mute ? `<div class="status yellow"><b>Публикации запрещены ${term(p.mute)}</b>${p.mute.reason ? esc(p.mute.reason) : "Без причины"}</div>` : "");
}
function drawUser(p) {
  if (p.gone) {
    openSheet(`<div class="hero"><span class="avatar big">?</span><div><h2>Аккаунт удалён</h2><p>ID ${p.tg_id}</p></div></div>
      ${restrictionStatus(p)}
      ${p.ban ? `<button class="btn secondary" data-lift="ban">Снять бан</button>` : ""}`, (root) => bindUser(root, p));
    return;
  }
  const c = p.counts, s = p.settings;
  openSheet(`
    <div class="hero">${avatar(p, "big")}<div>
      <h2>${esc(p.name)}${badges(p)}</h2>
      <p>${p.username ? `<a class="link" href="https://t.me/${esc(p.username)}" data-out>@${esc(p.username)}</a> · ` : ""}ID ${p.tg_id}</p>
      <p>${esc(groupLine(p) || "без группы")}</p>
    </div></div>
    ${restrictionStatus(p)}

    <div class="card"><ul class="facts">
      <li><span>Имя в приложении</span><b>${esc(p.real_name || "—")}</b></li>
      <li><span>Ник</span><b>${esc(p.nickname || "—")}</b></li>
      <li><span>Имя в Telegram</span><b>${esc(p.tg_name || "—")}</b></li>
      ${p.bio ? `<li><span>О себе</span><b>${esc(p.bio)}</b></li>` : ""}
      <li><span>Зарегистрировался</span><b>${when(p.created_at, true)}</b></li>
      <li><span>Последний раз</span><b>${ago(p.seen_at)}</b></li>
      <li><span>Согласие</span><b>${p.consent_at ? when(p.consent_at, true) : "нет"}</b></li>
    </ul></div>

    <h3 class="label">Заходил за 30 дней · ${p.activity.filter(Boolean).length} дн.</h3>
    <div class="heat">${p.activity.map((on) => `<i class="${on ? "on" : ""}"></i>`).join("")}</div>

    <div class="kpis">
      <div class="kpi"><b>${n(c.friends)}</b><span>друзей</span></div>
      <div class="kpi"><b>${n(c.posts)}</b><span>записей</span></div>
      <div class="kpi"><b>${n(c.comments)}</b><span>комментариев</span></div>
      <div class="kpi"><b>${n(c.reminders)}</b><span>напоминаний</span></div>
      <div class="kpi ${c.reports_on ? "alert" : ""}"><b>${n(c.reports_on)}</b><span>жалоб на него</span></div>
      <div class="kpi"><b>${n(c.reports_by)}</b><span>его жалоб</span></div>
    </div>
    <div class="card"><ul class="facts">
      <li><span>Напоминания о каждой паре</span><b>${s.remind_all ? `да, за ${s.remind_lead} мин` : "нет"}</b></li>
      <li><span>Утренняя сводка</span><b>${s.digest_time || "нет"}</b></li>
      <li><span>Календарь</span><b>${s.calendar ? "подписан" : "нет"}</b></li>
      <li><span>Приложение на телефон</span><b>${{ sent: "предложено", declined: "отказался", opened: "открыл ссылку", installed: "установил" }[s.app_offer] || "—"}</b></li>
    </ul></div>

    <h3 class="label">Ограничения</h3>
    ${p.ban ? `<button class="btn secondary" data-lift="ban">Снять бан</button>` : `<button class="btn danger" data-restrict="ban">Заблокировать</button>`}
    ${p.mute ? `<button class="btn secondary" data-lift="mute">Снять запрет публикаций</button>` : `<button class="btn secondary" data-restrict="mute">Запретить публикации</button>`}
    <p class="hint">Бан закрывает приложение и бота. Запрет публикаций оставляет расписание, но не даёт писать, создавать клубы и менять профиль.</p>

    <h3 class="label">Профиль</h3>
    <div class="row">
      <button class="btn secondary" data-reset="nickname" ${p.nickname ? "" : "disabled"}>Сбросить ник</button>
      <button class="btn secondary" data-reset="bio" ${p.bio ? "" : "disabled"}>Удалить «о себе»</button>
    </div>
    <button class="btn secondary" data-reset="avatar" ${p.custom_avatar ? "" : "disabled"}>Удалить загруженное фото</button>

    <h3 class="label">Написать через бота</h3>
    <textarea id="msg" maxlength="3500" placeholder="Сообщение придёт от бота приложения"></textarea>
    <button class="btn" id="send-msg">Отправить</button>

    ${p.clubs.length ? `<h3 class="label">Клубы</h3><ul class="list">${p.clubs.map((cl) => `<li><button class="item" data-club="${cl.id}">
      <span class="item-text"><b>${esc(cl.name)}</b><span>${{ owner: "владелец", admin: "админ", member: "участник" }[cl.role]}</span></span></button></li>`).join("")}</ul>` : ""}
    ${p.posts.length ? `<h3 class="label">Записи</h3><ul class="list">${p.posts.map((x) => `<li class="entry">
      <div class="entry-body">${esc(x.body || "[фото]")}</div>
      <div class="entry-foot"><span>${esc(x.club)} · ${when(x.created_at)}${x.public ? " · видна всем" : ""}</span><span class="grow"></span>
      <button class="link danger" data-del-post="${x.id}">Удалить</button></div></li>`).join("")}</ul>` : ""}
    ${p.comments.length ? `<h3 class="label">Комментарии</h3><ul class="list">${p.comments.map((x) => `<li class="entry">
      <div class="entry-body">${esc(x.body)}</div>
      <div class="entry-foot"><span>${esc(x.club)} · ${when(x.created_at)}</span><span class="grow"></span>
      <button class="link danger" data-del-comment="${x.id}">Удалить</button></div></li>`).join("")}</ul>` : ""}
    ${p.swearing.length ? `<h3 class="label">Мат</h3><ul class="list">${p.swearing.map((x) => `<li class="entry">
      <div class="entry-body">${esc(x.body)}</div><div class="entry-foot"><span>${PLACE[x.place] || x.place} · ${when(x.created_at)}${x.blocked ? " · не пропущено" : ""}</span></div></li>`).join("")}</ul>` : ""}
    ${p.devices.length ? `<h3 class="label">Устройства</h3><div class="card"><ul class="facts">${p.devices.map((d) =>
      `<li><span>${esc(d.name)}</span><b>${ago(d.seen_at)}</b></li>`).join("")}</ul></div>` : ""}`, (root) => bindUser(root, p));
}
function bindUser(root, p) {
  const id = p.tg_id;
  root.querySelectorAll("[data-out]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    if (inTelegram) tg.openTelegramLink(a.href); else window.open(a.href, "_blank");
  }));
  root.querySelectorAll("[data-restrict]").forEach((b) => b.addEventListener("click", () => restrictForm(p, b.dataset.restrict)));
  root.querySelectorAll("[data-lift]").forEach((b) => b.addEventListener("click", async () => {
    const r = await act(b, () => del(`/users/${id}/restrict/${b.dataset.lift}`));
    if (r) { drawUser(r); refreshList(); }
  }));
  root.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirmTap(b)) return;
    const r = await act(b, () => post(`/users/${id}/reset`, { field: b.dataset.reset }));
    if (r) drawUser(r);
  }));
  root.querySelector("#send-msg")?.addEventListener("click", async (e) => {
    const text = root.querySelector("#msg").value.trim();
    if (!text) return;
    const r = await act(e.currentTarget, () => post(`/users/${id}/message`, { text }), "Отправлено");
    if (r) root.querySelector("#msg").value = "";
  });
  root.querySelectorAll("[data-club]").forEach((b) => b.addEventListener("click", () => openClub(Number(b.dataset.club))));
  root.querySelectorAll("[data-del-post]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirmTap(b, "Удалить?")) return;
    if (await act(b, () => del(`/posts/${b.dataset.delPost}`))) b.closest("li").remove();
  }));
  root.querySelectorAll("[data-del-comment]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirmTap(b, "Удалить?")) return;
    if (await act(b, () => del(`/comments/${b.dataset.delComment}`))) b.closest("li").remove();
  }));
}
function restrictForm(p, kind) {
  const terms = [[1, "1 день"], [3, "3 дня"], [7, "Неделя"], [30, "Месяц"], [0, "Бессрочно"]];
  let days = kind === "ban" ? 7 : 3;
  openSheet(`
    <div class="hero">${avatar(p)}<div><h2>${kind === "ban" ? "Заблокировать" : "Запретить публикации"}</h2><p>${esc(p.name)}</p></div></div>
    <div class="field"><span>Срок</span><div class="chips" style="margin:0;padding:0;flex-wrap:wrap">${terms.map(([d, l]) =>
      `<button class="chip" data-days="${d}" aria-pressed="${d === days}">${l}</button>`).join("")}</div></div>
    <label class="field"><span>Причина (её увидит пользователь)</span><input type="text" id="reason" maxlength="300" placeholder="Например, оскорбления в комментариях"></label>
    <button class="toggle" id="notify" role="switch" aria-checked="true" style="padding:14px 4px">
      <span>Сообщить через бота<small>Пользователь получит сообщение с причиной и сроком</small></span><span class="switch"></span></button>
    <button class="btn ${kind === "ban" ? "danger" : ""}" id="go">${kind === "ban" ? "Заблокировать" : "Запретить"}</button>
    <button class="btn secondary" id="cancel">Отмена</button>`, (root) => {
    root.querySelectorAll("[data-days]").forEach((b) => b.addEventListener("click", () => {
      days = Number(b.dataset.days);
      root.querySelectorAll("[data-days]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    }));
    const notify = root.querySelector("#notify");
    notify.addEventListener("click", () => notify.setAttribute("aria-checked", String(notify.getAttribute("aria-checked") !== "true")));
    root.querySelector("#cancel").addEventListener("click", () => openUser(p.tg_id));
    root.querySelector("#go").addEventListener("click", async (e) => {
      const r = await act(e.currentTarget, () => post(`/users/${p.tg_id}/restrict`, {
        kind, days: days || null, reason: root.querySelector("#reason").value, notify: notify.getAttribute("aria-checked") === "true" }));
      if (r) { drawUser(r); refreshList(); }
    });
  });
}
/** after an action in a sheet, the list behind it shows the new state */
function refreshList() {
  if (state.tab === "users") loadPeople();
}

/* ---------- Клубы ---------- */

const CATS = { science: "Наука", it: "IT", sport: "Спорт", art: "Творчество", music: "Музыка", games: "Игры", language: "Языки", volunteer: "Волонтёрство", other: "Другое" };
const VIS = { public: "открытый", friends: "для друзей владельца", closed: "по заявке", invite: "по приглашению" };
const clubTags = (c) => (c.official ? `<span class="tag blue">официальный</span>` : "") + (c.frozen ? `<span class="tag yellow">заморожен</span>` : "")
  + (c.reports ? `<span class="tag red">жалоб: ${c.reports}</span>` : "");

async function renderClubs() {
  loading("Клубы");
  let list;
  try { list = await api("/clubs"); } catch (e) { return failed("Клубы", e, renderClubs); }
  if (state.tab !== "clubs") return;
  app.innerHTML = `
    <h1 class="view-title">Клубы</h1>
    <p class="view-sub">${n(list.length)} клубов · сверху самые активные за неделю</p>
    <ul class="list">${list.map((c) => `<li><button class="item" data-club="${c.id}">
      ${avatar(c, "club")}
      <span class="item-text"><b>${esc(c.name)}${clubTags(c)}</b><span>${n(c.members)} участн. · ${n(c.posts)} записей${c.posts_7d ? ` · +${c.posts_7d} за неделю` : ""} · ${c.owner ? esc(c.owner.name) : "без владельца"}</span></span>
    </button></li>`).join("") || `<li class="item"><span class="item-text"><span>Клубов пока нет</span></span></li>`}</ul>`;
  app.querySelectorAll("[data-club]").forEach((b) => b.addEventListener("click", () => openClub(Number(b.dataset.club))));
}
async function openClub(id) {
  haptic();
  openSheet('<i class="sk"></i><i class="sk"></i>');
  let c;
  try { c = await api(`/clubs/${id}`); } catch (e) { openSheet(`<div class="note"><strong>Не открылось</strong>${esc(errText(e))}</div>`); return; }
  drawClub(c);
}
function drawClub(c) {
  openSheet(`
    <div class="hero">${avatar(c, "big club")}<div>
      <h2>${esc(c.name)}${clubTags(c)}</h2>
      <p>${CATS[c.category] || c.category} · ${VIS[c.visibility] || c.visibility} · с ${when(c.created_at, true)}</p>
    </div></div>
    ${c.about ? `<p class="entry-body">${esc(c.about)}</p>` : ""}
    <div class="kpis">
      <div class="kpi"><b>${n(c.members)}</b><span>участников</span></div>
      <div class="kpi"><b>${n(c.posts)}</b><span>записей</span></div>
      <div class="kpi"><b>${n(c.posts_7d)}</b><span>за неделю</span></div>
    </div>
    <div class="card"><ul class="facts">
      <li><span>Владелец</span><b>${c.owner ? `${esc(c.owner.name)}${c.owner.username ? ` · @${esc(c.owner.username)}` : ""}` : "—"}</b></li>
      <li><span>Последняя запись</span><b>${c.last_post ? ago(c.last_post) : "не было"}</b></li>
      ${c.chat_url ? `<li><span>Чат</span><b>${esc(c.chat_url)}</b></li>` : ""}
    </ul></div>

    <h3 class="label">Управление</h3>
    <ul class="list">
      <li><button class="toggle" data-flag="official" role="switch" aria-checked="${c.official}"><span>Официальный клуб<small>Синяя галочка у названия в приложении</small></span><span class="switch"></span></button></li>
      <li><button class="toggle" data-flag="frozen" role="switch" aria-checked="${c.frozen}"><span>Заморозить<small>Нельзя писать, комментировать и вступать; всё остаётся на месте</small></span><span class="switch"></span></button></li>
    </ul>
    <label class="field"><span>Название</span><input type="text" id="club-name" maxlength="48" value="${esc(c.name)}"></label>
    <button class="btn secondary" id="rename">Переименовать</button>
    ${c.member_list.length > 1 ? `<label class="field"><span>Передать клуб</span><select id="new-owner">${c.member_list.filter((m) => m.role !== "owner").map((m) =>
      `<option value="${m.tg_id}">${esc(m.name)} · ${m.role === "admin" ? "админ" : "участник"}</option>`).join("")}</select></label>
      <button class="btn secondary" id="transfer">Сделать владельцем</button>` : ""}
    <button class="btn danger" id="delete-club">Удалить клуб полностью</button>
    <p class="hint">Удаляются все записи, фото, комментарии и участники. Это не отменить.</p>

    <h3 class="label">Участники · ${c.member_list.length}</h3>
    <ul class="list">${c.member_list.map((m) => personItem(m, { owner: "владелец", admin: "админ", member: "" }[m.role])).join("")}</ul>
    ${c.post_list.length ? `<h3 class="label">Последние записи</h3><ul class="list">${c.post_list.map((x) => `<li class="entry">
      ${x.body ? `<div class="entry-body" style="margin-top:0">${esc(x.body)}</div>` : ""}
      ${x.photo_url ? `<img class="entry-photo" src="${esc(x.photo_url)}" alt="" loading="lazy">` : ""}
      <div class="entry-foot"><span>${esc(x.author)} · ${when(x.created_at)} · комм. ${x.comments}${x.public ? " · видна всем" : ""}</span><span class="grow"></span>
      <button class="link danger" data-del-post="${x.id}">Удалить</button></div></li>`).join("")}</ul>` : ""}`, (root) => {
    root.querySelectorAll("[data-flag]").forEach((b) => b.addEventListener("click", async () => {
      const on = b.getAttribute("aria-checked") !== "true";
      const r = await act(b, () => post(`/clubs/${c.id}`, { [b.dataset.flag]: on }));
      if (r) { drawClub(r); if (state.tab === "clubs") renderClubs(); }
    }));
    root.querySelector("#rename").addEventListener("click", async (e) => {
      const r = await act(e.currentTarget, () => post(`/clubs/${c.id}`, { name: root.querySelector("#club-name").value }));
      if (r) { drawClub(r); if (state.tab === "clubs") renderClubs(); }
    });
    root.querySelector("#transfer")?.addEventListener("click", async (e) => {
      if (!confirmTap(e.currentTarget)) return;
      const r = await act(e.currentTarget, () => post(`/clubs/${c.id}/owner`, { tg_id: Number(root.querySelector("#new-owner").value) }));
      if (r) drawClub(r);
    });
    root.querySelector("#delete-club").addEventListener("click", async (e) => {
      if (!confirmTap(e.currentTarget, `Удалить «${c.name}» навсегда? Нажмите ещё раз`)) return;
      if (await act(e.currentTarget, () => del(`/clubs/${c.id}`))) { closeSheet(); if (state.tab === "clubs") renderClubs(); }
    });
    bindPeople(root);
    root.querySelectorAll("[data-del-post]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirmTap(b, "Удалить?")) return;
      if (await act(b, () => del(`/posts/${b.dataset.delPost}`))) b.closest("li").remove();
    }));
  });
}

/* ---------- Модерация ---------- */

const MODER = [["reports", "Жалобы"], ["swearing", "Мат"], ["posts", "Записи"], ["comments", "Комментарии"]];
async function renderModeration() {
  app.innerHTML = `
    <h1 class="view-title">Модерация</h1>
    <div class="chips">${MODER.map(([id, label]) => `<button class="chip" data-m="${id}" aria-pressed="${state.moder === id}">${label}</button>`).join("")}</div>
    <div id="moder"><i class="sk"></i><i class="sk"></i></div>`;
  app.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => { haptic(); state.moder = b.dataset.m; renderModeration(); }));
  const host = document.getElementById("moder");
  try {
    if (state.moder === "reports") await drawReports(host);
    else if (state.moder === "swearing") await drawSwearing(host);
    else await drawContent(host, state.moder);
  } catch (e) {
    host.innerHTML = `<div class="note"><strong>Не загрузилось</strong>${esc(errText(e))}</div>`;
  }
}
const who = (p) => p ? `<button class="entry-head" data-user="${p.tg_id}" style="width:100%;text-align:left">${avatar(p)}
  <span class="entry-who"><b>${esc(p.name)}${badges(p)}</b>${p.username ? `@${esc(p.username)} · ` : ""}${esc(p.group || "")}</span></button>`
  : `<div class="entry-head"><span class="avatar">?</span><span class="entry-who"><b>Удалённый аккаунт</b></span></div>`;

async function drawReports(host) {
  const list = await api(`/reports?status=${state.reportStatus}`);
  if (state.tab !== "moder") return;
  host.innerHTML = `
    <div class="chips" style="margin-top:8px">
      <button class="chip" data-rs="open" aria-pressed="${state.reportStatus === "open"}">Ждут решения</button>
      <button class="chip" data-rs="all" aria-pressed="${state.reportStatus === "all"}">Все</button>
    </div>
    ${list.length ? `<ul class="list">${list.map((r) => `<li class="entry" data-report="${r.id}">
      <div class="entry-foot" style="margin-top:0"><span class="tag ${r.status === "open" ? "red" : ""}" style="margin:0">${KIND[r.kind]}</span>
        <b style="color:var(--text)">${esc(r.reason)}</b><span class="grow"></span><span>${ago(r.created_at)}</span></div>
      ${r.note ? `<p class="entry-body">«${esc(r.note)}»</p>` : ""}
      <p class="entry-body quote">${esc(r.snapshot || "—")}${r.exists ? "" : "\n\n[уже удалено]"}</p>
      ${r.club ? `<p class="hint" style="margin:8px 0 0">Клуб: <button class="link" data-club="${r.club.id}">${esc(r.club.name)}</button></p>` : ""}
      <p class="hint" style="margin:10px 0 4px">${r.kind === "user" ? "На кого" : r.kind === "club" ? "Владелец" : "Автор"}</p>
      ${who(r.author)}
      <p class="hint" style="margin:10px 0 4px">Пожаловался</p>
      ${who(r.reporter)}
      ${r.status === "open" ? `<div class="entry-actions">
        ${r.exists && (r.kind === "post" || r.kind === "comment") ? `<button class="btn small danger" data-remove="${r.kind}:${r.target}">Удалить ${r.kind === "post" ? "запись" : "комментарий"}</button>` : ""}
        ${r.author ? `<button class="btn small secondary" data-user="${r.author.tg_id}">Наказать автора</button>` : ""}
        <button class="btn small secondary" data-resolve="done">Решено</button>
        <button class="btn small secondary" data-resolve="dismissed">Отклонить</button>
      </div>` : `<p class="hint">${r.status === "done" ? "Решено" : "Отклонено"} ${when(r.resolved_at)}</p>`}
    </li>`).join("")}</ul>` : `<div class="note"><strong>Жалоб нет</strong>Когда кто-нибудь нажмёт «Пожаловаться» в приложении, жалоба появится здесь, а бот панели пришлёт уведомление.</div>`}`;
  host.querySelectorAll("[data-rs]").forEach((b) => b.addEventListener("click", () => { state.reportStatus = b.dataset.rs; renderModeration(); }));
  bindPeople(host);
  host.querySelectorAll("[data-club]").forEach((b) => b.addEventListener("click", () => openClub(Number(b.dataset.club))));
  host.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirmTap(b, "Удалить?")) return;
    const [kind, id] = b.dataset.remove.split(":");
    if (await act(b, () => del(`/${kind === "post" ? "posts" : "comments"}/${id}`))) { renderModeration(); refreshDots(); }
  }));
  host.querySelectorAll("[data-resolve]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest("[data-report]").dataset.report;
    if (await act(b, () => post(`/reports/${id}`, { status: b.dataset.resolve }))) { renderModeration(); refreshDots(); }
  }));
}
async function drawSwearing(host) {
  const list = await api("/profanity");
  if (state.tab !== "moder") return;
  host.innerHTML = list.length ? `<p class="hint">Всё, где фильтр нашёл мат. Открытые записи с матом не публикуются, остальное видят только участники клуба или друзья.</p>
    <ul class="list">${list.map((x) => `<li class="entry">${who(x.who)}
      <p class="entry-body quote">${esc(x.body)}</p>
      <div class="entry-foot"><span>${PLACE[x.place] || x.place} · ${when(x.created_at)}${x.blocked ? " · не пропущено" : ""}</span></div></li>`).join("")}</ul>`
    : `<div class="note"><strong>Чисто</strong>Мат пока нигде не попадался.</div>`;
  bindPeople(host);
}
async function drawContent(host, kind, before = null) {
  const r = await api(`/content?kind=${kind}${before ? `&before=${before}` : ""}`);
  if (state.tab !== "moder" || state.moder !== kind) return;
  const html = r.items.map((x) => `<li class="entry">${who(x.who)}
    ${x.body ? `<p class="entry-body">${esc(x.body)}</p>` : ""}
    ${x.photo_url ? `<img class="entry-photo" src="${esc(x.photo_url)}" alt="" loading="lazy">` : ""}
    <div class="entry-foot"><button class="link" data-club="${x.club_id}">${esc(x.club)}</button><span>${when(x.created_at)}${x.public ? " · видна всем" : ""}</span>
      <span class="grow"></span><button class="link danger" data-del="${x.id}">Удалить</button></div></li>`).join("");
  if (!before) host.innerHTML = r.items.length ? `<ul class="list" id="content">${html}</ul><button class="more" id="more-content" ${r.more ? "" : "hidden"}>Показать ещё</button>`
    : `<div class="note"><strong>Пусто</strong>${kind === "posts" ? "Записей" : "Комментариев"} пока нет.</div>`;
  else { host.querySelector("#content").insertAdjacentHTML("beforeend", html); host.querySelector("#more-content").hidden = !r.more; }
  const last = r.items.at(-1)?.id;
  const more = host.querySelector("#more-content");
  if (more) more.onclick = () => drawContent(host, kind, last);
  bindPeople(host);
  host.querySelectorAll("[data-club]").forEach((b) => { b.onclick = () => openClub(Number(b.dataset.club)); });
  host.querySelectorAll("[data-del]").forEach((b) => { b.onclick = async () => {
    if (!confirmTap(b, "Удалить?")) return;
    if (await act(b, () => del(`/${kind}/${b.dataset.del}`))) b.closest("li").remove();
  }; });
}

/* ---------- Ещё ---------- */

async function renderMore() {
  const me = await refreshDots();
  app.innerHTML = `
    <h1 class="view-title">Ещё</h1>
    <ul class="list">${Object.entries(MORE).map(([id, [title, sub]]) => `<li><button class="item" data-more="${id}">
      <span class="item-text"><b>${title}${id === "feedback" && me?.unread ? `<span class="tag red">${me.unread}</span>` : ""}</b><span>${sub}</span></span>
      <span class="item-side">›</span></button></li>`).join("")}</ul>
    <p class="hint">Вы вошли как ${esc(me?.name || "администратор")}${me?.username ? ` (@${esc(me.username)})` : ""}. Панель видна только этому аккаунту.</p>`;
  app.querySelectorAll("[data-more]").forEach((b) => b.addEventListener("click", () => { haptic(); go("more", b.dataset.more); }));
}

/* broadcasts */
const BSTATUS = { scheduled: ["запланирована", "blue"], sending: ["отправляется", "yellow"], done: ["отправлена", "green"], cancelled: ["отменена", ""] };
const draftSeg = { faculty: "", course: "", group: "", active: "", inactive: "" };
async function renderBroadcasts() {
  loading("Рассылки");
  let list;
  try { [list] = await Promise.all([api("/broadcasts"), catalog()]); } catch (e) { return failed("Рассылки", e, renderBroadcasts); }
  if (state.sub !== "broadcasts") return;
  const keep = { text: document.getElementById("b-text")?.value || "", at: document.getElementById("b-at")?.value || "" };
  app.innerHTML = `${backToMore()}
    <h1 class="view-title">Рассылки</h1>
    <p class="view-sub">Сообщение приходит от бота приложения. Заблокированным не отправляется.</p>
    <label class="field"><span>Текст</span><textarea id="b-text" maxlength="3500" rows="5" placeholder="Например, вышло обновление: теперь…">${esc(keep.text)}</textarea></label>
    <div class="field"><span>Кому</span>${catalogSelects("b", draftSeg)}
      <div class="selects" style="grid-template-columns:1fr 1fr">
        <select id="b-active"><option value="">Любая активность</option>${[1, 7, 30].map((d) => `<option value="${d}" ${String(draftSeg.active) === String(d) ? "selected" : ""}>Заходили за ${d} дн.</option>`).join("")}</select>
        <select id="b-inactive"><option value="">—</option>${[7, 14, 30].map((d) => `<option value="${d}" ${String(draftSeg.inactive) === String(d) ? "selected" : ""}>Не заходили ${d} дн.</option>`).join("")}</select>
      </div></div>
    <label class="field"><span>Когда (по Москве; пусто — сразу)</span><input type="datetime-local" id="b-at" value="${esc(keep.at)}"></label>
    <button class="toggle" id="b-button" role="switch" aria-checked="true" style="padding:14px 4px"><span>Кнопка «Открыть расписание»<small>Под сообщением</small></span><span class="switch"></span></button>
    <p class="hint" id="b-count">Считаем получателей…</p>
    <button class="btn" id="b-send" disabled>Отправить</button>

    <h2 class="label">История</h2>
    ${list.length ? `<ul class="list">${list.map((b) => `<li class="entry">
      <div class="entry-foot" style="margin-top:0"><span class="tag ${BSTATUS[b.status][1]}" style="margin:0">${BSTATUS[b.status][0]}</span><span>#${b.id} · ${esc(b.segment_text)}</span></div>
      <p class="entry-body">${esc(b.body)}</p>
      <div class="entry-foot"><span>${b.status === "scheduled" ? `отправка ${when(b.send_at)}` : `доставлено ${n(b.sent)} из ${n(b.total)}${b.failed ? `, не дошло ${n(b.failed)}` : ""}`}</span>
        <span class="grow"></span>${["scheduled", "sending"].includes(b.status) ? `<button class="link danger" data-cancel="${b.id}">Отменить</button>` : ""}</div>
    </li>`).join("")}</ul>` : `<p class="hint">Рассылок ещё не было.</p>`}`;
  bindBack();
  const seg = () => ({ faculty_id: draftSeg.faculty || null, course: draftSeg.course || null, group_id: draftSeg.group || null,
    active: draftSeg.active || null, inactive: draftSeg.inactive || null });
  const send = document.getElementById("b-send");
  let count = 0;
  const recount = async () => {
    try {
      const r = await post("/broadcasts", { body: "", segment: seg(), dry_run: true });
      count = r.count;
      document.getElementById("b-count").textContent = `${r.segment_text}: ${n(r.count)} получателей`;
      send.textContent = r.count ? `Отправить ${n(r.count)} получателям` : "Некому отправлять";
      send.disabled = !r.count;
    } catch (e) { document.getElementById("b-count").textContent = errText(e); }
  };
  bindCatalogSelects(app, draftSeg, () => renderBroadcasts());
  document.getElementById("b-active").addEventListener("change", (e) => { draftSeg.active = e.target.value; recount(); });
  document.getElementById("b-inactive").addEventListener("change", (e) => { draftSeg.inactive = e.target.value; recount(); });
  const btn = document.getElementById("b-button");
  btn.addEventListener("click", () => btn.setAttribute("aria-checked", String(btn.getAttribute("aria-checked") !== "true")));
  send.addEventListener("click", async () => {
    const text = document.getElementById("b-text").value.trim();
    if (!text) { document.getElementById("b-text").focus(); return; }
    if (!confirmTap(send, `Точно отправить ${n(count)} людям? Нажмите ещё раз`)) return;
    const r = await act(send, () => post("/broadcasts", { body: text, segment: seg(), button: btn.getAttribute("aria-checked") === "true",
      send_at: document.getElementById("b-at").value || null }));
    if (r) { document.getElementById("b-text").value = ""; document.getElementById("b-at").value = ""; renderBroadcasts(); }
  });
  app.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirmTap(b, "Отменить?")) return;
    if (await act(b, () => post(`/broadcasts/${b.dataset.cancel}/cancel`))) renderBroadcasts();
  }));
  recount();
}

/* messages to the developer */
async function renderFeedback() {
  loading("Сообщения");
  let list;
  try { list = await api("/feedback"); } catch (e) { return failed("Сообщения", e, renderFeedback); }
  if (state.sub !== "feedback") return;
  refreshDots();
  app.innerHTML = `${backToMore()}
    <h1 class="view-title">Сообщения</h1>
    <p class="view-sub">«Написать разработчику» в настройках приложения</p>
    ${list.length ? `<ul class="list">${list.map((f) => `<li class="entry" data-fb="${f.id}">
      ${who(f.who)}
      <p class="entry-body">${esc(f.body)}</p>
      <div class="entry-foot"><span>${when(f.created_at)}</span>${f.read_at ? "" : `<span class="tag red" style="margin:0">новое</span>`}</div>
      ${f.reply ? `<div class="reply"><small>Ваш ответ · ${when(f.replied_at)}</small>${esc(f.reply)}</div>` : `
        <textarea class="fb-text" maxlength="3500" rows="3" placeholder="Ответ придёт от бота приложения" style="margin-top:10px"></textarea>
        <button class="btn small" data-reply style="margin-top:8px">Ответить</button>`}
    </li>`).join("")}</ul>` : `<div class="note"><strong>Пока пусто</strong>Сообщения из приложения появятся здесь, а бот панели пришлёт уведомление.</div>`}`;
  bindBack();
  bindPeople(app);
  app.querySelectorAll("[data-reply]").forEach((b) => b.addEventListener("click", async () => {
    const li = b.closest("[data-fb]");
    const text = li.querySelector(".fb-text").value.trim();
    if (!text) return;
    if (await act(b, () => post(`/feedback/${li.dataset.fb}/reply`, { text }))) renderFeedback();
  }));
}

/* schedule */
async function renderSchedule() {
  loading("Расписание");
  let s;
  try { s = await api("/schedule"); } catch (e) { return failed("Расписание", e, renderSchedule); }
  if (state.sub !== "schedule") return;
  const broken = s.groups.filter((g) => g.sync_error);
  const groupItem = (g) => `<li class="entry">
    <div class="entry-foot" style="margin-top:0;color:var(--text)"><b>${esc(g.name)}</b><span style="color:var(--faint)">${g.course} курс${g.master ? " маг." : ""} · ${esc(g.faculty)}</span></div>
    <div class="entry-foot"><span>обновлено ${ago(g.synced_at)} · пар впереди: ${n(g.lessons)} · студентов: ${n(g.students)}</span><span class="grow"></span>
      <button class="btn small secondary" data-sync="${g.id}">Обновить</button></div>
    ${g.sync_error ? `<p class="err">${esc(g.sync_error)}</p>` : ""}</li>`;
  app.innerHTML = `${backToMore()}
    <h1 class="view-title">Расписание</h1>
    <div class="card"><ul class="facts">
      <li><span>Все группы обновлены</span><b>${ago(s.all_synced_at)}</b></li>
      <li><span>Список групп с сайта</span><b>${ago(s.catalog_synced_at)}</b></li>
      <li><span>Групп с ошибкой</span><b style="color:${broken.length ? "var(--red)" : "inherit"}">${broken.length}</b></li>
    </ul></div>
    <button class="btn" id="sync-all" ${s.syncing ? "disabled" : ""}>${s.syncing ? "Обновляем все группы…" : "Обновить все группы сейчас"}</button>
    <p class="hint">Само обновляется раз в 6 часов, а группа — когда её студент открывает приложение, если с прошлого раза прошло 2 часа.</p>

    <h2 class="label">Изменения расписания</h2>
    ${s.changes.length ? `<ul class="list">${s.changes.map((c) => `<li class="entry">
      <div class="entry-foot" style="margin-top:0"><b style="color:var(--text)">${esc(c.group_name || c.group_id)}</b><span>${when(c.at)}</span><span class="grow"></span>
        <span class="tag green" style="margin:0">+${c.added}</span><span class="tag red" style="margin:0">−${c.removed}</span></div>
      <ul class="details">${c.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></li>`).join("")}</ul>`
      : `<p class="hint">Изменений пока не было: журнал ведётся с этой версии.</p>`}

    <h2 class="label">Группы · ${s.groups.length}</h2>
    <ul class="list">${s.groups.map(groupItem).join("")}</ul>`;
  bindBack();
  document.getElementById("sync-all").addEventListener("click", async (e) => {
    if (await act(e.currentTarget, () => post("/schedule/sync", {}), "Обновляем все группы…")) setTimeout(() => state.sub === "schedule" && renderSchedule(), 20000);
  });
  app.querySelectorAll("[data-sync]").forEach((b) => b.addEventListener("click", async () => {
    b.textContent = "Обновляем…";
    if (await act(b, () => post("/schedule/sync", { group_id: Number(b.dataset.sync) }), "Готово")) setTimeout(() => state.sub === "schedule" && renderSchedule(), 800);
    else b.textContent = "Обновить";
  }));
}

/* server */
async function renderServer() {
  loading("Сервер");
  let s;
  try { s = await api("/server"); } catch (e) { return failed("Сервер", e, renderServer); }
  if (state.sub !== "server") return;
  const usedDisk = s.disk.total - s.disk.free;
  const usedMem = s.memory.total && s.memory.available != null ? s.memory.total - s.memory.available : null;
  const lastBackup = s.backups[0];
  app.innerHTML = `${backToMore()}
    <h1 class="view-title">Сервер</h1>
    <div class="kpis">
      <div class="kpi ${s.disk.free < 2 * 1024 ** 3 ? "alert" : ""}"><b>${bytes(s.disk.free)}</b><span>свободно на диске из ${bytes(s.disk.total)}</span></div>
      <div class="kpi"><b>${usedMem != null ? `${pct(usedMem, s.memory.total)}%` : "—"}</b><span>памяти занято${s.memory.total ? ` из ${bytes(s.memory.total)}` : ""}</span></div>
      <div class="kpi"><b>${s.load ? s.load[0].toFixed(2) : "—"}</b><span>нагрузка (1 мин)</span></div>
      <div class="kpi"><b>${bytes(s.db_size)}</b><span>база данных</span></div>
      <div class="kpi"><b>${bytes(s.avatars.bytes + s.posts.bytes)}</b><span>фото (${n(s.avatars.files + s.posts.files)} файлов)</span></div>
      <div class="kpi ${lastBackup ? "" : "alert"}"><b>${lastBackup ? ago(lastBackup.at) : "нет"}</b><span>последняя копия базы</span></div>
    </div>
    <div class="card"><ul class="facts">
      <li><span>Версия приложения</span><b>${esc(s.version || "—")}</b></li>
      <li><span>Сервер приложения работает</span><b>${duration(s.app_uptime)}</b></li>
      <li><span>Машина работает</span><b>${duration(s.system_uptime)}</b></li>
      <li><span>Бот приложения</span><b style="color:${s.bot ? "var(--green)" : "var(--red)"}">${s.bot ? `@${esc(s.bot_name)} работает` : "не запущен"}</b></li>
      <li><span>Бот панели</span><b style="color:${s.crm_bot ? "var(--green)" : "var(--red)"}">${s.crm_bot ? "работает" : "не запущен"}</b></li>
      <li><span>Групп с ошибкой обновления</span><b>${s.broken_groups}</b></li>
      <li><span>Диск занят</span><b>${pct(usedDisk, s.disk.total)}%</b></li>
      <li><span>Python</span><b>${esc(s.python)}</b></li>
    </ul></div>
    <h2 class="label">Резервные копии · хранятся 14 последних</h2>
    <div class="card"><ul class="facts">${s.backups.map((b) => `<li><span>${esc(b.name)}</span><b>${bytes(b.size)}</b></li>`).join("") || "<li><span>Копий пока нет</span></li>"}</ul></div>
    <h2 class="label">Строк в базе</h2>
    <div class="card"><ul class="facts">${Object.entries(s.tables).map(([t, c]) => `<li><span>${esc(t)}</span><b>${n(c)}</b></li>`).join("")}</ul></div>`;
  bindBack();
}

/* settings */
async function renderSettings() {
  loading("Настройки");
  let c;
  try { c = await api("/config"); } catch (e) { return failed("Настройки", e, renderSettings); }
  if (state.sub !== "settings") return;
  app.innerHTML = `${backToMore()}
    <h1 class="view-title">Настройки</h1>
    <p class="view-sub">Меняются сразу, без выкладки</p>

    <h2 class="label">Семестр</h2>
    <div class="row">
      <label class="field" style="margin:0"><span>Начало</span><input type="date" id="sem-start" value="${esc(c.semester.start)}"></label>
      <label class="field" style="margin:0"><span>Начало сессии</span><input type="date" id="sem-session" value="${esc(c.semester.session)}"></label>
    </div>
    <button class="btn secondary" id="save-sem">Сохранить даты</button>
    <p class="hint">По ним приложение рисует прогресс семестра на вкладке статистики.</p>

    <h2 class="label">Функции</h2>
    <ul class="list">${Object.entries(c.labels).map(([k, label]) => `<li><button class="toggle" data-feature="${k}" role="switch" aria-checked="${c.features[k]}">
      <span>${esc(label)}</span><span class="switch"></span></button></li>`).join("")}</ul>
    <p class="hint">Выключенная функция отвечает студентам «временно отключено». Уже созданное остаётся.</p>

    <h2 class="label">Баннер в приложении</h2>
    <textarea id="banner" maxlength="300" rows="3" placeholder="Например, 5 ноября с 2:00 до 3:00 приложение может быть недоступно">${esc(c.banner)}</textarea>
    <div class="row"><button class="btn" id="save-banner">Показать</button><button class="btn secondary" id="clear-banner" ${c.banner ? "" : "disabled"}>Убрать</button></div>
    <p class="hint">Показывается над вкладками у всех; каждый может закрыть его у себя.</p>`;
  bindBack();
  document.getElementById("save-sem").addEventListener("click", (e) => act(e.currentTarget,
    () => post("/config", { semester: { start: document.getElementById("sem-start").value, session: document.getElementById("sem-session").value } }), "Сохранено"));
  app.querySelectorAll("[data-feature]").forEach((b) => b.addEventListener("click", async () => {
    const on = b.getAttribute("aria-checked") !== "true";
    const r = await act(b, () => post("/config", { features: { [b.dataset.feature]: on } }));
    if (r) { b.setAttribute("aria-checked", String(r.features[b.dataset.feature])); b.disabled = false; }
  }));
  document.getElementById("save-banner").addEventListener("click", async (e) => {
    if (await act(e.currentTarget, () => post("/config", { banner: document.getElementById("banner").value }), "Показан")) document.getElementById("clear-banner").disabled = false;
  });
  document.getElementById("clear-banner").addEventListener("click", async (e) => {
    if (await act(e.currentTarget, () => post("/config", { banner: "" }), "Убран")) document.getElementById("banner").value = "";
  });
}

/* journal */
async function renderLog() {
  loading("Журнал");
  let list;
  try { list = await api("/log"); } catch (e) { return failed("Журнал", e, renderLog); }
  if (state.sub !== "log") return;
  app.innerHTML = `${backToMore()}
    <h1 class="view-title">Журнал действий</h1>
    ${list.length ? `<ul class="list">${list.map((x) => `<li class="entry">
      <p class="entry-body" style="margin:0">${esc(x.action)}</p>
      <div class="entry-foot"><span>${x.target ? `${esc(x.target)} · ` : ""}${when(x.at)}${x.undone_at ? " · отменено" : ""}</span><span class="grow"></span>
        ${x.can_undo ? `<button class="link" data-undo="${x.id}">Отменить</button>` : ""}</div></li>`).join("")}</ul>`
      : `<div class="note"><strong>Пусто</strong>Здесь появится всё, что вы делаете в панели: баны, удаления, рассылки, настройки.</div>`}`;
  bindBack();
  app.querySelectorAll("[data-undo]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirmTap(b, "Отменить?")) return;
    if (await act(b, () => post(`/log/${b.dataset.undo}/undo`))) renderLog();
  }));
}

/* ---------- start ---------- */

(async function start() {
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor?.("bg_color"); tg.setBackgroundColor?.(getComputedStyle(document.body).backgroundColor); } catch (_) {}
  }
  app.innerHTML = '<i class="sk"></i><i class="sk"></i><i class="sk"></i>';
  const me = await refreshDots();
  if (!me) {
    try { await api("/me"); } catch (e) { if (!(e instanceof HttpError && (e.status === 401 || e.status === 403))) failed("Панель", e, () => location.reload()); }
    return;
  }
  document.getElementById("tabbar").hidden = false;
  go("stats");
  setInterval(() => { if (document.visibilityState === "visible") refreshDots(); }, 60000);
})();
