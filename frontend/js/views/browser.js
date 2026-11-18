// ===========================================================================
// Ordneransicht: Liste/Kacheln, Suche, Auswahl, Ziehen & Ablegen, Hochladen
// ===========================================================================
import {
  h, icon, clear, api, state, toast, errorToast, bytes, shortDate, fileIcon, thumbUrl, canThumb, plural, joinPath,
  openMenu, loader, empty, callout, isMobile, KIND_LABEL,
} from "../core.js";
import * as A from "../actions.js";
import { startUpload, collectDropped, pickFiles } from "../upload.js";
import { openViewer } from "./viewer.js";
import { howToAdd } from "./home.js";

const PAGE = 250;
const prefs = (() => { try { return JSON.parse(localStorage.getItem("fh-prefs") || "{}"); } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem("fh-prefs", JSON.stringify(prefs)); } catch { /* */ } };

// Ab dieser Fensterbreite öffnet sich die Vorschau rechts neben der Liste statt als Vollbild
const WIDE = window.matchMedia("(min-width: 1180px)");

export async function renderBrowser({ page, el, share, path, refreshShares, open }) {
  // Aufteilung: links Dateien, rechts (auf großen Bildschirmen) die Vorschau
  const paneHost = h("aside", { class: "preview-pane" });
  const split = h("div", { class: "browse-split" }, h("div", { class: "browse-left" }), paneHost);
  if (prefs.paneW) split.style.setProperty("--pane-w", `${prefs.paneW}px`);
  el.append(split);
  el = split.firstChild;
  const shareInfo = state.shares.find(s => s.name === share);
  const ctx = { share, path, writable: false };
  const v = {
    items: [], filter: "", search: null, searching: false, sel: new Set(), lastIdx: null,
    sort: prefs.sort || { key: "name", dir: 1 }, view: (prefs.views || {})[`${share}/${path}`] || null,
    hidden: !!prefs.hidden, shown: PAGE, loaded: false, info: null, ignoreClickUntil: 0,
  };

  // ---------- Kopf ----------
  const label = shareInfo?.label || share;
  const parts = path ? path.split("/") : [];
  const title = parts.length ? parts[parts.length - 1] : label;
  const href = (n) => "#/f/" + [share, ...parts.slice(0, n)].map(encodeURIComponent).join("/");
  const up = parts.length ? href(parts.length - 1) : "#/";
  const favBtn = h("button", { class: "btn icon ghost", title: "Favorit" });
  const drawFav = () => { clear(favBtn).append(icon("star", "sm")); favBtn.style.color = A.isFavorite(share, path) ? "var(--warn)" : ""; favBtn.querySelector("svg").style.fill = A.isFavorite(share, path) ? "currentColor" : "none"; };
  favBtn.addEventListener("click", async () => { await A.toggleFavorite(share, path, title, true); drawFav(); });
  drawFav();
  const crumbs = h("div", { class: "crumbs" },
    h("a", { href: "#/" }, "Start"), icon("chevronRight", "sm"),
    parts.length ? h("a", { href: href(0) }, label) : h("span", { class: "cur" }, label),
    parts.map((p, i) => [icon("chevronRight", "sm"), i === parts.length - 1 ? h("span", { class: "cur" }, p) : h("a", { href: href(i + 1) }, p)]));
  const newBtn = h("button", { class: "btn primary" }, icon("plus", "sm"), h("span", { class: "hide-sm" }, "Neu"));
  const moreBtn = h("button", { class: "btn icon", title: "Mehr" }, icon("more"));
  el.append(h("div", { class: "hide-sm-block", style: { marginBottom: "6px" } }, crumbs),
    h("div", { class: "browser-head" },
      h("a", { class: "btn icon ghost", href: up, title: "Eine Ebene höher" }, icon("chevronLeft")),
      h("h1", null, title), favBtn, h("span", { class: "spacer" }), newBtn, moreBtn));

  // ---------- Werkzeugleiste ----------
  const qInput = h("input", { class: "input", type: "search", placeholder: isMobile() ? "Suchen …" : `In „${title}“ suchen …`, autocapitalize: "off", spellcheck: "false", enterkeyhint: "search" });
  const clearQ = h("button", { class: "btn icon sm ghost clear-q hidden", title: "Suche löschen", onclick: () => { qInput.value = ""; v.filter = ""; v.search = null; clearQ.classList.add("hidden"); draw(); } }, icon("x", "sm"));
  let qTimer = null;
  qInput.addEventListener("input", () => {
    v.filter = qInput.value.trim(); v.search = null; v.shown = PAGE;
    clearQ.classList.toggle("hidden", !v.filter);
    clearTimeout(qTimer); qTimer = setTimeout(draw, 80);
  });
  qInput.addEventListener("keydown", (e) => { if (e.key === "Enter") deepSearch(); if (e.key === "Escape") clearQ.click(); });
  const viewBtns = h("div", { class: "view-toggle" });
  function drawViewBtns() { clear(viewBtns).append(
    [["list", "rows", "Liste"], ["grid", "grid", "Kacheln"], ["photos", "image", "Fotos"]].map(([k, ic, t]) =>
      h("button", { class: v.view === k ? "active" : "", title: t, "aria-label": t, onclick: () => setView(k) }, icon(ic, "sm")))); }
  const setView = (k) => { v.view = k; if (k !== "photos") prefs.view = k; prefs.views = { ...(prefs.views || {}), [`${share}/${path}`]: k }; savePrefs(); drawViewBtns(); draw(); };
  drawViewBtns();
  el.append(h("div", { class: "toolbar" },
    h("div", { class: "input-wrap search" }, icon("search", "sm"), qInput, clearQ),
    viewBtns));

  const selbarHost = h("div");
  const infoLine = h("div", { class: "row wrap muted small", style: { margin: "0 2px 10px", gap: "8px" } });
  const body = h("div", null, loader());
  el.append(selbarHost, infoLine, body);

  // ---------- Laden ----------
  async function load({ keepSel = false } = {}) {
    try {
      const r = await api("/list", { query: { share, path } });
      v.items = r.items; v.info = r; v.loaded = true;
      if (!v.view) {
        // Ordner voller Fotos automatisch als Kacheln zeigen
        const files = r.items.filter(i => !i.dir && !i.hidden);
        const media = files.filter(i => i.kind === "image" || i.kind === "video").length;
        v.view = files.length >= 4 && media / files.length > 0.6 ? "grid" : prefs.view || "list";
        drawViewBtns();
      }
      ctx.writable = r.writable;
      if (!keepSel) v.sel.clear(); else for (const n of [...v.sel]) if (!r.items.some(i => i.name === n)) v.sel.delete(n);
      draw();
    } catch (e) {
      if (e.status === 401) return;
      clear(body).append(e.status === 404 && !parts.length
        ? h("div", null, h("div", { class: "card" }, empty("folder", "Freigabe nicht gefunden", "Dieser Ordner ist im FileHelper (nicht mehr) eingebunden.")), howToAdd())
        : callout("bad", "Ordner kann nicht geöffnet werden", e.message));
      clear(infoLine);
    }
  }
  const reload = () => load({ keepSel: true });
  let upTimer = null;
  page.on("fh:uploaded", (e) => { if (e.detail.share === share && e.detail.path === path) { clearTimeout(upTimer); upTimer = setTimeout(reload, 500); } });
  page.cleanup.push(() => clearTimeout(upTimer));

  // ---------- Daten aufbereiten ----------
  function visible() {
    let items = v.search ? v.search.items : v.items;
    if (!v.hidden) items = items.filter(i => !i.hidden);
    if (v.filter && !v.search) { const words = v.filter.toLowerCase().split(/\s+/); items = items.filter(i => words.every(w => i.name.toLowerCase().includes(w))); }
    const { key, dir } = v.sort;
    const coll = new Intl.Collator("de", { numeric: true, sensitivity: "base" });
    return [...items].sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      let c = 0;
      if (key === "size") c = (a.size || 0) - (b.size || 0);
      else if (key === "mtime") c = a.mtime - b.mtime;
      else if (key === "kind") c = coll.compare(a.kind, b.kind) || coll.compare(a.name, b.name);
      if (!c) c = coll.compare(a.name, b.name);
      return c * dir;
    });
  }
  const keyOf = (i) => (i.parent ? `${i.parent}/${i.name}` : i.name);
  const selected = () => visible().filter(i => v.sel.has(keyOf(i)));

  // ---------- Zeichnen ----------
  function draw() {
    if (!v.loaded) return;
    const items = visible();
    clear(body);
    const selecting = v.sel.size > 0;
    body.classList.toggle("selecting", selecting);
    drawSelbar();
    drawInfo(items);
    if (v.searching) { body.append(loader()); return; }
    if (!items.length) {
      if (v.filter) {
        body.append(h("div", { class: "card" }, empty("search", v.search ? "Nichts gefunden" : "Nichts in diesem Ordner gefunden",
          v.search ? `Auch in den Unterordnern gibt es nichts mit „${v.filter}“.` : "Mit der Eingabetaste suchst du auch in allen Unterordnern.",
          !v.search ? h("button", { class: "btn", onclick: deepSearch }, icon("search", "sm"), "In Unterordnern suchen") : null)));
      } else {
        body.append(h("div", { class: "card" }, empty("folder", "Dieser Ordner ist leer",
          ctx.writable ? (isMobile() ? "Tippe auf „Hochladen“, um Dateien hinzuzufügen." : "Zieh Dateien hierher oder nutze „Neu“ → „Dateien hochladen“.") : "Hier liegen noch keine Dateien.",
          ctx.writable ? h("button", { class: "btn primary", onclick: uploadFiles }, icon("upload", "sm"), "Dateien hochladen") : null)));
      }
      return;
    }
    const slice = items.slice(0, v.shown);
    const container = v.view === "list" ? listView(slice, items) : tileView(slice, items);
    body.append(container);
    if (items.length > v.shown) {
      const more = h("div", { class: "loader", style: { padding: "24px" } }, h("button", { class: "btn", onclick: () => { v.shown += PAGE * 2; draw(); } }, `Weitere ${plural(items.length - v.shown, "Element", "Elemente")} anzeigen`));
      body.append(more);
      const io = new IntersectionObserver((ents) => { if (ents.some(e => e.isIntersecting)) { io.disconnect(); v.shown += PAGE * 2; draw(); } }, { rootMargin: "600px" });
      io.observe(more);
      page.cleanup.push(() => io.disconnect());
    }
  }

  function drawInfo(items) {
    clear(infoLine);
    if (v.search) {
      infoLine.append(h("span", null, `${plural(items.length, "Treffer", "Treffer")} für „${v.filter}“ in „${title}“ und Unterordnern${v.search.complete ? "" : " (Suche abgebrochen – zu viele Dateien)"}`),
        h("button", { class: "btn sm ghost", onclick: () => clearQ.click() }, "Suche beenden"));
      return;
    }
    const dirs = items.filter(i => i.dir).length;
    const files = items.length - dirs;
    const size = items.reduce((s, i) => s + (i.size || 0), 0);
    const bits = [];
    if (dirs) bits.push(plural(dirs, "Ordner", "Ordner"));
    if (files) bits.push(`${plural(files, "Datei", "Dateien")} · ${bytes(size)}`);
    infoLine.append(h("span", null, bits.join(", ") || "Leer"));
    if (!ctx.writable) infoLine.append(h("span", { class: "badge" }, icon("lock", "sm"), state.user.readonly ? "Nur ansehen" : "Nur lesen"));
    if (v.info?.truncated) infoLine.append(h("span", { class: "badge warn" }, "Sehr großer Ordner – nur 20.000 Einträge"));
    if (v.info?.free != null && ctx.writable) infoLine.append(h("span", { class: "spacer" }), h("span", { class: "hide-sm" }, `${bytes(v.info.free)} frei`));
  }

  function sortHead(key, labelText) {
    const on = v.sort.key === key;
    return h("button", { class: on ? "on" : "", onclick: () => { v.sort = { key, dir: on ? -v.sort.dir : 1 }; prefs.sort = v.sort; savePrefs(); draw(); } },
      labelText, on ? icon(v.sort.dir > 0 ? "arrowUp" : "arrowDown", "sm") : null);
  }

  function listView(slice, all) {
    const allSel = all.length && all.every(i => v.sel.has(keyOf(i)));
    const someSel = !allSel && all.some(i => v.sel.has(keyOf(i)));
    const headCbx = h("div", { class: `cbx ${allSel ? "on" : someSel ? "part" : ""}`, onclick: () => { if (allSel) v.sel.clear(); else all.forEach(i => v.sel.add(keyOf(i))); draw(); } }, icon(someSel ? "minus" : "check"));
    const wrap = h("div", { class: "files" },
      h("div", { class: "files-head" }, headCbx, sortHead("name", "Name"), h("div", { style: { textAlign: "right" } }, sortHead("size", "Größe")), sortHead("mtime", "Geändert"), h("div")));
    slice.forEach((item, idx) => wrap.append(row(item, idx, all)));
    return wrap;
  }

  function thumbOrIcon(item, size = 256) {
    const ic = fileIcon(item);
    if (canThumb(item)) {
      const img = h("img", { src: thumbUrl(share, A.itemPath(ctx, item), size), alt: "", loading: "lazy", decoding: "async" });
      img.addEventListener("error", () => img.remove(), { once: true });
      ic.append(img);
    } else if (!item.dir) {
      const e = item.name.includes(".") ? item.name.split(".").pop().slice(0, 4) : "";
      if (e && ["file", "text", "doc", "sheet", "slides", "archive", "design"].includes(item.kind)) ic.append(h("span", { class: "ext" }, e));
    }
    return ic;
  }

  function subline(item) {
    if (item.parent) return `in ${item.parent === "/" ? title : item.parent}`;
    return item.dir ? shortDate(item.mtime) : `${bytes(item.size)} · ${shortDate(item.mtime)}`;
  }

  function row(item, idx, all) {
    const k = keyOf(item);
    const isSel = v.sel.has(k);
    const more = h("button", { class: "btn icon sm ghost", title: "Aktionen", onclick: (e) => { e.stopPropagation(); menu(item, more); } }, icon("more"));
    const r = h("div", { class: `file-row ${isSel ? "sel" : ""} ${item.hidden ? "hidden-file" : ""} ${activeKey === k ? "active" : ""}`, role: "row", tabindex: "0", "data-key": k },
      h("div", { class: "cbx-cell" }, h("div", { class: "cbx", onclick: (e) => { e.stopPropagation(); toggleSel(item, idx, all, e.shiftKey); } }, icon("check"))),
      h("div", { class: "f-main" }, thumbOrIcon(item, 256),
        h("div", { style: { minWidth: 0 } }, h("div", { class: "f-name" }, item.name), h("div", { class: "f-sub" }, subline(item)))),
      h("div", { class: "f-size" }, item.dir ? "" : bytes(item.size)),
      h("div", { class: "f-date" }, item.parent ? h("span", { title: item.parent }, item.parent === "/" ? "–" : item.parent.split("/").pop()) : shortDate(item.mtime)),
      more);
    bindItem(r, item, idx, all);
    return r;
  }

  function tileView(slice, all) {
    const photos = v.view === "photos";
    const wrap = h("div", { class: `tiles ${photos ? "photos" : ""}` });
    slice.forEach((item, idx) => {
      const isSel = v.sel.has(keyOf(item));
      const thumb = h("div", { class: "t-thumb" });
      if (canThumb(item)) {
        const img = h("img", { src: thumbUrl(share, A.itemPath(ctx, item), photos ? 256 : 512), alt: "", loading: "lazy", decoding: "async" });
        img.addEventListener("error", () => { img.replaceWith(fileIcon(item)); }, { once: true });
        thumb.append(img);
        if (item.kind === "video") thumb.append(h("div", { class: "play" }, icon("play")));
      } else thumb.append(fileIcon(item));
      const more = h("button", { class: "btn icon sm ghost t-more", title: "Aktionen", onclick: (e) => { e.stopPropagation(); menu(item, more); } }, icon("more"));
      const t = h("div", { class: `tile ${isSel ? "sel" : ""} ${activeKey === keyOf(item) ? "active" : ""}`, tabindex: "0", "data-key": keyOf(item) },
        h("div", { class: "cbx", onclick: (e) => { e.stopPropagation(); toggleSel(item, idx, all, e.shiftKey); } }, icon("check")),
        more, thumb, h("div", { class: "t-name" }, item.name), h("div", { class: "t-meta" }, item.dir ? "Ordner" : bytes(item.size)));
      bindItem(t, item, idx, all);
      wrap.append(t);
    });
    return wrap;
  }

  // ---------- Bedienung eines Elements ----------
  function bindItem(node, item, idx, all) {
    let pressTimer = null, startX = 0, startY = 0;
    node.addEventListener("click", (e) => {
      if (Date.now() < v.ignoreClickUntil) return; // Klick direkt nach langem Drücken ignorieren
      if (e.metaKey || e.ctrlKey) return toggleSel(item, idx, all, false);
      if (e.shiftKey && v.lastIdx !== null) return toggleSel(item, idx, all, true);
      if (v.sel.size) return toggleSel(item, idx, all, false);
      openItem(item);
    });
    node.addEventListener("keydown", (e) => { if (e.key === "Enter") openItem(item); if (e.key === " ") { e.preventDefault(); toggleSel(item, idx, all, e.shiftKey); } });
    node.addEventListener("contextmenu", (e) => {
      if (isMobile()) { e.preventDefault(); return; }
      e.preventDefault();
      menu(item, { x: e.clientX, y: e.clientY });
    });
    // Langes Drücken (Handy) = Auswahl starten
    node.addEventListener("touchstart", (e) => {
      const t = e.touches[0]; startX = t.clientX; startY = t.clientY;
      pressTimer = setTimeout(() => { v.ignoreClickUntil = Date.now() + 700; navigator.vibrate?.(15); if (!v.sel.has(keyOf(item))) toggleSel(item, idx, all, false); }, 450);
    }, { passive: true });
    node.addEventListener("touchmove", (e) => { const t = e.touches[0]; if (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) clearTimeout(pressTimer); }, { passive: true });
    node.addEventListener("touchend", () => clearTimeout(pressTimer));
    node.addEventListener("touchcancel", () => clearTimeout(pressTimer));

    // Ziehen innerhalb des FileHelpers (Desktop): auf einen Ordner ablegen = verschieben
    if (ctx.writable && !isMobile() && !item.parent) {
      node.draggable = true;
      node.addEventListener("dragstart", (e) => {
        if (!v.sel.has(keyOf(item))) { v.sel.clear(); v.sel.add(keyOf(item)); draw(); }
        const names = selected().map(i => i.name);
        e.dataTransfer.setData("application/x-filehelper", JSON.stringify({ share, path, names }));
        e.dataTransfer.effectAllowed = "copyMove";
      });
    }
    if (item.dir && ctx.writable && !item.parent) {
      node.addEventListener("dragover", (e) => {
        const internal = e.dataTransfer.types.includes("application/x-filehelper");
        if (!internal && !e.dataTransfer.types.includes("Files")) return;
        if (internal && v.sel.has(keyOf(item))) return;
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = internal ? (e.altKey || e.ctrlKey ? "copy" : "move") : "copy";
        node.classList.add("drop-target");
      });
      node.addEventListener("dragleave", () => node.classList.remove("drop-target"));
      node.addEventListener("drop", async (e) => {
        node.classList.remove("drop-target");
        const raw = e.dataTransfer.getData("application/x-filehelper");
        e.preventDefault(); e.stopPropagation();
        hideDrop();
        const destPath = joinPath(path, item.name);
        if (raw) {
          const d = JSON.parse(raw);
          const items = v.items.filter(i => d.names.includes(i.name));
          const mode = e.altKey || e.ctrlKey ? "copy" : "move";
          await A.transfer({ share: d.share, path: d.path, writable: true }, items, mode, reload, { share, path: destPath });
        } else {
          const files = await collectDropped(e.dataTransfer);
          if (files.length) startUpload(share, destPath, files);
        }
      });
    }
  }

  function toggleSel(item, idx, all, range) {
    const k = keyOf(item);
    if (range && v.lastIdx !== null) {
      const [a, b] = [Math.min(v.lastIdx, idx), Math.max(v.lastIdx, idx)];
      for (let i = a; i <= b; i++) v.sel.add(keyOf(all[i]));
    } else if (v.sel.has(k)) v.sel.delete(k); else v.sel.add(k);
    v.lastIdx = idx;
    draw();
  }

  function itemCtx(item) {
    // Bei Suchtreffern liegt das Element evtl. in einem Unterordner
    return item.parent ? { share, path: item.parent === "/" ? "" : item.parent, writable: ctx.writable } : ctx;
  }

  function openItem(item) {
    if (item.dir) {
      const p = item.parent ? joinPath(item.parent === "/" ? "" : item.parent, item.name) : joinPath(path, item.name);
      location.hash = "#/f/" + [share, ...p.split("/")].map(encodeURIComponent).join("/");
      return;
    }
    const c = itemCtx(item);
    const list = (item.parent ? visible().filter(i => !i.dir && i.parent === item.parent) : visible().filter(i => !i.dir));
    const index = Math.max(0, list.indexOf(item));
    if (usePane()) openPane(c, list, index);
    else openViewer({ ctx: c, items: list, index, onChange: reload, onShow: (it) => setActive(it, false) });
  }

  // ---------- Vorschau-Spalte (große Bildschirme) ----------
  let paneCtl = null, activeKey = null;
  const usePane = () => WIDE.matches && prefs.pane !== false;
  function setActive(item, scroll = true) {
    activeKey = item ? keyOf(item) : null;
    body.querySelectorAll(".file-row.active, .tile.active").forEach(n => n.classList.remove("active"));
    if (!activeKey) return;
    const node = [...body.querySelectorAll("[data-key]")].find(n => n.dataset.key === activeKey);
    if (node) { node.classList.add("active"); if (scroll) node.scrollIntoView({ block: "nearest" }); }
  }
  async function openPane(c, list, index) {
    if (paneCtl && !(await paneCtl.close())) return;
    split.classList.add("with-pane");
    clear(paneHost).append(resizer);
    paneCtl = openViewer({ ctx: c, items: list, index, onChange: reload, host: paneHost, onShow: (it) => setActive(it),
      onClose: () => { paneCtl = null; split.classList.remove("with-pane"); setActive(null); } });
  }
  const closePane = () => paneCtl?.close({ force: true });
  page.cleanup.push(closePane);
  const onWide = () => { if (!WIDE.matches) closePane(); };
  WIDE.addEventListener("change", onWide);
  page.cleanup.push(() => WIDE.removeEventListener("change", onWide));
  // Breite der Vorschau mit der Maus ziehen (wird gemerkt)
  const resizer = h("div", { class: "pane-resizer", title: "Breite ändern" });
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    const right = split.getBoundingClientRect().right;
    const move = (ev) => {
      const w = Math.round(Math.min(Math.max(right - ev.clientX, 360), split.clientWidth - 380));
      split.style.setProperty("--pane-w", `${w}px`);
      prefs.paneW = w;
    };
    const up = () => { resizer.removeEventListener("pointermove", move); resizer.removeEventListener("pointerup", up); savePrefs(); window.dispatchEvent(new Event("resize")); };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
  });
  resizer.addEventListener("dblclick", () => { delete prefs.paneW; savePrefs(); split.style.removeProperty("--pane-w"); });

  function menu(item, anchor) {
    const c = itemCtx(item);
    openMenu(anchor, A.itemMenu(c, item, { onChange: () => (v.search ? deepSearch() : reload()), onOpen: openItem }),
      { head: A.menuHead(item, item.dir ? "Ordner" : `${KIND_LABEL[item.kind] || "Datei"} · ${bytes(item.size)}`) });
  }

  // ---------- Auswahl-Leiste ----------
  function drawSelbar() {
    clear(selbarHost);
    if (!v.sel.size) return;
    const items = selected();
    const c = v.search ? { ...ctx } : ctx;
    const btn = (ic, labelText, fn, cls = "") => h("button", { class: `btn sm ${cls}`, onclick: fn }, icon(ic, "sm"), h("span", null, labelText));
    selbarHost.append(h("div", { class: "selbar" },
      h("span", { class: "count" }, plural(items.length, "ausgewählt", "ausgewählt")),
      btn("download", "Laden", () => A.download(c, items)),
      ctx.writable ? btn("move", "Verschieben", () => A.transfer(c, items, "move", () => { v.sel.clear(); reload(); })) : null,
      !state.user.readonly ? btn("copy", "Kopieren", () => A.transfer(c, items, "copy", () => { v.sel.clear(); reload(); })) : null,
      items.length === 1 && !state.user.readonly ? btn("link", "Teilen", () => A.shareLink(itemCtx(items[0]), items[0])) : null,
      ctx.writable ? btn("trash", "Löschen", () => A.remove(c, items, () => { v.sel.clear(); v.search ? deepSearch() : reload(); }), "danger-ghost") : null,
      btn("x", "Fertig", () => { v.sel.clear(); draw(); })));
  }

  // ---------- Suche in Unterordnern ----------
  async function deepSearch() {
    if ((v.filter || "").length < 2) return toast("Suchbegriff zu kurz", "Bitte mindestens 2 Zeichen eingeben.", "info");
    v.searching = true; v.sel.clear(); draw();
    try { v.search = await api("/search", { query: { share, path, q: v.filter } }); }
    catch (e) { errorToast(e, "Suche fehlgeschlagen"); v.search = null; }
    v.searching = false; v.shown = PAGE; draw();
  }

  // ---------- Neu / Hochladen ----------
  function uploadFiles() { pickFiles(false, (files) => startUpload(share, path, files)); }
  function uploadFolder() { pickFiles(true, (files) => startUpload(share, path, files)); }
  newBtn.addEventListener("click", () => {
    if (!ctx.writable) return toast("Nur lesen", state.user.readonly ? "Dein Konto darf nichts ändern." : "Diese Freigabe ist für FileHelper schreibgeschützt.", "info");
    openMenu(newBtn, [
      { icon: "upload", label: "Dateien hochladen", onClick: uploadFiles },
      { icon: "folder", label: "Ordner hochladen", onClick: uploadFolder },
      "-",
      { icon: "folderPlus", label: "Neuer Ordner", onClick: () => A.newFolder(ctx, reload) },
      { icon: "filePlus", label: "Neue Textdatei", onClick: () => A.newTextFile(ctx, reload) },
    ]);
  });
  moreBtn.addEventListener("click", () => openMenu(moreBtn, [
    { icon: "selectAll", label: "Alle auswählen", onClick: () => { visible().forEach(i => v.sel.add(keyOf(i))); draw(); } },
    { icon: "sort", label: `Sortieren: ${{ name: "Name", mtime: "Datum", size: "Größe", kind: "Art" }[v.sort.key]}`, onClick: sortSheet },
    { icon: v.hidden ? "eyeOff" : "eye", label: v.hidden ? "Versteckte Dateien ausblenden" : "Versteckte Dateien zeigen", onClick: () => { v.hidden = !v.hidden; prefs.hidden = v.hidden; savePrefs(); draw(); } },
    "-",
    { icon: "download", label: "Ordner als ZIP herunterladen", onClick: () => A.downloadFolder(share, path, title) },
    !state.user.readonly ? { icon: "link", label: "Link zu diesem Ordner teilen", onClick: () => A.shareLink(ctx, null) } : null,
    WIDE.matches ? { icon: "maximize", label: prefs.pane === false ? "Vorschau rechts neben der Liste" : "Vorschau als Vollbild öffnen",
      onClick: () => { prefs.pane = prefs.pane === false; savePrefs(); if (prefs.pane === false) closePane(); toast(prefs.pane === false ? "Vorschau öffnet als Vollbild" : "Vorschau öffnet rechts neben der Liste"); } } : null,
    { icon: "refresh", label: "Aktualisieren", onClick: () => { refreshShares(); load(); } },
  ]));

  function sortSheet() {
    const opts = [["name", 1, "Name (A–Z)"], ["name", -1, "Name (Z–A)"], ["mtime", -1, "Neueste zuerst"], ["mtime", 1, "Älteste zuerst"], ["size", -1, "Größte zuerst"], ["size", 1, "Kleinste zuerst"], ["kind", 1, "Nach Art"]];
    openMenu(moreBtn, opts.map(([key, dir, l]) => ({ icon: v.sort.key === key && v.sort.dir === dir ? "check" : "sort", label: l, onClick: () => { v.sort = { key, dir }; prefs.sort = v.sort; savePrefs(); draw(); } })));
  }

  // ---------- Dateien von außen hineinziehen ----------
  let dropEl = null, dragDepth = 0;
  const showDrop = () => {
    if (dropEl || !ctx.writable) return;
    dropEl = h("div", { class: "drop-overlay" }, h("div", null, h("div", { class: "e-ico" }, icon("upload", "lg")), h("h3", { style: { margin: "0 0 4px" } }, "Zum Hochladen loslassen"), h("div", { class: "muted" }, `nach „${title}“`)));
    document.body.append(dropEl);
  };
  const hideDrop = () => { dragDepth = 0; dropEl?.remove(); dropEl = null; };
  page.on("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { dragDepth++; showDrop(); } }, document);
  page.on("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) hideDrop(); }, document);
  page.on("dragover", (e) => { if (e.dataTransfer?.types.includes("Files") && ctx.writable) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }, document);
  page.on("drop", async (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault(); hideDrop();
    if (!ctx.writable) return toast("Nur lesen", "Hier kann nichts hochgeladen werden.", "info");
    const files = await collectDropped(e.dataTransfer);
    if (files.length) startUpload(share, path, files);
  }, document);
  page.cleanup.push(hideDrop);

  // Einfügen aus der Zwischenablage (z. B. Bildschirmfoto)
  page.on("paste", (e) => {
    if (!ctx.writable || /input|textarea/i.test(document.activeElement?.tagName || "")) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) startUpload(share, path, files.map((f, i) => ({ file: f, rel: f.name === "image.png" ? `Einfügen ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}${i ? "-" + i : ""}.png` : f.name })));
  }, document);

  // Tastatur
  page.on("keydown", (e) => {
    if (document.querySelector(".overlay, .viewer:not(.pane)") || /input|textarea|select/i.test(document.activeElement?.tagName || "")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); visible().forEach(i => v.sel.add(keyOf(i))); draw(); }
    else if (e.key === "Escape" && v.sel.size) { v.sel.clear(); draw(); }
    else if ((e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) && v.sel.size && ctx.writable) A.remove(ctx, selected(), () => { v.sel.clear(); reload(); });
    else if (e.key === "F2" && v.sel.size === 1 && ctx.writable) A.rename(ctx, selected()[0], reload);
    else if (e.key === "/" ) { e.preventDefault(); qInput.focus(); }
    else if (e.key === "Backspace" && parts.length) location.hash = up;
  }, document);

  // Für die Hochladen-Taste in der unteren Leiste
  state.currentFolder = { share, path, get writable() { return ctx.writable; }, upload: uploadFiles };

  await load();
  if (open) {
    const item = v.items.find(i => i.name === open && !i.dir);
    if (item) openItem(item);
  }
}
