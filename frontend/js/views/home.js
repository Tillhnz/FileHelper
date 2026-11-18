// ===========================================================================
// Start: Freigaben im Überblick, Favoriten
// ===========================================================================
import { h, icon, clear, state, bytes, pct, meter, pageHead, empty, callout, fileIcon, api, errorToast } from "../core.js";

const COLORS = ["#2f6df6", "#17a364", "#8a4fff", "#e0571c", "#1a9a9a", "#e0457b", "#c98a05"];
const FS_LABEL = { nfs: "NFS", nfs4: "NFS", cifs: "SMB", smb3: "SMB", "fuse.sshfs": "SSHFS", zfs: "ZFS", ext4: "Laufwerk", xfs: "Laufwerk", btrfs: "Laufwerk" };

export function shareColor(name) {
  const i = Math.max(0, state.shares.findIndex(s => s.name === name));
  return COLORS[i % COLORS.length];
}

function shareCard(s) {
  const used = s.total ? s.total - s.free : null;
  const href = `#/f/${encodeURIComponent(s.name)}`;
  return h("a", { class: "card clickable share-card", href, style: { color: "inherit" } },
    h("div", { class: "s-top" },
      h("div", { class: "folder-ico nas", style: { "--c": shareColor(s.name) } }, icon(s.mounted ? "hdd" : "folder")),
      h("div", { class: "grow" },
        h("div", { class: "s-name" }, s.label),
        h("div", { class: "row wrap", style: { gap: "6px", marginTop: "4px" } },
          s.stale ? h("span", { class: "badge bad" }, "antwortet nicht") : null,
          !s.stale && !s.writable ? h("span", { class: "badge" }, icon("lock", "sm"), "nur lesen") : null,
          s.fstype && FS_LABEL[s.fstype] ? h("span", { class: "badge info" }, FS_LABEL[s.fstype]) : null,
          s.hidden ? h("span", { class: "badge warn" }, "ausgeblendet") : null)),
      icon("chevronRight", "sm")),
    s.total ? h("div", null,
      h("div", { class: "row small muted", style: { marginBottom: "6px" } }, h("span", null, `${bytes(s.free)} frei`), h("span", { class: "spacer" }), h("span", null, `von ${bytes(s.total)}`)),
      meter(pct(used, s.total))) : h("div", { class: "muted small" }, s.stale ? "Die NAS ist gerade nicht erreichbar." : "Speicherplatz unbekannt"));
}

export function howToAdd() {
  const step = (n, title, text) => h("div", { class: "row", style: { alignItems: "flex-start", gap: "12px" } },
    h("div", { class: "step-num accent" }, n), h("div", null, h("strong", null, title), h("p", { class: "muted", style: { margin: "2px 0 0" } }, text)));
  return h("div", { class: "card", style: { marginTop: "18px" } },
    h("h3", null, "So kommen weitere Ordner in den FileHelper"),
    h("p", { class: "muted", style: { margin: "4px 0 16px" } }, "FileHelper zeigt jeden Ordner, der im Container unter ", h("span", { class: "mono" }, state.root || "/mnt"), " eingebunden ist. Am einfachsten geht das mit der Proxmox Zentrale:"),
    h("div", { class: "stack", style: { gap: "14px" } },
      step(1, "NAS verbinden", "Proxmox Zentrale → Speicher & NAS → „NAS-Freigabe verbinden“ (SMB oder NFS)."),
      step(2, "Im FileHelper anzeigen", "Bei der Freigabe auf „Im FileHelper anzeigen“ tippen und den Ordner auswählen."),
      step(3, "Fertig", "Der Container startet kurz neu – danach erscheint der Ordner hier als eigene Freigabe.")));
}

export async function renderHome({ el, page, refreshShares }) {
  const hour = new Date().getHours();
  const greet = hour < 11 ? "Guten Morgen" : hour < 18 ? "Hallo" : "Guten Abend";
  el.append(pageHead(`${greet}, ${state.user.name}`, "Deine Freigaben und Favoriten auf einen Blick."));
  const body = h("div");
  el.append(body);

  const draw = () => {
    clear(body);
    if (!state.shares.length) {
      body.append(h("div", { class: "card" }, empty("folder", "Noch keine Ordner freigegeben",
        "FileHelper läuft – jetzt fehlen nur noch die Ordner deiner NAS. Gib sie in der Proxmox Zentrale für den FileHelper frei.")), howToAdd());
      return;
    }
    body.append(h("div", { class: "grid cols-2" }, state.shares.map(shareCard)));
    if (state.favorites.length) {
      body.append(h("h2", { class: "section" }, icon("star", "sm"), "Favoriten"), favList(state.favorites.slice(0, 8)));
    }
    if (state.user.admin) body.append(h("details", { style: { marginTop: "26px" } }, h("summary", { class: "muted", style: { cursor: "pointer", fontWeight: 600 } }, "Weitere Ordner hinzufügen"), howToAdd()));
  };
  draw();
  page.on("fh:shares", draw);
  refreshShares().then(draw);
}

function favHref(f) {
  const parts = [f.share, ...(f.path ? f.path.split("/") : [])];
  if (!f.dir) parts.pop();
  return "#/f/" + parts.map(encodeURIComponent).join("/");
}

function favList(favs) {
  return h("div", { class: "card pad-0" }, h("div", { class: "list" }, favs.map(f => {
    const share = state.shares.find(s => s.name === f.share);
    const name = f.name || f.path.split("/").pop() || share?.label || f.share;
    const item = { name, dir: f.dir, kind: f.dir ? "folder" : "file" };
    return h("a", { class: "list-item clickable", href: favHref(f) + (f.dir ? "" : `?open=${encodeURIComponent(name)}`), style: { color: "inherit" } },
      fileIcon(item),
      h("div", { class: "grow" }, h("div", { class: "title" }, name), h("div", { class: "meta" }, [share?.label || f.share, ...(f.path ? f.path.split("/").slice(0, -1) : [])].join(" › "))),
      icon("chevronRight", "sm"));
  })));
}

export async function renderFavorites({ el }) {
  el.append(pageHead("Favoriten", "Ordner und Dateien, die du oft brauchst."));
  if (!state.favorites.length) {
    el.append(h("div", { class: "card" }, empty("star", "Noch keine Favoriten", "Tippe bei einem Ordner oder einer Datei auf „⋯“ und dann auf „Zu Favoriten“.")));
    return;
  }
  const list = favList(state.favorites);
  el.append(list);
  // Favoriten entfernen
  const edit = h("button", { class: "btn sm ghost", style: { marginTop: "12px" }, onclick: async () => {
    const { openSheet } = await import("../core.js");
    openSheet((sheet, close) => {
      const box = h("div", { class: "card pad-0 flat" });
      const redraw = () => {
        clear(box).append(h("div", { class: "list" }, state.favorites.map((f, i) => h("div", { class: "list-item" },
          h("div", { class: "grow" }, h("div", { class: "title" }, f.name || f.path || f.share), h("div", { class: "meta" }, `${f.share}/${f.path}`)),
          h("button", { class: "btn sm danger-ghost", onclick: async () => {
            const favs = state.favorites.filter((_, j) => j !== i);
            try { state.favorites = (await api("/me/favorites", { method: "PUT", body: { favorites: favs } })).favorites; redraw(); } catch (e) { errorToast(e); }
          } }, "Entfernen")))));
      };
      redraw();
      sheet.append(h("h2", null, "Favoriten bearbeiten"), box, h("div", { class: "sheet-foot" }, h("button", { class: "btn primary", onclick: () => { close(); location.reload(); } }, "Fertig")));
    });
  } }, icon("edit", "sm"), "Bearbeiten");
  el.append(edit);
  if (!state.shares.length) el.append(callout("warn", "Keine Freigaben sichtbar", "Die Ordner deiner Favoriten sind gerade nicht eingebunden."));
}
