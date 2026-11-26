import { SEGMENT_COUNT, adviceForRoughness } from './config';
import { circularSmooth } from './calibration';
import type { AnalysisResult, CompareResult, InspectionRecord } from './types';

export function toRecord(stoneId: string, a: AnalysisResult, date: string): InspectionRecord {
  const roughness36 = a.segments.map((s) => s.roughness);
  return {
    stoneId,
    date,
    roughness36,
    grit: a.segments.map((s) => s.grit),
    passes: a.segments.map((s) => s.passes),
    bins: a.segments.map((s) => s.bin),
    chips: a.chips,
    score: conditionScore(roughness36),
  };
}

// 整体状态分：越接近理想粗糙区间且越均匀越高
export function conditionScore(r: number[]): number {
  const ideal = 0.6;
  const dev = r.reduce((a, v) => a + Math.min(1, Math.abs(v - ideal) / 0.62), 0) / r.length;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length;
  const uniformityPenalty = Math.min(0.25, Math.sqrt(variance) * 0.5);
  return Math.round(100 * Math.max(0, 1 - dev) * (1 - uniformityPenalty));
}

// 环形互相关，找两条 36 曲线的最佳相位差（段）
export function alignShift(cur: number[], prev: number[]): { shift: number; correlation: number } {
  let best = { shift: 0, correlation: -2 };
  for (let sh = -4; sh <= 4; sh++) {
    const moved = prev.map((_, i) => prev[(i - sh + SEGMENT_COUNT) % SEGMENT_COUNT]);
    const c = pearson(cur, moved);
    if (c > best.correlation) best = { shift: sh, correlation: c };
  }
  return best;
}

export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return num / Math.sqrt(Math.max(1e-9, dx * dy));
}

export function compareRecords(current: InspectionRecord, previous: InspectionRecord | null): CompareResult {
  if (!previous) {
    return {
      current,
      previous: null,
      delta36: new Array(SEGMENT_COUNT).fill(0),
      worsened: [],
      improved: [],
      changedAdvice: [],
    };
  }
  const align = alignShift(current.roughness36, previous.roughness36);
  const alignedPrev =
    align.shift === 0
      ? previous.roughness36
      : previous.roughness36.map((_, i) => previous.roughness36[(i - align.shift + SEGMENT_COUNT) % SEGMENT_COUNT]);

  const delta36 = current.roughness36.map((r, i) => r - alignedPrev[i]);
  const worsened: number[] = [];
  const improved: number[] = [];
  const changedAdvice: number[] = [];
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    // R 下降 = 更磨平（恶化）；上升 = 更粗糙（打磨后改善/或过粗）
    if (delta36[i] <= -0.12) worsened.push(i);
    if (delta36[i] >= 0.12) improved.push(i);
    const aNow = adviceForRoughness(current.roughness36[i]).bin;
    const aPrev = adviceForRoughness(previous.roughness36[i]).bin;
    if (aNow !== aPrev) changedAdvice.push(i);
  }
  return { current, previous, delta36, worsened, improved, changedAdvice, correlation: align.correlation };
}

// 由本次结果反推一份“上一次检查”：整体略新/略均匀，在 1~2 个片区留下更早的磨损，
// 用于首次演示时生成可信、与本次高相关且有局部 Δ 的历史记录。用户保存后即以真实记录为准。
export function derivePreviousFromCurrent(rec: InspectionRecord, seed = 4242): InspectionRecord {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
  const r = rec.roughness36.slice();
  // 选 1~2 个连续片区，上次检查时更粗糙/或更平整，形成有意义的 Δ
  const zones = 1 + Math.floor(rnd() * 2);
  for (let z = 0; z < zones; z++) {
    const start = Math.floor(rnd() * 30);
    const w = 3 + Math.floor(rnd() * 4);
    const drift = 0.1 + rnd() * 0.14;
    for (let k = 0; k < w; k++) {
      const i = (start + k) % 36;
      // 多数片区表现为“这段时间被磨平”：上次 R 更高
      r[i] = Math.max(0.04, Math.min(0.96, r[i] + drift * (rnd() < 0.85 ? 1 : -1)));
    }
  }
  // 少量测量噪声
  for (let i = 0; i < 36; i++) r[i] = Math.max(0.03, Math.min(0.98, r[i] + (rnd() - 0.5) * 0.03));
  const grit = r.map((v) => adviceForRoughness(v).grit);
  const passes = r.map((v) => adviceForRoughness(v).passes);
  const bins = r.map((v) => adviceForRoughness(v).bin);
  return {
    ...rec,
    date: '2026-10-15',
    roughness36: r,
    grit,
    passes,
    bins,
    score: conditionScore(r),
    note: '上次例行检查',
  };
}

// 生成一份“上次检查”的演示记录（固定种子，日期较早）
export function seedPreviousRecord(stoneId: string, seed = 7701, date = '2026-10-15'): InspectionRecord {
  // 轻量确定性伪随机片区曲线，避免依赖 synth/Worker
  let a = seed >>> 0;
  const rnd = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
  const levels: number[] = [];
  let lv = 2;
  for (let z = 0; z < 8; z++) {
    lv = Math.max(0, Math.min(4, lv + (Math.floor(rnd() * 3) - 1)));
    const w = 3 + Math.floor(rnd() * 3);
    for (let k = 0; k < w && levels.length < 36; k++) levels.push(lv);
  }
  while (levels.length < 36) levels.push(2);
  const centers = [0.12, 0.3, 0.5, 0.71, 0.91];
  let r = levels.slice(0, 36).map((l) => centers[l] + (rnd() - 0.5) * 0.06);
  r = circularSmooth(r, 1);
  const grit = r.map((v) => adviceForRoughness(v).grit);
  const passes = r.map((v) => adviceForRoughness(v).passes);
  const bins = r.map((v) => adviceForRoughness(v).bin);
  return {
    stoneId,
    date,
    roughness36: r,
    grit,
    passes,
    bins,
    chips: [
      { segment: 14, angleDeg: 145, edge: 'outer', depthMm: 1.6, widthMm: 6.5, severity: 0.55, confidence: 0.9 },
    ],
    score: conditionScore(r),
    note: '上次例行检查',
  };
}
