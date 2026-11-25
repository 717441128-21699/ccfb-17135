import type { AnalysisResult, Direction, RawImage, WorkerResponse } from '../types.ts'

interface PendingRequest {
  resolve: (result: AnalysisResult) => void
  reject: (error: Error) => void
  onProgress?: (stage: string, percent: number) => void
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, PendingRequest>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./inspection.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data
    const request = pending.get(message.id)
    if (!request) return
    if (message.type === 'progress') {
      request.onProgress?.(message.stage, message.percent)
      return
    }
    pending.delete(message.id)
    if (message.type === 'result') request.resolve(message.result)
    else request.reject(new Error(message.message))
  }
  worker.onerror = (event) => {
    for (const [id, request] of pending) {
      request.reject(new Error(event.message || 'Worker 运行失败'))
      pending.delete(id)
    }
  }
  return worker
}

export function analyzeFramesInWorker(
  frames: RawImage[],
  direction: Direction,
  onProgress?: (stage: string, percent: number) => void,
): Promise<AnalysisResult> {
  const id = nextId++
  const w = getWorker()
  return new Promise<AnalysisResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress })
    const request = { id, type: 'analyze-frames' as const, direction, frames }
    // Structured clone keeps the demo's source frames available for reruns.
    w.postMessage(request)
  })
}

export function terminateInspectionWorker(): void {
  worker?.terminate()
  worker = null
  pending.clear()
}
