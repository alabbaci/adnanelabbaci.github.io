// The side panel: city, region, province and resource screens.
import { fmt, esc, compact, int } from "./format.js";
import { icon, resourceIcon } from "./icons.js";

const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd", "th", "th", "th", "th", "th", "th"][n % 10]);
const KIND = { City: "City (all arrondissements)", UCom: "Urban commune", UrbC: "Urban centre", RC: "Rural commune" };
const BIOMES = [[3, "Farmland", "#a3b05c"], [4, "Steppe", "#b5ad6a"], [5, "Scrub", "#989763"], [6, "Desert", "#e0c690"]];
const RELIEF = [[0, "Flat", "#c9c2a6"], [1, "Hills", "#a08f6e"], [2, "Mountains", "#6f6558"]];
const SECTORS = [["Farming, fishing", "#8fc74a"], ["Industry, construction", "#e08a45"], ["Services", "#5fb0ea"], ["Taxes on products", "#8f8a7c"]];

export function initPanels(app) {
  const w = app.world, el = document.getElementById("panel");

  const go = (kind, id, label) => `<button type="button" data-go="${kind}:${id}">${esc(label)}</button>`;
  const head = (kicker, title, sub) => `<div class="sp-head"><div class="sp-kicker">${kicker}</div><h2 class="sp-title">${esc(title)}</h2><div class="sp-sub">${sub}</div>
    <button type="button" class="icon-btn sp-close" data-close aria-label="Close the panel">✕</button></div>`;
  const big = (items) => `<div class="bigstats">${items.map(([v, l, cls]) => `<div class="bigstat"><b class="${cls || ""}">${esc(v)}</b><span>${esc(l)}</span></div>`).join("")}</div>`;
  const stack = (parts) => {
    const tot = parts.reduce((a, p) => a + p[0], 0) || 1;
    return `<div class="stack">${parts.map((p) => `<i style="width:${(p[0] / tot) * 100}%;background:${p[2]}" title="${esc(p[1])}"></i>`).join("")}</div>
      <div class="keyline">${parts.filter((p) => p[0] / tot >= 0.005).map((p) => `<span style="--c:${p[2]}">${esc(p[1])} ${Math.round((p[0] / tot) * 100)}%</span>`).join("")}</div>`;
  };
  function census(u) {
    const pts = [[1994, u.pop1994], [2004, u.pop2004], [2014, u.pop2014], [2024, u.pop2024]].filter((p) => p[1]);
    const max = Math.max(...pts.map((p) => p[1]));
    return `<div class="spark">${pts.map(([y, v]) => `<div><b>${compact(v)}</b><i style="height:${Math.max(3, (v / max) * 70)}%"></i><span>${y}</span></div>`).join("")}</div>`;
  }
  function change(u) {
    if (!u.pop2014) return ["n/a", "since 2014", ""];
    const d = (u.pop2024 / u.pop2014 - 1) * 100;
    return [fmt(d, "signedpct"), "since 2014", d >= 0 ? "up" : "down"];
  }
  function land(u) {
    const g = u.geo;
    if (!g) return "";
    const top = g.topCell >= 0 ? `${fmt(g.top, "m")}` : "n/a";
    return `<h3>The land</h3>${stack(BIOMES.map(([b, n, c]) => [g.biome[b], n, c]))}<div style="height:6px"></div>${stack(RELIEF.map(([r, n, c]) => [g.relief[r], n, c]))}
      <dl class="kv" style="margin-top:8px"><dt>Hexes on the map</dt><dd>${int(g.n)} <small>× ${w.hexAreaKm2} km²</small></dd>
      <dt>Forest hexes</dt><dd>${int(g.forest)}</dd>${g.oasis ? `<dt>Oasis hexes</dt><dd>${int(g.oasis)}</dd>` : ""}
      <dt>Mean elevation</dt><dd>${fmt(g.meanElev, "m")}</dd><dt>Highest hex (mean height)</dt><dd>${top}</dd></dl>`;
  }
  const cityList = (list, n = 8) => list.length ? `<h3>Cities</h3><div class="list">${list.slice(0, n).map((c) =>
    `<button type="button" data-go="city:${c.id}"><span class="grow">${c.capital >= 2 ? "★ " : ""}${esc(c.name)}</span><span class="r">${int(c.pop2024)}</span></button>`).join("")}</div>${list.length > n ? `<p class="note">and ${list.length - n} more on the map.</p>` : ""}` : "";
  const resRow = (r, extra = "") => `<button type="button" data-go="resource:${r.id}"><span class="res-dot" style="background:${app.catColor[r.cat]}">${icon(resourceIcon(r.kind, r.cat), 12)}</span>
    <span class="grow">${esc(r.name)}</span><span class="r">${extra || (r.statValue != null ? esc(compact(r.statValue) + " " + (r.statUnit || "")) : "")}</span></button>`;
  const resList = (list, title = "Resources") => list.length ? `<h3>${title}</h3><div class="list">${list.map((r) => resRow(r)).join("")}</div>` : "";

  function cityPanel(c) {
    const p = w.provinceById.get(c.province), r = w.regionById.get(c.region), cell = c.cell;
    const badges = [c.capital === 3 ? `<span class="badge cap">★ National capital</span>` : "", c.capital >= 2 ? `<span class="badge cap">Regional capital</span>` : "", `<span class="badge">${esc(KIND[c.kind] || c.kind)}</span>`].join(" ");
    const [lon, lat] = [c.lon, c.lat];
    const near = w.nearbyResources(c.x, c.y, 70).slice(0, 8);
    const yearly = c.pop2014 ? ((Math.pow(c.pop2024 / c.pop2014, 0.1) - 1) * 100) : null;
    const facts = w.facts.filter((f) => ["gdp_per_capita_2024_mad", "unemployment_2024_rgph", "mean_years_schooling_25plus_2024"].includes(f.key));
    return head(badges, c.name, `${go("province", p.id, p.name)} · ${go("region", r.id, r.name)}`) + `<div class="sp-body">
      ${big([[int(c.pop2024), "residents, 2024"], change(c), ["#" + c.rank, `of ${w.cities.length} cities`]])}
      <h3>Census by census</h3>${census(c)}
      ${yearly != null ? `<p class="note">${yearly >= 0 ? "Grew" : "Shrank"} by ${Math.abs(yearly).toFixed(1)}% a year between the 2014 and 2024 censuses.</p>` : ""}
      <h3>The tile</h3><dl class="kv"><dt>Terrain</dt><dd>${esc(w.terrainName(cell))}</dd><dt>Elevation</dt><dd>${fmt(w.elev[cell], "m")}</dd>
        ${w.riverAt.get(cell) ? `<dt>River</dt><dd>${esc(w.riverAt.get(cell))}</dd>` : ""}<dt>Position</dt><dd>${Math.abs(lat).toFixed(2)}°N ${Math.abs(lon).toFixed(2)}°W</dd></dl>
      ${near.length ? `<h3>Within 70 km</h3><div class="list">${near.map(([d, x]) => resRow(x, Math.round(d) + " km")).join("")}</div>` : ""}
      ${facts.length ? `<h3>Its region, ${esc(r.name)}</h3><dl class="kv">${facts.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(fmt(f.values[r.id], f.fmt))}</dd>`).join("")}</dl>
        <p class="note">Morocco publishes accounts, jobs and schooling by region, not by city. ${go("region", r.id, "Open the region")}</p>` : ""}
      <p class="src">Population: HCP censuses (RGPH 2024). Place: Overture Maps. Land: ESA WorldCover, SRTM.</p></div>`;
  }

  function factRows(id) {
    return w.facts.map((f) => {
      let v = f.values[id], extra = "";
      if (v == null && f.grouped && f.grouped.regions.includes(id)) { v = f.grouped.value; extra = `<small>south, grouped</small>`; }
      else { const rk = w.rankOf(f.values, id); if (rk) extra = `<small>${ord(rk.rank)} of ${rk.n}</small>`; }
      return v == null ? "" : `<dt>${esc(f.label)}</dt><dd>${esc(fmt(v, f.fmt))}${extra}</dd>`;
    }).join("");
  }

  function regionPanel(r, cell) {
    const provs = w.provinces.filter((p) => p.region === r.id).sort((a, b) => b.pop2024 - a.pop2024), maxP = provs[0].pop2024;
    const cap = w.cities.find((c) => c.region === r.id && c.capital >= 2);
    let here = "";
    if (cell != null && cell >= 0) {
      const p = w.provinceAt(cell);
      here = `<h3>This hex</h3><dl class="kv"><dt>Terrain</dt><dd>${esc(w.terrainName(cell))}</dd><dt>Elevation</dt><dd>${fmt(w.elev[cell], "m")}</dd>
        ${w.riverAt.get(cell) ? `<dt>River</dt><dd>${esc(w.riverAt.get(cell))}</dd>` : ""}
        <dt>${p.kind === "prefecture" ? "Prefecture" : "Province"}</dt><dd><button type="button" class="linkish" data-go="province:${p.id}">${esc(p.name)}</button></dd></dl>`;
    }
    const sec = w.sectors && w.sectors[r.id];
    const share = (r.pop2024 / w.national.pop2024) * 100;
    return head(`<span class="badge" style="border-color:${r.color};color:${r.color}">Region · ${esc(r.iso)}</span>`, r.name,
      cap ? `Capital: ${go("city", cap.id, cap.name)}` : `Capital: ${esc(r.capital)}`) + `<div class="sp-body">
      ${big([[compact(r.pop2024), "residents, 2024"], [compact(r.area_km2) + " km²", "area"], [fmt(r.density, "density"), "density"]])}
      ${here}
      <h3>People</h3>${census(r)}<p class="note">${share.toFixed(1)}% of Morocco's population. ${change(r)[0]} since the 2014 census.</p>
      ${sec ? `<h3>Economy, 2024</h3>${stack(sec.map((v, i) => [v, SECTORS[i][0], SECTORS[i][1]]))}` : ""}
      <h3>Figures</h3><dl class="kv">${factRows(r.id)}</dl>
      ${land(r)}
      <h3>Provinces and prefectures</h3><div class="bars">${provs.map((p) => `<button type="button" class="bar-row" data-go="province:${p.id}"><span class="nm">${esc(p.name)}</span><span class="tr"><i style="width:${(p.pop2024 / maxP) * 100}%"></i></span><span class="vl">${compact(p.pop2024)}</span></button>`).join("")}</div>
      ${cityList(w.citiesIn("region", r.id))}
      ${resList(w.resourcesIn("region", r.id))}
      <p class="src">HCP (census, regional accounts, employment survey, poverty mapping), Ministry of Tourism. Definitions and links: <button type="button" class="linkish" data-almanac="Sources">Almanac</button>.</p></div>`;
  }

  function provincePanel(p) {
    const r = w.regionById.get(p.region), peers = w.provinces;
    const rank = (key) => { const v = Object.fromEntries(peers.map((x) => [x.id, x[key]])); const k = w.rankOf(v, p.id); return k ? `<small>${ord(k.rank)} of ${k.n}</small>` : ""; };
    return head(`<span class="badge">${p.kind === "prefecture" ? "Prefecture" : "Province"}</span>`, p.name, `Region: ${go("region", r.id, r.name)}`) + `<div class="sp-body">
      ${big([[compact(p.pop2024), "residents, 2024"], [compact(p.area_km2) + " km²", "area"], [fmt(p.density, "density"), "density"]])}
      <h3>People</h3>${census(p)}
      <dl class="kv" style="margin-top:8px"><dt>Population, 2024</dt><dd>${int(p.pop2024)}${rank("pop2024")}</dd><dt>Density</dt><dd>${fmt(p.density, "density")}${rank("density")}</dd>
        <dt>Yearly change, 2014 to 2024</dt><dd>${fmt(p.growth, "signedpct")}${rank("growth")}</dd></dl>
      ${land(p)}
      ${cityList(w.citiesIn("province", p.id), 12)}
      ${resList(w.resourcesIn("province", p.id))}
      <p class="note">GDP, jobs, schooling and poverty are published by region. ${go("region", r.id, "Open " + r.name)}</p>
      <p class="src">Population: HCP censuses (RGPH 2024). Area: citypopulation.de. Outline: geoBoundaries.</p></div>`;
  }

  function resourcePanel(x) {
    const cat = w.resourceCats.find((c) => c.id === x.cat) || { label: x.cat, color: "#888" };
    const p = w.provinceById.get(x.province), r = w.regionById.get(x.region);
    const peers = w.resources.filter((o) => o.cat === x.cat && o !== x).sort((a, b) => (b.statValue || 0) - (a.statValue || 0)).slice(0, 10);
    const status = x.status && x.status !== "n/a" ? `<span class="badge">${esc(x.status)}</span>` : "";
    return head(`<span class="res-dot" style="background:${cat.color}">${icon(resourceIcon(x.kind, x.cat), 12)}</span> ${esc(cat.label)}${x.kind ? " · " + esc(x.kind.replace(/_/g, " ")) : ""} ${status}`, x.name,
      `${go("province", p.id, p.name)} · ${go("region", r.id, r.name)}`) + `<div class="sp-body">
      ${x.statValue != null ? big([[compact(x.statValue) + " " + (x.statUnit || ""), (x.statLabel || "") + (x.statYear ? ", " + x.statYear : "")]]) : ""}
      ${x.note ? `<p class="note" style="margin-top:10px;color:var(--ink)">${esc(x.note)}</p>` : ""}
      ${x.approx ? `<p class="note">Lower-confidence entry: the position is approximate, or the figure comes from a secondary summary of its source.</p>` : ""}
      <h3>The tile</h3><dl class="kv"><dt>Terrain</dt><dd>${esc(w.terrainName(x.cell))}</dd><dt>Elevation</dt><dd>${fmt(w.elev[x.cell], "m")}</dd>
        <dt>Position</dt><dd>${Math.abs(x.lat).toFixed(2)}°N ${Math.abs(x.lon).toFixed(2)}°W</dd></dl>
      ${peers.length ? `<h3>More ${esc(cat.label.toLowerCase())}</h3><div class="list">${peers.map((o) => resRow(o)).join("")}</div>` : ""}
      ${x.url ? `<p class="src">Source: <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(new URL(x.url).hostname.replace(/^www\./, ""))}</a></p>` : ""}</div>`;
  }

  function render(sel) {
    document.body.classList.toggle("has-panel", !!sel);
    if (!sel) { el.classList.remove("open"); el.innerHTML = ""; return; }
    let h = "";
    if (sel.kind === "city") h = cityPanel(w.cityById.get(sel.id));
    else if (sel.kind === "region") h = regionPanel(w.regionById.get(sel.id), sel.cell);
    else if (sel.kind === "province") h = provincePanel(w.provinceById.get(sel.id));
    else if (sel.kind === "resource") h = resourcePanel(w.resourceById.get(sel.id));
    el.innerHTML = h;
    el.classList.add("open");
    const body = el.querySelector(".sp-body");
    if (body) body.scrollTop = 0;
  }
  el.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) return app.select(null);
    const g = e.target.closest("[data-go]"), a = e.target.closest("[data-almanac]");
    if (g) { const [kind, id] = g.dataset.go.split(":"); app.select({ kind, id }, { fly: true }); }
    else if (a) app.openAlmanac(a.dataset.almanac);
  });
  app.on("select", render);
  return { close: () => render(null) };
}
