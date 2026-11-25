import { BAND_BOTTOM, BAND_TOP, SEGMENT_COUNT } from '../config.ts'
import { clamp } from '../lib/rng.ts'
import type { ChipMark, RawImage, SegmentMetric } from '../types.ts'

interface FeatureSet {
  scratchDensity: number
  scratchEnergy: number
  anisotropy: number
  rowEnergy: number
  gloss: number
  meanLuma: number
  highlight: number
}

class IntegralGray {
  width: number
  height: number
  sum: Float64Array
  square: Float64Array

  constructor(gray: Float32Array, width: number, height: number) {
    this.width = width
    this.height = height
    this.sum = new Float64Array((width + 1) * (height + 1))
    this.square = new Float64Array((width + 1) * (height + 1))
    const stride = width + 1
    for (let y = 1; y <= height; y++) {
      let rowSum = 0
      let rowSquare = 0
      for (let x = 1; x <= width; x++) {
        const v = gray[(y - 1) * width + (x - 1)]
        rowSum += v
        rowSquare += v * v
        const ii = y * stride + x
        this.sum[ii] = this.sum[(y - 1) * stride + x] + rowSum
        this.square[ii] = this.square[(y - 1) * stride + x] + rowSquare
      }
    }
  }

  meanStd(x0: number, y0: number, x1: number, y1: number): { mean: number; std: number } {
    const xA = Math.max(0, Math.floor(x0))
    const yA = Math.max(0, Math.floor(y0))
    const xB = Math.min(this.width, Math.ceil(x1))
    const yB = Math.min(this.height, Math.ceil(y1))
    const stride = this.width + 1
    const a = yA * stride + xA
    const b = yA * stride + xB
    const c = yB * stride + xA
    const d = yB * stride + xB
    const n = Math.max(1, (xB - xA) * (yB - yA))
    const s = this.sum[d] - this.sum[b] - this.sum[c] + this.sum[a]
    const sq = this.square[d] - this.square[b] - this.square[c] + this.square[a]
    const mean = s / n
    const variance = Math.max(0, sq / n - mean * mean)
    return { mean, std: Math.sqrt(variance) }
  }
}

function roughnessFromFeatures(f: FeatureSet): number {
  // Calibrated on synthetic granite rings with known Ra labels. Inputs are
  // dark coherent groove density, mean groove gradient energy, and smooth
  // specular coverage (0..1).
  const value =
    0.7834 +
    3.962 * f.scratchDensity +
    0.2902 * f.scratchEnergy +
    0.2068 * f.anisotropy -
    0.0097 * f.rowEnergy +
    0.1094 * f.gloss -
    3.3659 * f.meanLuma +
    2.0908 * f.highlight
  return clamp(value)
}

function rowEnergyForRect(gray: Float32Array, width: number, x0: number, x1: number, y0: number, y1: number): number {
  let sumSq = 0
  let count = 0
  let previous: number | null = null
  for (let y = y0; y < y1; y++) {
    let rowSum = 0
    for (let x = x0; x < x1; x++) rowSum += gray[y * width + x]
    const mean = rowSum / Math.max(1, x1 - x0)
    if (previous !== null) {
      const d = mean - previous
      sumSq += d * d
      count++
    }
    previous = mean
  }
  return Math.sqrt(sumSq / Math.max(1, count))
}

function featuresForRect(
  image: RawImage,
  gray: Float32Array,
  integral: IntegralGray,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): FeatureSet {
  const w = image.width
  const X0 = Math.max(2, Math.round(x0))
  const X1 = Math.min(w - 3, Math.round(x1))
  const Y0 = Math.max(2, Math.round(y0))
  const Y1 = Math.min(image.height - 3, Math.round(y1))
  const rw = Math.max(1, X1 - X0)
  const rh = Math.max(1, Y1 - Y0)
  const candidate = new Uint8Array(rw * rh)
  let scratchCount = 0
  let energySum = 0
  let gxAbsSum = 0
  let gyAbsSum = 0

  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const gi = y * w + x
      const gx = gray[gi + 1] - gray[gi - 1]
      const gy = gray[gi + w] - gray[gi - w]
      const agx = Math.abs(gx)
      const agy = Math.abs(gy)
      gxAbsSum += agx
      gyAbsSum += agy
      const center = gray[gi]
      const darkGroove = center < gray[gi - 2 * w] - 4.5 && center < gray[gi + 2 * w] - 4.5
      // Circumferential scratches are dark, horizontally coherent grooves:
      // vertical derivative dominates. Isotropic granite spots and bright
      // specular streak edges fail either coherence or the dark-center test.
      if (darkGroove && agy > 9 && agy > 1.55 * agx + 2.5) {
        const li = (y - Y0) * rw + (x - X0)
        candidate[li] = 1
        scratchCount++
        energySum += clamp(agy / 82)
      }
    }
  }

  let coherentCount = 0
  let coherentEnergy = 0
  for (let y = Y0 + 1; y < Y1 - 1; y++) {
    for (let x = X0 + 8; x < X1 - 8; x++) {
      const li = (y - Y0) * rw + (x - X0)
      if (!candidate[li]) continue
      let hits = 0
      for (let k = -7; k <= 7; k++) hits += candidate[li + k] ?? 0
      if (hits >= 6) {
        coherentCount++
        const gi = y * w + x
        coherentEnergy += clamp(Math.abs(gray[gi + w] - gray[gi - w]) / 82)
      }
    }
  }

  const area = rw * rh
  const scratchDensity = coherentCount / area
  const scratchEnergy = coherentCount ? coherentEnergy / coherentCount : energySum / Math.max(1, scratchCount)

  let rowDiffSumSq = 0
  let rowDiffCount = 0
  let previousRowMean: number | null = null
  for (let y = Y0; y < Y1; y++) {
    let rowSum = 0
    for (let x = X0; x < X1; x++) rowSum += gray[y * w + x]
    const rowMean = rowSum / Math.max(1, X1 - X0)
    if (previousRowMean !== null) {
      const d = rowMean - previousRowMean
      rowDiffSumSq += d * d
      rowDiffCount++
    }
    previousRowMean = rowMean
  }
  const rowEnergy = Math.sqrt(rowDiffSumSq / Math.max(1, rowDiffCount))

  let glossPixels = 0
  let glossChecked = 0
  let lumaSum = 0
  const histogram = new Uint32Array(256)
  const data = image.data
  for (let y = Y0; y < Y1; y += 2) {
    for (let x = X0; x < X1; x += 2) {
      const i = (y * w + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const luma = gray[y * w + x]
      lumaSum += luma
      histogram[Math.min(255, Math.max(0, Math.round(luma)))]++
      const maxc = Math.max(r, g, b)
      const minc = Math.min(r, g, b)
      const { std } = integral.meanStd(x - 3, y - 3, x + 4, y + 4)
      glossChecked++
      // Smooth, low-saturation high lights are specular reflection. Bright
      // quartz/mica is compact and therefore rejected by the std test.
      if (luma > 176 && std < 27 && maxc - minc < 68) glossPixels++
    }
  }
  let percentileTarget = Math.max(1, Math.floor(glossChecked * 0.9))
  let percentile = 255
  for (let v = 0; v < 256; v++) {
    percentileTarget -= histogram[v]
    if (percentileTarget <= 0) {
      percentile = v
      break
    }
  }
  const gloss = clamp(glossPixels / Math.max(1, glossChecked))
  const meanLuma = clamp(lumaSum / Math.max(1, glossChecked) / 255)
  const highlight = percentile / 255
  const anisotropy = (gyAbsSum - gxAbsSum) / Math.max(1e-6, gyAbsSum + gxAbsSum)
  return { scratchDensity, scratchEnergy, anisotropy, rowEnergy, gloss, meanLuma, highlight }
}

interface EdgeRun {
  start: number
  end: number
  peak: number
  edge: 'upper' | 'lower'
}

function detectEdgeRuns(image: RawImage, gray: Float32Array): EdgeRun[] {
  const w = image.width
  const upper = new Float32Array(w)
  const lower = new Float32Array(w)
  const upperY0 = BAND_TOP - 9
  const upperY1 = BAND_TOP + 25
  const lowerY0 = BAND_BOTTOM - 25
  const lowerY1 = BAND_BOTTOM + 9

  for (let x = 0; x < w; x++) {
    let uc = 0
    let lc = 0
    for (let y = upperY0; y < upperY1; y++) {
      if (y >= 0 && y < image.height && gray[y * w + x] < 72) uc++
    }
    for (let y = lowerY0; y < lowerY1; y++) {
      if (y >= 0 && y < image.height && gray[y * w + x] < 72) lc++
    }
    upper[x] = uc
    lower[x] = lc
  }

  const smooth = (arr: Float32Array): Float32Array => {
    const out = new Float32Array(w)
    for (let x = 0; x < w; x++) {
      let sum = 0
      let n = 0
      for (let k = -3; k <= 3; k++) {
        const xx = (x + k + w) % w
        sum += arr[xx]
        n++
      }
      out[x] = sum / n
    }
    return out
  }
  const u = smooth(upper)
  const l = smooth(lower)

  const findRuns = (arr: Float32Array, edge: 'upper' | 'lower'): EdgeRun[] => {
    const threshold = 7.2
    const runs: EdgeRun[] = []
    let start = -1
    let peak = 0
    // Duplicate the first 40 columns to merge wrap-around chips.
    for (let x = 0; x <= w + 40; x++) {
      const xx = x % w
      const v = arr[xx]
      if (v > threshold) {
        if (start < 0) start = x
        peak = Math.max(peak, v)
      } else if (start >= 0) {
        if (x - start >= 15 && x - start <= 150) {
          runs.push({ start: start % w, end: (x - 1) % w, peak, edge })
        }
        start = -1
        peak = 0
      }
    }
    return runs
  }

  return [...findRuns(u, 'upper'), ...findRuns(l, 'lower')]
}

function runCenter(run: EdgeRun, width: number): number {
  let { start, end } = run
  if (end < start) end += width
  if (end - start > width / 2) {
    // Wrapped run representation fallback.
    return ((end + start) / 2) % width
  }
  return ((start + end) / 2) % width
}

export function analyzeRoughness(image: RawImage): {
  segments: SegmentMetric[]
  chips: ChipMark[]
  curve: number[]
} {
  const w = image.width
  const h = image.height
  const gray = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const p = i * 4
    gray[i] = 0.2126 * image.data[p] + 0.7152 * image.data[p + 1] + 0.0722 * image.data[p + 2]
  }
  const integral = new IntegralGray(gray, w, h)
  const runs = detectEdgeRuns(image, gray)
  const segW = w / SEGMENT_COUNT

  const rawChips: ChipMark[] = runs.map((run, i) => {
    const cx = runCenter(run, w)
    const segment = Math.min(SEGMENT_COUNT - 1, Math.floor(cx / segW))
    const segStart = segment * segW
    const depthPx = clamp(run.peak - 4.5, 5, 25)
    const widthPx = run.end >= run.start ? run.end - run.start + 1 : w - run.start + run.end + 1
    return {
      id: `chip-${i}-${run.edge}`,
      segment,
      x01: clamp((cx - segStart) / segW),
      x: cx,
      edge: run.edge,
      severity: clamp(depthPx / 22),
      widthPx,
      depthPx,
      confidence: clamp(0.55 + widthPx / 120 + depthPx / 80, 0, 0.98),
    }
  })

  // Merge upper/lower detections at the same physical chip.
  const chips: ChipMark[] = []
  for (const chip of rawChips.sort((a, b) => a.x - b.x)) {
    const near = chips.find((c) => {
      const dx = Math.min(Math.abs(c.x - chip.x), w - Math.abs(c.x - chip.x))
      return dx < 58 && c.segment === chip.segment && c.edge !== chip.edge && c.edge !== 'both'
    })
    if (near) {
      near.edge = 'both'
      near.severity = Math.max(near.severity, chip.severity)
      near.depthPx = Math.max(near.depthPx, chip.depthPx)
      near.widthPx = Math.max(near.widthPx, chip.widthPx)
      near.confidence = Math.max(near.confidence, chip.confidence)
      near.id = `chip-both-${near.segment}`
    } else {
      chips.push(chip)
    }
  }

  const segments: SegmentMetric[] = []
  const rawCurve: number[] = []
  for (let s = 0; s < SEGMENT_COUNT; s++) {
    const x0 = s * segW
    const x1 = (s + 1) * segW
    const qW = (x1 - x0) / 4
    const y0 = BAND_TOP + 4
    const y1 = BAND_BOTTOM - 4
    const subFeatures: FeatureSet[] = []
    const subRoughness: [number, number, number, number] = [0, 0, 0, 0]
    for (let q = 0; q < 4; q++) {
      const f = featuresForRect(image, gray, integral, x0 + q * qW + 2, y0, x0 + (q + 1) * qW - 2, y1)
      subFeatures.push(f)
      subRoughness[q] = roughnessFromFeatures(f)
    }
    const aggregate: FeatureSet = {
      scratchDensity: subFeatures.reduce((a, f) => a + f.scratchDensity, 0) / 4,
      scratchEnergy: subFeatures.reduce((a, f) => a + f.scratchEnergy, 0) / 4,
      anisotropy: subFeatures.reduce((a, f) => a + f.anisotropy, 0) / 4,
      rowEnergy: subFeatures.reduce((a, f) => a + f.rowEnergy, 0) / 4,
      gloss: subFeatures.reduce((a, f) => a + f.gloss, 0) / 4,
      meanLuma: subFeatures.reduce((a, f) => a + f.meanLuma, 0) / 4,
      highlight: subFeatures.reduce((a, f) => a + f.highlight, 0) / 4,
    }
    aggregate.rowEnergy = rowEnergyForRect(
      gray,
      w,
      Math.max(2, Math.round(x0) + 2),
      Math.min(w - 3, Math.round(x1) - 2),
      BAND_TOP + 4,
      BAND_BOTTOM - 4,
    )
    const roughness = clamp(subRoughness.reduce((a, b) => a + b, 0) / 4)
    const unevenness = clamp((Math.max(...subRoughness) - Math.min(...subRoughness)) / 0.38)
    const chip = chips.find((c) => c.segment === s) ?? null
    const seamConfidence = 0.9
    segments.push({
      index: s,
      roughness,
      scratchDensity: aggregate.scratchDensity,
      scratchEnergy: aggregate.scratchEnergy,
      anisotropy: aggregate.anisotropy,
      rowEnergy: aggregate.rowEnergy,
      gloss: aggregate.gloss,
      meanLuma: aggregate.meanLuma,
      highlight: aggregate.highlight,
      unevenness,
      subRoughness,
      chip,
      confidence: clamp(0.72 + seamConfidence * 0.25 - (chip ? 0.04 : 0), 0, 0.98),
    })
    rawCurve.push(roughness)
  }

  // Wear zones are spatially continuous; a small circular filter suppresses
  // single-frame focus/exposure outliers without erasing segment-scale zones.
  const curve: number[] = []
  for (let s = 0; s < SEGMENT_COUNT; s++) {
    const prev = rawCurve[(s - 1 + SEGMENT_COUNT) % SEGMENT_COUNT]
    const next = rawCurve[(s + 1) % SEGMENT_COUNT]
    const smoothed = 0.22 * prev + 0.56 * rawCurve[s] + 0.22 * next
    segments[s].roughness = clamp(smoothed)
    curve.push(clamp(smoothed))
  }

  return { segments, chips, curve }
}
