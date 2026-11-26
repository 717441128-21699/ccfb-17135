import { mkdirSync } from 'node:fs';
import { makeTruth, renderWorld, shootSet } from '../src/core/synth';
import { stitchRing } from '../src/core/stitch';
import { cropStrip, detectBandRows, equalizeStrip } from '../src/core/band';
import { rgbaToGray } from '../src/core/improc';
import { scratchFeatures } from '../src/core/features';
import { writePng, downscale } from './png';
import { BAND_BOTTOM, BAND_TOP, WORLD_W } from '../src/core/config';
import type { RgbaImage } from '../src/core/types';

mkdirSync('diag', { recursive: true });
const seed = Number(process.argv[2] ?? 1);
const truth = makeTruth(seed);
const world = renderWorld(truth);
writePng('diag/01-world.png', downscale(world.img, 1600));

// 真值带
const H = BAND_BOTTOM - BAND_TOP;
const off = BAND_TOP * WORLD_W * 4;
const band: RgbaImage = { width: WORLD_W, height: H, data: world.img.data.subarray(off, off + H * WORLD_W * 4) };
writePng('diag/02-truth-band.png', downscale(band, 1800));

const photos = shootSet(world, { runSeed: 101, direction: 1 });
writePng('diag/03-photo-sharp.png', photos.reduce((a, p) => (p.focusSigma < a.focusSigma ? p : a), photos[0]).rgba);
writePng('diag/04-photo-blur.png', photos.reduce((a, p) => (p.focusSigma > a.focusSigma ? p : a), photos[0]).rgba);

const st = stitchRing(photos);
writePng('diag/05-mosaic-raw.png', downscale(st.mosaicRaw, 1800));
writePng('diag/06-mosaic-eq.png', downscale(st.mosaic, 1800));
writePng('diag/07-ring.png', downscale(st.ring, 900));

const rows = detectBandRows(st.mosaic);
const crop = cropStrip(st.mosaic, rows);
writePng('diag/08-strip-crop.png', downscale(crop, 1800));
const eq = equalizeStrip(crop);
writePng('diag/09-strip-equalized.png', downscale(eq.strip, 1800));

// scratch persistence 可视化
const gray = rgbaToGray(eq.strip);
const sf = scratchFeatures(gray);
let mx = 1;
for (let i = 0; i < sf.hPersist.length; i++) mx = Math.max(mx, sf.hPersist[i]);
const vis: RgbaImage = { width: gray.width, height: gray.height, data: new Uint8ClampedArray(gray.width * gray.height * 4) };
for (let i = 0; i < gray.width * gray.height; i++) {
  const v = Math.min(255, (sf.hPersist[i] / mx) * 255 * 1.6);
  vis.data[i * 4] = v;
  vis.data[i * 4 + 1] = v * 0.9;
  vis.data[i * 4 + 2] = v * 0.4;
  vis.data[i * 4 + 3] = 255;
}
writePng('diag/10-scratch-map.png', downscale(vis, 1800));
console.log('dumped diag/*.png ; rows', rows);
