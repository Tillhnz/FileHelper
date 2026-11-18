// ===========================================================================
// 3D-Ansicht für STL, STEP/STP, IGES und OBJ – eigener kleiner WebGL-Betrachter
//   Maus: ziehen = drehen, rechte Taste/Shift = verschieben, Rad = zoomen, Doppelklick = zurücksetzen
//   Touch: ein Finger = drehen, zwei Finger = zoomen & verschieben
// ===========================================================================
import { h, icon, clear, bytes } from "./core.js";

export const MODEL_EXTS = new Set(["stl", "stp", "step", "igs", "iges", "obj"]);
const DEFAULT_COLOR = [0.56, 0.66, 0.84];

// ---------- kleine Matrix-Helfer (Spalten-Major wie in WebGL) ----------
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function ortho(w, hgt, near, far) {
  const nf = 1 / (near - far);
  return new Float32Array([1 / w, 0, 0, 0, 0, 1 / hgt, 0, 0, 0, 0, 2 * nf, 0, 0, 0, (far + near) * nf, 1]);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function lookAt(eye, target, up) {
  const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

const VS = `
attribute vec3 aPos; attribute vec3 aNormal; attribute vec3 aColor;
uniform mat4 uMVP; uniform mat4 uView;
varying vec3 vN; varying vec3 vC; varying vec3 vV;
void main() {
  vN = mat3(uView[0].xyz, uView[1].xyz, uView[2].xyz) * aNormal;
  vec4 p = uView * vec4(aPos, 1.0);
  vV = -p.xyz; vC = aColor;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;
const FS = `
precision mediump float;
varying vec3 vN; varying vec3 vC; varying vec3 vV;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(vV);
  vec3 l1 = normalize(vec3(0.35, 0.55, 1.0));
  vec3 l2 = normalize(vec3(-0.6, -0.3, 0.4));
  float d = max(dot(n, l1), 0.0);
  float f = max(dot(n, l2), 0.0);
  float s = pow(max(dot(n, normalize(l1 + v)), 0.0), 48.0);
  vec3 c = vC * (0.30 + 0.62 * d + 0.18 * f) + vec3(0.22) * s;
  gl_FragColor = vec4(pow(c, vec3(0.92)), 1.0);
}`;
const LINE_VS = `attribute vec3 aPos; uniform mat4 uMVP; void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;
const LINE_FS = `precision mediump float; uniform vec4 uColor; void main() { gl_FragColor = uColor; }`;

function program(gl, vs, fs) {
  const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

function flatNormals(pos) {
  const n = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i + 3] - pos[i], ay = pos[i + 4] - pos[i + 1], az = pos[i + 5] - pos[i + 2];
    const bx = pos[i + 6] - pos[i], by = pos[i + 7] - pos[i + 1], bz = pos[i + 8] - pos[i + 2];
    let x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
    const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
    for (let k = 0; k < 9; k += 3) { n[i + k] = x; n[i + k + 1] = y; n[i + k + 2] = z; }
  }
  return n;
}

function smoothNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
    const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const fn = cross(e1, e2);
    for (const v of [a, b, c]) { n[v] += fn[0]; n[v + 1] += fn[1]; n[v + 2] += fn[2]; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  return n;
}

function niceStep(size) {
  const raw = size / 10, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m < 2 ? 1 : m < 5 ? 2 : 5) * p;
}

/** Lädt ein Modell von `url` und zeigt es in `container`. Gibt { destroy } zurück. */
export function openModel(container, { url, ext, size, dark = true }) {
  let destroyed = false;
  const status = h("div", { class: "m3d-status" }, icon("spinner", "spin lg"), h("div", { class: "m3d-msg" }, "Modell wird geladen …"));
  const canvas = h("canvas", { class: "m3d-canvas" });
  const info = h("div", { class: "m3d-info hidden" });
  const tools = h("div", { class: "m3d-tools hidden" });
  const root = h("div", { class: `m3d ${dark ? "dark" : ""}` }, canvas, status, info, tools);
  clear(container).append(root);
  const setMsg = (t) => { const m = status.querySelector(".m3d-msg"); if (m) m.textContent = t; };
  const fail = (t) => { clear(status).append(icon("alert", "lg"), h("div", { class: "m3d-msg" }, t)); status.classList.add("error"); };

  let worker = null, gl = null, cleanupFns = [];
  const ctrl = new AbortController();

  (async () => {
    // 1) Datei laden (mit Fortschritt)
    let buf;
    try {
      const r = await fetch(url, { credentials: "same-origin", signal: ctrl.signal });
      if (!r.ok) throw new Error(`Fehler ${r.status}`);
      const total = Number(r.headers.get("content-length")) || size || 0;
      if (r.body && total) {
        const reader = r.body.getReader();
        const out = new Uint8Array(total);
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (got + value.length > out.length) throw new Error("Größe passt nicht");
          out.set(value, got); got += value.length;
          setMsg(`Modell wird geladen … ${Math.floor((got / total) * 100)} % von ${bytes(total)}`);
        }
        buf = out.buffer.slice(0, got);
      } else buf = await r.arrayBuffer();
    } catch (e) { if (!destroyed) fail(`Laden fehlgeschlagen: ${e.message}`); return; }
    if (destroyed) return;

    // 2) Im Hintergrund einlesen
    setMsg(ext === "stl" || ext === "obj" ? "Wird aufbereitet …" : "CAD-Datei wird umgerechnet … (große STEP-Dateien brauchen etwas)");
    let res;
    try {
      worker = new Worker("/static/js/model-worker.js");
      res = await new Promise((resolve, reject) => {
        worker.onmessage = (e) => (e.data.ok ? resolve(e.data) : reject(new Error(e.data.error)));
        worker.onerror = (e) => reject(new Error(e.message || "Fehler beim Einlesen"));
        worker.postMessage({ buffer: buf, ext }, [buf]);
      });
    } catch (e) { if (!destroyed) fail(e.message); return; }
    finally { worker?.terminate(); worker = null; }
    if (destroyed) return;

    // 3) Zeichnen
    try { setup(res); } catch (e) { fail(`3D-Anzeige nicht möglich: ${e.message}`); }
  })();

  function setup(res) {
    gl = canvas.getContext("webgl2", { antialias: true, alpha: false, preserveDrawingBuffer: false })
      || canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) throw new Error("Dein Browser unterstützt kein WebGL.");
    const gl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    const uintIdx = gl2 || !!gl.getExtension("OES_element_index_uint");

    // Begrenzung des Modells
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const m of res.meshes) for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) {
      const v = m.positions[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
    }
    if (!isFinite(mn[0])) throw new Error("Das Modell ist leer.");
    const dims = sub(mx, mn);
    const center = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    const radius = Math.max(Math.hypot(dims[0], dims[1], dims[2]) / 2, 1e-6);

    const prog = program(gl, VS, FS);
    const loc = { pos: gl.getAttribLocation(prog, "aPos"), nor: gl.getAttribLocation(prog, "aNormal"), col: gl.getAttribLocation(prog, "aColor"),
      mvp: gl.getUniformLocation(prog, "uMVP"), view: gl.getUniformLocation(prog, "uView") };
    const lineProg = program(gl, LINE_VS, LINE_FS);
    const lloc = { pos: gl.getAttribLocation(lineProg, "aPos"), mvp: gl.getUniformLocation(lineProg, "uMVP"), color: gl.getUniformLocation(lineProg, "uColor") };

    const buffer = (data, target = gl.ARRAY_BUFFER) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
    const draws = [];
    for (const m of res.meshes) {
      let { positions, normals, indices } = m;
      if (indices && !uintIdx && positions.length / 3 > 65535) {
        // Altes WebGL ohne 32-Bit-Indizes: entpacken
        const p = new Float32Array(indices.length * 3), n = normals ? new Float32Array(indices.length * 3) : null, c = m.colors ? new Float32Array(indices.length * 3) : null;
        for (let i = 0; i < indices.length; i++) for (let k = 0; k < 3; k++) {
          p[i * 3 + k] = positions[indices[i] * 3 + k];
          if (n) n[i * 3 + k] = normals[indices[i] * 3 + k];
          if (c) c[i * 3 + k] = m.colors[indices[i] * 3 + k];
        }
        positions = p; normals = n; indices = null; m.colors = c;
      }
      if (!normals) normals = indices ? smoothNormals(positions, indices) : flatNormals(positions);
      draws.push({
        pos: buffer(positions), nor: buffer(normals), col: m.colors ? buffer(m.colors) : null, color: m.color || DEFAULT_COLOR,
        idx: indices ? buffer(uintIdx ? indices : new Uint16Array(indices), gl.ELEMENT_ARRAY_BUFFER) : null,
        count: indices ? indices.length : positions.length / 3, idxType: uintIdx ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      });
    }

    // Raster auf Höhe der Unterseite (wie ein Druckbett)
    const step = niceStep(Math.max(dims[0], dims[1], 1e-6) * 1.6);
    const half = Math.ceil((Math.max(dims[0], dims[1]) * 0.8 + step) / step) * step;
    const gridPts = [];
    for (let x = -half; x <= half + 1e-9; x += step) gridPts.push(center[0] + x, center[1] - half, mn[2], center[0] + x, center[1] + half, mn[2]);
    for (let y = -half; y <= half + 1e-9; y += step) gridPts.push(center[0] - half, center[1] + y, mn[2], center[0] + half, center[1] + y, mn[2]);
    const gridBuf = buffer(new Float32Array(gridPts));
    const gridCount = gridPts.length / 3;
    let showGrid = true;

    // Kamera
    // Abstand so, dass das ganze Modell hineinpasst – auch im schmalen Hochformat (Handy)
    const fitDist = () => {
      const fov = 35 * Math.PI / 180, aspect = Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1);
      const fovH = 2 * Math.atan(Math.tan(fov / 2) * aspect);
      return (radius / Math.sin(Math.min(fov, fovH) / 2)) * 1.08;
    };
    const cam = { yaw: -3 * Math.PI / 4, pitch: 0.55, dist: radius * 3, target: [...center], ortho: false };
    const views = { iso: [-3 * Math.PI / 4, 0.55], front: [-Math.PI / 2, 0.0001], side: [0, 0.0001], top: [-Math.PI / 2, Math.PI / 2 - 0.0001] };
    const setView = (k) => { [cam.yaw, cam.pitch] = views[k]; cam.target = [...center]; cam.dist = fitDist(); draw(); };
    const home = () => setView("iso");

    let raf = 0;
    function draw() { if (!raf && !destroyed) raf = requestAnimationFrame(render); }
    function eye() {
      const cp = Math.cos(cam.pitch);
      return [cam.target[0] + cam.dist * cp * Math.cos(cam.yaw), cam.target[1] + cam.dist * cp * Math.sin(cam.yaw), cam.target[2] + cam.dist * Math.sin(cam.pitch)];
    }
    function render() {
      raf = 0;
      if (destroyed || gl.isContextLost()) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), hgt = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; }
      gl.viewport(0, 0, w, hgt);
      const bg = dark ? [0.043, 0.055, 0.075] : [0.95, 0.955, 0.965];
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      const aspect = w / hgt;
      const near = Math.max(cam.dist - radius * 4, cam.dist / 1000), far = cam.dist + radius * 6;
      const proj = cam.ortho ? ortho(cam.dist * 0.36 * aspect, cam.dist * 0.36, near, far) : perspective(35 * Math.PI / 180, aspect, near, far);
      const view = lookAt(eye(), cam.target, [0, 0, 1]);
      const mvp = mul(proj, view);

      gl.useProgram(prog);
      gl.uniformMatrix4fv(loc.mvp, false, mvp);
      gl.uniformMatrix4fv(loc.view, false, view);
      for (const d of draws) {
        gl.bindBuffer(gl.ARRAY_BUFFER, d.pos); gl.enableVertexAttribArray(loc.pos); gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, d.nor); gl.enableVertexAttribArray(loc.nor); gl.vertexAttribPointer(loc.nor, 3, gl.FLOAT, false, 0, 0);
        if (d.col) { gl.bindBuffer(gl.ARRAY_BUFFER, d.col); gl.enableVertexAttribArray(loc.col); gl.vertexAttribPointer(loc.col, 3, gl.FLOAT, false, 0, 0); }
        else { gl.disableVertexAttribArray(loc.col); gl.vertexAttrib3f(loc.col, d.color[0], d.color[1], d.color[2]); }
        if (d.idx) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.idx); gl.drawElements(gl.TRIANGLES, d.count, d.idxType, 0); }
        else gl.drawArrays(gl.TRIANGLES, 0, d.count);
      }
      gl.disableVertexAttribArray(loc.nor); gl.disableVertexAttribArray(loc.col);
      if (showGrid) {
        gl.useProgram(lineProg);
        gl.uniformMatrix4fv(lloc.mvp, false, mvp);
        gl.uniform4f(lloc.color, ...(dark ? [0.42, 0.48, 0.58, 0.55] : [0.55, 0.6, 0.68, 0.6]));
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf); gl.enableVertexAttribArray(lloc.pos); gl.vertexAttribPointer(lloc.pos, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, gridCount);
        gl.disable(gl.BLEND);
      }
    }

    // ---------- Bedienung ----------
    const pointers = new Map();
    let last = null, lastPinch = null, moved = false;
    const pan = (dx, dy) => {
      const e = eye();
      const fwd = norm(sub(cam.target, e)), right = norm(cross(fwd, [0, 0, 1])), up = cross(right, fwd);
      const s = (cam.ortho ? 0.72 : 0.63) * cam.dist / Math.max(canvas.clientHeight, 1);
      for (let k = 0; k < 3; k++) cam.target[k] += (-dx * right[k] + dy * up[k]) * s;
    };
    const zoom = (f) => { cam.dist = Math.min(Math.max(cam.dist * f, radius * 0.05), radius * 40); };
    const onDown = (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      last = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey };
      lastPinch = null; moved = false;
    };
    const onMove = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (lastPinch) { zoom(lastPinch.d / d); pan(mid.x - lastPinch.mid.x, mid.y - lastPinch.mid.y); }
        lastPinch = { d, mid }; moved = true; draw(); return;
      }
      if (!last) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      if (last.button === 2 || last.button === 1 || last.shift) pan(dx, dy);
      else { cam.yaw -= dx * 0.008; cam.pitch = Math.min(Math.max(cam.pitch + dy * 0.008, -Math.PI / 2 + 0.001), Math.PI / 2 - 0.001); }
      last = { ...last, x: e.clientX, y: e.clientY };
      draw();
    };
    const onUp = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) lastPinch = null; if (!pointers.size) last = null; else { const p = [...pointers.values()][0]; last = { x: p.x, y: p.y, button: 0 }; } };
    const onWheel = (e) => { e.preventDefault(); zoom(Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0015))); draw(); };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", home);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    cleanupFns.push(() => ro.disconnect());
    void moved;

    // ---------- Anzeige ----------
    status.remove();
    const fmt = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(".", ",");
    info.classList.remove("hidden");
    info.append(h("strong", null, `${fmt(dims[0])} × ${fmt(dims[1])} × ${fmt(dims[2])} mm`),
      h("span", null, `${Math.round(res.triangles).toLocaleString("de-DE")} Dreiecke${res.meshes.length > 1 ? ` · ${res.meshes.length} Teile` : ""}`));
    const tbtn = (ic, label, fn, title) => h("button", { class: "btn sm", title: title || label, onclick: fn }, ic ? icon(ic, "sm") : null, label ? h("span", null, label) : null);
    const gridBtn = tbtn(null, "Raster", () => { showGrid = !showGrid; gridBtn.classList.toggle("on", showGrid); draw(); }, "Raster ein/aus");
    gridBtn.classList.add("on");
    const orthoBtn = tbtn(null, "Ortho", () => { cam.ortho = !cam.ortho; orthoBtn.classList.toggle("on", cam.ortho); draw(); }, "Ohne Perspektive (für Maße)");
    tools.classList.remove("hidden");
    tools.append(tbtn("refresh", null, home, "Ansicht zurücksetzen (Doppelklick)"),
      tbtn(null, "Iso", () => setView("iso")), tbtn(null, "Vorne", () => setView("front")), tbtn(null, "Seite", () => setView("side")), tbtn(null, "Oben", () => setView("top")),
      gridBtn, orthoBtn);
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); fail("Die 3D-Anzeige wurde vom Browser beendet (zu wenig Grafikspeicher?)."); });
    cam.dist = fitDist();
    draw();
  }

  return {
    destroy() {
      destroyed = true;
      ctrl.abort();
      worker?.terminate();
      cleanupFns.forEach(f => f());
      try { gl?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* egal */ }
      root.remove();
    },
  };
}
