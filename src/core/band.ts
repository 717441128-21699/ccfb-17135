import { MOSAIC_H } from './config';
import { clamp } from './rng';
import { boxBlurWrapX, createRgba, gaussianBlur, rgbaToGray } from './improc';
import type { RgbaImage } from './types';

export interface BandRows {
  top: number;
  bottom: number;
  yCenter: number;
  rowHeight: number;
}

// 用每行的纵向梯度能量 + 暗边界线检测运行带上下缘
export function detectBandRows(mosaic: RgbaImage): BandRows {
  const g = rgbaToGray(mosaic);
  const W = g.width;
  const H = g.height;
  const rowGrad = new Float32Array(H);
  const rowDark = new Float32Array(H);
  for (let y = 1; y < H - 1; y++) {
    let grad = 0;
    let dark = 0;
    let n = 0;
    for (let x = 0; x < W; x += 6) {
      const i = y * W + x;
      grad += Math.abs(g.data[i + W] - g.data[i - W]);
      dark += g.data[i];
      n++;
    }
    rowGrad[y] = grad / n;
    rowDark[y] = dark / n;
  }
  // 平滑
  const gradSmooth = smooth1D(rowGrad, 3);

  // 上缘：期望 90..195，下缘 300..410
  let top = 124;
  let topBest = -1;
  for (let y = 80; y <= 200; y++) {
    // 上缘暗线：该行偏暗且下方梯度大
    const score = gradSmooth[y] + Math.max(0, 120 - rowDark[y]) * 0.15;
    if (score > topBest) {
      topBest = score;
      top = y;
    }
  }
  let bottom = 372;
  let botBest = -1;
  for (let y = 295; y <= 420; y++) {
    const score = gradSmooth[y] + Math.max(0, 120 - rowDark[y]) * 0.15;
    if (score > botBest) {
      botBest = score;
      bottom = y;
    }
  }
  // 约束带宽合理（200..290），否则回退到几何先验
  if (bottom - top < 190 || bottom - top > 300) {
    top = 122;
    bottom = 372;
  }
  return { top, bottom, yCenter: (top + bottom) / 2, rowHeight: bottom - top };
}

function smooth1D(a: Float32Array, r: number): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0;
    let n = 0;
    for (let k = -r; k <= r; k++) {
      const j = clamp(i + k, 0, a.length - 1);
      s += a[j];
      n++;
    }
    out[i] = s / n;
  }
  return out;
}

// 从马赛克裁出展开长带（含边缘余量，便于崩口检测）
export function cropStrip(mosaic: RgbaImage, rows: BandRows, margin = 16): RgbaImage {
  const W = mosaic.width;
  const top = Math.max(0, rows.top - margin);
  const bottom = Math.min(mosaic.height - 1, rows.bottom + margin);
  const H = bottom - top;
  const out = createRgba(W, H);
  for (let y = 0; y < H; y++) {
    const srcStart = ((y + top) * W) * 4;
    const dstStart = y * W * 4;
    out.data.set(mosaic.data.subarray(srcStart, srcStart + W * 4), dstStart);
  }
  return out;
}

export interface EqualizeResult {
  strip: RgbaImage;
  colFocusBefore: number[];
  colFocusAfter: number[];
  brightnessUniformityBefore: number;
  brightnessUniformityAfter: number;
  focusUniformityBefore: number;
  focusUniformityAfter: number;
}

// 径向光照拉平 + 按列对焦自适应 Unsharp
export function equalizeStrip(strip: RgbaImage, blockCount = 40): EqualizeResult {
  const W = strip.width;
  const H = strip.height;
  const gray = rgbaToGray(strip);

  // 1) 径向行亮度校正（保留角度方向的反光强弱）
  const rowMean = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < W; x += 4) s += gray.data[y * W + x];
    rowMean[y] = s / (W / 4);
  }
  const rowSmooth = smooth1D(rowMean, 14);
  let global = 0;
  for (let y = 0; y < H; y++) global += rowSmooth[y];
  global /= H;
  const rowGain = new Float32Array(H);
  for (let y = 0; y < H; y++) rowGain[y] = clamp(global / Math.max(20, rowSmooth[y]), 0.7, 1.4);

  const corrected = createRgba(W, H);
  for (let y = 0; y < H; y++) {
    const g = rowGain[y];
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      corrected.data[i] = clamp(strip.data[i] * g, 0, 255);
      corrected.data[i + 1] = clamp(strip.data[i + 1] * g, 0, 255);
      corrected.data[i + 2] = clamp(strip.data[i + 2] * g, 0, 255);
      corrected.data[i + 3] = 255;
    }
  }

  // 2) 分块对焦评分 -> 列锐化量
  const cg = rgbaToGray(corrected);
  const blockW = Math.floor(W / blockCount);
  const focusBefore: number[] = [];
  for (let b = 0; b < blockCount; b++) {
    const x0 = b * blockW;
    focusBefore.push(blockLaplacian(cg.data, W, H, x0, Math.min(W, x0 + blockW)));
  }
  const sorted = [...focusBefore].sort((a, b) => a - b);
  const targetFocus = sorted[Math.floor(sorted.length * 0.75)] || 1;
  const blockAmount = focusBefore.map((f) => clamp(0.55 * Math.sqrt(targetFocus / Math.max(20, f)) - 0.15, 0.05, 1.1));

  // 列锐化量线性插值
  const colAmount = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const bf = x / blockW;
    const b0 = Math.min(blockCount - 1, Math.floor(bf));
    const b1 = Math.min(blockCount - 1, b0 + 1);
    const t = bf - b0;
    colAmount[x] = blockAmount[b0] * (1 - t) + blockAmount[b1] * t;
  }

  // 3x3 盒模糊作为 unsharp 低频
  const blur = boxBlurRgba3(corrected);
  const sharp = createRgba(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = colAmount[x];
      for (let c = 0; c < 3; c++) {
        const v = corrected.data[i + c] * (1 + a * 1.4) - blur.data[i + c] * a * 1.4;
        sharp.data[i + c] = clamp(v, 0, 255);
      }
      sharp.data[i + 3] = 255;
    }
  }

  // 锐化后分块对焦
  const sg = rgbaToGray(sharp);
  const focusAfter: number[] = [];
  for (let b = 0; b < blockCount; b++) {
    const x0 = b * blockW;
    focusAfter.push(blockLaplacian(sg.data, W, H, x0, Math.min(W, x0 + blockW)));
  }

  // 均匀性 = 1 - 变异系数
  const brightBefore = columnBrightness(strip, blockCount);
  const brightAfter = columnBrightness(sharp, blockCount);
  return {
    strip: sharp,
    colFocusBefore: focusBefore,
    colFocusAfter: focusAfter,
    brightnessUniformityBefore: uniformity(brightBefore),
    brightnessUniformityAfter: uniformity(brightAfter),
    focusUniformityBefore: uniformity(focusBefore),
    focusUniformityAfter: uniformity(focusAfter),
  };
}

function columnBrightness(img: RgbaImage, blocks: number): number[] {
  const W = img.width;
  const bw = Math.floor(W / blocks);
  const out: number[] = [];
  for (let b = 0; b < blocks; b++) {
    let s = 0;
    let n = 0;
    for (let x = b * bw; x < Math.min(W, (b + 1) * bw); x += 5) {
      for (let y = 0; y < img.height; y += 5) {
        const i = (y * W + x) * 4;
        s += (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
        n++;
      }
    }
    out.push(s / n);
  }
  return out;
}

function uniformity(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  return clamp(1 - sd / Math.max(1, m), 0, 1);
}

function blockLaplacian(d: Float32Array | Uint8ClampedArray, W: number, H: number, x0: number, x1: number): number {
  let mean = 0;
  let m2 = 0;
  let n = 0;
  for (let y = 2; y < H - 2; y += 2) {
    for (let x = Math.max(2, x0 + 2); x < Math.min(W - 2, x1 - 2); x += 2) {
      const i = y * W + x;
      const lap = d[i - W] + d[i + W] + d[i - 1] + d[i + 1] - 4 * d[i];
      n++;
      const delta = lap - mean;
      mean += delta / n;
      m2 += delta * (lap - mean);
    }
  }
  return n > 1 ? m2 / (n - 1) : 0;
}

function boxBlurRgba3(img: RgbaImage): RgbaImage {
  // 用灰度高斯 sigma1.1 然后构造三通道相同模糊？为了 unsharp 保色，直接对 RGB 做 3x3
  const W = img.width;
  const H = img.height;
  const out = createRgba(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const yy = clamp(y + oy, 0, H - 1);
        for (let ox = -1; ox <= 1; ox++) {
          const xx = clamp(x + ox, 0, W - 1);
          const i = (yy * W + xx) * 4;
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
      }
      const o = (y * W + x) * 4;
      out.data[o] = r / 9;
      out.data[o + 1] = g / 9;
      out.data[o + 2] = b / 9;
      out.data[o + 3] = 255;
    }
  }
  void gaussianBlur;
  return out;
}
