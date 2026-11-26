import { CURVE_SAMPLES, SEGMENT_COUNT, adviceForRoughness } from './config';
import { CAL, clamp01, curveFromSegments, estimateRoughness36 } from './calibration';
import { cropStrip, detectBandRows, equalizeStrip } from './band';
import { extractFeatures } from './features';
import { detectChips } from './chips';
import { gaussianBlur, rgbaToGray } from './improc';
import type { AnalysisResult, SegmentStat, StitchResult, StoneTruth } from './types';

export function analyzeStitch(st: StitchResult, truth?: StoneTruth): AnalysisResult {
  const t0 = now();
  const rows = detectBandRows(st.mosaic);

  // 展开：未校正 vs 亮度/对焦拉匀（后者仅用于展示与清晰度指标）
  const stripRaw = cropStrip(st.mosaicRaw, rows, 12);
  const correctedCrop = cropStrip(st.mosaic, rows, 12);
  const eq = equalizeStrip(correctedCrop);
  const strip = eq.strip;

  // 粗糙度特征必须从“仅做曝光/暗角校正、未径向拉平/锐化”的图提取，
  // 否则径向增益会抹掉真实反光瓣、锐化会改变划痕能量。
  const gray = rgbaToGray(correctedCrop);
  const feats = extractFeatures(gray, 180);
  const low = gaussianBlur(gray, 26, true);
  const W = gray.width;
  const H = gray.height;

  // 每段低频亮度
  const lowSeg: number[] = [];
  for (let s = 0; s < SEGMENT_COUNT; s++) {
    const x0 = (s * W) / SEGMENT_COUNT;
    const x1 = ((s + 1) * W) / SEGMENT_COUNT;
    let sum = 0;
    let n = 0;
    for (let x = x0; x < x1; x += 3) {
      for (let y = H * 0.24; y < H * 0.76; y += 3) {
        sum += low.data[(y | 0) * W + (Math.floor(x) % W)];
        n++;
      }
    }
    lowSeg.push(sum / n);
  }

  // 锚点校准融合 + 环形中值
  const rough36 = estimateRoughness36(
    feats.segments.map((f, s) => ({ sheen: f.sheen, low: lowSeg[s], scrR: f.scratchRatio })),
  );

  const meanNcc = st.shifts.length ? st.shifts.reduce((a, x) => a + x.score, 0) / st.shifts.length : 0.6;
  const baseConf = clamp01(0.55 + meanNcc * 0.45);

  const chips = detectChips(st.mosaic, rows);

  const segments: SegmentStat[] = rough36.map((r, s) => {
    const f = feats.segments[s];
    const adv = adviceForRoughness(r);
    const segChips = chips.filter((c) => c.segment === s);
    let chip = segChips[0] ?? null;
    if (segChips.length > 1) {
      // 同段多缘时保留最严重，另一处仍在 chips 列表中
      chip = segChips.reduce((a, b) => (b.severity > a.severity ? b : a));
    }
    const reflectivity = clamp01(
      0.5 + (f.sheen - CAL.sheenCenter) / (2 * CAL.sheenHalf),
    );
    const scratchDensity = clamp01(
      0.5 + (f.scratchDensity - CAL.scrDCenter) / (2 * CAL.scrDHalf),
    );
    const stat: SegmentStat = {
      index: s,
      angleStartDeg: s * 10,
      angleEndDeg: (s + 1) * 10,
      roughness: r,
      reflectivity,
      scratchDensity,
      matte: 1 - reflectivity,
      confidence: clamp01(baseConf - (f.focus < 6 ? 0.12 : 0)),
      grit: adv.grit,
      passes: adv.passes,
      label: adv.label,
      tone: adv.tone,
      bin: adv.bin,
      chip,
    };
    if (truth) {
      stat.truthRoughness = truth.roughness[s];
      stat.truthBin = truth.wearLevel[s];
      stat.adviceMatch = adv.bin === truth.wearLevel[s];
    }
    return stat;
  });

  // 高分辨率曲线：融合 180 箱 -> 平滑 -> 插值到 CURVE_SAMPLES
  const binLow: number[] = [];
  const bw = W / feats.binCount;
  for (let b = 0; b < feats.binCount; b++) {
    const x0 = Math.floor(b * bw);
    const x1 = Math.floor((b + 1) * bw);
    let sum = 0;
    let n = 0;
    for (let x = x0; x < x1; x += 3) {
      for (let y = H * 0.25; y < H * 0.75; y += 4) {
        sum += low.data[(y | 0) * W + (x % W)];
        n++;
      }
    }
    binLow.push(sum / Math.max(1, n));
  }
  // 主曲线由校准后的 36 段平滑插值，保证曲线/段色/建议一致
  const curve = curveFromSegments(rough36, CURVE_SAMPLES);
  const curveReflect = resampleCircular(
    feats.bins.map((b) => clamp01(0.5 - (b.sheen - CAL.sheenCenter) / (2 * CAL.sheenHalf))),
    CURVE_SAMPLES,
  );
  const curveScratch = resampleCircular(
    feats.bins.map((b) => clamp01((b.ratio - 0.335) / (0.437 - 0.335))),
    CURVE_SAMPLES,
  );

  // 环坐标几何
  const rAt = (mosaicY: number) => st.ringRCenter - (mosaicY - 250) * st.ringRadialScale;
  const result: AnalysisResult = {
    stripRaw,
    strip,
    width: strip.width,
    height: strip.height,
    curve,
    curveReflect,
    curveScratch,
    segments,
    chips,
    focusBefore: eq.colFocusBefore,
    focusAfter: eq.colFocusAfter,
    brightnessUniformityBefore: eq.brightnessUniformityBefore,
    brightnessUniformityAfter: eq.brightnessUniformityAfter,
    focusUniformityBefore: eq.focusUniformityBefore,
    focusUniformityAfter: eq.focusUniformityAfter,
    elapsedMs: now() - t0,
    ringDetected: {
      cx: st.ringCx,
      cy: st.ringCy,
      rInner: rAt(rows.bottom),
      rOuter: rAt(rows.top),
    },
  };
  return result;
}

function resampleCircular(src: number[], outN: number): number[] {
  const n = src.length;
  const out = new Array<number>(outN);
  for (let i = 0; i < outN; i++) {
    const f = (i / outN) * n;
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const t = f - Math.floor(f);
    out[i] = src[i0] * (1 - t) + src[i1] * t;
  }
  return out;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
