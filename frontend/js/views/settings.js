// ===========================================================================
// Einstellungen: Konto, Darstellung, Benutzer, Freigaben, System
// ===========================================================================
import {
  h, icon, clear, api, state, toast, errorToast, pageHead, field, input, segmented, toggle, openSheet, confirmDialog, bytes, relTime,
  callout, loader, withBusy,
} from "../core.js";
import { howToAdd } from "./home.js";

export async function renderSettings({ el, refreshShares, logout, setTheme, currentTheme }) {
  el.append(pageHead("Einstellungen", null, [h("button", { class: "btn", onclick: logout }, icon("logout", "sm"), "Abmelden")]));

  // Konto
  const pwBtn = h("button", { class: "btn" }, icon("key", "sm"), "Passwort ändern");
  pwBtn.addEventListener("click", changePassword);
  el.append(h("div", { class: "card" },
    h("div", { class: "row", style: { gap: "14px" } }, h("div", { class: "avatar", style: { width: "48px", height: "48px", fontSize: "18px" } }, state.user.name[0].toUpperCase()),
      h("div", { style: { flex: 1, minWidth: 0 } }, h("div", { style: { fontWeight: 700, fontSize: "17px" } }, state.user.name),
        h("div", { class: "muted small" }, state.user.admin ? "Administrator" : state.user.readonly ? "Darf nur ansehen und herunterladen" : "Benutzer")),
      pwBtn)));

  // Darstellung
  el.append(h("h2", { class: "section" }, icon("palette", "sm"), "Darstellung"),
    h("div", { class: "card" }, field("Design", segmented([{ value: "auto", label: "Automatisch" }, { value: "light", label: "Hell" }, { value: "dark", label: "Dunkel" }], currentTheme(), setTheme),
      "Automatisch folgt der Einstellung deines Geräts.")));

  if (!state.user.admin) { el.append(versionLine()); return; }

  // Freigaben
  const sharesBox = h("div", null, loader());
  el.append(h("h2", { class: "section" }, icon("hdd", "sm"), "Freigaben"), sharesBox);
  async function drawShares() {
    let shares;
    try { shares = (await api("/shares", { query: { all: 1 } })).shares; } catch (e) { clear(sharesBox).append(callout("bad", null, e.message)); return; }
    clear(sharesBox);
    if (!shares.length) { sharesBox.append(callout("info", "Noch keine Ordner eingebunden", null), howToAdd()); return; }
    sharesBox.append(h("div", { class: "card pad-0" }, h("div", { class: "list" }, shares.map(s => h("div", { class: "list-item wrap-sm" },
      h("div", { class: "folder-ico", style: { width: "38px", height: "38px" } }, icon(s.mounted ? "hdd" : "folder", "sm")),
      h("div", { class: "grow" }, h("div", { class: "title" }, s.label, s.label !== s.name ? h("span", { class: "muted", style: { fontWeight: 500 } }, ` (${s.name})`) : null),
        h("div", { class: "meta" }, [`${state.root}/${s.name}`, s.writable ? "lesen & schreiben" : "nur lesen", s.total ? `${bytes(s.free)} frei` : null].filter(Boolean).join(" · "))),
      h("div", { class: "end" },
        s.hidden ? h("span", { class: "badge warn" }, "ausgeblendet") : null,
        h("button", { class: "btn sm", onclick: () => editShare(s) }, icon("edit", "sm"), "Anpassen")))))),
    h("p", { class: "muted small", style: { margin: "10px 2px 0" } }, "Neue Ordner gibst du in der Proxmox Zentrale frei (Speicher & NAS → „Im FileHelper anzeigen“)."));
  }
  function editShare(s) {
    openSheet((sheet, close) => {
      const d = { label: s.label === s.name ? "" : s.label, hidden: s.hidden };
      const save = h("button", { class: "btn primary" }, icon("check", "sm"), "Speichern");
      save.addEventListener("click", () => withBusy(save, async () => {
        try { await api(`/shares/${encodeURIComponent(s.name)}`, { method: "PUT", body: d }); close(); toast("Gespeichert"); drawShares(); refreshShares(); }
        catch (e) { errorToast(e); }
      }));
      sheet.append(h("h2", null, `Freigabe „${s.name}“`), h("p", { class: "sheet-sub" }, "Nur die Anzeige im FileHelper ändert sich – nicht der Ordner selbst."),
        h("div", { class: "stack", style: { gap: "16px" } },
          field("Anzeigename", input({ value: d.label, placeholder: s.name, oninput: (e) => { d.label = e.target.value; } })),
          toggle("Ausblenden", "Taucht dann für niemanden mehr in der Liste auf.", d.hidden, (v) => { d.hidden = v; })),
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), save));
    });
  }

  // Benutzer
  const usersBox = h("div", null, loader());
  el.append(h("h2", { class: "section" }, icon("users", "sm"), "Benutzer", h("span", { class: "spacer" }),
    h("button", { class: "btn sm", onclick: () => editUser(null) }, icon("plus", "sm"), "Benutzer anlegen")), usersBox);
  async function drawUsers() {
    let users;
    try { users = (await api("/users")).users; } catch (e) { clear(usersBox).append(callout("bad", null, e.message)); return; }
    clear(usersBox).append(h("div", { class: "card pad-0" }, h("div", { class: "list" }, users.map(u => h("div", { class: "list-item" },
      h("div", { class: "avatar" }, u.name[0].toUpperCase()),
      h("div", { class: "grow" }, h("div", { class: "title" }, u.name, u.name === state.user.name ? h("span", { class: "muted", style: { fontWeight: 500 } }, " (du)") : null),
        h("div", { class: "meta" }, `${u.admin ? "Administrator" : u.readonly ? "Nur ansehen" : "Benutzer"} · ${u.last_login ? `zuletzt ${relTime(u.last_login)}` : "noch nie angemeldet"}`)),
      h("button", { class: "btn sm ghost", onclick: () => editUser(u) }, icon("edit", "sm"), h("span", { class: "hide-sm" }, "Bearbeiten")))))));
  }
  function editUser(u) {
    openSheet((sheet, close) => {
      const d = { name: u?.name || "", password: "", role: u ? (u.admin ? "admin" : u.readonly ? "readonly" : "user") : "user" };
      const save = h("button", { class: "btn primary" }, icon("check", "sm"), u ? "Speichern" : "Anlegen");
      save.addEventListener("click", () => withBusy(save, async () => {
        const body = { name: d.name.trim(), password: d.password || undefined, admin: d.role === "admin", readonly: d.role === "readonly" };
        try {
          if (u) await api(`/users/${encodeURIComponent(u.name)}`, { method: "PUT", body });
          else await api("/users", { method: "POST", body });
          close(); toast(u ? "Gespeichert" : "Benutzer angelegt", body.name); drawUsers();
        } catch (e) { errorToast(e); }
      }));
      const del = u && u.name !== state.user.name ? h("button", { class: "btn danger-ghost", onclick: async () => {
        if (!(await confirmDialog({ title: `${u.name} löschen?`, text: "Das Konto kann sich danach nicht mehr anmelden. Dateien bleiben erhalten.", confirmText: "Löschen", danger: true }))) return;
        try { await api(`/users/${encodeURIComponent(u.name)}`, { method: "DELETE" }); close(); toast("Benutzer gelöscht"); drawUsers(); } catch (e) { errorToast(e); }
      } }, icon("trash", "sm"), "Löschen") : null;
      sheet.append(h("h2", null, u ? `${u.name} bearbeiten` : "Benutzer anlegen"),
        h("div", { class: "stack", style: { gap: "16px", marginTop: "14px" } },
          !u ? field("Benutzername", input({ autocapitalize: "off", autocomplete: "off", oninput: (e) => { d.name = e.target.value; } })) : null,
          field(u ? "Neues Passwort" : "Passwort", input({ type: "password", autocomplete: "new-password", placeholder: u ? "Leer lassen = unverändert" : "Mindestens 8 Zeichen", oninput: (e) => { d.password = e.target.value; } })),
          field("Rolle", segmented([{ value: "user", label: "Benutzer" }, { value: "readonly", label: "Nur ansehen" }, { value: "admin", label: "Admin" }], d.role, (v) => { d.role = v; }),
            "Benutzer dürfen hochladen, umbenennen und löschen. „Nur ansehen“ erlaubt nur Anschauen und Herunterladen. Admins verwalten zusätzlich Benutzer und Freigaben.")),
        h("div", { class: "sheet-foot" }, del, h("span", { class: "spacer" }), h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), save));
    });
  }

  // System
  const sysBox = h("div", null, loader());
  el.append(h("h2", { class: "section" }, icon("server", "sm"), "System"), sysBox);
  async function drawSystem(check = false) {
    let s;
    try { s = await api("/system", { query: { check: check ? 1 : undefined } }); } catch (e) { clear(sysBox).append(callout("bad", null, e.message)); return; }
    const feat = (ok, label, hint) => h("div", { class: "row", style: { gap: "8px" } }, icon(ok ? "checkCircle" : "xCircle", "sm"), h("span", null, label), !ok && hint ? h("span", { class: "muted small" }, hint) : null);
    const updBtn = h("button", { class: `btn ${s.update ? "primary" : ""}` }, icon(s.update ? "download" : "refresh", "sm"), s.update ? "Jetzt aktualisieren" : "Nach Updates suchen");
    updBtn.addEventListener("click", () => withBusy(updBtn, async () => {
      if (!s.update) { await drawSystem(true); return; }
      try {
        await api("/system/update", { method: "POST" });
        toast("Update läuft", "FileHelper startet gleich neu – die Seite lädt sich danach selbst neu.", "busy", { timeout: 0 });
        waitForRestart(s.version);
      } catch (e) { errorToast(e); }
    }));
    const cacheBtn = h("button", { class: "btn sm ghost" }, icon("trash", "sm"), "Leeren");
    cacheBtn.addEventListener("click", () => withBusy(cacheBtn, async () => { try { await api("/system/cache", { method: "DELETE" }); toast("Vorschaubilder gelöscht", "Sie werden bei Bedarf neu erstellt."); drawSystem(); } catch (e) { errorToast(e); } }));
    clear(sysBox).append(h("div", { class: "card" },
      h("div", { class: "row wrap", style: { gap: "12px" } },
        h("div", { style: { flex: 1, minWidth: "200px" } }, h("div", { style: { fontWeight: 700, fontSize: "16px" } }, `FileHelper ${s.version}`),
          h("div", { class: "muted small" }, s.check_error ? "Update-Prüfung gerade nicht möglich (kein Internet?)"
            : s.update ? `${s.changes.length}${s.more ? "+" : ""} neue ${s.changes.length === 1 ? "Änderung" : "Änderungen"} auf GitHub${s.latest && s.latest !== s.version ? ` · Version ${s.latest}` : ""}`
            : `Du hast den neuesten Stand${s.installed ? ` (${s.installed})` : ""}.`)),
        s.update && s.security ? h("span", { class: "badge warn" }, icon("shield", "sm"), "Sicherheitsupdate") : null,
        updBtn),
      s.update && s.changes.length ? h("details", { style: { marginTop: "12px" } },
        h("summary", { class: "muted small", style: { cursor: "pointer", fontWeight: 600 } }, "Was ist neu?"),
        h("ul", { class: "plain-list small", style: { marginTop: "8px" } }, s.changes.map(c => h("li", null, c.subject)))) : null,
      h("div", { class: "menu-sep", style: { margin: "16px 0" } }),
      h("div", { class: "stack", style: { gap: "8px" } },
        feat(s.thumbs.pillow, "Vorschaubilder für Fotos", "Pillow fehlt"),
        feat(s.thumbs.heif, "iPhone-Fotos (HEIC)", "pillow-heif fehlt"),
        feat(s.thumbs.ffmpeg, "Vorschaubilder für Videos", "ffmpeg fehlt (apt install ffmpeg)"),
        h("div", { class: "row", style: { gap: "8px" } }, icon("image", "sm"), h("span", null, `Zwischenspeicher Vorschaubilder: ${bytes(s.cache)}`), cacheBtn)),
      h("div", { class: "menu-sep", style: { margin: "16px 0" } }),
      h("div", { class: "muted small" }, "Im Container: ", h("span", { class: "mono" }, "filehelper update"), " · ", h("span", { class: "mono" }, "filehelper passwd <name>"), " · Quellcode: ",
        h("a", { href: `https://github.com/${s.repo}`, target: "_blank", rel: "noopener" }, s.repo))));
  }

  // Benachrichtigungen (ntfy) – wie bei den anderen Helpern
  const notifyBox = h("div", null, loader());
  el.append(h("h2", { class: "section" }, icon("info", "sm"), "Benachrichtigungen"), notifyBox);
  async function drawNotify() {
    let s;
    try { s = (await api("/system")).ntfy; } catch (e) { clear(notifyBox).append(callout("bad", null, e.message)); return; }
    const d = { topic: s.topic, url: s.url, notify: s.notify, token: "", click: s.click || "" };
    const save = h("button", { class: "btn primary" }, icon("check", "sm"), "Speichern");
    const test = h("button", { class: "btn", disabled: !s.topic }, icon("sparkle", "sm"), "Test-Nachricht");
    save.addEventListener("click", () => withBusy(save, async () => {
      try { await api("/system/notify", { method: "PUT", body: d }); toast("Gespeichert", d.topic ? `Updates kommen über ntfy, Thema „${d.topic}“.` : "Push-Nachrichten sind aus."); drawNotify(); }
      catch (e) { errorToast(e); }
    }));
    test.addEventListener("click", () => withBusy(test, async () => {
      try { await api("/system/notify/test", { method: "POST" }); toast("Test gesendet", "Schau in die ntfy-App."); } catch (e) { errorToast(e); }
    }));
    clear(notifyBox).append(h("div", { class: "card" },
      h("p", { class: "muted", style: { margin: "0 0 16px" } }, "Wie bei den anderen Helpern: Sobald auf GitHub eine neue Version liegt – auch automatisch übernommene Sicherheitsupdates von Dependabot –, kommt eine Push-Nachricht über die App ntfy. Sicherheitsupdates mit hoher Priorität. Geprüft wird alle 6 Stunden."),
      h("div", { class: "stack", style: { gap: "16px" } },
        h("div", { class: "form-grid" },
          field("ntfy-Thema", input({ value: d.topic, placeholder: "z. B. till-homelab", autocapitalize: "off", oninput: (e) => { d.topic = e.target.value.trim(); } }), "Dasselbe Thema wie bei den anderen Helpern abonnieren. Leer = aus."),
          field("ntfy-Server", input({ value: d.url, placeholder: "https://ntfy.sh", autocapitalize: "off", oninput: (e) => { d.url = e.target.value.trim(); } }))),
        h("div", { class: "form-grid" },
          field("Zugangstoken", input({ type: "password", placeholder: s.has_token ? "gespeichert – leer lassen = unverändert" : "nur bei geschütztem Thema", autocomplete: "off", oninput: (e) => { d.token = e.target.value.trim(); } })),
          field("Adresse von FileHelper", input({ value: d.click, placeholder: "z. B. https://dateien.all-heinzen.de", autocapitalize: "off", oninput: (e) => { d.click = e.target.value.trim(); } }), "Optional: Tippen auf die Nachricht öffnet die Einstellungen.")),
        toggle("Bei neuen Versionen benachrichtigen", null, d.notify, (v) => { d.notify = v; })),
      h("div", { class: "sheet-foot", style: { marginTop: "16px" } }, test, save)));
  }

  await Promise.all([drawShares(), drawUsers(), drawSystem(), drawNotify()]);
}

function versionLine() {
  return h("p", { class: "muted small", style: { marginTop: "24px" } }, `FileHelper ${state.version}`);
}

function waitForRestart(oldVersion) {
  let n = 0;
  const t = setInterval(async () => {
    n++;
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      const j = await r.json();
      if (j.version !== oldVersion || n > 60) { clearInterval(t); location.reload(); }
    } catch { /* startet gerade neu */ }
  }, 3000);
}

async function changePassword() {
  openSheet((sheet, close) => {
    const d = { old: "", new: "", repeat: "" };
    const save = h("button", { class: "btn primary" }, icon("check", "sm"), "Ändern");
    save.addEventListener("click", () => withBusy(save, async () => {
      if (d.new !== d.repeat) return toast("Passwörter stimmen nicht überein", "", "bad");
      try { await api("/me/password", { method: "POST", body: { old: d.old, new: d.new } }); close(); toast("Passwort geändert", "Andere Geräte müssen sich neu anmelden."); }
      catch (e) { errorToast(e); }
    }));
    sheet.append(h("h2", null, "Passwort ändern"),
      h("div", { class: "stack", style: { gap: "16px", marginTop: "14px" } },
        field("Bisheriges Passwort", input({ type: "password", autocomplete: "current-password", oninput: (e) => { d.old = e.target.value; } })),
        field("Neues Passwort", input({ type: "password", autocomplete: "new-password", oninput: (e) => { d.new = e.target.value; } }), "Mindestens 8 Zeichen."),
        field("Neues Passwort wiederholen", input({ type: "password", autocomplete: "new-password", oninput: (e) => { d.repeat = e.target.value; } }))),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), save));
  });
}
