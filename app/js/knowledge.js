// Loads the local crop knowledge base. Cached by the service worker, so the
// library and the guides stay usable with no network.
import { tx } from './i18n.js';

export const CROP_IDS = ['olive', 'orange', 'lemon', 'avocado'];
let cache = null;

export async function loadCrops() {
  if (cache) return cache;
  const crops = await Promise.all(
    CROP_IDS.map(id => fetch(`data/crops/${id}.json`).then(r => {
      if (!r.ok) throw new Error(`crops/${id}: HTTP ${r.status}`);
      return r.json();
    }))
  );
  cache = crops;
  return cache;
}

export function getCrop(crops, id) {
  return crops.find(c => c.id === id) || null;
}

export function findIssue(crops, cropId, issueId) {
  const c = getCrop(crops, cropId);
  if (!c) return null;
  return c.issues.find(i => i.id === issueId) || null;
}

// Matches a free-text model verdict back onto a knowledge-base entry, so the
// result screen can attach a vetted step-by-step guide to it.
export function matchIssue(crop, verdict) {
  if (!crop || !verdict) return null;
  const needle = normalise(verdict);
  let best = null, bestScore = 0;
  for (const issue of crop.issues) {
    const candidates = [issue.id.replace(/_/g, ' '), issue.latin, issue.name.fr, issue.name.en, issue.name.ar];
    for (const cand of candidates) {
      const score = overlap(needle, normalise(cand));
      if (score > bestScore) { bestScore = score; best = issue; }
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function normalise(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0600-\u06ff ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Share of the shorter string's significant words that appear in the other.
function overlap(a, b) {
  if (!a || !b) return 0;
  const wa = a.split(' ').filter(w => w.length > 2);
  const wb = b.split(' ').filter(w => w.length > 2);
  if (!wa.length || !wb.length) return 0;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const hits = short.filter(w => long.some(x => x.includes(w) || w.includes(x))).length;
  return hits / short.length;
}

// A search URL rather than a hard-coded video id: links that can't rot.
export function videoSearchUrl(cropName, issueName, lang) {
  const terms = { fr: 'traitement verger', ar: 'علاج بستان', en: 'orchard treatment' }[lang] || '';
  const q = encodeURIComponent(`${cropName} ${issueName} ${terms}`.trim());
  return `https://www.youtube.com/results?search_query=${q}`;
}

export function issueSummaryFor(crops) {
  // Compact catalogue handed to the model so its verdict lands on a known label.
  return crops.map(c => ({
    crop: c.id,
    issues: c.issues.map(i => ({ id: i.id, name: i.name.fr, latin: i.latin, type: i.type }))
  }));
}

export { tx };
