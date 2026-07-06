// Step 3 — headless smoke test of the built HTML.
// Decodes the payload straight out of the file and verifies that the
// packed arrays are self-consistent and all libraries are inlined.
const fs = require('fs');

const html = fs.readFileSync(process.argv[2] || 'casablanca-night-grid.html', 'utf8');
let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}`);
  if (!ok) failed++;
};

// libraries present
for (const marker of [
  'REVISION=', 'WebGLRenderer', 'OrbitControls', 'EffectComposer', 'RenderPass',
  'ShaderPass', 'CopyShader', 'LuminosityHighPassShader',
  'UnrealBloomPass', 'MaskPass', 'window.earcut',
]) check(`library inlined: ${marker}`, html.includes(marker));
check('no CommonJS leftovers in earcut', !/module\.exports/.test(html));
check('no external URLs in fetch/src/href', !/src\s*=\s*["']https?:/.test(html));

// extract payload
const m = html.match(/const P = (\{.*?\});\n/s);
check('payload found', !!m);
const P = JSON.parse(m[1]);
const dec = (s, T) => new T(new Uint8Array(Buffer.from(s, 'base64')).buffer);

const bLens = dec(P.bldRingLens, Uint16Array);
const bRole = dec(P.bldRingRole, Uint8Array);
const bPer = dec(P.bldRingsPer, Uint8Array);
const bStart = dec(P.bldStarts, Int32Array);
const bDelta = dec(P.bldDeltas, Int16Array);
const bH = dec(P.bldHeights, Float32Array);
const rLens = dec(P.roadLens, Uint16Array);
const rStart = dec(P.roadStarts, Int32Array);
const rDelta = dec(P.roadDeltas, Int16Array);

const sum = (a) => { let s = 0; for (const v of a) s += v; return s; };

check(`meta.nBld (${P.meta.nBld}) == heights == ringsPer`,
  P.meta.nBld === bH.length && P.meta.nBld === bPer.length);
check(`sum(ringsPer) == nRings (${bLens.length})`,
  sum(bPer) === bLens.length && bRole.length === bLens.length);
check('first ring of every building is outer', (() => {
  let r = 0;
  for (let b = 0; b < bPer.length; b++) { if (bRole[r] !== 0) return false; r += bPer[b]; }
  return true;
})());
check(`bld starts pairs == nRings`, bStart.length === 2 * bLens.length);
check(`sum(bldRingLens) - nRings == bld delta pairs `
  + `(${sum(bLens) - bLens.length})`,
  sum(bLens) - bLens.length === bDelta.length / 2);
check('every ring has >= 3 vertices', bLens.every((l) => l >= 3));
check('all heights finite', bH.every(Number.isFinite));
check(`meta.nRoad (${P.meta.nRoad}) == road polylines`,
  P.meta.nRoad === rLens.length && rStart.length === 2 * rLens.length);
check(`sum(roadLens) - nRoads == road delta pairs `
  + `(${sum(rLens) - rLens.length})`,
  sum(rLens) - rLens.length === rDelta.length / 2);
check('every polyline has >= 2 points', rLens.every((l) => l >= 2));

// reconstruct extents as the app will
let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
{
  let d = 0;
  for (let i = 0; i < bLens.length; i++) {
    let qx = bStart[2 * i], qy = bStart[2 * i + 1];
    for (let k = 0; k < bLens[i]; k++) {
      if (k > 0) { qx += bDelta[d++]; qy += bDelta[d++]; }
      if (qx < minx) minx = qx; if (qx > maxx) maxx = qx;
      if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
    }
  }
}
const wKm = (maxx - minx) / P.meta.scale / 1000;
const hKm = (maxy - miny) / P.meta.scale / 1000;
check(`city extent sane (${wKm.toFixed(1)} x ${hKm.toFixed(1)} km)`,
  wKm > 3 && wKm < 40 && hKm > 3 && hKm < 40);
const maxH = Math.max(...bH);
check(`max height sane (${maxH.toFixed(1)} m)`, maxH > 50 && maxH < 400);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
