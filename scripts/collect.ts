import { writeFileSync, mkdirSync } from 'node:fs';
import { makeTruth, renderWorld, shootSet } from '../src/core/synth';
import { stitchRing } from '../src/core/stitch';
import { cropStrip, detectBandRows } from '../src/core/band';
import { extractFeatures, sheenProfile, sheenProfileRobust } from '../src/core/features';
import { gaussianBlur, rgbaToGray } from '../src/core/improc';
import type { CaptureDirection } from '../src/core/types';

export interface FeatRow {
  seed: number;
  dir: number;
  runSeed: number;
  seg: number;
  R: number;
  level: number;
  sheen: number;
  low: number;
  scrR: number;
  scrD: number;
  grad: number;
  focus: number;
}

function collect(seed: number, dir: CaptureDirection, runSeed: number): FeatRow[] {
  const truth = makeTruth(seed);
  const world = renderWorld(truth);
  const photos = shootSet(world, { runSeed, direction: dir });
  const st = stitchRing(photos);
  const rows = detectBandRows(st.mosaic);
  const crop = cropStrip(st.mosaic, rows, 12);
  const gray = rgbaToGray(crop);
  const feats = extractFeatures(gray);
  const low = gaussianBlur(gray, 26, true);
  const W = gray.width, H = gray.height;
  const out: FeatRow[] = [];
  for (let s = 0; s < 36; s++) {
    const x0 = Math.floor((s * W) / 36);
    const x1 = Math.floor(((s + 1) * W) / 36);
    let lm = 0, ln = 0;
    for (let x = x0; x < x1; x += 3) for (let y = H * 0.22; y < H * 0.78; y += 3) { lm += low.data[(y | 0) * W + (x % W)]; ln++; }
    const sh = sheenProfile(gray, x0, x1);
    const sheenRob = sheenProfileRobust(gray, x0, x1);
    const f = feats.segments[s];
    out.push({
      seed, dir, runSeed, seg: s, R: truth.roughness[s], level: truth.wearLevel[s],
      sheen: sheenRob, low: lm / ln,
      scrR: f.scratchRatio, scrD: f.scratchDensity, grad: f.gradEnergy, focus: f.focus,
    });
  }
  return out;
}

mkdirSync('diag', { recursive: true });
const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
const all: FeatRow[] = [];
for (const sd of seeds) {
  all.push(...collect(sd, 1, 1000 + sd));
  writeFileSync('diag/rows.json', JSON.stringify(all));
  console.error('seed', sd, 'fwd done rows', all.length);
  all.push(...collect(sd, -1, 2000 + sd));
  writeFileSync('diag/rows.json', JSON.stringify(all));
  console.error('seed', sd, 'rev done rows', all.length);
}
writeFileSync('diag/rows.json', JSON.stringify(all));
console.log('TOTAL', all.length);
