import type { GroundTruth, Prescription, SegmentMetric, TruthAgreement } from '../types.ts'
import { adjacentPrescription, samePrescription } from './expert.ts'

export function scoreTruth(
  truth: GroundTruth,
  metrics: SegmentMetric[],
  prescriptions: Prescription[],
  detectedChips: Array<{ segment: number; x01: number }>,
): TruthAgreement {
  let ae = 0
  let exact = 0
  let adjacent = 0
  for (let i = 0; i < truth.segments.length; i++) {
    ae += Math.abs(truth.segments[i].roughness - metrics[i].roughness)
    if (samePrescription(truth.segments[i].veteran, prescriptions[i])) exact++
    if (adjacentPrescription(truth.segments[i].veteran, prescriptions[i])) adjacent++
  }

  let tp = 0
  for (const tc of truth.chips) {
    const hit = detectedChips.some(
      (dc) => dc.segment === tc.segment && Math.abs(dc.x01 - tc.x01) < 0.28,
    )
    if (hit) tp++
  }
  const fp = Math.max(0, detectedChips.length - tp)
  const fn = Math.max(0, truth.chips.length - tp)
  const precision = detectedChips.length ? tp / (tp + fp) : 1
  const recall = truth.chips.length ? tp / (tp + fn) : 1

  return {
    segmentCount: truth.segments.length,
    roughnessMae: ae / truth.segments.length,
    exactPrescription: exact / truth.segments.length,
    adjacentPrescription: adjacent / truth.segments.length,
    chipRecall: recall,
    chipPrecision: precision,
  }
}

export function formatAgreement(a: TruthAgreement): string {
  return [
    `粗糙度 MAE ${a.roughnessMae.toFixed(3)}`,
    `建议一致 ${(a.exactPrescription * 100).toFixed(1)}%`,
    `近似一致 ${(a.adjacentPrescription * 100).toFixed(1)}%`,
    `崩口召回 ${(a.chipRecall * 100).toFixed(0)}%`,
  ].join(' · ')
}
