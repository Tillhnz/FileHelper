// ===========================================================================
// FileHelper – Rahmen, Navigation, Anmeldung
// ===========================================================================
import { h, icon, clear, api, state, toast, errorToast, field, input, loader, meter, pct, isMobile } from "./js/core.js";
import { renderHome, renderFavorites } from "./js/views/home.js";
import { renderBrowser } from "./js/views/browser.js";
import { renderLinks } from "./js/views/links.js";
import { renderSettings } from "./js/views/settings.js";
import { startUpload } from "./js/upload.js";

const app = document.getElementById("app");
let page = null; // aktuelle Seite: { cleanup: [] }

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------
export function setTheme(t) {
  try { t === "auto" ? localStorage.removeItem("fh-theme") : localStorage.setItem("fh-theme", t); } catch { /* */ }
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
}
export function currentTheme() { return document.documentElement.dataset.theme || "auto"; }

// ---------------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------------
function renderLogin(message) {
  clear(app);
  const user = input({ autocomplete: "username", autocapitalize: "off", spellcheck: "false", placeholder: "admin" });
  const pass = input({ type: "password", autocomplete: "current-password" });
  const remember = h("input", { type: "checkbox", checked: true });
  const errBox = h("div");
  const btn = h("button", { class: "btn primary lg block", type: "submit" }, "Anmelden");
  try { user.value = localStorage.getItem("fh-last-user") || ""; } catch { /* */ }
  const form = h("form", { class: "stack", style: { gap: "16px" } },
    field("Benutzername", user), field("Passwort", pass),
    h("label", { class: "row", style: { gap: "10px", cursor: "pointer" } }, remember, h("span", null, "Angemeldet bleiben (30 Tage)")),
    errBox, btn);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clear(errBox);
    btn.disabled = true;
    try {
      await api("/login", { method: "POST", body: { username: user.value.trim(), password: pass.value, remember: remember.checked } });
      try { localStorage.setItem("fh-last-user", user.value.trim()); } catch { /* */ }
      await boot();
    } catch (err) {
      errBox.append(h("div", { class: "callout bad" }, icon("xCircle"), h("div", null, h("p", null, err.message))));
      pass.select();
    } finally { btn.disabled = false; }
  });
  app.append(h("div", { class: "login-wrap" },
    h("div", { class: "login-art" },
      h("div", { class: "brand" }, h("div", { class: "brand-mark" }, icon("folder")), h("div", null, "FileHelper", h("small", null, "Deine Dateien von der NAS"))),
      h("h1", null, "Alle deine Dateien. Überall im Heimnetz."),
      h("p", null, "Fotos, Videos und Dokumente ansehen, herunterladen, hochladen und teilen – am Rechner und auf dem Handy."),
      h("div", { class: "login-features" }, ["Vorschau für Fotos & Videos", "Hochladen per Ziehen", "Links zum Teilen", "Hell & dunkel"].map(t => h("span", null, t)))),
    h("div", { class: "login-panel" }, h("div", { class: "login-box" },
      h("h2", null, "Anmelden"), h("p", null, message || "Mit deinem FileHelper-Konto."), form,
      h("p", { class: "muted small", style: { marginTop: "22px" } }, "Passwort vergessen? Im Container ", h("span", { class: "mono" }, "filehelper passwd admin"), " ausführen.")))));
  setTimeout(() => (user.value ? pass : user).focus(), 50);
}

window.addEventListener("fh:logout", () => { state.user = null; renderLogin("Deine Anmeldung ist abgelaufen. Bitte neu anmelden."); });

export async function logout() {
  try { await api("/logout", { method: "POST" }); } catch { /* */ }
  state.user = null;
  location.hash = "#/";
  renderLogin("Du wurdest abgemeldet.");
}

// ---------------------------------------------------------------------------
// Rahmen
// ---------------------------------------------------------------------------
let sidebarShares = null;
let mainEl = null;

function navLink(href, ico, label, extra) {
  return h("a", { href, "data-href": href }, icon(ico), h("span", { class: "n-label" }, label), extra || null);
}

function buildShell() {
  clear(app);
  sidebarShares = h("div", { class: "nav" });
  const initials = (state.user.name[0] || "?").toUpperCase();
  const themeBtn = h("button", { class: "btn icon sm ghost theme-btn", title: "Hell/Dunkel", onclick: () => {
    const dark = currentTheme() === "dark" || (currentTheme() === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    setTheme(dark ? "light" : "dark"); clear(themeBtn).append(icon(dark ? "moon" : "sun", "sm"));
  } }, icon(document.documentElement.dataset.theme === "dark" ? "sun" : "moon", "sm"));
  const sidebar = h("aside", { class: "sidebar" },
    h("a", { class: "brand", href: "#/" }, h("div", { class: "brand-mark" }, icon("folder")), h("div", null, "FileHelper", h("small", null, "Deine Dateien"))),
    h("nav", { class: "nav" },
      navLink("#/", "home", "Start"),
      navLink("#/fav", "star", "Favoriten"),
      navLink("#/links", "link", "Geteilte Links"),
      navLink("#/settings", "settings", "Einstellungen")),
    h("div", { class: "nav-section" }, "Freigaben"),
    sidebarShares,
    h("div", { class: "sidebar-foot" }, h("div", { class: "user-chip" },
      h("div", { class: "avatar" }, initials),
      h("div", { style: { minWidth: 0, flex: 1 } }, h("div", { style: { fontWeight: 650 } }, state.user.name),
        h("div", { class: "muted small" }, state.user.admin ? "Administrator" : state.user.readonly ? "Nur ansehen" : "Benutzer")),
      themeBtn,
      h("button", { class: "btn icon sm ghost", title: "Abmelden", onclick: logout }, icon("logout", "sm")))));

  const topbar = h("div", { class: "topbar" },
    h("a", { class: "brand", href: "#/" }, h("div", { class: "brand-mark" }, icon("folder", "sm")), "FileHelper"),
    h("span", { class: "spacer" }),
    h("a", { class: "btn icon ghost", href: "#/settings", "aria-label": "Einstellungen" }, icon("user")));

  const bottom = h("nav", { class: "bottom-nav" },
    h("a", { href: "#/", "data-href": "#/" }, icon("home"), "Start"),
    h("a", { href: "#/fav", "data-href": "#/fav" }, icon("star"), "Favoriten"),
    h("a", { href: "#", class: "plus", onclick: (e) => { e.preventDefault(); quickUpload(); } }, icon("upload"), "Hochladen"),
    h("a", { href: "#/links", "data-href": "#/links" }, icon("link"), "Links"),
    h("a", { href: "#/settings", "data-href": "#/settings" }, icon("settings"), "Mehr"));

  mainEl = h("main", { class: "main" });
  app.append(h("div", { class: "shell" }, sidebar, h("div", null, topbar, mainEl)), bottom);
}

export async function refreshShares() {
  try {
    const r = await api("/shares");
    state.shares = r.shares;
    state.root = r.root;
  } catch (e) { if (e.status !== 401) errorToast(e, "Freigaben konnten nicht geladen werden"); }
  drawSidebarShares();
  return state.shares;
}

function drawSidebarShares() {
  if (!sidebarShares) return;
  clear(sidebarShares);
  if (!state.shares.length) { sidebarShares.append(h("div", { class: "muted small", style: { padding: "4px 12px" } }, "Noch keine Ordner freigegeben.")); return; }
  for (const s of state.shares) {
    const href = `#/f/${encodeURIComponent(s.name)}`;
    sidebarShares.append(h("a", { href, "data-href": href, "data-share": s.name },
      icon(s.mounted ? "hdd" : "folder"), h("span", { class: "n-label" }, s.label),
      s.total ? meter(pct(s.total - s.free, s.total), "thin") : null));
  }
  markActive();
}

function markActive() {
  const hash = (location.hash || "#/").split("?")[0];
  const share = hash.startsWith("#/f/") ? decodeURIComponent(hash.slice(4).split("/")[0]) : null;
  document.querySelectorAll(".nav a, .bottom-nav a").forEach(a => {
    const href = a.dataset.href;
    const on = share ? a.dataset.share === share : href === hash || (href !== "#/" && href && hash.startsWith(href));
    a.classList.toggle("active", !!on);
  });
}

// Hochladen über die untere Leiste (Handy): im aktuellen Ordner, sonst Ordner wählen
async function quickUpload() {
  if (state.currentFolder?.writable) return state.currentFolder.upload();
  const { pickFolder } = await import("./js/views/picker.js");
  const dest = await pickFolder({ title: "Wohin hochladen?", confirm: "Hier hochladen", writableOnly: true });
  if (!dest) return;
  const inp = h("input", { type: "file", multiple: true });
  inp.addEventListener("change", () => { if (inp.files.length) startUpload(dest.share, dest.path, [...inp.files].map(f => ({ file: f, rel: f.name }))); });
  inp.click();
}

// ---------------------------------------------------------------------------
// Seiten
// ---------------------------------------------------------------------------
function newPage() {
  if (page) page.cleanup.forEach(fn => { try { fn(); } catch { /* */ } });
  page = { cleanup: [], on(ev, fn, target = window) { target.addEventListener(ev, fn); this.cleanup.push(() => target.removeEventListener(ev, fn)); } };
  state.currentFolder = null;
  return page;
}

async function route() {
  if (!state.user) return;
  const [hash, hquery] = (location.hash || "#/").split("?");
  const params = new URLSearchParams(hquery || "");
  const p = newPage();
  clear(mainEl);
  const el = h("div", { class: "fade-in" });
  mainEl.append(el);
  markActive();
  window.scrollTo(0, 0);
  const parts = hash.slice(2).split("/");
  try {
    if (parts[0] === "f" && parts[1]) {
      const share = decodeURIComponent(parts[1]);
      const path = parts.slice(2).map(decodeURIComponent).join("/");
      await renderBrowser({ page: p, el, share, path, refreshShares, open: params.get("open") });
    } else if (parts[0] === "fav") await renderFavorites({ page: p, el });
    else if (parts[0] === "links") await renderLinks({ page: p, el });
    else if (parts[0] === "settings") await renderSettings({ page: p, el, refreshShares, logout, setTheme, currentTheme });
    else await renderHome({ page: p, el, refreshShares });
  } catch (e) {
    if (e.status === 401) return;
    clear(el).append(h("div", { class: "callout bad" }, icon("xCircle"), h("div", null, h("strong", null, "Laden fehlgeschlagen"), h("p", null, e.message))));
  }
}

window.addEventListener("hashchange", route);

async function boot() {
  clear(app).append(loader());
  try {
    const me = await api("/me");
    state.user = me.user;
    state.favorites = me.favorites || [];
    state.version = me.version;
  } catch (e) {
    if (e.status === 401) return renderLogin();
    clear(app).append(h("div", { class: "main" }, h("div", { class: "callout bad" }, icon("xCircle"), h("div", null, h("strong", null, "FileHelper ist nicht erreichbar"), h("p", null, e.message)))));
    return;
  }
  try { state.features = (await api("/system")).thumbs; } catch { state.features = {}; }
  buildShell();
  await refreshShares();
  await route();
}

// Beim Zurückkehren in den Tab Freigaben auffrischen (z. B. neu eingebundene NAS-Ordner)
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.user) refreshShares(); });

boot();
export { isMobile, toast };
