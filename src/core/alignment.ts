import { SEGMENT_COUNT } from '../config.ts'
import type { DirectionAlignment } from '../types.ts'

/** Circular Pearson correlation; used to register CW and CCW roughness curves. */
export function circularCorrelation(a: number[], b: number[], shift: number): number {
  const n = Math.min(a.length, b.length)
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[(i + shift + n) % n]
  }
  ma /= n
  mb /= n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma
    const y = b[(i + shift + n) % n] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  if (da < 1e-10 || db < 1e-10) return 0
  return num / Math.sqrt(da * db)
}

export function alignCurves(
  clockwise: number[],
  normalizedReverse: number[],
  segmentCount = SEGMENT_COUNT,
): DirectionAlignment {
  // The stitcher reverses capture order for a CCW shot set, so its output is
  // already normalized to clockwise strip orientation. Only the starting mark
  // offset remains unknown.
  const candidate = normalizedReverse
  let bestShift = 0
  let bestCorr = -Infinity
  for (let shift = 0; shift < segmentCount; shift++) {
    const corr = circularCorrelation(clockwise, candidate, shift)
    if (corr > bestCorr) {
      bestCorr = corr
      bestShift = shift
    }
  }

  let sum = 0
  let max = 0
  for (let i = 0; i < segmentCount; i++) {
    const j = (i + bestShift + segmentCount) % segmentCount
    const d = Math.abs(clockwise[i] - candidate[j])
    sum += d
    max = Math.max(max, d)
  }
  return {
    circularShift: bestShift,
    correlation: bestCorr,
    meanAbsDifference: sum / segmentCount,
    maxAbsDifference: max,
    reversed: false,
  }
}

export function registeredReverseCurve(
  clockwise: number[],
  normalizedReverse: number[],
  alignment: DirectionAlignment,
): number[] {
  const out = new Array<number>(clockwise.length).fill(0)
  for (let i = 0; i < clockwise.length; i++) {
    const j = (i + alignment.circularShift + clockwise.length) % clockwise.length
    out[i] = normalizedReverse[j]
  }
  return out
}
