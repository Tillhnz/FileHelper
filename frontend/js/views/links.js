// ===========================================================================
// Geteilte Links verwalten
// ===========================================================================
import { h, icon, clear, api, state, toast, errorToast, pageHead, empty, dateTime, relTime, copyText, confirmDialog, loader, fileIcon } from "../core.js";

export async function renderLinks({ el }) {
  el.append(pageHead("Geteilte Links", "Links, über die andere Dateien ohne Konto herunterladen können."));
  const body = h("div", null, loader());
  el.append(body);

  async function load() {
    let links;
    try { links = (await api("/links")).links; } catch (e) { clear(body).append(h("div", { class: "callout bad" }, e.message)); return; }
    clear(body);
    if (!links.length) {
      body.append(h("div", { class: "card" }, empty("link", "Noch nichts geteilt", "Bei einer Datei oder einem Ordner auf „⋯“ → „Link teilen“ tippen. Der Link funktioniert ohne Konto – auf Wunsch mit Ablaufdatum und Passwort.")));
      return;
    }
    const now = Date.now() / 1000;
    body.append(h("div", { class: "card pad-0" }, h("div", { class: "list" }, links.map(l => {
      const url = `${location.origin}/s/${l.token}`;
      const expired = l.expires && l.expires < now;
      const share = state.shares.find(s => s.name === l.share);
      return h("div", { class: "list-item wrap-sm" },
        fileIcon({ kind: l.dir ? "folder" : "file", name: l.name }),
        h("div", { class: "grow" },
          h("div", { class: "title" }, l.name),
          h("div", { class: "meta" }, [share?.label || l.share, ...(l.path ? l.path.split("/").slice(0, -1) : [])].join(" › ")),
          h("div", { class: "row wrap", style: { gap: "6px", marginTop: "6px" } },
            expired ? h("span", { class: "badge bad" }, "abgelaufen") : l.expires ? h("span", { class: "badge" }, icon("clock", "sm"), `bis ${dateTime(l.expires)}`) : h("span", { class: "badge" }, "unbegrenzt"),
            l.protected ? h("span", { class: "badge info" }, icon("lock", "sm"), "Passwort") : null,
            h("span", { class: "badge" }, icon("download", "sm"), `${l.downloads}× geladen`),
            state.user.admin && l.user !== state.user.name ? h("span", { class: "badge" }, icon("user", "sm"), l.user) : null,
            h("span", { class: "muted small" }, `erstellt ${relTime(l.created)}`))),
        h("div", { class: "end" },
          !expired ? h("button", { class: "btn sm", onclick: async () => { if (await copyText(url)) toast("Link kopiert", url); } }, icon("copy", "sm"), "Kopieren") : null,
          !expired ? h("a", { class: "btn sm icon ghost", href: url, target: "_blank", rel: "noopener", title: "Öffnen" }, icon("external", "sm")) : null,
          h("button", { class: "btn sm icon ghost", title: "Link löschen", onclick: async () => {
            if (!(await confirmDialog({ title: "Link löschen?", text: `Danach funktioniert der Link zu „${l.name}“ nicht mehr. Die Datei selbst bleibt erhalten.`, confirmText: "Löschen", danger: true }))) return;
            try { await api(`/links/${l.id}`, { method: "DELETE" }); toast("Link gelöscht"); load(); } catch (e) { errorToast(e); }
          } }, icon("trash", "sm"))));
    }))));
  }
  await load();
}
