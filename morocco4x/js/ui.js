// Interface around the map: yields bar, lens dock, legend, tooltip, search, share, help.
import { fmt, esc, fold, compact } from "./format.js";
import { icon, resourceIcon, hydrateIcons } from "./icons.js";
import { rampColor } from "./world.js";
import { initPanels } from "./panels.js";
import { initAlmanac } from "./almanac.js";

const $ = (id) => document.getElementById(id);
const LAYERS = [["borders", "Region borders and names"], ["provinces", "Province borders"], ["rivers", "Rivers"], ["roads", "Motorways and main roads"], ["rail", "Railways"], ["grid", "Hex grid"]];

export function initUI(app) {
  const w = app.world, s = app.state;
  const pops = [$("yield-report"), $("share-pop"), $("search-results"), $("layers-pop"), $("lens-picker")];
  let openBtn = null;

  function closePops(except) {
    for (const p of pops) if (p !== except) p.classList.remove("open");
    if (openBtn) { openBtn.setAttribute("aria-expanded", "false"); openBtn = null; }
  }
  function openPop(pop, btn, place = true) {
    const was = pop.classList.contains("open") && openBtn === btn;
    closePops();
    if (was) return false;
    pop.classList.add("open");
    openBtn = btn; btn && btn.setAttribute("aria-expanded", "true");
    if (place && btn) {
      const r = btn.getBoundingClientRect(), pw = pop.offsetWidth;
      pop.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left)) + "px";
      pop.style.top = r.bottom + 8 + "px";
    }
    return true;
  }
  document.addEventListener("pointerdown", (e) => {
    if (pops.some((p) => p.contains(e.target)) || (openBtn && openBtn.contains(e.target)) || e.target.closest(".search")) return;
    closePops();
  });

  const toastEl = $("toast");
  let toastT = 0;
  app.toast = (msg) => { toastEl.textContent = msg; toastEl.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove("show"), 2200); };

  // ---------------------------------------------------------------- top bar
  $("turn").innerHTML = `Turn <b>${esc(w.meta.turn)}</b> · ${esc(w.meta.turnLabel)}`;
  $("brand").addEventListener("click", () => { app.select(null); app.home(); });
  const yieldsEl = $("yields");
  yieldsEl.innerHTML = w.yields.map((y) => `<button type="button" class="yield" data-y="${y.id}" style="color:${y.color}" aria-expanded="false" aria-haspopup="dialog"
      title="${esc(y.label)}: click for the report" aria-label="${esc(y.label)}: ${esc(fmt(y.value, y.fmt))}. Open the report">${icon(y.icon, 17)}<span>${esc(fmt(y.value, y.fmt))}</span><span class="caret"></span></button>`).join("");
  yieldsEl.addEventListener("click", (e) => {
    const b = e.target.closest(".yield");
    if (!b) return;
    const y = w.yields.find((v) => v.id === b.dataset.y), pop = $("yield-report");
    pop.innerHTML = yieldReport(y);
    openPop(pop, b);
  });
  $("yield-report").addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]"), lens = e.target.closest("[data-lens]");
    if (go) { closePops(); const [kind, id] = go.dataset.go.split(":"); app.select({ kind, id }, { fly: true }); }
    if (lens) { closePops(); app.setLens(lens.dataset.lens); }
  });
  function yieldReport(y) {
    const rows = w.regions.map((r) => [r, y.values[r.id]]).filter((a) => a[1] != null).sort((a, b) => b[1] - a[1]);
    const max = Math.max(...rows.map((a) => a[1]), y.grouped ? y.grouped.value : 0) || 1;
    let h = `<div class="yr-head" style="color:${y.color}">${icon(y.icon, 26)}<b>${esc(fmt(y.value, y.fmt))}</b><span>${esc(y.label)}</span></div>
      <p class="yr-def">${esc(y.definition)}</p><div class="bars">`;
    for (const [r, v] of rows) h += `<button type="button" class="bar-row" data-go="region:${r.id}"><span class="nm">${esc(r.name)}</span><span class="tr"><i style="width:${(v / max) * 100}%;background:${y.color}"></i></span><span class="vl">${esc(fmt(v, y.fmt))}</span></button>`;
    if (y.grouped) h += `<div class="bar-row"><span class="nm" title="${esc(y.grouped.label)}">South (grouped)</span><span class="tr"><i style="width:${(y.grouped.value / max) * 100}%;background:${y.color};opacity:.6"></i></span><span class="vl">${esc(fmt(y.grouped.value, y.fmt))}</span></div>`;
    h += `</div>`;
    if (y.grouped) h += `<p class="note">HCP publishes Guelmim-Oued Noun, Laâyoune-Sakia El Hamra and Dakhla-Oued Ed-Dahab as one group for this figure.</p>`;
    if (y.lens && w.lensById.has(y.lens)) h += `<p class="note"><button type="button" class="linkish" data-lens="${y.lens}">Show the ${esc(w.lensById.get(y.lens).label)} lens on the map</button></p>`;
    h += `<p class="src">Source: ${y.sourceUrl ? `<a href="${esc(y.sourceUrl)}" target="_blank" rel="noopener">${esc(y.source)}</a>` : esc(y.source)}${y.year ? " · " + y.year : ""}</p>`;
    return h;
  }

  // ---------------------------------------------------------------- lens dock
  const quick = $("lens-quick"), picker = $("lens-picker"), legend = $("legend");
  function renderDock() {
    const ids = [null, ...w.quickLenses];
    if (s.lens && !ids.includes(s.lens)) ids.push(s.lens);
    quick.innerHTML = ids.map((id) => {
      const L = id ? w.lensById.get(id) : null;
      return `<button type="button" class="lens-btn ${s.lens === id ? "active" : ""}" data-id="${id || ""}" aria-pressed="${s.lens === id}" title="${L ? esc(L.label) + " lens" : "Terrain (no lens)"}">${icon(L ? lensIcon(L) : "map")}<span>${L ? esc(L.label) : "Terrain"}</span></button>`;
    }).join("");
    $("btn-res").setAttribute("aria-pressed", String(s.showResources));
    const on = LAYERS.filter(([k]) => s.layers[k]).length;
    $("ml-count").textContent = on;
    $("btn-layers").setAttribute("aria-label", `Map layers (${on} of ${LAYERS.length} on)`);
  }
  const lensIcon = (L) => ({ People: "pop", Economy: "gold", "Work & welfare": "work", Education: "science", Land: "layers" }[L.group] || "layers");
  quick.addEventListener("click", (e) => { const b = e.target.closest(".lens-btn"); if (b) app.setLens(b.dataset.id || null); });
  $("btn-res").addEventListener("click", () => app.setResources(!s.showResources));

  function renderPicker() {
    const groups = [];
    for (const L of w.lenses) { let g = groups.find((x) => x[0] === L.group); if (!g) groups.push((g = [L.group, []])); g[1].push(L); }
    const lvl = { region: "by region", province: "by province", hex: "by hex" };
    picker.innerHTML = `<div class="lp-group">Map</div><div class="lp-grid"><button type="button" class="lp-item ${!s.lens ? "active" : ""}" data-id=""><span>Terrain</span><small>no lens</small></button></div>` +
      groups.map(([g, list]) => `<div class="lp-group">${esc(g)}</div><div class="lp-grid">${list.map((L) =>
        `<button type="button" class="lp-item ${s.lens === L.id ? "active" : ""}" data-id="${L.id}"><span>${esc(L.label)}</span><small>${lvl[L.level]}${L.year ? " · " + L.year : ""}</small></button>`).join("")}</div>`).join("");
  }
  $("btn-lenses").addEventListener("click", (e) => { renderPicker(); openPop(picker, e.currentTarget, false); $("layers-pop").classList.remove("open"); });
  picker.addEventListener("click", (e) => { const b = e.target.closest(".lp-item"); if (b) { app.setLens(b.dataset.id || null); closePops(); } });

  const layersPop = $("layers-pop");
  function renderLayers() {
    layersPop.innerHTML = `<div class="pop-title">Map layers</div>` + LAYERS.map(([k, label]) => `<label class="check"><input type="checkbox" data-layer="${k}" ${s.layers[k] ? "checked" : ""}><span>${label}</span></label>`).join("") +
      `<div class="pop-title">Resources</div>` + w.resourceCats.map((c) => {
        const n = w.resources.filter((r) => r.cat === c.id).length;
        return `<label class="check"><input type="checkbox" data-cat="${c.id}" ${s.hiddenCats.has(c.id) ? "" : "checked"}><span class="sw" style="background:${c.color}">${icon(resourceIcon("", c.id), 12)}</span><span>${esc(c.label)} <span class="muted">${n}</span></span></label>`;
      }).join("");
  }
  $("btn-layers").addEventListener("click", (e) => { renderLayers(); openPop(layersPop, e.currentTarget, false); });
  layersPop.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.layer) app.setLayer(t.dataset.layer, t.checked);
    if (t.dataset.cat) { app.setCat(t.dataset.cat, t.checked); if (t.checked && !s.showResources) app.setResources(true); }
  });

  // ---------------------------------------------------------------- legend
  function renderLegend(L) {
    if (!L) { legend.classList.remove("open"); return; }
    L.filter = null;
    const lvl = { region: "12 regions", province: "75 provinces", hex: "per hex" }[L.level];
    const ticks = [0, 0.5, 1].map((t) => L.format(L.inv(t)));
    legend.innerHTML = `<div class="lg-title"><span>${esc(L.label)}</span><small>${lvl}${L.year ? " · " + L.year : ""}</small></div>
      <div class="lg-ramp" id="lg-ramp" title="Drag to show only a range"><canvas width="280" height="16"></canvas><div class="lg-sel"></div></div>
      <div class="lg-labels"><span>${esc(ticks[0])}</span><span>${esc(ticks[1])}</span><span>${esc(ticks[2])}</span></div>
      <div class="lg-note" id="lg-note"></div>`;
    const cv = legend.querySelector("canvas"), c2 = cv.getContext("2d");
    for (let x = 0; x < cv.width; x++) { const c = rampColor(L.ramp, x / (cv.width - 1)); c2.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; c2.fillRect(x, 0, 1, cv.height); }
    const note = $("lg-note"), ramp = $("lg-ramp"), selBox = ramp.querySelector(".lg-sel");
    const baseNote = () => { note.innerHTML = `${esc(L.note || "")} <span class="muted">${esc(L.source || "")}</span>`; };
    baseNote();
    let t0 = null;
    const tAt = (e) => { const r = ramp.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
    const apply = (a, b) => {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (hi - lo < 0.02) { L.filter = null; selBox.style.display = "none"; baseNote(); }
      else {
        L.filter = [lo, hi]; selBox.style.display = "block"; selBox.style.left = lo * 100 + "%"; selBox.style.width = (hi - lo) * 100 + "%";
        note.innerHTML = `Showing only ${esc(L.format(L.inv(lo)))} to ${esc(L.format(L.inv(hi)))}. <button type="button" id="lg-clear">Clear range</button>`;
      }
      app.refilter();
    };
    ramp.addEventListener("pointerdown", (e) => { ramp.setPointerCapture(e.pointerId); t0 = tAt(e); });
    ramp.addEventListener("pointermove", (e) => { if (t0 != null) apply(t0, tAt(e)); });
    ramp.addEventListener("pointerup", (e) => { if (t0 != null) { apply(t0, tAt(e)); t0 = null; } });
    note.addEventListener("click", (e) => { if (e.target.id === "lg-clear") apply(0, 0); });
    legend.classList.add("open");
  }
  app.on("lens", (L) => { renderDock(); renderLegend(L); });
  app.on("layers", renderDock);

  // ---------------------------------------------------------------- tooltip
  const tip = $("tooltip");
  function showTooltip(cx, cy, { cell, city, res }) {
    let h = "";
    const L = s.lens ? w.lensById.get(s.lens) : null;
    if (city) {
      h = `<div class="t-title">${esc(city.name)}</div><div class="t-sub">${esc(w.provinceById.get(city.province).name)} · ${esc(w.regionById.get(city.region).name)}</div>
        <div class="t-row"><span>Population 2024</span><b>${fmt(city.pop2024, "int")}</b></div><div class="t-hint">Click to open the city</div>`;
    } else if (res) {
      const cat = w.resourceCats.find((c) => c.id === res.cat);
      h = `<div class="t-title">${esc(res.name)}</div><div class="t-sub">${esc(cat ? cat.label : res.cat)}${res.kind ? " · " + esc(res.kind.replace(/_/g, " ")) : ""}</div>`;
      if (res.statValue != null) h += `<div class="t-row"><span>${esc(res.statLabel || "")}${res.statYear ? " " + res.statYear : ""}</span><b>${esc(compact(res.statValue))} ${esc(res.statUnit || "")}</b></div>`;
      h += `<div class="t-hint">Click for details</div>`;
    } else if (cell >= 0) {
      const b = w.biome[cell], p = w.provinceAt(cell), r = w.regionAt(cell);
      h = `<div class="t-title">${esc(w.terrainName(cell))}</div>`;
      if (p) h += `<div class="t-sub">${esc(p.name)} · ${esc(r.name)}</div>`;
      else if (b > 2) h += `<div class="t-sub">${esc(w.countries[w.country[cell]] || "Land")} · outside the map's data</div>`;
      if (b > 2) {
        h += `<div class="t-row"><span>Elevation</span><b>${fmt(w.elev[cell], "m")}</b></div>`;
        const lc = [["Cropland", w.crop[cell]], ["Trees", w.tree[cell]], ["Built-up", w.built[cell]], ["Bare ground", w.bare[cell]]].filter((a) => a[1] >= 3).sort((a, b2) => b2[1] - a[1]).slice(0, 3);
        if (lc.length) h += `<div class="t-row"><span>Land cover</span><b>${lc.map((a) => `${a[0]} ${a[1]}%`).join(" · ")}</b></div>`;
        const rv = w.riverAt.get(cell);
        if (rv) h += `<div class="t-row"><span>River</span><b>${esc(rv)}</b></div>`;
      } else if (w.elev[cell] < 0) h += `<div class="t-row"><span>Depth</span><b>${fmt(-w.elev[cell], "m")}</b></div>`;
      if (L && p) {
        const v = L.valueAt(cell), u = L.unitAt(cell);
        h += `<div class="t-lens t-row"><span>${esc(L.label)}${u ? " · " + esc(u.name) : ""}</span><b>${esc(L.format(v))}</b></div>`;
      }
      if (p) h += `<div class="t-hint">Click to open the region</div>`;
    }
    if (!h) return hideTooltip();
    tip.innerHTML = h;
    tip.style.display = "block";
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - tw - 8, cx + 16) + "px";
    tip.style.top = (cy + 18 + th > window.innerHeight ? cy - th - 12 : cy + 18) + "px";
  }
  function hideTooltip() { tip.style.display = "none"; }

  // ---------------------------------------------------------------- search
  const input = $("search-input"), results = $("search-results");
  const index = [
    ...w.cities.map((c) => ({ kind: "city", id: c.id, name: c.name, sub: w.provinceById.get(c.province).name, right: compact(c.pop2024), ic: "city", w: 3 + Math.log10(c.pop2024) })),
    ...w.regions.map((r) => ({ kind: "region", id: r.id, name: r.name, sub: "Region", right: compact(r.pop2024), ic: "region", w: 9 })),
    ...w.provinces.map((p) => ({ kind: "province", id: p.id, name: p.name, sub: (p.kind === "prefecture" ? "Prefecture" : "Province") + " · " + w.regionById.get(p.region).name, right: compact(p.pop2024), ic: "region", w: 5 })),
    ...w.resources.map((r) => ({ kind: "resource", id: r.id, name: r.name, sub: (w.resourceCats.find((c) => c.id === r.cat) || {}).label || r.cat, right: "", ic: resourceIcon(r.kind, r.cat), w: 2 })),
  ];
  for (const it of index) it.f = fold(it.name);
  let found = [], cur = 0;
  function search() {
    const q = fold(input.value);
    if (!q) { results.classList.remove("open"); input.setAttribute("aria-expanded", "false"); return; }
    found = index.map((it) => { const i = it.f.indexOf(q); return i < 0 ? null : [(i === 0 ? 100 : it.f[i - 1] === " " ? 60 : 20) + it.w - it.f.length * 0.05, it]; })
      .filter(Boolean).sort((a, b) => b[0] - a[0]).slice(0, 12).map((a) => a[1]);
    cur = 0;
    paintResults();
    closePops(results);
    results.classList.add("open");
    input.setAttribute("aria-expanded", "true");
    const r = input.getBoundingClientRect();
    results.style.left = Math.max(8, Math.min(window.innerWidth - results.offsetWidth - 8, r.left)) + "px";
    results.style.top = r.bottom + 8 + "px";
  }
  function paintResults() {
    results.innerHTML = found.length ? found.map((it, i) => `<button type="button" role="option" class="sr-item ${i === cur ? "sel" : ""}" data-i="${i}" aria-selected="${i === cur}">
      <span class="sr-kind">${icon(it.ic, 13)}</span><span class="grow"><span class="nm">${esc(it.name)}</span><small>${esc(it.sub)}</small></span><span class="r">${esc(it.right)}</span></button>`).join("")
      : `<div class="sr-empty">Nothing found for “${esc(input.value)}”.</div>`;
  }
  function choose(i) {
    const it = found[i];
    if (!it) return;
    results.classList.remove("open"); input.value = ""; input.blur();
    app.select({ kind: it.kind, id: it.id }, { fly: true });
  }
  input.addEventListener("input", search);
  input.addEventListener("focus", search);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { cur = Math.min(found.length - 1, cur + 1); paintResults(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { cur = Math.max(0, cur - 1); paintResults(); e.preventDefault(); }
    else if (e.key === "Enter") choose(cur);
  });
  results.addEventListener("click", (e) => { const b = e.target.closest(".sr-item"); if (b) choose(+b.dataset.i); });

  // ---------------------------------------------------------------- share
  const sharePop = $("share-pop");
  $("btn-share").addEventListener("click", (e) => {
    if (openPop(sharePop, e.currentTarget)) {
      sharePop.querySelector(".pop-url").value = location.origin + app.link();
      sharePop.querySelector(".pop-status").textContent = "";
      const r = e.currentTarget.getBoundingClientRect();
      sharePop.style.left = Math.max(8, r.right - sharePop.offsetWidth) + "px";
    }
  });
  sharePop.addEventListener("click", async (e) => {
    const b = e.target.closest(".pop-item");
    if (!b) return;
    const status = sharePop.querySelector(".pop-status"), url = location.origin + app.link();
    if (b.dataset.act === "copy") {
      try { await navigator.clipboard.writeText(url); status.textContent = "Link copied."; }
      catch { const f = sharePop.querySelector(".pop-url"); f.select(); status.textContent = "Press Ctrl+C to copy."; }
    } else {
      status.textContent = "Rendering…";
      await new Promise((r) => setTimeout(r, 30));
      const cv = app.snapshot(1600, 900), c2 = cv.getContext("2d"), L = s.lens ? w.lensById.get(s.lens) : null;
      c2.setTransform(1, 0, 0, 1, 0, 0);
      c2.fillStyle = "rgba(14,20,32,.86)"; c2.fillRect(0, 852, 1600, 48);
      c2.fillStyle = "#d7b377"; c2.font = '600 22px "Iowan Old Style",Palatino,Georgia,serif'; c2.textBaseline = "middle";
      c2.fillText("MOROCCO 4X" + (L ? "  ·  " + L.label : "  ·  Terrain"), 22, 877);
      c2.fillStyle = "#c5bca6"; c2.font = "15px system-ui,sans-serif"; c2.textAlign = "right";
      c2.fillText("Data: HCP, ESA WorldCover, SRTM, Overture Maps / OpenStreetMap, geoBoundaries", 1578, 877);
      cv.toBlob((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = "morocco4x.png"; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        status.textContent = "Image downloaded.";
      }, "image/png");
    }
  });

  // ---------------------------------------------------------------- modals
  const help = $("help"), pedia = $("pedia");
  let lastFocus = null;
  function openModal(m) { lastFocus = document.activeElement; closePops(); m.hidden = false; (m.querySelector("[data-close]") || m).focus(); }
  function closeModal(m) { m.hidden = true; lastFocus && lastFocus.focus && lastFocus.focus(); }
  for (const m of [help, pedia]) m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) closeModal(m); });
  $("btn-help").addEventListener("click", () => openModal(help));
  const almanac = initAlmanac(app, () => closeModal(pedia));
  $("btn-pedia").addEventListener("click", () => { almanac.show(); openModal(pedia); });
  app.openAlmanac = (page) => { almanac.show(page); if (pedia.hidden) openModal(pedia); };

  const mm = $("minimap-wrap");
  $("btn-minimap").addEventListener("click", () => mm.classList.add("open"));
  mm.addEventListener("dblclick", () => mm.classList.remove("open"));

  const panels = initPanels(app);
  hydrateIcons();
  renderDock();

  return {
    showTooltip, hideTooltip,
    openHelp: () => openModal(help),
    modalOpen: () => !help.hidden || !pedia.hidden,
    escape() {
      if (!help.hidden) return closeModal(help);
      if (!pedia.hidden) return closeModal(pedia);
      if (pops.some((p) => p.classList.contains("open"))) { closePops(); input.blur(); return; }
      if (document.activeElement === input) return input.blur();
      if (mm.classList.contains("open") && window.innerWidth <= 760) return mm.classList.remove("open");
      if (s.sel) return app.select(null);
      panels.close();
    },
  };
}
