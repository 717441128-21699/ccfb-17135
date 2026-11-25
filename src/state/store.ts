import { analyzeCurves } from '../core/index.ts'
import { captureBothDirections, type CaptureSet } from '../synth/generate.ts'
import { analyzeFramesInWorker } from '../workers/client.ts'
import type { AnalysisResult, Direction, InspectionReport, RawImage } from '../types.ts'
import { createBaselineReport, loadStoredReports, resultToReport, saveReport } from './reports.ts'

export type PageId = 'guide' | 'stitch' | 'unwrap' | 'compare'

export interface ProgressState {
  running: boolean
  stage: string
  percent: number
  error: string | null
}

export interface AppState {
  page: PageId
  seed: number
  stoneId: string
  captures: ReturnType<typeof captureBothDirections> | null
  cwResult: AnalysisResult | null
  ccwResult: AnalysisResult | null
  activeDirection: Direction
  selectedSegment: number
  progress: ProgressState
  history: InspectionReport[]
  baseline: InspectionReport
  currentReport: InspectionReport | null
  compareReportId: string
  showHeatmap: boolean
  showTruthOverlay: boolean
}

type Listener = (state: AppState) => void

const baseline = createBaselineReport()

const PAGE_IDS: PageId[] = ['guide', 'stitch', 'unwrap', 'compare']

function pageFromHash(): PageId {
  const hash = window.location.hash.replace(/^#\/?/, '') as PageId
  return PAGE_IDS.includes(hash) ? hash : 'guide'
}

export const state: AppState = {
  page: pageFromHash(),
  seed: 20261126,
  stoneId: 'HC-07',
  captures: null,
  cwResult: null,
  ccwResult: null,
  activeDirection: 'cw',
  selectedSegment: 0,
  progress: { running: false, stage: '待开始', percent: 0, error: null },
  history: loadStoredReports(),
  baseline,
  currentReport: null,
  compareReportId: baseline.id,
  showHeatmap: true,
  showTruthOverlay: false,
}

const listeners = new Set<Listener>()

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emit(): void {
  for (const listener of listeners) listener(state)
}

export function navigate(page: PageId): void {
  state.page = page
  const hash = `#/${page}`
  if (window.location.hash !== hash) window.location.hash = hash
  emit()
}

export function syncPageFromHash(): void {
  state.page = pageFromHash()
  emit()
}

export function selectSegment(index: number): void {
  state.selectedSegment = Math.max(0, Math.min(35, index))
  emit()
}

export function setActiveDirection(direction: Direction): void {
  state.activeDirection = direction
  emit()
}

export function ensureCaptures(): NonNullable<AppState['captures']> {
  if (!state.captures) {
    state.captures = captureBothDirections(state.seed, true)
  }
  return state.captures
}

export function generateCaptures(): void {
  state.captures = captureBothDirections(state.seed, true)
  state.cwResult = null
  state.ccwResult = null
  state.currentReport = null
  emit()
}

function setProgress(patch: Partial<ProgressState>): void {
  state.progress = { ...state.progress, ...patch }
  emit()
}

export async function runAnalysis(which: Direction | 'both' = 'both'): Promise<void> {
  if (state.progress.running) return
  setProgress({ running: true, error: null, stage: '合成/读取照片', percent: 2 })
  try {
    // Let the progress UI paint before deterministic synthesis blocks briefly.
    await new Promise((resolve) => setTimeout(resolve, 30))
    const captures = ensureCaptures()

    if (which === 'cw' || which === 'both') {
      const result = await analyzeFramesInWorker(
        captures.cw.frames.map((f) => f.image),
        'cw',
        (stage, percent) => setProgress({ stage: `顺转 · ${stage}`, percent: Math.round(2 + percent * 0.46) }),
      )
      state.cwResult = result
      emit()
    }

    if (which === 'ccw' || which === 'both') {
      const result = await analyzeFramesInWorker(
        captures.ccw.frames.map((f) => f.image),
        'ccw',
        (stage, percent) => setProgress({ stage: `倒转 · ${stage}`, percent: Math.round(50 + percent * 0.46) }),
      )
      state.ccwResult = result
      emit()
    }

    if (state.cwResult && state.ccwResult) {
      const alignment = analyzeCurves(state.cwResult.curve, state.ccwResult.curve)
      state.cwResult.alignment = alignment
      state.ccwResult.alignment = alignment
    }
    if (state.cwResult) {
      state.currentReport = resultToReport(state.cwResult, state.stoneId, state.seed)
    }
    setProgress({ running: false, stage: '完成', percent: 100 })
    state.page = which === 'ccw' ? 'stitch' : state.page === 'guide' ? 'stitch' : state.page
    emit()
  } catch (error) {
    setProgress({
      running: false,
      stage: '失败',
      percent: 0,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function runUploadedFrames(frames: RawImage[]): Promise<void> {
  if (state.progress.running) return
  setProgress({ running: true, error: null, stage: '导入实拍照片', percent: 8 })
  try {
    const result = await analyzeFramesInWorker(frames, 'cw', (stage, percent) =>
      setProgress({ stage: `实拍 · ${stage}`, percent }),
    )
    state.cwResult = result
    state.activeDirection = 'cw'
    state.currentReport = resultToReport(result, state.stoneId)
    state.page = 'stitch'
    setProgress({ running: false, stage: '完成', percent: 100 })
    emit()
  } catch (error) {
    setProgress({
      running: false,
      stage: '失败',
      percent: 0,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function saveCurrentReport(): void {
  if (!state.currentReport) return
  state.history = saveReport(state.currentReport)
  state.compareReportId = state.currentReport.id
  emit()
}

export function getComparisonReport(): InspectionReport {
  if (state.compareReportId === state.baseline.id) return state.baseline
  return state.history.find((r) => r.id === state.compareReportId) ?? state.baseline
}

export function setComparisonReport(id: string): void {
  state.compareReportId = id
  emit()
}

export function toggleHeatmap(): void {
  state.showHeatmap = !state.showHeatmap
  emit()
}

export function toggleTruthOverlay(): void {
  state.showTruthOverlay = !state.showTruthOverlay
  emit()
}
