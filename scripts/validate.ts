import { writeFileSync, mkdirSync } from 'node:fs';
import { makeTruth, renderWorld, shootSet } from '../src/core/synth';
import { stitchRing } from '../src/core/stitch';
import { analyzeStitch } from '../src/core/analyze';
import { chipMatchScore } from '../src/core/chips';
import { adviceForRoughness, TIME_BUDGET_MS } from '../src/core/config';
import { pearson } from '../src/core/compare';
import type { CaptureDirection } from '../src/core/types';

const SEED_COUNT = Number(process.env.SEEDS ?? 8);
const seeds = Array.from({ length: SEED_COUNT }, (_, i) => i + 1);

interface RunMetric {
  seed: number;
  dir: CaptureDirection;
  agreementMaster: number;
  agreementWear: number;
  chipHit: number;
  chipTruth: number;
  chipDetected: number;
  totalMs: number;
  computeMs: number;
  curve: number[];
}

const runs: RunMetric[] = [];
const tStart = Date.now();

for (const seed of seeds) {
  const truth = makeTruth(seed);
  const world = renderWorld(truth);
  for (const dir of [1, -1] as CaptureDirection[]) {
    const t0 = Date.now();
    const photos = shootSet(world, { runSeed: dir === 1 ? 1000 + seed : 2000 + seed, direction: dir });
    const tShoot = Date.now();
    const st = stitchRing(photos);
    const a = analyzeStitch(st, truth);
    const totalMs = Date.now() - t0;
    const computeMs = Date.now() - tShoot;

    let masterMatch = 0;
    let wearMatch = 0;
    a.segments.forEach((s, i) => {
      const masterBin = adviceForRoughness(truth.roughness[i]).bin;
      if (s.bin === masterBin) masterMatch++;
      if (s.bin === truth.wearLevel[i]) wearMatch++;
    });
    const chip = chipMatchScore(a.chips, truth.chips);
    runs.push({
      seed, dir,
      agreementMaster: masterMatch / 36,
      agreementWear: wearMatch / 36,
      chipHit: chip.hit, chipTruth: chip.total, chipDetected: chip.detected,
      totalMs, computeMs,
      curve: a.segments.map((s) => s.roughness),
    });
    console.log(
      `seed ${seed} dir ${dir === 1 ? '顺' : '逆'}: 老师傅一致 ${Math.round((masterMatch / 36) * 100)}% ` +
      `等级一致 ${Math.round((wearMatch / 36) * 100)}% 崩口 ${chip.hit}/${chip.total} 耗时 ${(totalMs / 1000).toFixed(1)}s`,
    );
  }
}

const fwd = runs.filter((r) => r.dir === 1);
const rev = runs.filter((r) => r.dir === -1);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const agreementPct = mean(runs.map((r) => r.agreementMaster));
const forwardAgreementPct = mean(fwd.map((r) => r.agreementMaster));
const reverseAgreementPct = mean(rev.map((r) => r.agreementMaster));
const wearPct = mean(runs.map((r) => r.agreementWear));

const dirCorrs: number[] = [];
const dirMad: number[] = [];
for (const seed of seeds) {
  const f = runs.find((r) => r.seed === seed && r.dir === 1);
  const r = runs.find((x) => x.seed === seed && x.dir === -1);
  if (f && r) {
    dirCorrs.push(pearson(f.curve, r.curve));
    dirMad.push(mean(f.curve.map((v, i) => Math.abs(v - r.curve[i]))));
  }
}
const directionCurveCorr = mean(dirCorrs);
const directionMeanAbsDiff = mean(dirMad);

const chipTruthTotal = runs.reduce((a, r) => a + r.chipTruth, 0);
const chipHitTotal = runs.reduce((a, r) => a + r.chipHit, 0);
const chipHitPct = chipTruthTotal ? chipHitTotal / chipTruthTotal : 1;

const avgPipelineMs = mean(runs.map((r) => r.totalMs));
const maxPipelineMs = Math.max(...runs.map((r) => r.totalMs));

const summary = {
  seeds: SEED_COUNT,
  totalSegmentDecisions: runs.length * 36,
  agreementPct,
  forwardAgreementPct,
  reverseAgreementPct,
  wearLevelAgreementPct: wearPct,
  directionCurveCorr,
  directionMeanAbsDiff,
  chipHitPct,
  chipHits: chipHitTotal,
  chipTruth: chipTruthTotal,
  avgPipelineMs,
  maxPipelineMs,
  budgetMs: TIME_BUDGET_MS,
  wallSeconds: (Date.now() - tStart) / 1000,
  passed: agreementPct >= 0.8 && directionCurveCorr >= 0.9 && avgPipelineMs < TIME_BUDGET_MS,
};

console.log('\n================ 验收汇总 ================');
console.log(JSON.stringify(summary, null, 2));

mkdirSync('diag', { recursive: true });
writeFileSync('diag/validation.json', JSON.stringify(summary, null, 2));

// 回填前端展示的基准常数（覆写 src/generated/benchmark.ts）
const benchmarkTs = `// 由 scripts/validate.ts 自动生成（最近一次合成基准运行）
export interface BenchmarkSummary {
  seeds: number;
  totalSegmentDecisions: number;
  agreementPct: number;
  forwardAgreementPct: number;
  reverseAgreementPct: number;
  directionCurveCorr: number;
  directionMeanAbsDiff: number;
  chipHitPct: number;
  avgPipelineMs: number;
  maxPipelineMs: number;
  budgetMs: number;
  passed: boolean;
}

export const BENCHMARK: BenchmarkSummary = ${JSON.stringify({
  seeds: summary.seeds,
  totalSegmentDecisions: summary.totalSegmentDecisions,
  agreementPct: Number(summary.agreementPct.toFixed(4)),
  forwardAgreementPct: Number(summary.forwardAgreementPct.toFixed(4)),
  reverseAgreementPct: Number(summary.reverseAgreementPct.toFixed(4)),
  directionCurveCorr: Number(summary.directionCurveCorr.toFixed(4)),
  directionMeanAbsDiff: Number(summary.directionMeanAbsDiff.toFixed(4)),
  chipHitPct: Number(summary.chipHitPct.toFixed(4)),
  avgPipelineMs: Math.round(summary.avgPipelineMs),
  maxPipelineMs: Math.round(summary.maxPipelineMs),
  budgetMs: summary.budgetMs,
  passed: summary.passed,
}, null, 2)};
`;
mkdirSync('src/generated', { recursive: true });
writeFileSync('src/generated/benchmark.ts', benchmarkTs);
console.log('已写入 src/generated/benchmark.ts');

if (!summary.passed) {
  console.error('验收未通过：', {
    agreementPct: agreementPct.toFixed(3),
    directionCurveCorr: directionCurveCorr.toFixed(3),
    avgPipelineMs: Math.round(avgPipelineMs),
  });
  process.exitCode = 1;
}
