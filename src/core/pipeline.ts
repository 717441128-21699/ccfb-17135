import { analyzeRoughness } from './analysis.ts'
import { prescribeMetric } from './expert.ts'
import { stitchFrames } from './stitch.ts'
import type { AnalysisResult, Direction, RawImage, WorkerResponse } from '../types.ts'

export function runPipeline(
  frames: RawImage[],
  direction: Direction,
  onProgress?: (response: Omit<Extract<WorkerResponse, { type: 'progress' }>, 'id'>) => void,
): AnalysisResult {
  const started = (globalThis.performance?.now?.() ?? Date.now()) as number
  const stitch = stitchFrames(frames, direction, {
    onProgress: (stage, percent) => onProgress?.({ type: 'progress', stage, percent: Math.round(percent * 0.72) }),
  })
  onProgress?.({ type: 'progress', stage: '粗糙度分析', percent: 78 })
  const { segments, chips, curve } = analyzeRoughness(stitch.image)
  onProgress?.({ type: 'progress', stage: '生成打磨建议', percent: 92 })
  const prescriptions = segments.map(prescribeMetric)
  const totalElapsedMs = (globalThis.performance?.now?.() ?? Date.now()) - started
  onProgress?.({ type: 'progress', stage: '完成', percent: 100 })
  return {
    direction,
    stitch,
    segments,
    prescriptions,
    chips,
    curve,
    elapsedMs: totalElapsedMs - stitch.elapsedMs,
    totalElapsedMs,
  }
}
