// ===========================================================================
// Ordner auswählen (für Verschieben, Kopieren und Hochladen vom Handy)
// ===========================================================================
import { h, icon, clear, api, state, openSheet, loader, callout, joinPath, errorToast, promptDialog } from "../core.js";

export function pickFolder({ title, confirm = "Auswählen", share, path = "", writableOnly = false, exclude = [], notHere = null } = {}) {
  return new Promise((resolve) => {
    const shares = state.shares.filter(s => !writableOnly || s.writable);
    if (!shares.length) { resolve(null); return; }
    let cur = { share: shares.some(s => s.name === share) ? share : shares[0].name, path: shares.some(s => s.name === share) ? path : "" };
    openSheet((sheet, close) => {
      const shareRow = h("div", { class: "chips", style: { marginBottom: "12px" } });
      const where = h("div", { class: "row", style: { gap: "8px", marginBottom: "8px", minWidth: 0 } });
      const listBox = h("div", { class: "card pad-0 flat picker-list" });
      const ok = h("button", { class: "btn primary" }, icon("check", "sm"), confirm);
      const mk = h("button", { class: "btn" }, icon("folderPlus", "sm"), "Neuer Ordner");
      const isExcluded = (sh, p) => exclude.some(x => x.share === sh && (p === x.path || p.startsWith(x.path + "/")));

      function drawShares() {
        clear(shareRow).append(shares.map(s => h("button", { class: `chip ${s.name === cur.share ? "active" : ""}`, onclick: () => { cur = { share: s.name, path: "" }; drawShares(); browse(); } }, s.label)));
      }
      async function browse() {
        const label = shares.find(s => s.name === cur.share)?.label || cur.share;
        clear(where).append(icon("folder", "sm"), h("span", { class: "mono", style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, [label, ...(cur.path ? cur.path.split("/") : [])].join(" › ")));
        clear(listBox).append(loader());
        let r;
        try { r = await api("/list", { query: { share: cur.share, path: cur.path } }); }
        catch (e) { clear(listBox).append(h("div", { style: { padding: "12px" } }, callout("bad", null, e.message))); return; }
        const dirs = r.items.filter(i => i.dir && !i.hidden).sort((a, b) => a.name.localeCompare(b.name, "de", { numeric: true }));
        const bad = isExcluded(cur.share, cur.path);
        const here = notHere && notHere.share === cur.share && notHere.path === cur.path;
        ok.disabled = bad || here || (writableOnly && !r.writable);
        mk.disabled = !r.writable;
        clear(listBox).append(h("div", { class: "list" },
          cur.path ? h("div", { class: "list-item clickable", style: { minHeight: "50px" }, onclick: () => { cur.path = cur.path.split("/").slice(0, -1).join("/"); browse(); } },
            icon("chevronLeft", "sm"), h("div", { class: "grow" }, "Eine Ebene höher")) : null,
          dirs.length ? dirs.map(d => {
            const p = joinPath(cur.path, d.name);
            const dis = isExcluded(cur.share, p);
            return h("div", { class: "list-item clickable", style: { minHeight: "50px", opacity: dis ? 0.45 : 1 }, onclick: () => { if (dis) return; cur.path = p; browse(); } },
              h("div", { class: "ficon k-folder", style: { width: "32px", height: "32px" } }, icon("folder", "sm")), h("div", { class: "grow title", style: { fontWeight: 560 } }, d.name), icon("chevronRight", "sm"));
          }) : h("div", { class: "muted small", style: { padding: "14px 16px" } }, "Keine Unterordner.")));
        if (bad) listBox.prepend(h("div", { style: { padding: "10px" } }, callout("warn", null, "Ein Ordner kann nicht in sich selbst verschoben werden.")));
      }
      mk.addEventListener("click", async () => {
        const name = await promptDialog({ title: "Neuer Ordner", label: "Name", value: "Neuer Ordner", confirmText: "Anlegen" });
        if (!name) return;
        try { await api("/mkdir", { method: "POST", body: { share: cur.share, path: cur.path, name } }); cur.path = joinPath(cur.path, name); browse(); }
        catch (e) { errorToast(e); }
      });
      ok.addEventListener("click", () => close({ ...cur }));
      sheet.append(h("h2", null, title || "Ordner wählen"), h("p", { class: "sheet-sub" }, "Tippe auf einen Ordner, um hineinzugehen."),
        shares.length > 1 ? shareRow : null, where, listBox,
        h("div", { class: "sheet-foot" }, mk, h("span", { class: "spacer" }), h("button", { class: "btn", onclick: () => close(null) }, "Abbrechen"), ok));
      drawShares();
      browse();
    }, { onClose: (r) => resolve(r || null) });
  });
}
