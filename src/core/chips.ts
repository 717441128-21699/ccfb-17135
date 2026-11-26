import { BAND_WIDTH_MM, SEGMENT_COUNT } from './config';
import { clamp } from './rng';
import { rgbaToGray } from './improc';
import type { BandRows } from './band';
import type { ChipMark, RgbaImage } from './types';

const CIRC_MM = 380; // 运行带周长标定（示意）

interface EdgeTrack {
  top: Float32Array;
  bottom: Float32Array;
}

// 逐列追踪上下缘（暗线 + 梯度），用于轮廓偏移与深度估计
function trackEdges(mosaic: RgbaImage, rows: BandRows): EdgeTrack {
  const g = rgbaToGray(mosaic);
  const W = g.width;
  const H = g.height;
  const top = new Float32Array(W);
  const bottom = new Float32Array(W);

  const scoreAt = (x: number, y: number): number => {
    if (y < 3 || y >= H - 3) return -1;
    const i = y * W + x;
    const grad = Math.abs(g.data[i + 2 * W] - g.data[i - 2 * W]);
    const dark = Math.max(0, 105 - g.data[i]);
    return grad + dark * 0.55;
  };

  for (let x = 0; x < W; x++) {
    let bestT = rows.top;
    let bestTS = -1;
    for (let y = rows.top - 22; y <= rows.top + 60; y++) {
      let s = 0;
      for (let dx = -3; dx <= 3; dx++) s += scoreAt((x + dx + W) % W, y);
      if (s > bestTS) { bestTS = s; bestT = y; }
    }
    top[x] = bestT;

    let bestB = rows.bottom;
    let bestBS = -1;
    for (let y = rows.bottom - 60; y <= rows.bottom + 22; y++) {
      let s = 0;
      for (let dx = -3; dx <= 3; dx++) s += scoreAt((x + dx + W) % W, y);
      if (s > bestBS) { bestBS = s; bestB = y; }
    }
    bottom[x] = bestB;
  }
  return { top, bottom };
}

function medianBaseline(edge: Float32Array, win = 721): Float32Array {
  const W = edge.length;
  const half = win >> 1;
  const out = new Float32Array(W);
  const buf: number[] = [];
  for (let x = 0; x < W; x++) {
    buf.length = 0;
    for (let k = -half; k <= half; k += 5) buf.push(edge[((x + k) % W + W) % W]);
    buf.sort((a, b) => a - b);
    out[x] = buf[buf.length >> 1];
  }
  return out;
}

function smoothCircular(a: Float32Array, r: number): Float32Array {
  const W = a.length;
  const out = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0;
    let n = 0;
    for (let k = -r; k <= r; k++) { s += a[((x + k) % W + W) % W]; n++; }
    out[x] = s / n;
  }
  return out;
}

interface Run { x0: number; x1: number }

function findRuns(score: Float32Array, thresh: number, minWidth: number): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let x = 0; x <= score.length; x++) {
    const v = x < score.length ? score[x] : 0;
    if (v > thresh && x < score.length) {
      if (start < 0) start = x;
    } else if (start >= 0) {
      if (x - start >= minWidth) runs.push({ x0: start, x1: x - 1 });
      start = -1;
    }
  }
  return runs;
}

function pctInRun(arr: Float32Array, x0: number, x1: number, q: number): number {
  const vals: number[] = [];
  for (let x = x0; x <= x1; x++) vals.push(arr[x]);
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(q * vals.length))] ?? 0;
}

export function detectChips(mosaic: RgbaImage, rows: BandRows): ChipMark[] {
  const W = mosaic.width;
  const gray = rgbaToGray(mosaic);
  const d = gray.data;
  const H = gray.height;
  const edges = trackEdges(mosaic, rows);

  // 小窗平滑边缘去毛刺，宽窗基线求内凹残差，再平滑残差
  const topSm = smoothCircular(edges.top, 6);
  const botSm = smoothCircular(edges.bottom, 6);
  const baseT = medianBaseline(topSm);
  const baseB = medianBaseline(botSm);
  const resT0 = new Float32Array(W);
  const resB0 = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    resT0[x] = Math.max(0, topSm[x] - baseT[x]);
    resB0[x] = Math.max(0, baseB[x] - botSm[x]);
  }
  const resT = smoothCircular(resT0, 4);
  const resB = smoothCircular(resB0, 4);

  const pxPerMmRadial = rows.rowHeight / BAND_WIDTH_MM || 20;
  const pxPerMmArc = W / CIRC_MM;
  const marks: ChipMark[] = [];

  // 缺口暗度佐证：切片跨在标称边缘上下（合成缺口为深色阴影）
  const darkEvidence = (xc: number, edge: 'inner' | 'outer'): number => {
    let sum = 0;
    let n = 0;
    for (let dx = -16; dx <= 16; dx += 2) {
      const x = ((xc + dx) % W + W) % W;
      for (let yy = -18; yy <= 46; yy += 3) {
        const y = edge === 'inner' ? rows.top + yy : rows.bottom + yy;
        if (y < 0 || y >= H) continue;
        sum += d[y * W + x];
        n++;
      }
    }
    const mean = n ? sum / n : 150;
    return clamp((132 - mean) / 72, 0, 1);
  };

  const addRuns = (runs: Run[], edge: 'inner' | 'outer', residual: Float32Array) => {
    for (const r of runs) {
      const widthPx = r.x1 - r.x0;
      if (widthPx < 58 || widthPx > 300) continue;
      const depthPx = pctInRun(residual, r.x0, r.x1, 0.85);
      if (depthPx < 14) continue;
      const xc = Math.round((r.x0 + r.x1) / 2);
      const dark = darkEvidence(xc, edge);
      const segment = Math.floor((xc / W) * SEGMENT_COUNT) % SEGMENT_COUNT;
      marks.push({
        segment,
        angleDeg: (xc / W) * 360,
        edge,
        depthMm: Math.round((depthPx / pxPerMmRadial) * 10) / 10,
        widthMm: Math.round((widthPx / pxPerMmArc) * 10) / 10,
        severity: clamp(depthPx / 42, 0.25, 1),
        confidence: clamp(0.6 + depthPx / 130 + dark * 0.18, 0, 0.97),
      });
    }
  };

  addRuns(findRuns(resT, 12, 44), 'inner', resT);
  addRuns(findRuns(resB, 12, 44), 'outer', resB);

  // 非极大抑制：按显著度排序，角度 13° 内（不分内外缘）只保留最强的一处，
  // 消除同一崩口被两缘/相邻窗口重复报告。
  const score = (m: ChipMark) => m.severity * m.widthMm + m.confidence;
  const sorted = marks.sort((a, b) => score(b) - score(a));
  const picked: ChipMark[] = [];
  for (const m of sorted) {
    const clash = picked.some((p) => {
      let da = Math.abs(p.angleDeg - m.angleDeg) % 360;
      if (da > 180) da = 360 - da;
      return da <= 13;
    });
    if (!clash) picked.push(m);
  }
  return picked.sort((a, b) => a.angleDeg - b.angleDeg).slice(0, 8);
}

// 供验证：崩口命中判定（同段或相邻段、同缘）
export function chipMatchScore(detected: ChipMark[], truth: { segment: number; edge: string }[]): {
  hit: number;
  total: number;
  detected: number;
} {
  let hit = 0;
  for (const t of truth) {
    const ok = detected.some(
      (c) => c.edge === t.edge && Math.min(Math.abs(c.segment - t.segment), 36 - Math.abs(c.segment - t.segment)) <= 1,
    );
    if (ok) hit++;
  }
  return { hit, total: truth.length, detected: detected.length };
}
