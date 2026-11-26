// 粗糙度校准：五磨损等级锚点 + 分段线性映射 + 环形中值/平滑。
// 锚点由 scripts/validate.ts / collect.ts 在带真值合成集上标定后冻结，
// 属于“仪器标定常数”，不依赖运行时真值。

export const LEVEL_R = [0.12, 0.31, 0.5, 0.7, 0.89];

// level 0..4 对应的特征锚点（合成真值标定）
export const ANCHORS = {
  sheen: [127, 86, 56, 24, 1.5], // 径向反光模板幅度，随等级升高而下降
  low: [186.7, 172.1, 158.3, 143.2, 129.9], // 大尺度低频亮度
  scrR: [0.335, 0.363, 0.374, 0.411, 0.437], // 水平相干划痕能量比，随等级升高
};

export const FUSION = {
  wSheen: 0.5,
  wLow: 0.5,
  wScratch: 0.14, // 细划痕密度作为佐证通道（权重较小，抗虚焦）
  medianPasses: 1,
  smoothPasses: 0,
};

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// 单调分段线性 + 端点线性外推。xs/ys 必须同序单调。
export function interpAnchor(x: number, xs: number[], ys: number[]): number {
  if (x <= xs[0]) {
    const slope = (ys[1] - ys[0]) / (xs[1] - xs[0] || 1);
    return ys[0] + (x - xs[0]) * slope;
  }
  const n = xs.length;
  if (x >= xs[n - 1]) {
    const slope = (ys[n - 1] - ys[n - 2]) / (xs[n - 1] - xs[n - 2] || 1);
    return ys[n - 1] + (x - xs[n - 1]) * slope;
  }
  for (let i = 0; i < n - 1; i++) {
    if (x >= xs[i] && x <= xs[i + 1]) {
      const t = (x - xs[i]) / (xs[i + 1] - xs[i] || 1);
      return ys[i] * (1 - t) + ys[i + 1] * t;
    }
  }
  return 2;
}

// sheen/low 随 level 递减：把锚点反转为升序特征值，level 为 4..0
export function sheenToLevel(v: number): number {
  return interpAnchor(v, [...ANCHORS.sheen].reverse(), [4, 3, 2, 1, 0]);
}
export function lowToLevel(v: number): number {
  return interpAnchor(v, [...ANCHORS.low].reverse(), [4, 3, 2, 1, 0]);
}
export function scratchToLevel(v: number): number {
  return interpAnchor(v, ANCHORS.scrR, [0, 1, 2, 3, 4]);
}

export function levelToRoughness(lv: number): number {
  const x = Math.max(0, Math.min(4, lv));
  const i = Math.min(3, Math.floor(x));
  const t = x - i;
  return clamp01(LEVEL_R[i] * (1 - t) + LEVEL_R[i + 1] * t);
}

export interface SegmentRaw {
  sheen: number;
  low: number;
  scrR: number;
}

// 单段融合为连续等级 0..4
export function segmentLevel(f: SegmentRaw): number {
  const refl = FUSION.wSheen * sheenToLevel(f.sheen) + FUSION.wLow * lowToLevel(f.low);
  const scr = scratchToLevel(f.scrR);
  return (1 - FUSION.wScratch) * refl + FUSION.wScratch * scr;
}

export function circularMedian(values: number[]): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const a = values[(i - 1 + n) % n];
    const b = values[i];
    const c = values[(i + 1) % n];
    out[i] = [a, b, c].sort((x, y) => x - y)[1];
  }
  return out;
}

// 环形三点加权平滑
export function circularSmooth(values: number[], passes = 1): number[] {
  let cur = values.slice();
  const n = cur.length;
  for (let p = 0; p < passes; p++) {
    const next = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      next[i] = cur[(i - 1 + n) % n] * 0.25 + cur[i] * 0.5 + cur[(i + 1) % n] * 0.25;
    }
    cur = next;
  }
  return cur;
}

function percentile(sortedAsc: number[], q: number): number {
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(q * sortedAsc.length)))];
}

// 36 段原始特征 -> 校准后的 36 个 R。
// 先套五锚点得到连续等级，再用本壶 p10/p90（均衡五片区下正好接近极端档中心）
// 做稳健量程标定，抗花岗岩底色/残曝光；最后环形中值去除孤立误判。
export function estimateRoughness36(raw: SegmentRaw[]): number[] {
  const combined = raw.map(segmentLevel);
  const sorted = [...combined].sort((a, b) => a - b);
  const lo = percentile(sorted, 0.1);
  const hi = percentile(sorted, 0.9);
  const span = hi - lo || 1;
  let levels = combined.map((v) => Math.max(-0.2, Math.min(4.2, ((v - lo) / span) * 4)));
  for (let p = 0; p < FUSION.medianPasses; p++) levels = circularMedian(levels);
  levels = circularSmooth(levels, FUSION.smoothPasses);
  return levels.map(levelToRoughness);
}

// 由 36 段 R 余弦插值出任意点数的平滑环向曲线
export function curveFromSegments(r36: number[], samples: number): number[] {
  const out = new Array<number>(samples);
  for (let i = 0; i < samples; i++) {
    const f = (i / samples) * 36;
    const i0 = Math.floor(f) % 36;
    const i1 = (i0 + 1) % 36;
    let t = f - Math.floor(f);
    t = t * t * (3 - 2 * t); // smoothstep，避免折线
    out[i] = r36[i0] * (1 - t) + r36[i1] * t;
  }
  return out;
}

// 任意点数曲线的环形平滑（保留给高分辨率特征曲线）
export function circularSmoothN(values: number[], radius = 6): number[] {
  const n = values.length;
  if (n < 3 || radius < 1) return values.slice();
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let w = 0;
    for (let k = -radius; k <= radius; k++) {
      const wt = radius + 1 - Math.abs(k);
      s += values[(i + k + n * 100) % n] * wt;
      w += wt;
    }
    out[i] = s / w;
  }
  return out;
}

// 兼容旧调用：单特征归一化分量（用于 UI 仪表的粗略映射）
export const CAL = {
  sheenCenter: 40,
  sheenHalf: 80,
  scrDCenter: 0.12,
  scrDHalf: 0.2,
};
export function fuseOne(f: { sheen: number; low?: number; scrR?: number; scrD?: number }): number {
  const lv = segmentLevel({ sheen: f.sheen, low: f.low ?? 158, scrR: f.scrR ?? 0.38 });
  return levelToRoughness(lv);
}
