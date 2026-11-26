import {
  BAND_BOTTOM,
  BAND_H,
  BAND_TOP,
  CAPTURE_STEP,
  PHOTO_ANG_WIN,
  PHOTO_COUNT,
  PHOTO_H,
  PHOTO_RAD_WIN,
  PHOTO_W,
  WORLD_H,
  WORLD_W,
} from './config';
import { clamp, gaussian, mulberry32, fbm2 } from './rng';
import { createRgba, sampleRgbaWrapX } from './improc';
import type { CaptureDirection, ChipTruth, PhotoShot, RgbaImage, StoneTruth } from './types';

export interface WorldMaps {
  img: RgbaImage;
  roughX: Float32Array; // 每个角度列的真值粗糙度
  topEdge: Float32Array;
  botEdge: Float32Array;
  truth: StoneTruth;
}

// ---------- 真值：36 段粗糙度 + 崩口 ----------

export function makeTruth(seed: number, stoneId = 'HC-2026-07'): StoneTruth {
  const rand = mulberry32(seed * 7919 + 17);
  // 五种磨损程度的粗糙指数中心（与 ADVICE_TABLE 五档对应，并与档界保持安全距离）
  const LEVEL_CENTER = [0.12, 0.3, 0.5, 0.71, 0.9];
  const wearLevel = new Array<number>(36).fill(2);

  // 均衡地把 36 段切成 5 个片区，保证五种磨损程度各占 6~8 段；片区顺序随机。
  const widths = [6, 6, 6, 6, 6];
  let extra = 6;
  while (extra-- > 0) widths[Math.floor(rand() * 5)]++;
  const order = [0, 1, 2, 3, 4];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  let segCursor = 0;
  widths.forEach((w, z) => {
    for (let s = segCursor; s < segCursor + w; s++) wearLevel[s % 36] = order[z];
    segCursor += w;
  });

  // 等级中心 + 小幅段内起伏（保持在档界安全区内）
  const roughness = wearLevel.map((l) => clamp(LEVEL_CENTER[l] + (rand() - 0.5) * 0.05, 0.05, 0.96));
  // 轻邻域相关，仅让边界略自然，不改变档位归属
  const copy = roughness.slice();
  for (let s = 0; s < 36; s++) {
    const nb = (copy[(s + 35) % 36] + copy[(s + 1) % 36]) / 2;
    roughness[s] = clamp(copy[s] * 0.88 + nb * 0.12, 0.04, 0.97);
  }

  // 崩口：2~4 处，集中在运行带两缘
  const chips: ChipTruth[] = [];
  const chipCount = 2 + Math.floor(rand() * 3);
  const usedSegs = new Set<number>();
  for (let i = 0; i < chipCount; i++) {
    let seg = Math.floor(rand() * 36);
    let guard = 0;
    while (usedSegs.has(seg) && guard++ < 20) seg = Math.floor(rand() * 36);
    usedSegs.add(seg);
    const cx = (seg + 0.25 + rand() * 0.5) * (WORLD_W / 36);
    chips.push({
      segment: seg,
      edge: rand() < 0.5 ? 'inner' : 'outer',
      angleWorldX: cx,
      widthWorld: 46 + rand() * 110,
      depthWorld: 9 + rand() * 26,
    });
  }

  return { stoneId, seed, textureKind: Math.floor(rand() * 3), roughness, wearLevel, chips };
}

// 段值周期平滑插值到每个角度列
function buildRoughColumns(truth: StoneTruth): Float32Array {
  const out = new Float32Array(WORLD_W);
  const segW = WORLD_W / 36;
  for (let x = 0; x < WORLD_W; x++) {
    const f = x / segW;
    const s0 = Math.floor(f) % 36;
    const s1 = (s0 + 1) % 36;
    let t = f - Math.floor(f);
    t = t * t * (3 - 2 * t);
    // 段中心对齐：让每段主体保持段值，只在段界附近过渡
    const segPos = (x % segW) / segW;
    if (segPos < 0.18) {
      const prev = truth.roughness[(s0 + 35) % 36];
      const k = smooth01(segPos / 0.18);
      out[x] = prev * (1 - k) * 0.5 + truth.roughness[s0] * (0.5 + 0.5 * k);
    } else if (segPos > 0.82) {
      const next = truth.roughness[s1];
      const k = smooth01((segPos - 0.82) / 0.18);
      out[x] = truth.roughness[s0] * (1 - 0.5 * k) + next * (0.5 * k);
    } else {
      out[x] = truth.roughness[s0];
    }
    void t;
  }
  // 叠加缓慢段内起伏
  for (let x = 0; x < WORLD_W; x++) {
    const n = fbm2(x / 90, 11.3, truth.seed + 77, 3, 120);
    out[x] = clamp(out[x] + (n - 0.5) * 0.07, 0, 1);
  }
  return out;
}

function smooth01(t: number): number {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------- 渲染标准世界 ----------

export function renderWorld(truth: StoneTruth): WorldMaps {
  const rand = mulberry32(truth.seed * 104729 + 3);
  const img = createRgba(WORLD_W, WORLD_H);
  const d = img.data;
  const roughX = buildRoughColumns(truth);

  const topEdge = new Float32Array(WORLD_W);
  const botEdge = new Float32Array(WORLD_W);
  for (let x = 0; x < WORLD_W; x++) {
    const wave = (fbm2(x / 220, 3.1, truth.seed + 5, 3, WORLD_W / 220) - 0.5) * 7;
    topEdge[x] = BAND_TOP + wave;
    botEdge[x] = BAND_BOTTOM + wave * 0.8;
  }
  // 崩口切入边界
  for (const c of truth.chips) {
    const hw = c.widthWorld / 2;
    const x0 = Math.max(0, Math.floor(c.angleWorldX - hw * 1.2));
    const x1 = Math.min(WORLD_W - 1, Math.ceil(c.angleWorldX + hw * 1.2));
    for (let x = x0; x <= x1; x++) {
      const t = (x - c.angleWorldX) / hw;
      if (Math.abs(t) > 1) continue;
      const jag = 0.75 + 0.25 * fbm2(x / 9, c.depthWorld, truth.seed + 99, 2, 1200);
      const profile = c.depthWorld * Math.sqrt(Math.max(0, 1 - t * t)) * jag;
      if (c.edge === 'inner') topEdge[x] += profile;
      else botEdge[x] -= profile;
    }
  }

  const kind = truth.textureKind;
  const baseGray = [150, 138, 158][kind] ?? 150;
  const mottleAmp = [20, 36, 24][kind] ?? 24;
  const mottleScale = [80, 150, 64][kind] ?? 90;
  const mottlePeriod = Math.round(WORLD_W / mottleScale);

  // 逐像素花岗岩 + 运行带磨损光学
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const i = (y * WORLD_W + x) * 4;
      const mottle = fbm2(x / mottleScale, y / mottleScale, truth.seed + 11, 4, mottlePeriod);
      const fine = fbm2(x / 12, y / 12, truth.seed + 23, 3, 900);
      let g = baseGray + (mottle - 0.5) * 2 * mottleAmp + (fine - 0.5) * 16;

      const te = topEdge[x];
      const be = botEdge[x];
      const inBand = y >= te && y <= be;
      const r = roughX[x];

      if (inBand) {
        const cy = (te + be) / 2;
        const half = (be - te) / 2;
        const ry = (y - cy) / Math.max(1, half);
        // 运行带底色略深、更匀
        g = g * 0.94 - 4;
        // 粗糙面微明暗对比（高频）
        g += (fine - 0.5) * (8 + 30 * r);
        // 大面积柔光反射：越光滑越强（低频，不会被误判成斑点）
        const radialLobe = Math.exp(-ry * ry * 2.4);
        const angSheen = 0.86 + 0.14 * fbm2(x / 600, 7.7, truth.seed + 31, 3, 18);
        g += 92 * Math.pow(1 - r, 1.05) * radialLobe * angSheen;
        // 磨平处的窄而亮的镜面核心
        g += 46 * Math.pow(1 - r, 2.0) * Math.exp(-ry * ry * 16);
        // 粗糙面略吸光
        g *= 1 - 0.08 * r;
      }

      // 边缘压暗线 + 亮沿，便于边缘追踪
      const dTop = Math.abs(y - te);
      const dBot = Math.abs(y - be);
      const de = Math.min(dTop, dBot);
      if (de < 2.2) g *= 0.55 + 0.2 * (de / 2.2);
      else if (de < 4.2) g += 14 * (1 - (de - 2.2) / 2);

      g = clamp(g, 0, 255);
      d[i] = g;
      d[i + 1] = clamp(g - 2 + (fine - 0.5) * 4, 0, 255);
      d[i + 2] = clamp(g - 6 + (mottle - 0.5) * 8, 0, 255);
      d[i + 3] = 255;
    }
  }

  // 花岗岩黑白斑点（各向同性小斑块 —— 主要干扰项）
  splatSpeckles(img, truth.seed, kind);

  // 细划痕：密度随真值粗糙度单调增加，方向以环向为主（各向异性 —— 与斑点区分）
  drawScratches(img, truth, roughX, rand);

  // 崩口内部：深色阴影 + 参差亮茬
  drawChipVoids(img, truth, topEdge, botEdge, rand);

  return { img, roughX, topEdge, botEdge, truth };
}

function blend(d: Uint8ClampedArray, w: number, x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || y < 0 || x >= w || y >= d.length / 4 / w) return;
  const i = (y * w + x) * 4;
  d[i] = d[i] * (1 - a) + r * a;
  d[i + 1] = d[i + 1] * (1 - a) + g * a;
  d[i + 2] = d[i + 2] * (1 - a) + b * a;
}

function splatSpeckles(img: RgbaImage, seed: number, kind: number): void {
  const rand = mulberry32(seed * 4099 + 99);
  const { width: w, height: h, data: d } = img;
  const count = [34000, 22000, 26000][kind] ?? 28000;
  for (let i = 0; i < count; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const white = rand() < 0.52;
    const rad = 0.5 + rand() * (kind === 1 ? 3.4 : 1.9);
    const a = 0.35 + rand() * 0.55;
    const col = white ? 218 + rand() * 37 : 12 + rand() * 46;
    const rr = Math.ceil(rad);
    for (let oy = -rr; oy <= rr; oy++) {
      for (let ox = -rr; ox <= rr; ox++) {
        const dist = Math.sqrt(ox * ox + oy * oy);
        if (dist > rad) continue;
        const cov = clamp(rad - dist + 0.5, 0, 1) * a;
        blend(d, w, (x + ox) | 0, (y + oy) | 0, col, col, col, cov);
      }
    }
  }
  // 少量大颗粒石英 / 黑云母
  for (let i = 0; i < 520; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const rad = 2.5 + rand() * (kind === 1 ? 5.5 : 3);
    const white = rand() < 0.6;
    const col = white ? 225 : 30;
    const a = 0.5 + rand() * 0.4;
    const rr = Math.ceil(rad);
    for (let oy = -rr; oy <= rr; oy++) {
      for (let ox = -rr; ox <= rr; ox++) {
        const dist = Math.sqrt(ox * ox + oy * oy);
        if (dist > rad) continue;
        const cov = clamp((rad - dist) / rad, 0, 1) * a;
        blend(d, w, (x + ox) | 0, (y + oy) | 0, col, col, white ? col + 6 : col + 8, cov);
      }
    }
  }
}

function drawScratches(img: RgbaImage, truth: StoneTruth, roughX: Float32Array, rand: () => number): void {
  const { width: w, data: d } = img;
  const segW = w / 36;
  for (let s = 0; s < 36; s++) {
    const r = truth.roughness[s];
    const n = Math.floor(14 + r * 150);
    for (let k = 0; k < n; k++) {
      const x0 = s * segW + rand() * segW;
      const te = BAND_TOP + 4;
      const be = BAND_BOTTOM - 4;
      const y0 = te + rand() * (be - te);
      const len = 18 + rand() * (60 + r * 90);
      const slope = (rand() - 0.5) * 7; // 轻微斜向
      const width = 0.8 + rand() * 1.5;
      const alpha = 0.1 + rand() * (0.16 + 0.2 * r);
      const dark = rand() < 0.72;
      const col = dark ? 40 : 220;
      const steps = Math.ceil(len / 2);
      for (let t = 0; t <= steps; t++) {
        const f = t / steps;
        const x = x0 + f * len;
        const y = y0 + f * slope + Math.sin(f * 6 + k) * 0.6;
        // 避开崩口（粗略：边界外不画）
        const roughHere = roughX[clamp(x | 0, 0, w - 1)];
        void roughHere;
        const rr = Math.ceil(width);
        for (let oy = -rr; oy <= rr; oy++) {
          const cov = clamp(width - Math.abs(oy) + 0.5, 0, 1) * alpha;
          blend(d, w, x | 0, (y + oy) | 0, col, col, col, cov);
        }
      }
    }
  }
}

function drawChipVoids(
  img: RgbaImage,
  truth: StoneTruth,
  topEdge: Float32Array,
  botEdge: Float32Array,
  rand: () => number,
): void {
  const { width: w, data: d } = img;
  for (const c of truth.chips) {
    const hw = c.widthWorld / 2;
    const x0 = Math.floor(c.angleWorldX - hw);
    const x1 = Math.ceil(c.angleWorldX + hw);
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= w) continue;
      if (c.edge === 'inner') {
        // 原上缘 BAND_TOP，新上缘 topEdge[x] 下移，之间是崩缺
        for (let y = BAND_TOP - 2; y < topEdge[x]; y++) {
          if (y < 0) continue;
          const i = (y * w + x) * 4;
          const depth = clamp((y - BAND_TOP) / Math.max(1, c.depthWorld), 0, 1);
          const n = rand() * 14;
          const g = 22 + depth * 18 + n;
          d[i] = g;
          d[i + 1] = g + 2;
          d[i + 2] = g + 5;
          d[i + 3] = 255;
        }
        // 参差亮茬
        const ry = topEdge[x];
        blend(d, w, x, ry | 0, 214, 214, 208, 0.8);
        blend(d, w, x, (ry - 1) | 0, 188, 188, 182, 0.5);
      } else {
        for (let y = botEdge[x] + 1; y <= BAND_BOTTOM + 2; y++) {
          if (y >= img.height) continue;
          const i = (y * w + x) * 4;
          const depth = clamp((BAND_BOTTOM - y) / Math.max(1, c.depthWorld), 0, 1);
          const n = rand() * 14;
          const g = 22 + depth * 18 + n;
          d[i] = g;
          d[i + 1] = g + 2;
          d[i + 2] = g + 5;
          d[i + 3] = 255;
        }
        const ry = botEdge[x];
        blend(d, w, x, ry | 0, 214, 214, 208, 0.8);
        blend(d, w, x, (ry + 1) | 0, 188, 188, 182, 0.5);
      }
    }
  }
}

// ---------- 拍摄：从世界扭曲采样成微距照片 ----------

export interface CaptureOptions {
  runSeed: number;
  direction: CaptureDirection;
  brightnessJitter?: number; // 曝光波动幅度
  focusJitter?: number;
  noise?: number;
}

export function shootSet(world: WorldMaps, opts: CaptureOptions): PhotoShot[] {
  const rand = mulberry32((world.truth.seed >>> 0) * 31 + opts.runSeed * 2654435761);
  const shots: PhotoShot[] = [];
  const bJit = opts.brightnessJitter ?? 0.12;
  const fJit = opts.focusJitter ?? 0.34; // 轻微对焦差异：sigma ≈ 0.35..0.69
  const noiseAmt = opts.noise ?? 4.5;

  // 同一组机位角度（带轻微定位误差），正/反只是拍摄顺序相反
  const centers: number[] = [];
  for (let j = 0; j < PHOTO_COUNT; j++) {
    centers.push(j * CAPTURE_STEP + (rand() - 0.5) * 14);
  }
  const order = opts.direction === 1 ? centers.map((_, j) => j) : centers.map((_, j) => PHOTO_COUNT - 1 - j);

  order.forEach((j, captureIdx) => {
    const center = centers[j];
    const angleWin = PHOTO_ANG_WIN * (0.97 + rand() * 0.06);
    const radWin = PHOTO_RAD_WIN * (0.96 + rand() * 0.08);
    const radCenter = (BAND_TOP + BAND_BOTTOM) / 2 + (rand() - 0.5) * 26;
    const brightness = 1 + (rand() - 0.5) * 2 * bJit + 0.06 * Math.sin(captureIdx * 0.9);
    const exposureAdd = (rand() - 0.5) * 16;
    const focusSigma = 0.35 + rand() * fJit;

    const rgba = createRgba(PHOTO_W, PHOTO_H);
    const tmp: [number, number, number, number] = [0, 0, 0, 255];
    for (let py = 0; py < PHOTO_H; py++) {
      const wy = radCenter + (py - PHOTO_H / 2) * (radWin / PHOTO_H);
      for (let px = 0; px < PHOTO_W; px++) {
        const wx = center + (px - PHOTO_W / 2) * (angleWin / PHOTO_W);
        sampleRgbaWrapX(world.img, wx, wy, tmp);
        // 暗角
        const vx = (px - PHOTO_W / 2) / (PHOTO_W / 2);
        const vy = (py - PHOTO_H / 2) / (PHOTO_H / 2);
        const vig = 1 - 0.22 * (vx * vx + vy * vy);
        let rr = tmp[0] * brightness * vig + exposureAdd;
        let gg = tmp[1] * brightness * vig + exposureAdd;
        let bb = tmp[2] * brightness * vig + exposureAdd;
        const n = gaussian(rand) * noiseAmt;
        rr += n;
        gg += n;
        bb += n;
        const i = (py * PHOTO_W + px) * 4;
        rgba.data[i] = rr;
        rgba.data[i + 1] = gg;
        rgba.data[i + 2] = bb;
        rgba.data[i + 3] = 255;
      }
    }

    // 虚焦 + 传感器噪点已加；做盒式模糊近似高斯
    if (focusSigma > 0.5) boxBlurRgba(rgba, Math.round(focusSigma));

    shots.push({
      id: j,
      order: captureIdx,
      direction: opts.direction,
      angleCenter: center,
      brightness,
      focusSigma,
      rgba,
    });
  });

  return shots;
}

// RGBA 快速滑动盒式模糊（两次近似高斯）
function boxBlurRgba(img: RgbaImage, radius: number): void {
  if (radius < 1) return;
  const { width: w, height: h, data } = img;
  for (let iter = 0; iter < 2; iter++) {
    const src = new Uint8ClampedArray(data);
    const win = radius * 2 + 1;
    // 横
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        const row = y * w * 4;
        for (let k = -radius; k <= radius; k++) sum += src[row + clamp(k, 0, w - 1) * 4 + c];
        for (let x = 0; x < w; x++) {
          data[row + x * 4 + c] = sum / win;
          const xo = clamp(x - radius, 0, w - 1);
          const xi = clamp(x + radius + 1, 0, w - 1);
          sum += src[row + xi * 4 + c] - src[row + xo * 4 + c];
        }
      }
    }
    // 纵
    const src2 = new Uint8ClampedArray(data);
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += src2[clamp(k, 0, h - 1) * w * 4 + x * 4 + c];
        for (let y = 0; y < h; y++) {
          data[(y * w + x) * 4 + c] = sum / win;
          const yo = clamp(y - radius, 0, h - 1);
          const yi = clamp(y + radius + 1, 0, h - 1);
          sum += src2[(yi * w + x) * 4 + c] - src2[(yo * w + x) * 4 + c];
        }
      }
    }
  }
}
