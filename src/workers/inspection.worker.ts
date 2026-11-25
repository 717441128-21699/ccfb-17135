import { analyzeRoughness } from '../core/analysis.ts'
import { prescribeMetric } from '../core/expert.ts'
import { runPipeline } from '../core/pipeline.ts'
import type { AnalysisResult, WorkerRequest, WorkerResponse } from '../types.ts'

interface MinimalWorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}

const ctx = self as unknown as MinimalWorkerScope

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(message, transfer)
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data
  try {
    if (req.type === 'analyze-frames') {
      const result = runPipeline(req.frames, req.direction, (progress) => {
        post({ id: req.id, ...progress })
      })
      post({ id: req.id, type: 'result', result }, [result.stitch.image.data.buffer])
      return
    }

    const started = performance.now()
    const { segments, chips, curve } = analyzeRoughness(req.strip)
    const prescriptions = segments.map(prescribeMetric)
    const result: AnalysisResult = {
      direction: req.direction,
      stitch: {
        image: req.strip,
        width: req.strip.width,
        height: req.strip.height,
        circumferencePx: req.strip.width,
        offsets: [],
        seams: [],
        closureDx: 0,
        closureScore: 1,
        focusScores: [],
        exposureGains: [],
        elapsedMs: 0,
        direction: req.direction,
        frameCount: req.frameCount ?? 0,
      },
      segments,
      prescriptions,
      chips,
      curve,
      elapsedMs: performance.now() - started,
      totalElapsedMs: performance.now() - started,
    }
    post({ id: req.id, type: 'result', result }, [result.stitch.image.data.buffer])
  } catch (error) {
    post({
      id: req.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
