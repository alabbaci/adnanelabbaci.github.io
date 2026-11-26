// The Almanac: what the map shows, how each number is defined, and where it comes from.
import { fmt, esc, compact, int } from "./format.js";
import { icon, resourceIcon } from "./icons.js";
import { BIOME_RGB } from "./render.js";

const PAGES = ["About this map", "Yields", "Regions", "Terrain", "Lenses", "Resources", "Sources"];
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

export function initAlmanac(app, close) {
  const w = app.world, nav = document.getElementById("pedia-nav"), body = document.getElementById("pedia-body");
  let page = PAGES[0], sort = { key: "pop2024", dir: -1 };
  nav.innerHTML = `<div class="hd">Almanac</div>` + PAGES.map((p) => `<button type="button" data-page="${p}">${p}</button>`).join("");
  nav.addEventListener("click", (e) => { const b = e.target.closest("[data-page]"); if (b) show(b.dataset.page); });
  body.addEventListener("click", (e) => {
    const g = e.target.closest("[data-go]"), l = e.target.closest("[data-lens]"), th = e.target.closest("th[data-sort]"), pg = e.target.closest("[data-page]");
    if (g) { const [kind, id] = g.dataset.go.split(":"); close(); app.select({ kind, id }, { fly: true }); }
    else if (l) { close(); app.setLens(l.dataset.lens || null); }
    else if (th) { sort = { key: th.dataset.sort, dir: sort.key === th.dataset.sort ? -sort.dir : -1 }; show("Regions"); }
    else if (pg) show(pg.dataset.page);
  });

  const src = (name, url) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)}</a>` : esc(name));

  const pages = {
    "About this map"() {
      const land = w.regions.reduce((a, r) => a + (r.geo ? r.geo.n : 0), 0);
      return `<h2>About this map</h2>
        <p>This is the real Morocco drawn the way a 4X strategy game draws its world: a board of hexagons with terrain, cities with banners, resources on tiles, and a bar of national yields along the top. Nothing on it is invented. The terrain comes from satellite land cover and elevation data, the cities and their sizes from the 2024 census, and every figure from a published table.</p>
        <p><b>Scale.</b> Each hex is ${w.grid.hexKm} km across and covers ${w.hexAreaKm2} km². The country takes ${int(land)} hexes. The map uses an equal-area projection, so a hex is the same amount of ground in Tangier and in Dakhla.</p>
        <p><b>Turn ${esc(w.meta.turn)}.</b> The base year is 2024: the general census of population and housing (RGPH 2024) and the 2024 regional accounts. A few figures come from other years and say so.</p>
        <p><b>How to read it.</b> Hover any hex for its terrain, height and land cover. Click a city for its screen, click land for its region, click an icon for a mine, dam, port or power plant. The <b>Lenses</b> recolour the map by one statistic at a time. The legend's scale can be dragged to show only a range.</p>
        <h3>What is on the board</h3>
        <p>The 12 regions of the 2015 division are in play: they are the units Morocco's statistics office, the Haut-Commissariat au Plan (HCP), publishes for. Their outlines, and those of the 75 provinces and prefectures, come from geoBoundaries. Land beyond them (Algeria, Mauritania, Spain, the Canary Islands) is drawn dimmed for context and carries no data.</p>
        <p>Laâyoune-Sakia El Hamra, Dakhla-Oued Ed-Dahab and part of Guelmim-Oued Noun lie in Western Sahara, whose status is disputed and which the United Nations lists as a non-self-governing territory. The census and accounts shown for those regions are the Moroccan official ones, as published by HCP.</p>
        <h3>What a yield is here</h3>
        <p>Strategy games count food, production, gold, science and culture. Morocco publishes no such thing, so each yield is tied to the closest official series, and named for what it really is. See <button type="button" class="linkish" data-page="Yields">Yields</button> for the exact definitions. Most economic and social statistics exist by region only, so a city screen shows the city's own population history and its region's figures, never numbers apportioned down to the city.</p>
        <p class="muted">Generated ${esc(w.meta.generated)}. Inspired by Andrej Karpathy's usaciv. Code and data pipeline are in this site's repository.</p>`;
    },
    Yields() {
      return `<h2>Yields</h2><p>The seven numbers in the top bar. Click one on the bar for its breakdown by region.</p>` + w.yields.map((y) => `<div class="yield-def"><span style="color:${y.color}">${icon(y.icon, 22)}</span><div>
        <b>${esc(y.label)}: ${esc(fmt(y.value, y.fmt))}</b><br><span class="muted">${esc(y.definition)}</span><br>
        <span class="muted">Source: ${src(y.source, y.sourceUrl)}${y.year ? ", " + y.year : ""}.</span>
        ${y.lens && w.lensById.has(y.lens) ? ` <button type="button" class="linkish" data-lens="${y.lens}">Show on the map</button>` : ""}</div></div>`).join("");
    },
    Regions() {
      const f = (key) => w.facts.find((x) => x.key === key);
      const cols = [["pop2024", "Population", (r) => r.pop2024, "int"], ["area_km2", "Area km²", (r) => r.area_km2, "int"], ["density", "Density", (r) => r.density, "x1"],
        ["growth", "Growth/yr", (r) => r.growth, "signedpct"]];
      for (const [key, label, kind] of [["gdp_2024_mad_million", "GDP", "mad"], ["gdp_per_capita_2024_mad", "GDP/head", "int"], ["unemployment_2024_rgph", "Unempl.", "pct"],
        ["mean_years_schooling_25plus_2024", "Schooling", "x1"], ["poverty_multidim_2024", "Poverty", "pct"]]) {
        const fact = f(key);
        if (fact) cols.push([key, label, (r) => fact.values[r.id], kind]);
      }
      const col = cols.find((c) => c[0] === sort.key) || cols[0];
      const rows = [...w.regions].sort((a, b) => ((col[2](a) ?? -1e18) - (col[2](b) ?? -1e18)) * sort.dir);
      return `<h2>Regions</h2><p>The 12 regions, with their capital and headline figures. Click a column to sort, a row to open the region.</p>
        <div class="tablewrap"><table><thead><tr><th>Region</th><th>Capital</th>${cols.map((c) => `<th class="n sortable" data-sort="${c[0]}">${c[1]}${sort.key === c[0] ? (sort.dir < 0 ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr class="click" data-go="region:${r.id}"><td><span style="color:${r.color}">◆</span> ${esc(r.name)}</td><td>${esc(r.capital)}</td>${cols.map((c) => `<td class="n">${esc(fmt(c[2](r), c[3]))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
        <p class="muted">Population and growth: HCP censuses 2014 and 2024. Area: sum of province areas from citypopulation.de. GDP: HCP regional accounts 2024, current dirhams. Unemployment: 2024 census rate. Schooling: mean years, age 25 and over. Poverty: multidimensional, 2024.</p>`;
    },
    Terrain() {
      const sw = (c) => `<span class="swatch" style="background:${rgb(c)};clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)"></span>`;
      const row = (c, name, rule) => `<tr><td>${sw(c)}</td><td><b>${name}</b></td><td>${rule}</td></tr>`;
      return `<h2>Terrain</h2>
        <p>Every hex gets its terrain from two measurements of the ground inside it: the share of each land-cover class in ESA WorldCover 2021 (10 m satellite classification), and the spread of elevations in the SRTM-based terrain tiles. The rules are fixed and the same everywhere.</p>
        <h3>Ground</h3><table><tbody>
        ${row(BIOME_RGB.desert, "Desert", "Bare or sparsely vegetated ground covers at least 60% of the hex.")}
        ${row(BIOME_RGB.farmland, "Farmland", "Cropland covers at least 30% and is the leading cover.")}
        ${row(BIOME_RGB.grassland, "Steppe grassland", "Otherwise, grassland is the largest cover. In Morocco this is mostly dry steppe and pasture.")}
        ${row(BIOME_RGB.scrub, "Scrubland", "Otherwise, shrubs are the largest cover.")}
        ${row(BIOME_RGB.coast, "Coast and ocean", "Less than half the hex is land. Coast is sea next to land; ocean colour deepens with depth (GEBCO).")}
        ${row(BIOME_RGB.lake, "Lake", "Water not connected to the sea.")}
        </tbody></table>
        <h3>Relief</h3><table><tbody>
        <tr><td></td><td><b>Hills</b></td><td>Elevations inside the hex vary with a standard deviation of 55 m or more.</td></tr>
        <tr><td></td><td><b>Mountains</b></td><td>Standard deviation of 150 m or more, or a mean height above 1,800 m with 95 m or more.</td></tr>
        <tr><td></td><td><b>Snow line</b></td><td>A mountain hex that reaches 3,300 m. These are the High Atlas summits around Toubkal and M'Goun.</td></tr>
        </tbody></table>
        <h3>Features</h3><table><tbody>
        <tr><td></td><td><b>Forest</b></td><td>Tree cover of 28% or more. Drawn as conifers above 1,250 m (cedar and pine country), broadleaf below (cork oak, holm oak, argan).</td></tr>
        <tr><td></td><td><b>Oasis</b></td><td>A desert hex where crops and trees together cover 5% or more: the palm groves of the Drâa, Ziz and Dadès valleys.</td></tr>
        <tr><td></td><td><b>Town</b></td><td>Built-up ground covers 10% or more of the hex.</td></tr>
        <tr><td></td><td><b>Marsh</b></td><td>Wetland covers 20% or more.</td></tr>
        </tbody></table>
        <p>Shading follows a hillshade of the real relief, lit from the north-west. Rivers, roads and railways are the real lines from OpenStreetMap via Overture Maps, simplified.</p>`;
    },
    Lenses() {
      const lvl = { region: "12 regions", province: "75 provinces and prefectures", hex: "each hex" };
      return `<h2>Lenses</h2><p>A lens recolours the land by one statistic. Each is published at a certain level, and the map never pretends to more detail than the source has: a regional figure paints the whole region one colour.</p>
        <table><thead><tr><th>Lens</th><th>Level</th><th>What it shows</th></tr></thead><tbody>${w.lenses.map((L) => `<tr><td><button type="button" class="linkish" data-lens="${L.id}">${esc(L.label)}</button></td>
        <td>${lvl[L.level]}${L.year ? "<br><span class='muted'>" + L.year + "</span>" : ""}</td><td>${esc(L.note || "")}<br><span class="muted">${src(L.source || "", L.sourceUrl)}</span></td></tr>`).join("")}</tbody></table>`;
    },
    Resources() {
      if (!w.resources.length) return `<h2>Resources</h2><p>No resources are loaded.</p>`;
      return `<h2>Resources</h2><p>Real sites placed on the hex they stand on. Click one to fly to it.</p>` + w.resourceCats.map((c) => {
        const list = w.resources.filter((r) => r.cat === c.id).sort((a, b) => (b.statValue || 0) - (a.statValue || 0) || a.name.localeCompare(b.name));
        if (!list.length) return "";
        return `<h3><span style="color:${c.color}">${icon(resourceIcon("", c.id), 15)}</span> ${esc(c.label)} <span class="muted">(${list.length})</span></h3><table><tbody>${list.map((r) => `<tr class="click" data-go="resource:${r.id}">
          <td><b>${esc(r.name)}</b>${r.kind ? `<br><span class="muted">${esc(r.kind.replace(/_/g, " "))}${r.status && r.status !== "n/a" && r.status !== "operating" ? " · " + esc(r.status) : ""}</span>` : ""}</td>
          <td class="n">${r.statValue != null ? esc(compact(r.statValue) + " " + (r.statUnit || "")) + (r.statYear ? `<br><span class="muted">${r.statYear}</span>` : "") : ""}</td><td>${esc(r.note || "")}</td></tr>`).join("")}</tbody></table>`;
      }).join("");
    },
    Sources() {
      return `<h2>Sources</h2><p>Everything on the map is built by three small scripts from the public sources below. Tables that had to be transcribed are kept, with their links, next to the scripts.</p>
        <table><thead><tr><th>Source</th><th>Used for</th><th>Terms</th></tr></thead><tbody>${w.sources.map((s) => `<tr><td>${src(s.name, s.url)}</td><td>${esc(s.what)}</td><td>${esc(s.license || "")}</td></tr>`).join("")}</tbody></table>
        <h3>Known limits</h3>
        <ul>
          <li><b>Cities.</b> ${w.cities.length} cities and urban communes are shown, as listed in the census tables. The six largest are whole cities (all arrondissements together); the others are single urban communes, so a suburb that is its own commune appears as its own city. Two communes were left out because no reliable coordinates were found for them.</li>
          <li><b>Regional figures.</b> GDP, schooling, poverty and tourism are published by region. The employment survey groups the three southern regions; the Unemployment lens therefore uses the census rate, which is higher than the survey rate because the two measure joblessness differently.</li>
          <li><b>Census education and unemployment by region.</b> A few regional values were read from charts in the HCP results note rather than from a table. They are flagged in the source file.</li>
          <li><b>Areas.</b> Province areas are computed from geospatial data by citypopulation.de; official area figures differ slightly between sources.</li>
          <li><b>Terrain.</b> A hex takes the dominant land cover of ${w.hexAreaKm2} km². Small features inside it, such as a narrow valley oasis or a reservoir, may not show.</li>
          <li><b>Resources.</b> A curated selection of notable sites, not a complete inventory. Figures carry their own year.</li>
        </ul>`;
    },
  };

  function show(p) {
    if (p && pages[p]) page = p;
    for (const b of nav.querySelectorAll("button")) b.classList.toggle("active", b.dataset.page === page);
    body.innerHTML = pages[page]();
    body.scrollTop = 0;
  }
  return { show };
}
