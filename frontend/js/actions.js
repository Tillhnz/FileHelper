// ===========================================================================
// Aktionen für Dateien und Ordner (werden von Liste, Vorschau und Suche genutzt)
// ===========================================================================
import {
  h, icon, api, state, toast, errorToast, confirmDialog, promptDialog, openSheet, fileUrl, joinPath, bytes, dateTime,
  KIND_LABEL, fileIcon, plural, loader, clear, callout,
} from "./core.js";

export function itemPath(ctx, item) { return joinPath(item.parent && item.parent !== "/" ? item.parent : ctx.path, item.name); }
const parentOf = (ctx, item) => (item.parent !== undefined ? (item.parent === "/" ? "" : item.parent) : ctx.path);

function triggerDownload(url) {
  const a = h("a", { href: url, download: "", style: { display: "none" } });
  document.body.append(a); a.click(); a.remove();
}

export async function download(ctx, items) {
  if (!items.length) return;
  if (items.length === 1 && !items[0].dir) return triggerDownload(fileUrl(ctx.share, itemPath(ctx, items[0]), { dl: 1 }));
  // Mehrere Elemente (oder Ordner) als ZIP; alle müssen im selben Ordner liegen
  const base = parentOf(ctx, items[0]);
  if (items.some(i => parentOf(ctx, i) !== base)) return toast("Bitte einzeln herunterladen", "Die Auswahl liegt in verschiedenen Ordnern.", "info");
  const names = items.map(i => i.name);
  const q = new URLSearchParams({ share: ctx.share, path: base });
  names.forEach(n => q.append("item", n));
  let url = "/api/zip?" + q.toString();
  if (url.length > 6000) {
    try { url = "/api/zip?ticket=" + encodeURIComponent((await api("/zip", { method: "POST", body: { share: ctx.share, path: base, items: names } })).ticket); }
    catch (e) { return errorToast(e); }
  }
  toast("ZIP wird erstellt", "Der Download startet gleich. Große Ordner brauchen etwas.", "info");
  triggerDownload(url);
}

export function downloadFolder(share, path, name) {
  toast("ZIP wird erstellt", `„${name}“ wird gepackt – der Download startet gleich.`, "info");
  triggerDownload("/api/zip?" + new URLSearchParams({ share, path }).toString());
}

/** Wartet auf eine Aufgabe im Hintergrund (Kopieren, Verschieben, Löschen) und zeigt den Fortschritt. */
export function runJob(job, { doneTitle, onDone } = {}) {
  return new Promise((resolve) => {
    let t = null;
    const started = Date.now();
    const tick = async () => {
      let j;
      try { j = (await api(`/jobs/${job.id}`)).job; } catch (e) { t?.close(); errorToast(e); return resolve(false); }
      if (j.state === "running") {
        if (!t && Date.now() - started > 600) t = toast(j.title, "", "busy", { timeout: 0 });
        if (t) {
          const prog = j.kind === "delete" ? `${j.done} von ${j.total}` : j.total ? `${bytes(j.done)} von ${bytes(j.total)} (${Math.floor(j.done / j.total * 100)} %)` : "";
          t.setText([prog, j.current].filter(Boolean).join(" · "));
        }
        return setTimeout(tick, 700);
      }
      t?.close();
      if (j.state === "error") { toast("Das hat nicht geklappt", j.error, "bad", { timeout: 9000 }); onDone?.(false); return resolve(false); }
      toast(doneTitle || "Erledigt");
      onDone?.(true);
      resolve(true);
    };
    setTimeout(tick, 250);
  });
}

export async function remove(ctx, items, onDone) {
  if (!items.length) return;
  const one = items.length === 1 ? items[0] : null;
  const ok = await confirmDialog({
    title: one ? `„${one.name}“ löschen?` : `${items.length} Elemente löschen?`,
    text: (items.some(i => i.dir) ? "Ordner werden mit allem Inhalt gelöscht. " : "") + "Das lässt sich nicht rückgängig machen – auch nicht auf der NAS (außer sie hat einen Papierkorb oder Snapshots).",
    confirmText: "Endgültig löschen", danger: true });
  if (!ok) return;
  const groups = groupByParent(ctx, items);
  for (const [base, names] of groups) {
    try {
      const { job } = await api("/delete", { method: "POST", body: { share: ctx.share, path: base, items: names } });
      await runJob(job, { doneTitle: one ? `„${one.name}“ gelöscht` : `${items.length} Elemente gelöscht` });
    } catch (e) { errorToast(e, "Löschen fehlgeschlagen"); }
  }
  onDone?.();
}

function groupByParent(ctx, items) {
  const m = new Map();
  for (const i of items) { const b = parentOf(ctx, i); if (!m.has(b)) m.set(b, []); m.get(b).push(i.name); }
  return m;
}

export async function transfer(ctx, items, mode, onDone, dest) {
  if (!items.length) return;
  if (!dest) {
    const { pickFolder } = await import("./views/picker.js");
    dest = await pickFolder({ title: mode === "move" ? "Wohin verschieben?" : "Wohin kopieren?", confirm: mode === "move" ? "Hierher verschieben" : "Hierher kopieren",
      share: ctx.share, path: ctx.path, writableOnly: true, notHere: mode === "move" ? { share: ctx.share, path: parentOf(ctx, items[0]) } : null, exclude: items.filter(i => i.dir).map(i => ({ share: ctx.share, path: itemPath(ctx, i) })) });
    if (!dest) return;
  }
  for (const [base, names] of groupByParent(ctx, items)) {
    try {
      const { job } = await api("/transfer", { method: "POST", body: { mode, share: ctx.share, path: base, items: names, dest_share: dest.share, dest_path: dest.path } });
      const label = names.length === 1 ? `„${names[0]}“` : `${names.length} Elemente`;
      await runJob(job, { doneTitle: `${label} ${mode === "move" ? "verschoben" : "kopiert"}` });
    } catch (e) { errorToast(e, mode === "move" ? "Verschieben fehlgeschlagen" : "Kopieren fehlgeschlagen"); }
  }
  onDone?.();
}

export async function rename(ctx, item, onDone) {
  const name = await promptDialog({ title: "Umbenennen", label: "Neuer Name", value: item.name, confirmText: "Umbenennen", selectStem: !item.dir,
    validate: (v) => !v ? "Bitte einen Namen eingeben." : v.includes("/") ? "Der Name darf kein / enthalten." : v.startsWith(".fh-") ? "Dieser Name ist reserviert." : null });
  if (!name || name === item.name) return;
  try {
    await api("/rename", { method: "POST", body: { share: ctx.share, path: itemPath(ctx, item), new: name } });
    toast("Umbenannt", `„${item.name}“ heißt jetzt „${name}“.`);
    onDone?.(name);
  } catch (e) { errorToast(e, "Umbenennen fehlgeschlagen"); }
}

export async function newFolder(ctx, onDone) {
  const name = await promptDialog({ title: "Neuer Ordner", label: "Name", value: "Neuer Ordner", confirmText: "Anlegen",
    validate: (v) => !v ? "Bitte einen Namen eingeben." : v.includes("/") ? "Der Name darf kein / enthalten." : null });
  if (!name) return;
  try { await api("/mkdir", { method: "POST", body: { share: ctx.share, path: ctx.path, name } }); onDone?.(name); }
  catch (e) { errorToast(e, "Ordner konnte nicht angelegt werden"); }
}

export async function newTextFile(ctx, onDone) {
  const name = await promptDialog({ title: "Neue Textdatei", label: "Dateiname", value: "Notiz.txt", confirmText: "Anlegen", selectStem: true,
    validate: (v) => !v ? "Bitte einen Namen eingeben." : v.includes("/") ? "Der Name darf kein / enthalten." : null });
  if (!name) return;
  try { await api("/text", { method: "POST", body: { share: ctx.share, path: joinPath(ctx.path, name), text: "", create: true } }); onDone?.(name); }
  catch (e) { errorToast(e, "Datei konnte nicht angelegt werden"); }
}

// ---------- Favoriten ----------
export function isFavorite(share, path) { return state.favorites.some(f => f.share === share && f.path === path); }
export async function toggleFavorite(share, path, name, dir) {
  const on = isFavorite(share, path);
  const favs = on ? state.favorites.filter(f => !(f.share === share && f.path === path)) : [...state.favorites, { share, path, name, dir }];
  try {
    state.favorites = (await api("/me/favorites", { method: "PUT", body: { favorites: favs } })).favorites;
    toast(on ? "Aus Favoriten entfernt" : "Zu Favoriten hinzugefügt", name);
    return !on;
  } catch (e) { errorToast(e); return on; }
}

// ---------- Eigenschaften ----------
export function properties(ctx, item) {
  const path = itemPath(ctx, item);
  const share = state.shares.find(s => s.name === ctx.share);
  openSheet((sheet, close) => {
    const sizeEl = h("dd", null, item.dir ? "wird berechnet …" : `${bytes(item.size)} (${(item.size || 0).toLocaleString("de-DE")} Bytes)`);
    sheet.append(
      h("div", { class: "menu-head" }, fileIcon(item, { size: 48 }), h("div", null, h("div", { class: "title", style: { fontSize: "18px" } }, item.name), h("div", { class: "muted small" }, KIND_LABEL[item.kind] || "Datei"))),
      h("dl", { class: "summary" },
        h("dt", null, "Größe"), sizeEl,
        h("dt", null, "Geändert"), h("dd", null, dateTime(item.mtime)),
        h("dt", null, "Ort"), h("dd", { class: "mono", style: { fontWeight: 500 } }, `${share?.label || ctx.share}/${path}`),
        h("dt", null, "Im Container"), h("dd", { class: "mono", style: { fontWeight: 500 } }, `${state.root || "/mnt"}/${ctx.share}/${path}`)),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn primary", onclick: () => close() }, "Schließen")));
    if (item.dir) {
      api("/stat", { query: { share: ctx.share, path, size: 1 } })
        .then(r => { sizeEl.textContent = `${bytes(r.size)} · ${plural(r.files, "Datei", "Dateien")}, ${plural(r.dirs, "Ordner", "Ordner")}${r.complete ? "" : " (mindestens)"}`; })
        .catch(e => { sizeEl.textContent = e.message; });
    }
  });
}

// ---------- Teilen ----------
export function shareLink(ctx, item) {
  if (state.user.readonly) return toast("Nicht erlaubt", "Dein Konto darf keine Links erstellen.", "bad");
  const path = item ? itemPath(ctx, item) : ctx.path;
  const name = item ? item.name : (ctx.path.split("/").pop() || ctx.share);
  openSheet((sheet, close) => {
    const d = { days: "7", password: "" };
    const content = h("div");
    sheet.append(h("h2", null, "Link teilen"), h("p", { class: "sheet-sub" }, `Wer den Link hat, kann „${name}“ ansehen und herunterladen – ohne Konto.`), content);
    const form = () => {
      clear(content);
      const days = h("div", { class: "choice-grid", style: { gridTemplateColumns: "repeat(4, 1fr)" } });
      const opts = [["1", "1 Tag"], ["7", "7 Tage"], ["30", "30 Tage"], ["", "Unbegrenzt"]];
      const drawDays = () => { clear(days).append(opts.map(([v, l]) => h("button", { type: "button", class: `choice ${d.days === v ? "active" : ""}`, style: { padding: "10px", alignItems: "center" }, onclick: () => { d.days = v; drawDays(); } }, h("strong", { style: { fontSize: "14px" } }, l)))); };
      drawDays();
      const pw = h("input", { class: "input", type: "text", placeholder: "Optional", autocomplete: "off", oninput: (e) => { d.password = e.target.value; } });
      const btn = h("button", { class: "btn primary" }, icon("link", "sm"), "Link erstellen");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const { link } = await api("/links", { method: "POST", body: { share: ctx.share, path, days: d.days ? Number(d.days) : null, password: d.password || null } });
          result(link);
        } catch (e) { errorToast(e); btn.disabled = false; }
      });
      content.append(h("div", { class: "stack", style: { gap: "16px" } },
        h("div", { class: "field" }, h("label", null, "Gültig für"), days),
        h("div", { class: "field" }, h("label", null, "Passwort"), pw, h("div", { class: "hint" }, "Ohne Passwort reicht der Link allein.")),
        location.hostname.match(/^(\d+\.){3}\d+$|\.local$|\.lan$|^localhost$/) ? callout("info", "Nur im Heimnetz", "Du nutzt FileHelper über die Heimnetz-Adresse. Damit der Link auch von unterwegs geht, FileHelper über deinen Proxy (z. B. Nginx Proxy Manager) mit eigener Domain erreichbar machen.") : null),
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
    };
    const result = (link) => {
      clear(content);
      const url = `${location.origin}/s/${link.token}`;
      const inp = h("input", { class: "input", value: url, readonly: true, onclick: (e) => e.target.select() });
      content.append(h("div", { class: "stack", style: { gap: "14px" } },
        callout("ok", "Link erstellt", link.expires ? `Gültig bis ${dateTime(link.expires)}.` : "Gültig, bis du ihn löschst (unter „Geteilte Links“)."),
        h("div", { class: "link-box" }, inp, h("button", { class: "btn primary", onclick: async () => { const { copyText } = await import("./core.js"); if (await copyText(url)) toast("Link kopiert"); } }, icon("copy", "sm"), "Kopieren")),
        navigator.share ? h("button", { class: "btn block", onclick: () => navigator.share({ title: name, url }).catch(() => {}) }, icon("share", "sm"), "Über eine App teilen") : null),
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Fertig")));
    };
    form();
  });
}

// ---------- Menü für ein Element ----------
export function itemMenu(ctx, item, { onChange, onOpen } = {}) {
  const path = itemPath(ctx, item);
  const writable = ctx.writable;
  const fav = isFavorite(ctx.share, path);
  return [
    { icon: item.dir ? "folder" : "eye", label: item.dir ? "Öffnen" : "Ansehen", onClick: () => onOpen?.(item) },
    { icon: "download", label: item.dir ? "Als ZIP herunterladen" : "Herunterladen", onClick: () => download(ctx, [item]) },
    !state.user.readonly ? { icon: "link", label: "Link teilen", onClick: () => shareLink(ctx, item) } : null,
    { icon: "star", label: fav ? "Aus Favoriten entfernen" : "Zu Favoriten", onClick: () => toggleFavorite(ctx.share, path, item.name, item.dir) },
    "-",
    { icon: "edit", label: "Umbenennen", disabled: !writable, onClick: () => rename(ctx, item, onChange) },
    { icon: "move", label: "Verschieben …", disabled: !writable, onClick: () => transfer(ctx, [item], "move", onChange) },
    { icon: "copy", label: "Kopieren nach …", disabled: state.user.readonly, onClick: () => transfer(ctx, [item], "copy", onChange) },
    { icon: "info", label: "Eigenschaften", onClick: () => properties(ctx, item) },
    "-",
    { icon: "trash", label: "Löschen", danger: true, disabled: !writable, onClick: () => remove(ctx, [item], onChange) },
  ];
}

export function menuHead(item, sub) {
  return h("div", { class: "menu-head only-sm" }, fileIcon(item), h("div", null, h("div", { class: "title" }, item.name), sub ? h("div", { class: "muted small" }, sub) : null));
}

export { loader };
