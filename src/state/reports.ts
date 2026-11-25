import { SEGMENT_COUNT, STORAGE_KEY } from '../config.ts'
import { prescribeMetric } from '../core/expert.ts'
import { createGroundTruth } from '../synth/generate.ts'
import type { AnalysisResult, InspectionReport, SegmentMetric } from '../types.ts'

export function resultToReport(result: AnalysisResult, stoneId: string, seed?: number): InspectionReport {
  return {
    id: `report-${Date.now()}-${result.direction}`,
    stoneId,
    inspectedAt: new Date().toISOString(),
    direction: result.direction,
    seed,
    frameCount: result.stitch.frameCount,
    elapsedMs: result.totalElapsedMs,
    curve: [...result.curve],
    segments: result.segments.map((s) => ({ ...s, subRoughness: [...s.subRoughness] as [number, number, number, number] })),
    prescriptions: result.prescriptions.map((p) => ({ ...p })),
    chips: result.chips.map((c) => ({ ...c })),
    cwAlignment: result.alignment,
  }
}

export function createBaselineReport(): InspectionReport {
  const truth = createGroundTruth(20250818, false)
  const segments: SegmentMetric[] = truth.segments.map((s) => ({
    index: s.index,
    roughness: s.roughness,
    scratchDensity: 0,
    scratchEnergy: 0,
    anisotropy: 0,
    rowEnergy: 0,
    gloss: 0,
    meanLuma: 0.5,
    highlight: 0.8,
    unevenness: Math.max(...s.subRoughness) - Math.min(...s.subRoughness) > 0.2 ? 0.8 : 0.2,
    subRoughness: [...s.subRoughness],
    chip: null,
    confidence: 0.9,
  }))
  return {
    id: 'baseline-2026-spring',
    stoneId: 'HC-07',
    inspectedAt: '2026-08-18T10:30:00.000Z',
    direction: 'cw',
    seed: 20250818,
    frameCount: 40,
    elapsedMs: 96_000,
    curve: segments.map((s) => s.roughness),
    segments,
    prescriptions: segments.map(prescribeMetric),
    chips: [],
    note: '上赛季末检查归档',
  }
}

export function loadStoredReports(): InspectionReport[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as InspectionReport[]
    return Array.isArray(parsed) ? parsed.slice(-12) : []
  } catch {
    return []
  }
}

export function saveReport(report: InspectionReport): InspectionReport[] {
  const reports = loadStoredReports().filter((r) => r.id !== report.id)
  reports.push(report)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reports.slice(-12)))
  } catch {
    // Storage may be unavailable in private mode; in-memory comparison still works.
  }
  return reports.slice(-12)
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function emptyCurve(value = 0.5): number[] {
  return Array.from({ length: SEGMENT_COUNT }, () => value)
}
