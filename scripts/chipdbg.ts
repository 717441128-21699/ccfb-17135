import { makeTruth, renderWorld, shootSet } from '../src/core/synth';
import { stitchRing } from '../src/core/stitch';
import { detectBandRows } from '../src/core/band';
import { detectChips } from '../src/core/chips';
import { writePng } from './png';
import type { RgbaImage } from '../src/core/types';

const seed = Number(process.argv[2] ?? 2);
const truth = makeTruth(seed);
const world = renderWorld(truth);
const photos = shootSet(world, { runSeed: 1000 + seed, direction: 1 });
const st = stitchRing(photos);
const rows = detectBandRows(st.mosaic);
const chips = detectChips(st.mosaic, rows);
console.log('rows', rows);
console.log('TRUTH', JSON.stringify(truth.chips.map((c) => ({ seg: c.segment, edge: c.edge, w: Math.round(c.widthWorld), d: Math.round(c.depthWorld) }))));
console.log('DETECT', JSON.stringify(chips.map((c) => ({ seg: c.segment, edge: c.edge, mm: c.depthMm, w: c.widthMm, conf: c.confidence.toFixed(2) })), null, 0));

// 导出每个真崩口附近的马赛克放大条带
const MW = st.mosaic.width;
truth.chips.forEach((c, i) => {
  const xm = (c.angleWorldX / world.img.width) * MW;
  const x0 = Math.max(0, Math.floor(xm - 160));
  const w = 320;
  const y0 = Math.max(0, rows.top - 70);
  const h = rows.rowHeight + 140;
  const zoom: RgbaImage = { width: w * 2, height: h * 2, data: new Uint8ClampedArray(w * 2 * h * 2 * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = x0 + x, sy = y0 + y;
    if (sx < 0 || sx >= MW || sy < 0 || sy >= st.mosaic.height) continue;
    const si = (sy * MW + sx) * 4;
    for (let zy = 0; zy < 2; zy++) for (let zx = 0; zx < 2; zx++) {
      const di = ((y * 2 + zy) * zoom.width + x * 2 + zx) * 4;
      zoom.data[di] = st.mosaic.data[si];
      zoom.data[di + 1] = st.mosaic.data[si + 1];
      zoom.data[di + 2] = st.mosaic.data[si + 2];
      zoom.data[di + 3] = 255;
    }
  }
  writePng(`diag/chip-${seed}-${i}-${c.edge}.png`, zoom);
  console.log('wrote', `diag/chip-${seed}-${i}-${c.edge}.png`, 'xm', Math.round(xm));
});
