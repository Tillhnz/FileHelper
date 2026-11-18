// ===========================================================================
// Öffentliche Seite eines geteilten Links (ohne Anmeldung)
// ===========================================================================
import { h, icon, clear, api, qs, bytes, shortDate, dateTime, fileIcon, loader, empty, callout, joinPath, extOf } from "./core.js";
import { MODEL_EXTS, openModel } from "./model3d.js";

const token = location.pathname.split("/")[2];
const base = `/s/${encodeURIComponent(token)}`;
const app = document.getElementById("app");
const sapi = (path, opts = {}) => api(path, { ...opts, base });
const fileHref = (path, dl) => `${base}/file${qs({ path, dl: dl ? 1 : undefined })}`;
const thumbHref = (path, s = 512) => `${base}/thumb${qs({ path, s })}`;

function frame(...children) {
  clear(app).append(h("div", { class: "public-wrap" },
    h("div", { class: "public-top" }, h("div", { class: "brand", style: { padding: 0 } }, h("div", { class: "brand-mark" }, icon("folder")), h("div", null, "FileHelper", h("small", null, "Mit dir geteilt")))),
    ...children));
}

async function boot() {
  frame(loader());
  let info;
  try { info = await sapi("/info"); }
  catch (e) { frame(h("div", { class: "card" }, empty("link", "Link nicht verfügbar", e.message))); return; }
  document.title = `${info.name} – FileHelper`;
  if (info.locked) return passwordForm(info);
  if (info.dir) return folder(info, "");
  single(info);
}

function passwordForm(info) {
  const pw = h("input", { class: "input", type: "password", autocomplete: "off", placeholder: "Passwort" });
  const errBox = h("div");
  const btn = h("button", { class: "btn primary block", type: "submit" }, "Öffnen");
  const form = h("form", { class: "stack", style: { gap: "14px" } }, pw, errBox, btn);
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); clear(errBox); btn.disabled = true;
    try { await sapi("/auth", { method: "POST", body: { password: pw.value } }); boot(); }
    catch (err) { errBox.append(callout("bad", null, err.message)); btn.disabled = false; pw.select(); }
  });
  frame(h("div", { class: "card", style: { maxWidth: "420px", margin: "40px auto" } },
    h("div", { class: "row", style: { gap: "12px", marginBottom: "16px" } }, h("div", { class: "folder-ico" }, icon("lock")),
      h("div", null, h("strong", null, info.name), h("div", { class: "muted small" }, "Dieser Link ist mit einem Passwort geschützt."))), form));
  setTimeout(() => pw.focus(), 50);
}

function single(info) {
  const item = { name: info.name, kind: info.kind, size: info.size };
  let preview = null;
  if (info.error) preview = callout("bad", null, info.error);
  else if (info.kind === "image" && (!info.convert || info.thumb)) preview = h("img", { class: "preview", src: info.convert ? thumbHref("", 2048) : fileHref(""), alt: info.name });
  else if (info.kind === "video") preview = h("video", { src: fileHref(""), controls: true, playsinline: true, preload: "metadata" });
  else if (info.kind === "audio") preview = h("audio", { src: fileHref(""), controls: true, style: { width: "min(420px, 90vw)" } });
  else if (info.kind === "model" && MODEL_EXTS.has(extOf(info.name)) && info.size < 400 * 1024 * 1024) {
    preview = h("div", { class: "public-model" });
    setTimeout(() => openModel(preview, { url: fileHref(""), ext: extOf(info.name), size: info.size }), 0);
  }
  frame(h("div", { class: "card public-file" },
    preview || fileIcon(item),
    h("div", null, h("h1", null, info.name), h("div", { class: "muted", style: { marginTop: "6px" } }, [bytes(info.size), shortDate(info.mtime)].filter(Boolean).join(" · "))),
    !info.error ? h("a", { class: "btn primary lg", href: fileHref("", true) }, icon("download", "sm"), "Herunterladen") : null,
    info.expires ? h("div", { class: "muted small" }, `Link gültig bis ${dateTime(info.expires)}`) : null));
}

async function folder(info, path) {
  frame(loader());
  let r;
  try { r = await sapi("/list", { query: { path } }); }
  catch (e) { frame(callout("bad", "Ordner kann nicht geöffnet werden", e.message)); return; }
  const parts = path ? path.split("/") : [];
  const crumbs = h("div", { class: "crumbs", style: { display: "flex" } },
    parts.length ? h("a", { href: "#", onclick: (e) => { e.preventDefault(); folder(info, ""); } }, info.name) : h("span", { class: "cur" }, info.name),
    parts.map((p, i) => [icon("chevronRight", "sm"), i === parts.length - 1 ? h("span", { class: "cur" }, p) : h("a", { href: "#", onclick: (e) => { e.preventDefault(); folder(info, parts.slice(0, i + 1).join("/")); } }, p)]));
  const coll = new Intl.Collator("de", { numeric: true, sensitivity: "base" });
  const items = r.items.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : coll.compare(a.name, b.name)));
  const images = items.filter(i => i.kind === "image" && i.thumb);
  const zipName = parts.length ? parts[parts.length - 1] : info.name;
  const photoMode = images.length >= 4 && images.length / items.length > 0.6;
  const open = (i, p) => (i.dir ? folder(info, p) : window.open(i.convert && i.thumb ? thumbHref(p, 2048) : fileHref(p, false), "_blank", "noopener"));
  const tiles = h("div", { class: "tiles" }, items.map(i => {
    const p = joinPath(path, i.name);
    const th = h("div", { class: "t-thumb" });
    if (i.thumb) { const img = h("img", { src: thumbHref(p, 512), loading: "lazy", alt: "" }); img.addEventListener("error", () => img.replaceWith(fileIcon(i))); th.append(img); }
    else th.append(fileIcon(i));
    return h("div", { class: "tile", onclick: () => open(i, p) }, th, h("div", { class: "t-name" }, i.name), h("div", { class: "t-meta" }, i.dir ? "Ordner" : bytes(i.size)));
  }));
  const list = h("div", { class: "files" }, items.map(i => {
    const p = joinPath(path, i.name);
    const ic = fileIcon(i);
    if (i.thumb) { const img = h("img", { src: thumbHref(p, 256), loading: "lazy", alt: "" }); img.addEventListener("error", () => img.remove()); ic.append(img); }
    const row = h("div", { class: "file-row", style: { gridTemplateColumns: "minmax(0,1fr) auto" } },
      h("div", { class: "f-main" }, ic, h("div", { style: { minWidth: 0 } }, h("div", { class: "f-name" }, i.name),
        h("div", { class: "muted small" }, i.dir ? "Ordner" : `${bytes(i.size)} · ${shortDate(i.mtime)}`))),
      i.dir ? icon("chevronRight", "sm") : h("a", { class: "btn icon sm ghost", href: fileHref(p, true), title: "Herunterladen", onclick: (e) => e.stopPropagation() }, icon("download", "sm")));
    row.addEventListener("click", () => open(i, p));
    return row;
  }));
  frame(
    h("div", { class: "row wrap", style: { gap: "12px", marginBottom: "14px" } },
      h("div", { style: { flex: 1, minWidth: 0 } }, h("h1", { style: { margin: "0 0 4px", fontSize: "24px", letterSpacing: "-.02em", wordBreak: "break-word" } }, zipName), parts.length ? crumbs : null),
      items.length ? h("a", { class: "btn primary", href: `${base}/zip${qs({ path })}` }, icon("download", "sm"), "Alles als ZIP") : null),
    items.length ? (photoMode ? tiles : list) : h("div", { class: "card" }, empty("folder", "Dieser Ordner ist leer")),
    info.expires ? h("p", { class: "muted small", style: { marginTop: "14px" } }, `Link gültig bis ${dateTime(info.expires)}`) : null);
}

boot();
