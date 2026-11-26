import type { GrayImage, RgbaImage } from './types';
import { clamp } from './rng';

export function createRgba(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneRgba(img: RgbaImage): RgbaImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function rgbaToGray(img: RgbaImage): GrayImage {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // Rec.601 亮度
    out[i] = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
  }
  return { width: img.width, height: img.height, data: out };
}

// 双线性采样（clamp 到边缘）
export function sampleGray(img: GrayImage, x: number, y: number): number {
  const { width: w, height: h, data } = img;
  if (x < 0) x = 0;
  else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0;
  else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i00 = y0 * w + x0;
  const i10 = i00 + 1;
  const i01 = i00 + w;
  const i11 = i01 + 1;
  const a = data[i00];
  return (
    a * (1 - fx) * (1 - fy) +
    data[i10] * fx * (1 - fy) +
    data[i01] * (1 - fx) * fy +
    data[i11] * fx * fy
  );
}

// 角度方向循环平铺的双线性采样
export function sampleGrayWrapX(img: GrayImage, x: number, y: number): number {
  const { width: w, height: h, data } = img;
  if (y < 0) y = 0;
  else if (y > h - 1.001) y = h - 1.001;
  x = ((x % w) + w) % w;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const x1 = (x0 + 1) % w;
  const i00 = y0 * w + x0;
  const i10 = y0 * w + x1;
  const i01 = i00 + w;
  const i11 = y0 * w + x1 + w;
  const a = data[i00];
  return (
    a * (1 - fx) * (1 - fy) +
    data[i10] * fx * (1 - fy) +
    data[i01] * (1 - fx) * fy +
    data[i11] * fx * fy
  );
}

export function sampleRgbaWrapX(img: RgbaImage, x: number, y: number, out: [number, number, number, number]): void {
  const { width: w, height: h, data } = img;
  if (y < 0 || y > h - 1.001) {
    if (y < 0) y = 0;
    else y = h - 1.001;
  }
  x = ((x % w) + w) % w;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const x1 = (x0 + 1) % w;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = ((y0 + 1) * w + x0) * 4;
  const i11 = ((y0 + 1) * w + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const v =
      data[i00 + c] * (1 - fx) * (1 - fy) +
      data[i10 + c] * fx * (1 - fy) +
      data[i01 + c] * (1 - fx) * fy +
      data[i11 + c] * fx * fy;
    out[c] = v;
  }
}

// 可分离高斯模糊；wrapX 时横向循环（用于整圈长带）
export function gaussianBlur(src: GrayImage, sigma: number, wrapX = false): GrayImage {
  if (sigma <= 0.01) return { width: src.width, height: src.height, data: new Float32Array(src.data) };
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

  const { width: w, height: h, data } = src;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);

  // 横向
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        let xx = x + k;
        if (wrapX) xx = ((xx % w) + w) % w;
        else xx = clamp(xx, 0, w - 1);
        sum += data[row + xx] * kernel[k + radius];
      }
      tmp[row + x] = sum;
    }
  }
  // 纵向
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = clamp(y + k, 0, h - 1);
        sum += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = sum;
    }
  }
  return { width: w, height: h, data: out };
}

// 盒式模糊（快速，多次近似高斯），横向循环
export function boxBlurWrapX(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius < 1) return new Float32Array(src);
  let cur = new Float32Array(src);
  const tmp = new Float32Array(src.length);
  const win = radius * 2 + 1;
  // 横向滑动窗口（循环）
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += cur[row + (((k % w) + w) % w)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      const xOut = ((x - radius) % w + w) % w;
      const xIn = (x + radius + 1) % w;
      sum += cur[row + xIn] - cur[row + xOut];
    }
  }
  // 纵向滑动窗口（clamp）
  const out = new Float32Array(src.length);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      const yOut = clamp(y - radius, 0, h - 1);
      const yIn = clamp(y + radius + 1, 0, h - 1);
      sum += tmp[yIn * w + x] - tmp[yOut * w + x];
    }
  }
  return out;
}

// Laplacian 方差 —— 对焦/清晰度评分
export function focusScore(gray: GrayImage, x0 = 0, y0 = 0, rw = gray.width, rh = gray.height): number {
  const x1 = Math.min(gray.width - 1, x0 + rw);
  const y1 = Math.min(gray.height - 1, y0 + rh);
  let mean = 0;
  let m2 = 0;
  let n = 0;
  const d = gray.data;
  const w = gray.width;
  for (let y = Math.max(1, y0 + 1); y < y1 - 1; y++) {
    for (let x = Math.max(1, x0 + 1); x < x1 - 1; x++) {
      const i = y * w + x;
      const lap = d[i - w] + d[i + w] + d[i - 1] + d[i + 1] - 4 * d[i];
      n++;
      const delta = lap - mean;
      mean += delta / n;
      m2 += delta * (lap - mean);
    }
  }
  return n > 1 ? m2 / (n - 1) : 0;
}

export interface ShiftResult {
  dx: number;
  dy: number;
  score: number;
}

// 归一化互相关估计 b 相对 a 的平移。
// 约定：dx>0 表示 b 中对应内容比 a 偏右 dx 像素（拼接时 b 放到 x=dx）。
// expectedDx 给出期望位移中心与搜索半宽。
export function estimateShiftNCC(
  a: GrayImage,
  b: GrayImage,
  opts: { expectedDx: number; dxRange: number; dyRange: number; rowFrac?: [number, number]; step?: number },
): ShiftResult {
  const { expectedDx, dxRange, dyRange } = opts;
  const step = opts.step ?? 2;
  const [rf0, rf1] = opts.rowFrac ?? [0.25, 0.8];
  const aw = a.width;
  const ah = a.height;
  const y0 = Math.floor(ah * rf0);
  const y1 = Math.floor(ah * rf1);

  // 取 a 的中间模板条带，b 全图搜索。为提速先降采样由调用方决定，这里按 step 采样。
  let best = -2;
  let bestDx = expectedDx;
  let bestDy = 0;

  // 预计算 a 模板在各 dy 下不需要；直接对每个候选算 NCC
  for (let dx = expectedDx - dxRange; dx <= expectedDx + dxRange; dx += step) {
    for (let dy = -dyRange; dy <= dyRange; dy += step) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      let n = 0;
      // a 中取 x 从 0.15w..0.85w 的块，b 对应 x+dx
      const ax0 = Math.floor(aw * 0.12);
      const ax1 = Math.floor(aw * 0.88);
      for (let y = y0; y < y1; y += 2) {
        const by = y + dy;
        if (by < 1 || by >= b.height - 1) continue;
        for (let x = ax0; x < ax1; x += 2) {
          const bx = x + dx;
          if (bx < 1 || bx >= b.width - 1) continue;
          const va = a.data[y * aw + x];
          const vb = b.data[by * b.width + bx];
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
          n++;
        }
      }
      if (n < 200) continue;
      const ma = sa / n;
      const mb = sb / n;
      const va = saa - n * ma * ma;
      const vb = sbb - n * mb * mb;
      if (va <= 1 || vb <= 1) continue;
      const cov = sab - n * ma * mb;
      const ncc = cov / Math.sqrt(va * vb);
      if (ncc > best) {
        best = ncc;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  // 局部精修（step=1，±step）
  const coarseDx = bestDx;
  const coarseDy = bestDy;
  for (let dx = coarseDx - step; dx <= coarseDx + step; dx++) {
    for (let dy = coarseDy - step; dy <= coarseDy + step; dy++) {
      let sa = 0,
        sb = 0,
        saa = 0,
        sbb = 0,
        sab = 0,
        n = 0;
      const ax0 = Math.floor(aw * 0.12);
      const ax1 = Math.floor(aw * 0.88);
      for (let y = y0; y < y1; y += 1) {
        const by = y + dy;
        if (by < 1 || by >= b.height - 1) continue;
        for (let x = ax0; x < ax1; x += 1) {
          const bx = x + dx;
          if (bx < 1 || bx >= b.width - 1) continue;
          const va = a.data[y * aw + x];
          const vb = b.data[by * b.width + bx];
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
          n++;
        }
      }
      if (n < 200) continue;
      const ma = sa / n;
      const mb = sb / n;
      const va = saa - n * ma * ma;
      const vb = sbb - n * mb * mb;
      if (va <= 1 || vb <= 1) continue;
      const ncc = (sab - n * ma * mb) / Math.sqrt(va * vb);
      if (ncc > best) {
        best = ncc;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  return { dx: bestDx, dy: bestDy, score: clamp(best, -1, 1) };
}
