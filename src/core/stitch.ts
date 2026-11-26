import { CAPTURE_STEP, MOSAIC_H, MOSAIC_W, PHOTO_ANG_WIN, PHOTO_W, RING_SIZE } from './config';
import { clamp } from './rng';
import {
  boxBlurWrapX,
  createRgba,
  estimateShiftNCC,
  focusScore,
  rgbaToGray,
  type ShiftResult,
} from './improc';
import type { GrayImage } from './types';
import type { PhotoShot, Placement, RgbaImage, ShiftEstimate, StitchResult } from './types';

// 把拍摄顺序整理成角度递增顺序
function orderAngleWise(photos: PhotoShot[]): PhotoShot[] {
  if (photos.length === 0) return photos;
  return photos[0].direction === -1 ? [...photos].reverse() : photos;
}

export function stitchRing(photosIn: PhotoShot[], onProgress?: (p: number, msg: string) => void): StitchResult {
  const t0 = performanceNow();
  const photos = orderAngleWise(photosIn);
  const n = photos.length;
  const grays = photos.map((p) => rgbaToGray(p.rgba));
  // 高通灰度：去掉暗角/宽幅光照，只留花岗岩颗粒与划痕用于重叠匹配，避免 dx=0 假峰
  const hpGrays: GrayImage[] = grays.map((g) => {
    const low = boxBlurWrapX(g.data, g.width, g.height, 7);
    const data = new Float32Array(g.width * g.height);
    for (let i = 0; i < data.length; i++) data[i] = g.data[i] - low[i] + 128;
    return { width: g.width, height: g.height, data };
  });

  // 1) 相邻重叠 NCC 位移
  const shifts: ShiftEstimate[] = [];
  const rawShift: ShiftResult[] = [];
  const expectedAdvance = PHOTO_W * (CAPTURE_STEP / PHOTO_ANG_WIN); // photo px
  for (let i = 0; i < n - 1; i++) {
    const s = estimateShiftNCC(hpGrays[i], hpGrays[i + 1], {
      expectedDx: -Math.round(expectedAdvance),
      dxRange: 40,
      dyRange: 18,
      step: 4,
      rowFrac: [0.18, 0.82],
    });
    rawShift.push(s);
    shifts.push({ from: photos[i].id, to: photos[i + 1].id, dx: s.dx, dy: s.dy, score: s.score });
    onProgress?.(((i + 1) / (n - 1)) * 0.5, `重叠匹配 ${i + 1}/${n - 1}`);
  }

  // 2) 闭合：累计前进量 -> 一圈周长
  const advances = rawShift.map((s) => -s.dx); // photo px，角度递增为正
  const dys = rawShift.map((s) => s.dy);
  const span = advances.reduce((a, b) => a + b, 0); // 0..n-1
  const circumference = (span * n) / (n - 1);
  const q = MOSAIC_W / circumference;

  const placeXPhoto: number[] = [0];
  for (let i = 0; i < n - 1; i++) placeXPhoto.push(placeXPhoto[i] + advances[i]);

  // 径向累计并去趋势（消除随机漂移）
  const placeYPhoto: number[] = [0];
  for (let i = 0; i < n - 1; i++) placeYPhoto.push(placeYPhoto[i] - dys[i]);
  const meanY = placeYPhoto.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) placeYPhoto[i] -= meanY;

  // 3) 镜头平场（暗角）估计 -> 曝光增益链（重叠区亮度比，保留真实角度方向反光变化）
  const vigK = estimateVignetteK(photos);
  const flatGrays = grays.map((g, i) => {
    const corrected = new Float32Array(g.width * g.height);
    const p = photos[i];
    for (let y = 0; y < g.height; y += 1) {
      for (let x = 0; x < g.width; x += 1) {
        const vx = (x - g.width / 2) / (g.width / 2);
        const vy = (y - g.height / 2) / (g.height / 2);
        const v = clamp(1 - vigK * (vx * vx + vy * vy), 0.55, 1);
        corrected[y * g.width + x] = g.data[y * g.width + x] / v;
      }
    }
    void p;
    return boxBlurWrapX(corrected, g.width, g.height, 10);
  });
  const corr = exposureChain(flatGrays, rawShift);

  // 4) 对焦评分
  const focus = photos.map((p, i) => {
    const g = grays[i];
    return focusScore(g, 0, Math.floor(g.height * 0.2), g.width, Math.floor(g.height * 0.6));
  });

  const placements: Placement[] = photos.map((p, i) => ({
    photoId: p.id,
    x: placeXPhoto[i] * q,
    y: placeYPhoto[i],
    scale: q,
    exposure: corr[i],
    focus: focus[i],
  }));

  onProgress?.(0.58, '融合拼接长图（未校正）');
  const YOFS = 26;
  let mosaicRaw = assemble(photos, placements, q, YOFS, false, vigK);
  onProgress?.(0.74, '融合拼接长图（曝光校正）');
  let mosaic = assemble(photos, placements, q, YOFS, true, vigK);

  // 原点对齐：引导页给出首张中心角，把马赛克旋转到 x=0 ↔ 世界角 0，36 段因此对齐
  const scaleWM = (PHOTO_W / PHOTO_ANG_WIN) * q; // mosaic px / world angle px
  const first = photos[0];
  const firstCenterMx = placements[0].x + (PHOTO_W * q) / 2;
  const anchor = mod(firstCenterMx - first.angleCenter * scaleWM, MOSAIC_W);
  if (anchor > 1) {
    mosaic = rotateWrapX(mosaic, Math.round(anchor));
    mosaicRaw = rotateWrapX(mosaicRaw, Math.round(anchor));
  }

  onProgress?.(0.86, '极坐标生成圆环');
  const ring = renderRing(mosaic);

  onProgress?.(1, '拼接完成');
  return {
    mosaic,
    mosaicRaw,
    ring,
    ringCx: RING_SIZE / 2,
    ringCy: RING_SIZE / 2,
    ringRCenter: 600,
    ringRadialScale: 1.35,
    placements,
    shifts,
    circumferencePhotoPx: circumference,
    elapsedMs: performanceNow() - t0,
  };
}

function performanceNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function mod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

// 横向循环左移 shift 列：输出 x=0 取原 x=shift
function rotateWrapX(img: RgbaImage, shift: number): RgbaImage {
  const W = img.width;
  const H = img.height;
  const out = createRgba(W, H);
  const s = mod(shift, W);
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      const sx = (x + s) % W;
      out.data[row + x * 4] = img.data[row + sx * 4];
      out.data[row + x * 4 + 1] = img.data[row + sx * 4 + 1];
      out.data[row + x * 4 + 2] = img.data[row + sx * 4 + 2];
      out.data[row + x * 4 + 3] = 255;
    }
  }
  return out;
}

// 从全部照片按归一化半径分箱估计暗角系数：luma(r²) ≈ c0*(1-k*r²)
function estimateVignetteK(photos: PhotoShot[]): number {
  const BINS = 12;
  const sum = new Float64Array(BINS);
  const cnt = new Float64Array(BINS);
  for (const p of photos) {
    const w = p.rgba.width;
    const h = p.rgba.height;
    const d = p.rgba.data;
    for (let y = 0; y < h; y += 6) {
      const vy = (y - h / 2) / (h / 2);
      for (let x = 0; x < w; x += 6) {
        const vx = (x - w / 2) / (w / 2);
        const r2 = vx * vx + vy * vy;
        const b = Math.min(BINS - 1, Math.floor((r2 / 2) * BINS));
        const i = (y * w + x) * 4;
        sum[b] += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        cnt[b]++;
      }
    }
  }
  // 最小二乘 luma = a + b*r2，k = -b/a
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0,
    n = 0;
  for (let b = 0; b < BINS; b++) {
    if (cnt[b] < 10) continue;
    const r2 = ((b + 0.5) / BINS) * 2;
    const luma = sum[b] / cnt[b];
    sx += r2;
    sy += luma;
    sxx += r2 * r2;
    sxy += r2 * luma;
    n++;
  }
  if (n < 4) return 0.22;
  const denom = n * sxx - sx * sx;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const k = clamp(-slope / Math.max(1, intercept), -0.2, 0.6);
  return k;
}

// 相邻重叠区（重度模糊+平场校正后）均值比 -> 每张照片乘子
function exposureChain(flatGrays: Float32Array[], shifts: ShiftResult[]): number[] {
  const n = flatGrays.length;
  const logR = new Array<number>(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    const a = flatGrays[i];
    const b = flatGrays[i + 1];
    const W = 640;
    const H = 440;
    const { dx, dy } = shifts[i];
    let sa = 0,
      sb = 0,
      cnt = 0;
    const x0 = Math.floor(W * 0.22);
    const x1 = Math.floor(W * 0.78);
    const y0 = Math.floor(H * 0.3);
    const y1 = Math.floor(H * 0.7);
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const bx = x + dx;
        const by = y + dy;
        if (bx < 1 || bx >= W - 1 || by < 1 || by >= H - 1) continue;
        sa += a[y * W + x];
        sb += b[by * W + bx];
        cnt++;
      }
    }
    if (cnt > 200 && sb > 1) logR[i] = Math.log(clamp(sa / sb, 0.7, 1.4));
  }
  // 闭合正则：把总漂移均匀分摊到所有边（环形图最小二乘），避免指数累积
  let cum = 0;
  const cumLog: number[] = [0];
  for (let i = 0; i < n - 1; i++) {
    cum += logR[i];
    cumLog.push(cum);
  }
  // 首尾本应同源（第 n-1 张与第 0 张隔缝相邻），用平均斜率去除漂移
  const driftPerEdge = cum / n;
  const logCorr = cumLog.map((l, i) => l - driftPerEdge * i);
  const m = logCorr.reduce((a, b) => a + b, 0) / n;
  return logCorr.map((l) => Math.exp(l - m));
}

interface Instance {
  p: PhotoShot;
  pl: Placement;
  mx: number; // mosaic 左上 x
  my: number;
  mw: number;
}

interface ColRef {
  inst: number;
  cx: number;
}

function assemble(
  photos: PhotoShot[],
  placements: Placement[],
  q: number,
  yOfs: number,
  correct: boolean,
  vigK: number,
): RgbaImage {
  const W = MOSAIC_W;
  const H = MOSAIC_H;
  const out = createRgba(W, H);
  const accR = new Float32Array(W * H);
  const accG = new Float32Array(W * H);
  const accB = new Float32Array(W * H);
  const wsum = new Float32Array(W * H);

  const insts: Instance[] = photos.map((p, i) => {
    const pl = placements[i];
    return { p, pl, mx: pl.x, my: yOfs + pl.y, mw: p.rgba.width * q };
  });

  // 预计算每一列被哪些照片的哪些循环副本覆盖
  const colInst: ColRef[][] = Array.from({ length: W }, () => []);
  insts.forEach((inst, ii) => {
    for (const base of [inst.mx - W, inst.mx, inst.mx + W]) {
      const xStart = Math.max(0, Math.floor(base));
      const xEnd = Math.min(W - 1, Math.ceil(base + inst.mw));
      for (let X = xStart; X <= xEnd; X++) {
        if (X >= 0 && X < W && X >= base && X < base + inst.mw) colInst[X].push({ inst: ii, cx: base });
      }
    }
  });

  for (let X = 0; X < W; X++) {
    const refs = colInst[X];
    if (refs.length === 0) continue;
    for (let Y = 0; Y < H; Y++) {
      let r = 0,
        g = 0,
        b = 0,
        ws = 0;
      for (const ref of refs) {
        const inst = insts[ref.inst];
        const u = (X - ref.cx) / inst.mw; // 0..1
        const px = u * inst.p.rgba.width;
        const py = Y - inst.my;
        if (py < 0 || py >= inst.p.rgba.height) continue;
        // 尖峰角度权重：每列基本只取最近的一张，避免两张失配照片的划痕重影；
        // 仅在相邻照片权重交叉处做窄过渡
        const wx = Math.pow(Math.sin(Math.PI * clamp(u, 0, 1)), 2.4);
        const vv = py / inst.p.rgba.height;
        const wy = clamp(Math.sin(Math.PI * clamp(vv, 0, 1)) * 1.25 + 0.2, 0, 1);
        const wt = Math.max(0.001, wx * wy);
        const col = samplePhotoBilinear(inst.p.rgba, px, py);
        const vx = (px - inst.p.rgba.width / 2) / (inst.p.rgba.width / 2);
        const vy = (py - inst.p.rgba.height / 2) / (inst.p.rgba.height / 2);
        const invVig = 1 / clamp(1 - vigK * (vx * vx + vy * vy), 0.55, 1);
        const e = (correct ? inst.pl.exposure : 1) * invVig;
        r += col[0] * e * wt;
        g += col[1] * e * wt;
        b += col[2] * e * wt;
        ws += wt;
      }
      if (ws > 0) {
        const idx = Y * W + X;
        wsum[idx] = ws;
        accR[idx] = r;
        accG[idx] = g;
        accB[idx] = b;
      }
    }
  }

  // 归一化 + 全局亮度锚定（仅校正版）
  let globGain = 1;
  if (correct) {
    let sum = 0,
      cnt = 0;
    for (let i = 0; i < W * H; i += 37) {
      if (wsum[i] > 0) {
        sum += (accR[i] + accG[i] + accB[i]) / 3 / wsum[i];
        cnt++;
      }
    }
    const mean = sum / Math.max(1, cnt);
    if (mean > 1) globGain = clamp(150 / mean, 0.75, 1.35);
  }

  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (wsum[i] <= 0) {
      out.data[o + 3] = 0;
      continue;
    }
    const ws = wsum[i];
    out.data[o] = clamp((accR[i] / ws) * globGain, 0, 255);
    out.data[o + 1] = clamp((accG[i] / ws) * globGain, 0, 255);
    out.data[o + 2] = clamp((accB[i] / ws) * globGain, 0, 255);
    out.data[o + 3] = 255;
  }
  return out;
}

function samplePhotoBilinear(img: RgbaImage, x: number, y: number): [number, number, number] {
  const w = img.width;
  const h = img.height;
  x = clamp(x, 0, w - 1.001);
  y = clamp(y, 0, h - 1.001);
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = i00 + 4;
  const i01 = i00 + w * 4;
  const i11 = i01 + 4;
  const d = img.data;
  return [
    d[i00] * (1 - fx) * (1 - fy) + d[i10] * fx * (1 - fy) + d[i01] * (1 - fx) * fy + d[i11] * fx * fy,
    d[i00 + 1] * (1 - fx) * (1 - fy) +
      d[i10 + 1] * fx * (1 - fy) +
      d[i01 + 1] * (1 - fx) * fy +
      d[i11 + 1] * fx * fy,
    d[i00 + 2] * (1 - fx) * (1 - fy) +
      d[i10 + 2] * fx * (1 - fy) +
      d[i01 + 2] * (1 - fx) * fy +
      d[i11 + 2] * fx * fy,
  ];
}

// 马赛克（角度 x，径向 y）-> 圆环
export function renderRing(mosaic: RgbaImage): RgbaImage {
  const S = RING_SIZE;
  const cx = S / 2;
  const cy = S / 2;
  const rCenter = 600;
  const radialScale = 1.35;
  const yCenter = 250;
  const out = createRgba(S, S);
  const m = mosaic.data;
  const MW = mosaic.width;
  const MH = mosaic.height;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const r = Math.sqrt(dx * dx + dy * dy);
      const my = yCenter + (rCenter - r) / radialScale;
      const o = (y * S + x) * 4;
      if (my < 1 || my > MH - 2 || r < 120 || r > 792) {
        // 背景：深灰径向
        const bg = 16 + 10 * (r / 800);
        out.data[o] = bg;
        out.data[o + 1] = bg + 2;
        out.data[o + 2] = bg + 5;
        out.data[o + 3] = 255;
        continue;
      }
      let theta = Math.atan2(dy, dx); // -pi..pi
      if (theta < 0) theta += Math.PI * 2;
      const mx = (theta / (Math.PI * 2)) * MW;
      const x0 = mx | 0;
      const y0 = my | 0;
      const fx = mx - x0;
      const fy = my - y0;
      const x1 = (x0 + 1) % MW;
      const i00 = (y0 * MW + ((x0 % MW) + MW) % MW) * 4;
      const i10 = (y0 * MW + x1) * 4;
      const i01 = ((y0 + 1) * MW + ((x0 % MW) + MW) % MW) * 4;
      const i11 = ((y0 + 1) * MW + x1) * 4;
      for (let c = 0; c < 3; c++) {
        out.data[o + c] =
          m[i00 + c] * (1 - fx) * (1 - fy) +
          m[i10 + c] * fx * (1 - fy) +
          m[i01 + c] * (1 - fx) * fy +
          m[i11 + c] * fx * fy;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}
