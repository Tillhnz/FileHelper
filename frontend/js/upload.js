// ===========================================================================
// Hochladen: in Stücken (32 MB), mehrere gleichzeitig, mit Fortschritt
// ===========================================================================
import { h, icon, clear, bytes, toast, uid, qs, meter } from "./core.js";

const CHUNK = 32 * 1024 * 1024;
const PARALLEL = 3;
const queue = [];
let active = 0;
let panel = null, listEl = null, headText = null, headMeter = null, minimized = false;

/** files: [{ file: File, rel: "Unterordner/name.jpg" }] */
export function startUpload(share, path, files, { conflict = "rename" } = {}) {
  for (const f of files) {
    const item = { id: uid(), share, path, file: f.file, rel: f.rel || f.file.name, conflict, sent: 0, state: "wait", xhr: null, el: null };
    queue.push(item);
  }
  ensurePanel();
  drawPanel();
  pump();
}

function pump() {
  while (active < PARALLEL) {
    const next = queue.find(i => i.state === "wait");
    if (!next) break;
    active++;
    next.state = "run";
    send(next).finally(() => { active--; pump(); drawPanel(); });
  }
  drawPanel();
}

function sendChunk(item, offset, blob, final) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    const query = { share: item.share, path: item.path, name: item.rel, id: item.id, offset, final: final ? 1 : 0, conflict: item.conflict, mtime: item.file.lastModified || "" };
    xhr.open("POST", "/api/upload" + qs(query));
    xhr.setRequestHeader("X-FileHelper", "1");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { item.sent = offset + e.loaded; drawItem(item); drawHead(); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch { /* */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else { const e = new Error(data.error || (xhr.status === 413 ? "Zu groß für den Proxy davor (z. B. Nginx Proxy Manager: client_max_body_size erhöhen)" : `Fehler ${xhr.status}`)); e.status = xhr.status; e.data = data; reject(e); }
    };
    xhr.onerror = () => reject(Object.assign(new Error("Verbindung unterbrochen"), { retry: true }));
    xhr.onabort = () => reject(Object.assign(new Error("Abgebrochen"), { aborted: true }));
    xhr.send(blob);
  });
}

async function send(item) {
  const size = item.file.size;
  let offset = 0, tries = 0;
  try {
    do {
      const end = Math.min(offset + CHUNK, size);
      const final = end >= size;
      try {
        const r = await sendChunk(item, offset, item.file.slice(offset, end), final);
        offset = end; tries = 0;
        if (final) { item.result = r; break; }
      } catch (e) {
        if (e.aborted) throw e;
        // Stand passt nicht (z. B. nach Verbindungsabbruch) → dort weitermachen, wo der Server ist
        if (e.status === 409 && e.data?.have !== undefined && tries < 3) { offset = e.data.have; tries++; continue; }
        if ((e.retry || e.status >= 500) && tries < 4) { tries++; await new Promise(r => setTimeout(r, 1500 * tries)); continue; }
        throw e;
      }
    } while (offset < size || size === 0);
    item.state = item.result?.skipped ? "skipped" : "done";
    item.sent = size;
    window.dispatchEvent(new CustomEvent("fh:uploaded", { detail: { share: item.share, path: item.path } }));
  } catch (e) {
    item.state = e.aborted ? "cancelled" : "error";
    item.error = e.message;
    if (e.aborted) fetch("/api/upload" + qs({ share: item.share, path: item.path, name: item.rel, id: item.id }), { method: "DELETE", headers: { "X-FileHelper": "1" } }).catch(() => {});
  }
  item.xhr = null;
  drawItem(item);
  if (!queue.some(i => i.state === "wait" || i.state === "run")) finished();
}

function finished() {
  const done = queue.filter(i => i.state === "done").length;
  const failed = queue.filter(i => i.state === "error").length;
  if (failed) toast("Hochladen teilweise fehlgeschlagen", `${done} fertig, ${failed} mit Fehler.`, "bad", { timeout: 9000 });
  else if (done) toast("Hochgeladen", `${done} ${done === 1 ? "Datei" : "Dateien"} fertig.`);
  if (!failed) setTimeout(() => { if (!queue.some(i => i.state === "wait" || i.state === "run")) closePanel(); }, 2500);
}

// ---------- Fenster ----------
function ensurePanel() {
  if (panel) return;
  headText = h("span");
  headMeter = h("div", { class: "meter thin" }, h("i"));
  listEl = h("div", { class: "u-list" });
  const minBtn = h("button", { class: "btn icon sm ghost", title: "Ein-/Ausklappen" }, icon("chevronLeft", "sm"));
  minBtn.querySelector("svg").style.transform = "rotate(-90deg)";
  const closeBtn = h("button", { class: "btn icon sm ghost", title: "Alle abbrechen", onclick: (e) => { e.stopPropagation(); cancelAll(); } }, icon("x", "sm"));
  const head = h("div", { class: "u-head", onclick: () => { minimized = !minimized; panel.classList.toggle("min", minimized); minBtn.querySelector("svg").style.transform = minimized ? "rotate(90deg)" : "rotate(-90deg)"; } },
    icon("upload", "sm"), h("div", { style: { flex: 1, minWidth: 0 } }, headText, headMeter), minBtn, closeBtn);
  panel = h("div", { class: `uploads ${minimized ? "min" : ""}` }, head, listEl);
  document.body.append(panel);
  document.body.classList.add("has-uploads");
}

function closePanel() {
  panel?.remove(); panel = null;
  document.body.classList.remove("has-uploads");
  queue.splice(0, queue.length);
}

function cancelAll() {
  const running = queue.some(i => i.state === "wait" || i.state === "run");
  for (const i of queue) { if (i.state === "wait") i.state = "cancelled"; i.xhr?.abort(); }
  if (!running) closePanel(); else drawPanel();
}

function drawHead() {
  if (!panel) return;
  const total = queue.filter(i => i.state !== "cancelled" && i.state !== "skipped").reduce((s, i) => s + i.file.size, 0);
  const sent = queue.filter(i => i.state !== "cancelled" && i.state !== "skipped").reduce((s, i) => s + Math.min(i.sent, i.file.size), 0);
  const open = queue.filter(i => i.state === "wait" || i.state === "run").length;
  headText.textContent = open ? `Lade ${open} ${open === 1 ? "Datei" : "Dateien"} hoch · ${bytes(sent)} von ${bytes(total)}` : "Hochladen abgeschlossen";
  headMeter.firstChild.style.width = `${total ? (sent / total) * 100 : 100}%`;
  document.body.style.setProperty("--up-h", `${panel.offsetHeight + 12}px`);
}

function drawItem(item) {
  if (!item.el) return;
  const pctDone = item.file.size ? Math.min(100, (item.sent / item.file.size) * 100) : (item.state === "done" ? 100 : 0);
  const sub = { wait: "Wartet …", run: `${bytes(item.sent)} von ${bytes(item.file.size)}`, done: `Fertig${item.result?.name && item.result.name !== item.rel.split("/").pop() ? ` – gespeichert als „${item.result.name}“` : ""}`,
    error: item.error || "Fehler", cancelled: "Abgebrochen", skipped: "Übersprungen (gibt es schon)" }[item.state];
  item.el.className = `u-item ${item.state}`;
  clear(item.el).append(
    icon(item.state === "done" ? "checkCircle" : item.state === "error" ? "xCircle" : "file", "sm"),
    h("div", { class: "grow" }, h("div", { class: "u-name", title: item.rel }, item.rel), h("div", { class: "u-sub" }, sub),
      item.state === "run" ? meter(pctDone) : null),
    item.state === "run" || item.state === "wait" ? h("button", { class: "btn icon sm ghost", title: "Abbrechen", onclick: () => { if (item.state === "wait") { item.state = "cancelled"; drawItem(item); drawHead(); } else item.xhr?.abort(); } }, icon("x", "sm"))
      : item.state === "error" ? h("button", { class: "btn sm ghost", onclick: () => { item.state = "wait"; item.sent = 0; item.id = uid(); pump(); } }, "Nochmal") : null);
}

function drawPanel() {
  if (!panel) return;
  for (const item of queue) {
    if (!item.el) { item.el = h("div", { class: "u-item" }); listEl.append(item.el); }
    drawItem(item);
  }
  drawHead();
}

window.addEventListener("beforeunload", (e) => { if (queue.some(i => i.state === "run" || i.state === "wait")) { e.preventDefault(); e.returnValue = ""; } });

// ---------- Dateien auswählen / ablegen ----------
export function pickFiles(folder, onPick) {
  const inp = h("input", { type: "file", multiple: true, style: { display: "none" } });
  if (folder) { inp.webkitdirectory = true; inp.setAttribute("webkitdirectory", ""); }
  inp.addEventListener("change", () => {
    const files = [...inp.files].map(f => ({ file: f, rel: folder && f.webkitRelativePath ? f.webkitRelativePath : f.name }));
    inp.remove();
    if (files.length) onPick(files);
  });
  document.body.append(inp);
  inp.click();
}

/** Liest abgelegte Dateien – auch ganze Ordner (rekursiv). */
export async function collectDropped(dt) {
  const entries = [...(dt.items || [])].filter(i => i.kind === "file").map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (!entries.length || entries.some(e => !e)) return [...dt.files].map(f => ({ file: f, rel: f.name }));
  const out = [];
  const readAll = (reader) => new Promise((resolve) => {
    const acc = [];
    const next = () => reader.readEntries((batch) => { if (!batch.length) resolve(acc); else { acc.push(...batch); next(); } }, () => resolve(acc));
    next();
  });
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res) => entry.file(res, () => res(null)));
      if (file && !/^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(file.name)) out.push({ file, rel: prefix + file.name });
    } else if (entry.isDirectory) {
      for (const e of await readAll(entry.createReader())) await walk(e, `${prefix}${entry.name}/`);
    }
  }
  for (const e of entries) await walk(e, "");
  return out;
}
