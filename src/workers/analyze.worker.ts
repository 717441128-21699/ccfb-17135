/// <reference lib="webworker" />
import { analyzeStitch } from '../core/analyze';
import type { AnalysisResult, StitchResult, StoneTruth } from '../core/types';

export interface AnalyzeRequest {
  type: 'analyze';
  stitch: StitchResult;
  truth?: StoneTruth;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<AnalyzeRequest>) => {
  const req = ev.data;
  if (req.type !== 'analyze') return;
  try {
    const result: AnalysisResult = analyzeStitch(req.stitch, req.truth);
    const transfers = [result.strip.data.buffer, result.stripRaw.data.buffer] as ArrayBuffer[];
    ctx.postMessage({ type: 'analyzed', result }, transfers);
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error).message ?? String(err), stack: (err as Error).stack });
  }
};
