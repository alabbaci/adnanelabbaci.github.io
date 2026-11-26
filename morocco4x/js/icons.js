// One small icon set, used both as inline SVG in the interface and as canvas glyphs on the map.
// All paths live in a 24x24 box and are filled (even-odd).

function gear(teeth, r1, r2, hole) {
  let d = "";
  const n = teeth * 4;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / n, r = i % 4 < 2 ? r1 : r2;
    d += (i ? "L" : "M") + (12 + Math.cos(a) * r).toFixed(2) + " " + (12 + Math.sin(a) * r).toFixed(2);
  }
  return d + `ZM${12 + hole} 12a${hole} ${hole} 0 1 0 ${-2 * hole} 0a${hole} ${hole} 0 1 0 ${2 * hole} 0Z`;
}
function sun() {
  let d = "M16.4 12a4.4 4.4 0 1 0 -8.8 0a4.4 4.4 0 1 0 8.8 0Z";
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), p = (r, o) => `${(12 + c * r - s * o).toFixed(2)} ${(12 + s * r + c * o).toFixed(2)}`;
    d += `M${p(6.3, -1.2)}L${p(10.4, 0)}L${p(6.3, 1.2)}Z`;
  }
  return d;
}

export const PATHS = {
  search: "M10 3a7 7 0 1 0 4.2 12.6l5 5 1.6-1.6-5-5A7 7 0 0 0 10 3Zm0 2.2a4.8 4.8 0 1 1 0 9.6 4.8 4.8 0 0 1 0-9.6Z",
  share: "M18 2.5a3 3 0 1 1-2.75 4.2L9.4 10a3 3 0 0 1 0 4l5.85 3.3A3 3 0 1 1 14.3 19l-5.9-3.3a3 3 0 1 1 0-7.4L14.3 5A3 3 0 0 1 18 2.5Z",
  help: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 15a1.35 1.35 0 1 1 0 2.7 1.35 1.35 0 0 1 0-2.7ZM12 5.2c2.3 0 4 1.5 4 3.6 0 1.6-.9 2.5-1.9 3.2-.8.6-1.1 1-1.1 1.9v.5h-2.1v-.7c0-1.6.7-2.4 1.7-3.1.8-.6 1.2-1 1.2-1.7 0-.9-.7-1.5-1.8-1.5s-1.9.6-2.1 1.8l-2.1-.4c.4-2.2 2-3.6 4.200-3.600Z",
  book: "M2 5c3-1.500 6.500-1.500 9 .5V20c-2.500-1.700-6-1.800-9-.5ZM22 5c-3-1.500-6.500-1.500-9 .5V20c2.500-1.700 6-1.800 9-.5Z",
  gem: "M7 3h10l5 6-10 12L2 9ZM8.200 10.500h7.600L12 17.200Z",
  map: "M2 6l6-2.200 8 2.200 6-2.200v14.400l-6 2.200-8-2.200-6 2.200ZM7.400 5.600v12.800l1.200.3V5.900ZM15.400 6.300v12.800l1.200.3V6.600Z",
  layers: "M12 2.600 22 7.800 12 13 2 7.800ZM4.200 11.300 12 15.300l7.800-4L22 12.400l-10 5.200-10-5.200ZM4.200 15.600 12 19.600l7.800-4L22 16.700l-10 5.200-10-5.200Z",
  pop: "M9 4a3.300 3.300 0 1 1 0 6.600A3.300 3.300 0 0 1 9 4ZM2.500 20v-1.500a6.500 6.500 0 0 1 13 0V20ZM17 5.500a2.700 2.700 0 1 1 0 5.400 2.700 2.700 0 0 1 0-5.400ZM17.500 20v-1.500c0-1.800-.600-3.500-1.600-4.800a5 5 0 0 1 6.100 4.900V20Z",
  food: "M11.200 22V9.500h1.600V22ZM12 2c1.300 1.300 1.600 3 0 5-1.600-2-1.300-3.700 0-5ZM7 6.500c2 .1 3.600 1 4.200 3.500C8.900 9.900 7.400 8.800 7 6.500ZM17 6.500c-2 .1-3.600 1-4.200 3.500 2.300-.1 3.800-1.200 4.200-3.500ZM7 11c2 .1 3.600 1 4.200 3.500C8.900 14.400 7.400 13.300 7 11ZM17 11c-2 .1-3.600 1-4.200 3.500 2.300-.1 3.800-1.200 4.200-3.500ZM7 15.500c2 .1 3.600 1 4.200 3.500-2.300-.1-3.800-1.200-4.200-3.500ZM17 15.500c-2 .1-3.600 1-4.200 3.500 2.300-.1 3.800-1.200 4.200-3.500Z",
  production: gear(8, 10.2, 7.7, 3.3),
  gold: "M12 3c4.400 0 8 1.200 8 2.800S16.400 8.600 12 8.600 4 7.400 4 5.800 7.600 3 12 3ZM4 8.400c1.500 1.300 4.500 2 8 2s6.500-.700 8-2v2.700c0 1.600-3.600 2.800-8 2.800s-8-1.200-8-2.800ZM4 13.600c1.500 1.300 4.500 2 8 2s6.500-.700 8-2v2.700c0 1.600-3.600 2.800-8 2.800s-8-1.200-8-2.800Z",
  science: "M9 2h6v2h-1v5.200l5.600 9.400a2 2 0 0 1-1.700 3H6.100a2 2 0 0 1-1.700-3L10 9.200V4H9Zm3 9.400-3.500 5.900h7Z",
  culture: "M3 21V9.500a9 9 0 0 1 18 0V21h-5.200v-7.200a3.800 3.800 0 1 0-7.600 0V21Z",
  work: "M9 4h6a2 2 0 0 1 2 2v1h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3V6a2 2 0 0 1 2-2Zm0 3h6V6H9Z",
  pick: "M3.500 9.500C7 4.500 14 3 20.500 5.500c-4.600-.300-8.400.600-11.300 2.900l9.900 9.900-2.200 2.200-9.900-9.900C5.800 11.900 5 13.300 4.800 15Z",
  sun: sun(),
  wind: "M11.200 13h1.600l.8 9h-3.200ZM12 12.300 10.900 3c.7-.5 1.500-.5 2.200 0ZM12.300 12.500l8 3.700c0 .9-.4 1.600-1.100 2ZM11.700 12.500l-8 3.700c0 .9.4 1.600 1.100 2ZM13.600 12a1.600 1.600 0 1 0-3.200 0 1.600 1.600 0 0 0 3.200 0Z",
  bolt: "M13.500 2 5 13.500h5.500L9.500 22 19 10h-5.800Z",
  drop: "M12 2.500c3.500 4.200 6 7.400 6 10.700a6 6 0 0 1-12 0c0-3.300 2.500-6.500 6-10.700Z",
  dam: "M3 20 6.500 4.500h4L14 20ZM15.500 9.500c1 0 1.400.700 2.400.700s1.400-.700 2.600-.700V20h-4.300Z",
  anchor: "M12 2a2.600 2.600 0 0 1 1.100 5v2.200h3v2h-3v8.100c2.600-.500 4.600-2.400 5.100-4.900l-1.700.5 2.300-3.900 2.700 3.600-1.300-.1c-.800 4.200-4.200 7-8.200 7s-7.400-2.800-8.200-7l-1.300.1 2.700-3.600 2.300 3.900-1.700-.5c.5 2.500 2.500 4.400 5.100 4.900V11.200h-3v-2h3V7A2.600 2.600 0 0 1 12 2Z",
  fish: "M2 12c3-4.500 8-6 13-3.500L21.500 5v14L15 15.500C10 18 5 16.500 2 12Zm5.500-1.500a1.200 1.200 0 1 0 0 2.400 1.200 1.200 0 0 0 0-2.400Z",
  plane: "M12 2c.9 0 1.500 1 1.500 2.500V9l8 4.500v2l-8-2.300v4.600l2.500 1.900V21L12 20l-4 1v-1.300l2.500-1.900v-4.600l-8 2.300v-2l8-4.500V4.500C10.500 3 11.100 2 12 2Z",
  leaf: "M20 3c.5 8-2 14-9.500 15.500L9 21H7l1.300-3.200C5 15 5.500 9 10 6c3-2 6.500-2.500 10-3ZM9.500 16C14 13.500 16 10 17 6c-3 3.500-5.500 6-7.500 10Z",
  factory: "M2 21V10l6 3.500V10l6 3.500V4h6v17Z",
  city: "M3 21V10l5-3v4l4-3v13ZM13 21V4h8v17Zm2.200-14.500v2h1.500v-2Zm0 4v2h1.500v-2Zm0 4v2h1.500v-2Z",
  region: "M12 2 21 7v10l-9 5-9-5V7Zm0 2.600L5.300 8.300v7.400L12 19.400l6.700-3.700V8.300Z",
  target: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2.400a7.600 7.600 0 1 1 0 15.200 7.600 7.600 0 0 1 0-15.200Zm0 3.600a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
};

export function icon(name, size = 15) {
  const d = PATHS[name] || PATHS.gem;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="${d}"/></svg>`;
}

export function resourceIcon(kind, cat) {
  const k = (kind || "").toLowerCase();
  if (cat === "mine") return "pick";
  if (cat === "power") return /solar|csp|pv/.test(k) ? "sun" : /wind/.test(k) ? "wind" : /hydro|pumped/.test(k) ? "drop" : "bolt";
  if (cat === "dam") return "dam";
  if (cat === "port") return "anchor";
  if (cat === "fishing_port") return "fish";
  if (cat === "airport") return "plane";
  if (cat === "unesco") return "culture";
  if (cat === "agri") return /fish|sardine|octopus|camel/.test(k) ? "fish" : /cereal|wheat|sugar/.test(k) ? "food" : "leaf";
  return "factory";
}

const cache = new Map();
export function glyph(ctx, kind, cat, x, y, size) {
  const name = resourceIcon(kind, cat);
  let p = cache.get(name);
  if (!p) { p = new Path2D(PATHS[name]); cache.set(name, p); }
  const s = size / 24;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2); ctx.scale(s, s);
  ctx.fillStyle = "#fff";
  ctx.fill(p, "evenodd");
  ctx.restore();
}

export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) { el.innerHTML = icon(el.dataset.icon, +el.dataset.size || 15); el.removeAttribute("data-icon"); }
}
