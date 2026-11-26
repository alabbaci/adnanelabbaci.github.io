// Number formatting shared by every panel.
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e12) return trim(v / 1e12) + "T";
  if (a >= 1e9) return trim(v / 1e9) + "B";
  if (a >= 1e6) return trim(v / 1e6) + "M";
  if (a >= 1e4) return Math.round(v / 1e3) + "K";
  if (a >= 1e3) return trim(v / 1e3) + "K";
  return nf0.format(v);
}
function trim(v) { const a = Math.abs(v); return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/0$/, ""); }

export function fmt(v, kind) {
  if (v == null || Number.isNaN(v)) return "n/a";
  switch (kind) {
    case "int": return nf0.format(v);
    case "compact": return compact(v);
    case "pct": return nf1.format(v) + "%";
    case "pct0": return nf0.format(v) + "%";
    case "signedpct": return (v > 0 ? "+" : "") + nf1.format(v) + "%";
    case "mad": return "MAD " + compact(v);
    case "madpc": return "MAD " + nf0.format(v);
    case "density": return (v >= 100 ? nf0.format(v) : nf1.format(v)) + " /km²";
    case "km2": return nf0.format(v) + " km²";
    case "m": return nf0.format(v) + " m";
    case "x1": return nf1.format(v);
    default: return nf0.format(v);
  }
}
export const int = (v) => nf0.format(v);
export function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
export function fold(s) { return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
