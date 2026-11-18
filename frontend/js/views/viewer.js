// ===========================================================================
// Vorschau: Fotos, Videos, Musik, PDF, Text (mit Bearbeiten) – Wischen & Pfeiltasten
// ===========================================================================
import { h, icon, clear, api, state, toast, errorToast, bytes, shortDate, fileUrl, thumbUrl, fileIcon, extOf, KIND_LABEL, openMenu, confirmDialog } from "../core.js";
import * as A from "../actions.js";
import { MODEL_EXTS } from "../model3d.js";

const TEXT_LIMIT = 1024 * 1024;

export function openViewer({ ctx, items, index = 0, onChange }) {
  let i = index;
  let dirty = false;
  let model3d = null; // laufende 3D-Ansicht (muss beim Wechseln aufgeräumt werden)
  const stop3d = () => { model3d?.destroy(); model3d = null; };
  const titleEl = h("div", { class: "v-title" });
  const stage = h("div", { class: "v-stage" });
  const prev = h("button", { class: "v-nav prev", "aria-label": "Vorherige" }, icon("chevronLeft"));
  const next = h("button", { class: "v-nav next", "aria-label": "Nächste" }, icon("chevronRight"));
  const dlBtn = h("button", { class: "btn icon", title: "Herunterladen" }, icon("download", "sm"));
  const moreBtn = h("button", { class: "btn icon", title: "Mehr" }, icon("more", "sm"));
  const closeBtn = h("button", { class: "btn icon", title: "Schließen (Esc)" }, icon("x", "sm"));
  const top = h("div", { class: "v-top" }, titleEl, dlBtn, moreBtn, closeBtn);
  const root = h("div", { class: "viewer", role: "dialog", "aria-modal": "true" }, top, stage, prev, next);
  document.body.append(root);
  document.body.style.overflow = "hidden";

  const cur = () => items[i];
  async function close() {
    if (dirty && !(await confirmDialog({ title: "Änderungen verwerfen?", text: "Der Text wurde noch nicht gespeichert.", confirmText: "Verwerfen", danger: true }))) return;
    stop3d();
    root.remove(); document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey, true);
    history.state?.fhViewer && history.back();
    window.removeEventListener("popstate", onPop);
  }
  // Zurück-Taste (Handy) schließt die Vorschau statt die Seite zu wechseln
  history.pushState({ fhViewer: true }, "");
  const onPop = () => { if (document.body.contains(root)) { stop3d(); root.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", onKey, true); window.removeEventListener("popstate", onPop); } };
  window.addEventListener("popstate", onPop);

  async function go(delta) {
    if (dirty && !(await confirmDialog({ title: "Änderungen verwerfen?", text: "Der Text wurde noch nicht gespeichert.", confirmText: "Verwerfen", danger: true }))) return;
    dirty = false;
    const n = i + delta;
    if (n < 0 || n >= items.length) return;
    i = n; show();
  }
  prev.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));
  closeBtn.addEventListener("click", close);
  dlBtn.addEventListener("click", () => A.download(ctx, [cur()]));
  moreBtn.addEventListener("click", () => {
    const item = cur();
    const path = A.itemPath(ctx, item);
    openMenu(moreBtn, [
      { icon: "download", label: "Herunterladen", onClick: () => A.download(ctx, [item]) },
      { icon: "external", label: "Original in neuem Tab", onClick: () => window.open(fileUrl(ctx.share, path), "_blank", "noopener") },
      !state.user.readonly ? { icon: "link", label: "Link teilen", onClick: () => A.shareLink(ctx, item) } : null,
      { icon: "star", label: A.isFavorite(ctx.share, path) ? "Aus Favoriten entfernen" : "Zu Favoriten", onClick: () => A.toggleFavorite(ctx.share, path, item.name, false) },
      { icon: "info", label: "Eigenschaften", onClick: () => A.properties(ctx, item) },
      "-",
      { icon: "edit", label: "Umbenennen", disabled: !ctx.writable, onClick: () => A.rename(ctx, item, (name) => { item.name = name; show(); onChange?.(); }) },
      { icon: "trash", label: "Löschen", danger: true, disabled: !ctx.writable, onClick: () => A.remove(ctx, [item], () => {
        items.splice(i, 1); onChange?.();
        if (!items.length) return close();
        if (i >= items.length) i = items.length - 1;
        show();
      }) },
    ]);
  });

  function onKey(e) {
    if (document.querySelector(".overlay") || /input|textarea/i.test(document.activeElement?.tagName || "")) { if (e.key === "Escape" && document.activeElement?.tagName === "TEXTAREA") document.activeElement.blur(); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
  }
  document.addEventListener("keydown", onKey, true);

  // Wischen auf dem Handy
  let sx = 0, sy = 0, st = 0;
  stage.addEventListener("touchstart", (e) => { if (e.touches.length !== 1 || e.target.closest(".m3d")) { sx = null; return; } sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (sx === null || stage.classList.contains("zoomed") || (window.visualViewport && window.visualViewport.scale > 1.05)) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Date.now() - st < 600 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    else if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5 && cur().kind === "image") close();
  });

  function show() {
    const item = cur();
    const path = A.itemPath(ctx, item);
    clear(titleEl).append(h("strong", null, item.name),
      h("span", null, [items.length > 1 ? `${i + 1} von ${items.length}` : null, bytes(item.size), shortDate(item.mtime)].filter(Boolean).join(" · ")));
    prev.style.visibility = i > 0 ? "visible" : "hidden";
    next.style.visibility = i < items.length - 1 ? "visible" : "hidden";
    root.classList.remove("chrome-off");
    stage.classList.remove("zoomed");
    stop3d();
    clear(stage);
    const src = fileUrl(ctx.share, path);
    const ext = extOf(item.name);

    if (item.kind === "image" && ext !== "svg") {
      const loading = h("div", { class: "v-loading" }, icon("spinner", "spin lg"));
      // Was der Browser nicht kann (HEIC, RAW, TIFF), zeigen wir als umgewandeltes Vorschaubild
      const img = h("img", { src: item.convert ? thumbUrl(ctx.share, path, 2048) : src, alt: item.name, draggable: "false" });
      img.addEventListener("load", () => loading.remove());
      img.addEventListener("error", () => { loading.remove(); if (!item.convert && !img.dataset.fallback) { img.dataset.fallback = 1; img.src = thumbUrl(ctx.share, path, 2048); } else none(item, "Dieses Bild kann nicht angezeigt werden."); });
      img.addEventListener("click", (e) => {
        if (window.matchMedia("(hover: none)").matches) { root.classList.toggle("chrome-off"); return; }
        const zoom = !img.classList.contains("zoom");
        img.classList.toggle("zoom", zoom); stage.classList.toggle("zoomed", zoom);
        img.style.cursor = zoom ? "zoom-out" : "zoom-in";
        if (zoom) { const r = img.getBoundingClientRect(); stage.scrollTo((e.offsetX / r.width) * img.naturalWidth - stage.clientWidth / 2, (e.offsetY / r.height) * img.naturalHeight - stage.clientHeight / 2); }
      });
      img.style.cursor = "zoom-in";
      stage.append(loading, img);
      // nächstes Bild schon laden
      const nxt = items[i + 1];
      if (nxt?.kind === "image") { const pre = new Image(); pre.src = nxt.convert ? thumbUrl(ctx.share, A.itemPath(ctx, nxt), 2048) : fileUrl(ctx.share, A.itemPath(ctx, nxt)); }
    } else if (item.kind === "video") {
      const vid = h("video", { src, controls: true, autoplay: true, playsinline: true, preload: "metadata" });
      vid.addEventListener("error", () => none(item, "Dieses Videoformat kann dein Browser nicht abspielen. Lade es herunter und öffne es z. B. mit VLC."), { once: true });
      if (state.features?.ffmpeg) vid.poster = thumbUrl(ctx.share, path, 1024);
      stage.append(vid);
    } else if (item.kind === "audio") {
      const aud = h("audio", { src, controls: true, autoplay: true });
      stage.append(h("div", { class: "v-audio" }, h("div", { class: "cover" }, icon("music")), h("strong", { style: { fontSize: "18px" } }, item.name), aud));
    } else if (item.kind === "model" && MODEL_EXTS.has(ext)) {
      if (["stp", "step", "igs", "iges"].includes(ext) && state.features && state.features.step === false) {
        none(item, "Für STEP-Dateien fehlt noch der CAD-Leser. Im Container „filehelper update“ ausführen.");
      } else if (item.size > 400 * 1024 * 1024) {
        none(item, `Das Modell ist zu groß für die Vorschau im Browser (${bytes(item.size)}).`);
      } else {
        import("../model3d.js").then(({ openModel }) => { if (cur() === item) model3d = openModel(stage, { url: src, ext, size: item.size }); });
      }
    } else if (item.kind === "pdf") {
      stage.append(h("iframe", { src, title: item.name }));
    } else if (item.kind === "text" || (item.size < 64 * 1024 && ["", "conf", "service"].includes(ext))) {
      showText(item, src);
    } else {
      none(item);
    }
  }

  function none(item, text) {
    clear(stage).append(h("div", { class: "v-none" }, fileIcon(item),
      h("strong", { style: { fontSize: "18px", wordBreak: "break-word" } }, item.name),
      h("div", { style: { color: "rgba(255,255,255,.6)" } }, text || `${KIND_LABEL[item.kind] || "Datei"} · ${bytes(item.size)} – keine Vorschau möglich.`),
      h("button", { class: "btn primary", onclick: () => A.download(ctx, [item]) }, icon("download", "sm"), "Herunterladen")));
  }

  async function showText(item, src) {
    if (item.size > TEXT_LIMIT) return none(item, `Die Datei ist zu groß für die Vorschau (${bytes(item.size)}).`);
    const box = h("div", { class: "v-text" }, h("div", { class: "v-loading" }, icon("spinner", "spin lg")));
    stage.append(box);
    let text;
    try {
      const r = await fetch(src, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`Fehler ${r.status}`);
      text = await r.text();
    } catch (e) { return none(item, e.message); }
    if (cur() !== item) return;
    clear(box);
    const pre = h("pre", null, text);
    box.append(pre);
    if (ctx.writable) {
      const edit = h("button", { class: "btn sm", onclick: () => {
        const ta = h("textarea", { spellcheck: "false" });
        ta.value = text;
        ta.addEventListener("input", () => { dirty = ta.value !== text; save.disabled = !dirty; });
        ta.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save.click(); } });
        const save = h("button", { class: "btn sm primary", disabled: true }, icon("check", "sm"), "Speichern");
        save.addEventListener("click", async () => {
          save.disabled = true;
          try {
            await api("/text", { method: "POST", body: { share: ctx.share, path: A.itemPath(ctx, item), text: ta.value } });
            text = ta.value; dirty = false; item.size = new Blob([text]).size; item.mtime = Math.floor(Date.now() / 1000);
            toast("Gespeichert", item.name); onChange?.();
          } catch (e) { errorToast(e, "Speichern fehlgeschlagen"); save.disabled = false; }
        });
        clear(box).append(h("div", { class: "row" }, h("span", { class: "spacer" }), save), ta);
        ta.focus();
      } }, icon("edit", "sm"), "Bearbeiten");
      box.prepend(h("div", { class: "row" }, h("span", { style: { color: "rgba(255,255,255,.6)", fontSize: "13px" } }, `${text.split("\n").length.toLocaleString("de-DE")} Zeilen`), h("span", { class: "spacer" }), edit));
    }
  }

  show();
  return close;
}
