import { SEGMENT_COUNT } from './config';
import { boxBlurWrapX, gaussianBlur } from './improc';
import type { GrayImage } from './types';

export interface RawSegmentFeatures {
  segment: number;
  sheen: number; // 反光模板幅度（灰度单位，可负）
  sheenWide: number;
  scratchRatio: number; // 水平相干划痕能量 / 总梯度能量
  scratchDensity: number; // 阈值划痕像素占比
  gradEnergy: number;
  focus: number;
}

export interface RawFeatures {
  segments: RawSegmentFeatures[];
  // 高分辨率角度箱（用于曲线）
  bins: { sheen: number; scratch: number; ratio: number }[];
  binCount: number;
}

// 径向反光模板匹配：对每个角度区间求平均径向轮廓，投影到“中央柔光 + 窄镜面”模板
export function sheenProfile(gray: GrayImage, x0: number, x1: number, ycOverride?: number): { wide: number; core: number } {
  const W = gray.width;
  const H = gray.height;
  const prof = new Float32Array(H);
  let cnt = 0;
  for (let x = x0; x < x1; x += 2) {
    const xx = ((x % W) + W) % W;
    for (let y = 0; y < H; y++) prof[y] += gray.data[y * W + xx];
    cnt++;
  }
  if (cnt === 0) return { wide: 0, core: 0 };
  for (let y = 0; y < H; y++) prof[y] /= cnt;

  // 基线取上下外缘的中位数附近，避免整体反光照成直流
  const edge: number[] = [];
  for (let y = 0; y < H * 0.18; y++) edge.push(prof[y]);
  for (let y = Math.floor(H * 0.82); y < H; y++) edge.push(prof[y]);
  edge.sort((a, b) => a - b);
  const base = edge[edge.length >> 1] ?? prof[0];

  const yc = ycOverride ?? H / 2;
  const fit = (sigma: number): number => {
    const t = new Float32Array(H);
    let tm = 0;
    for (let y = 0; y < H; y++) {
      t[y] = Math.exp(-((y - yc) ** 2) / (2 * sigma * sigma));
      tm += t[y];
    }
    tm /= H;
    let num = 0;
    let den = 0;
    for (let y = 0; y < H; y++) {
      const tt = t[y] - tm;
      const r = prof[y] - base;
      num += r * tt;
      den += tt * tt;
    }
    return den > 0 ? num / den : 0;
  };

  return { wide: fit(H * 0.22), core: fit(H * 0.07) };
}

// 在几个可能的局部带心位置取最强模板响应，消除拼接径向漂移
export function sheenProfileRobust(gray: GrayImage, x0: number, x1: number): number {
  const H = gray.height;
  let best = -Infinity;
  for (const dy of [-16, -8, 0, 8, 16]) {
    const yc = H / 2 + dy;
    if (yc < H * 0.2 || yc > H * 0.8) continue;
    const sh = sheenProfile(gray, x0, x1, yc);
    const v = sh.wide + 0.5 * sh.core;
    if (v > best) best = v;
  }
  return best;
}

// Sobel + 方向相干 + 水平延续，输出每段划痕指标
export function scratchFeatures(gray: GrayImage): {
  hPersist: Float32Array;
  mag: Float32Array;
  coh: Float32Array;
} {
  const W = gray.width;
  const H = gray.height;
  const d = gray.data;
  const gx = new Float32Array(W * H);
  const gy = new Float32Array(W * H);
  const mag = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      // 横向循环
      const xl = y * W + (x - 1);
      const xr = y * W + ((x + 1) % W);
      gx[i] =
        -d[xl - W] - 2 * d[xl] - d[xl + W] + d[xr - W] + 2 * d[xr] + d[xr + W];
      gy[i] =
        -d[(y - 1) * W + x - 1] - 2 * d[(y - 1) * W + x] - d[(y - 1) * W + x + 1] +
        d[(y + 1) * W + x - 1] + 2 * d[(y + 1) * W + x] + d[(y + 1) * W + x + 1];
      mag[i] = Math.hypot(gx[i], gy[i]);
    }
  }
  const coh = new Float32Array(W * H);
  const hEdge = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const denom = gx[i] * gx[i] + gy[i] * gy[i] + 36;
    const c = (gy[i] * gy[i] - gx[i] * gx[i]) / denom; // -1..1，水平边缘为正
    coh[i] = c;
    hEdge[i] = mag[i] * Math.max(0, c);
  }
  // 水平方向延续（9×5 盒均值）：各向同性斑点无法形成长延续
  const hPersist = horizontalBox(hEdge, W, H, 5, 1);
  return { hPersist, mag, coh };
}

function horizontalBox(src: Float32Array, W: number, H: number, rx: number, ry: number): Float32Array {
  // 先用通用 boxBlurWrapX（正方形半径），这里直接调 radius=rx 近似；为保留细粒度用两次
  void ry;
  return boxBlurWrapX(src, W, H, rx);
}

export function extractFeatures(stripGray: GrayImage, binCount = 180): RawFeatures {
  const W = stripGray.width;
  const H = stripGray.height;
  const { hPersist, mag, coh } = scratchFeatures(stripGray);

  // 全局划痕阈值（基于持续响应的高分位），用于像素密度
  const sample: number[] = [];
  for (let i = 0; i < hPersist.length; i += 13) sample.push(hPersist[i]);
  sample.sort((a, b) => a - b);
  const persistThresh = sample[Math.floor(sample.length * 0.72)] * 1.05 + 2;

  const segments: RawSegmentFeatures[] = [];
  const segW = W / SEGMENT_COUNT;
  for (let s = 0; s < SEGMENT_COUNT; s++) {
    const x0 = Math.floor(s * segW);
    const x1 = Math.floor((s + 1) * segW);
    const sh = sheenProfile(stripGray, x0, x1);
    let hp = 0;
    let ge = 0;
    let dens = 0;
    let focus = 0;
    let n = 0;
    for (let x = x0; x < x1; x += 2) {
      for (let y = Math.floor(H * 0.12); y < H * 0.9; y += 2) {
        const i = y * W + x;
        hp += hPersist[i];
        ge += mag[i];
        if (hPersist[i] > persistThresh && coh[i] > 0.06) dens++;
        n++;
      }
    }
    // Laplacian 对焦
    let fmean = 0;
    let fm2 = 0;
    let fn = 0;
    for (let y = 2; y < H - 2; y += 2) {
      for (let x = x0 + 2; x < x1 - 2; x += 3) {
        const i = y * W + (x % W);
        const lap =
          stripGray.data[i - W] + stripGray.data[i + W] + stripGray.data[i - 1] + stripGray.data[i + 1] - 4 * stripGray.data[i];
        fn++;
        const dlt = lap - fmean;
        fmean += dlt / fn;
        fm2 += dlt * (lap - fmean);
      }
    }
    focus = fn > 1 ? fm2 / (fn - 1) : 0;
    segments.push({
      segment: s,
      sheen: sheenProfileRobust(stripGray, x0, x1),
      sheenWide: sh.wide,
      scratchRatio: hp / Math.max(1e-6, ge),
      scratchDensity: dens / Math.max(1, n),
      gradEnergy: ge / Math.max(1, n),
      focus,
    });
  }

  // 高分辨率箱
  const bins: RawFeatures['bins'] = [];
  const bw = W / binCount;
  for (let b = 0; b < binCount; b++) {
    const x0 = Math.floor(b * bw);
    const x1 = Math.floor((b + 1) * bw);
    const sh = sheenProfile(stripGray, x0, x1);
    let hp = 0;
    let ge = 0;
    let n = 0;
    for (let x = x0; x < x1; x += 2) {
      for (let y = Math.floor(H * 0.15); y < H * 0.88; y += 3) {
        const i = y * W + (x % W);
        hp += hPersist[i];
        ge += mag[i];
        n++;
      }
    }
    bins.push({ sheen: sh.wide + 0.5 * sh.core, scratch: hp / Math.max(1, n), ratio: hp / Math.max(1e-6, ge) });
  }

  // 保留 gaussianBlur 引用以备尺度扩展
  void gaussianBlur;
  return { segments, bins, binCount };
}
