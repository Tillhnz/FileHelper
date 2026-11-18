// ===========================================================================
// 3D-Modelle einlesen (läuft im Hintergrund, damit die Seite flüssig bleibt)
//   STL (binär + ASCII), OBJ: eigener Leser
//   STEP/STP, IGES: OpenCascade (occt-import-js, WebAssembly) – wird beim Installieren geladen
// Ergebnis: { meshes: [{ positions: Float32Array, normals: Float32Array|null, indices: Uint32Array|null, color: [r,g,b]|null }], triangles }
// ===========================================================================
const OCCT_BASE = "/static/vendor/occt/";
let occtPromise = null;

function loadOcct() {
  if (!occtPromise) {
    occtPromise = (async () => {
      try { importScripts(OCCT_BASE + "occt-import-js.js"); }
      catch { throw new Error("STEP-Unterstützung ist nicht installiert. Im Container „filehelper update“ ausführen."); }
      // eslint-disable-next-line no-undef
      return occtimportjs({ locateFile: (p) => OCCT_BASE + p });
    })();
  }
  return occtPromise;
}

function parseStl(buf) {
  const dv = new DataView(buf);
  const isBinary = buf.byteLength >= 84 && 84 + dv.getUint32(80, true) * 50 === buf.byteLength;
  if (isBinary) {
    const n = dv.getUint32(80, true);
    const pos = new Float32Array(n * 9);
    let colored = false;
    const col = new Float32Array(n * 9);
    for (let i = 0, o = 84; i < n; i++, o += 50) {
      for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(o + 12 + k * 4, true);
      // Farbe nach VisCAM/SolidView-Art (Bit 15 gesetzt = Farbe gültig)
      const attr = dv.getUint16(o + 48, true);
      if (attr & 0x8000) {
        colored = true;
        const r = (attr & 31) / 31, g = ((attr >> 5) & 31) / 31, b = ((attr >> 10) & 31) / 31;
        for (let v = 0; v < 3; v++) { col[i * 9 + v * 3] = r; col[i * 9 + v * 3 + 1] = g; col[i * 9 + v * 3 + 2] = b; }
      }
    }
    return [{ positions: pos, normals: null, indices: null, color: null, colors: colored ? col : null }];
  }
  const text = new TextDecoder().decode(buf);
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
  if (!out.length) throw new Error("Das sieht nicht wie eine STL-Datei aus.");
  return [{ positions: new Float32Array(out.slice(0, out.length - (out.length % 9))), normals: null, indices: null, color: null }];
}

function parseObj(buf) {
  const text = new TextDecoder().decode(buf);
  const v = [];
  const pos = [];
  for (const line of text.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "v") v.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === "f") {
      const idx = p.slice(1).map(s => { const i = parseInt(s, 10); return i < 0 ? v.length + i : i - 1; });
      for (let k = 1; k + 1 < idx.length; k++) for (const i of [idx[0], idx[k], idx[k + 1]]) { const q = v[i]; if (q) pos.push(q[0], q[1], q[2]); else pos.push(0, 0, 0); }
    }
  }
  if (!pos.length) throw new Error("Keine Flächen in der OBJ-Datei gefunden.");
  return [{ positions: new Float32Array(pos), normals: null, indices: null, color: null }];
}

async function parseCad(buf, kind) {
  const occt = await loadOcct();
  const data = new Uint8Array(buf);
  const params = { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.5 };
  const res = kind === "iges" ? occt.ReadIgesFile(data, params) : occt.ReadStepFile(data, params);
  if (!res || !res.success) throw new Error("Die Datei konnte nicht gelesen werden (keine gültige STEP/IGES-Datei?).");
  const norm = (c) => (c ? (c.some(x => x > 1) ? c.map(x => x / 255) : c) : null);
  const meshes = [];
  for (const m of res.meshes) {
    const positions = new Float32Array(m.attributes.position.array);
    const normals = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
    const indices = new Uint32Array(m.index.array);
    // Einzelne Flächen können eigene Farben haben → pro Ecke einfärben
    let colors = null;
    const faceCols = (m.brep_faces || []).filter(f => f.color);
    if (faceCols.length) {
      colors = new Float32Array(positions.length);
      const base = norm(m.color) || [0.62, 0.68, 0.76];
      for (let i = 0; i < colors.length; i += 3) colors.set(base, i);
      for (const f of m.brep_faces) {
        if (!f.color) continue;
        const c = norm(f.color);
        for (let t = f.first; t <= f.last; t++) for (let k = 0; k < 3; k++) colors.set(c, indices[t * 3 + k] * 3);
      }
    }
    meshes.push({ positions, normals, indices, color: norm(m.color), colors, name: m.name });
  }
  if (!meshes.length) throw new Error("Die Datei enthält keine Körper, die angezeigt werden können.");
  return meshes;
}

onmessage = async (ev) => {
  const { buffer, ext } = ev.data;
  try {
    let meshes;
    if (ext === "stl") meshes = parseStl(buffer);
    else if (ext === "obj") meshes = parseObj(buffer);
    else if (ext === "stp" || ext === "step") meshes = await parseCad(buffer, "step");
    else if (ext === "igs" || ext === "iges") meshes = await parseCad(buffer, "iges");
    else throw new Error("Dieses 3D-Format wird nicht unterstützt.");
    const triangles = meshes.reduce((s, m) => s + (m.indices ? m.indices.length : m.positions.length / 3) / 3, 0);
    const transfer = [];
    for (const m of meshes) for (const k of ["positions", "normals", "indices", "colors"]) if (m[k]) transfer.push(m[k].buffer);
    postMessage({ ok: true, meshes, triangles }, transfer);
  } catch (e) {
    postMessage({ ok: false, error: e.message || String(e) });
  }
};
