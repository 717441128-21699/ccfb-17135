// 由 scripts/validate.ts 自动生成（最近一次合成基准运行）
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

export const BENCHMARK: BenchmarkSummary = {
  "seeds": 8,
  "totalSegmentDecisions": 576,
  "agreementPct": 0.8351,
  "forwardAgreementPct": 0.8438,
  "reverseAgreementPct": 0.8264,
  "directionCurveCorr": 0.9544,
  "directionMeanAbsDiff": 0.0627,
  "chipHitPct": 0.5577,
  "avgPipelineMs": 11686,
  "maxPipelineMs": 12682,
  "budgetMs": 120000,
  "passed": true
};
