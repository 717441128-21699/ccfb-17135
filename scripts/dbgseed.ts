import { makeTruth, renderWorld, shootSet } from '../src/core/synth';
import { stitchRing } from '../src/core/stitch';
import { detectBandRows, cropStrip } from '../src/core/band';
import { extractFeatures } from '../src/core/features';
import { gaussianBlur, rgbaToGray } from '../src/core/improc';
import { adviceForRoughness } from '../src/core/config';
import { segmentLevel, estimateRoughness36, ANCHORS } from '../src/core/calibration';

const seed = Number(process.argv[2] ?? 2);
const truth = makeTruth(seed);
const world = renderWorld(truth);
const photos = shootSet(world, { runSeed: 1000 + seed, direction: 1 });
const st = stitchRing(photos);
const rows = detectBandRows(st.mosaic);
const crop = cropStrip(st.mosaic, rows, 12);
const gray = rgbaToGray(crop);
const feats = extractFeatures(gray, 180);
const low = gaussianBlur(gray, 26, true);
const W = gray.width, H = gray.height;
const lowSeg: number[] = [];
for (let s = 0; s < 36; s++) {
  const x0 = (s * W) / 36, x1 = ((s + 1) * W) / 36;
  let sum = 0, n = 0;
  for (let x = x0; x < x1; x += 3) for (let y = H * 0.24; y < H * 0.76; y += 3) { sum += low.data[(y | 0) * W + (Math.floor(x) % W)]; n++; }
  lowSeg.push(sum / n);
}
const raw = feats.segments.map((f, s) => ({ sheen: f.sheen, low: lowSeg[s], scrR: f.scratchRatio }));
const combined = raw.map(segmentLevel);
const r36 = estimateRoughness36(raw);
console.log('anchors sheen', ANCHORS.sheen.map((x) => x.toFixed(0)).join('/'), 'low', ANCHORS.low.map((x) => x.toFixed(0)).join('/'));
console.log('seg lv  tR   sheen low  scrR  combLv predR pBin mBin');
raw.forEach((f, s) => {
  const pBin = adviceForRoughness(r36[s]).bin;
  const mBin = adviceForRoughness(truth.roughness[s]).bin;
  console.log(
    String(s).padStart(2), String(truth.wearLevel[s]).padStart(2),
    truth.roughness[s].toFixed(2),
    f.sheen.toFixed(0).padStart(4), f.low.toFixed(0).padStart(3), f.scrR.toFixed(3),
    combined[s].toFixed(2).padStart(5), r36[s].toFixed(2), pBin, mBin, pBin === mBin ? '✓' : '✗',
  );
});
