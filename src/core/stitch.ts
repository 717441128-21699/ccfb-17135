import { FRAME_HEIGHT, FRAME_WIDTH } from '../config.ts'
import type { Direction, RawImage, SeamInfo, StitchResult } from '../types.ts'
import { boxBlur, createImage, downsampleGray, grayScale, unsharpMask } from '../lib/raster.ts'
import { clamp } from '../lib/rng.ts'

const now = (): number => {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance
  return perf?.now ? perf.now() : Date.now()
}

interface OffsetMatch {
  dx: number
  score: number
}

/** Normalized cross correlation over horizontal overlap after 4x downsampling. */
export function estimateHorizontalOffset(a: RawImage, b: RawImage): OffsetMatch {
  const factor = 4
  const ga = downsampleGray(a, factor)
  const gb = downsampleGray(b, factor)
  const w = ga.width
  const h = Math.min(ga.height, gb.height)
  const A = ga.gray
  const B = gb.gray

  // Captures are guided to roughly 60-80% overlap. Search 40%-87% overlap.
  const minShift = Math.max(4, Math.round(w * 0.13))
  const maxShift = Math.min(w - 8, Math.round(w * 0.62))
  let bestD = Math.round(w * 0.31)
  let bestScore = -Infinity
  const scores = new Map<number, number>()

  for (let d = minShift; d <= maxShift; d++) {
    const overlapW = w - d
    if (overlapW < 12) continue
    const n = overlapW * h
    let sumA = 0
    let sumB = 0
    for (let y = 0; y < h; y++) {
      const rowA = y * w + d
      const rowB = y * w
      for (let x = 0; x < overlapW; x++) {
        sumA += A[rowA + x]
        sumB += B[rowB + x]
      }
    }
    const meanA = sumA / n
    const meanB = sumB / n
    let num = 0
    let varA = 0
    let varB = 0
    for (let y = 0; y < h; y++) {
      const rowA = y * w + d
      const rowB = y * w
      for (let x = 0; x < overlapW; x++) {
        const va = A[rowA + x] - meanA
        const vb = B[rowB + x] - meanB
        num += va * vb
        varA += va * va
        varB += vb * vb
      }
    }
    const score = varA < 1 || varB < 1 ? 0 : num / Math.sqrt(varA * varB)
    scores.set(d, score)
    if (score > bestScore) {
      bestScore = score
      bestD = d
    }
  }

  // Parabolic sub-frame interpolation.
  const s0 = scores.get(bestD - 1) ?? bestScore
  const s1 = bestScore
  const s2 = scores.get(bestD + 1) ?? bestScore
  const denom = s0 - 2 * s1 + s2
  const delta = denom !== 0 ? Math.max(-1, Math.min(1, (0.5 * (s0 - s2)) / denom)) : 0
  return { dx: (bestD + delta) * factor, score: bestScore }
}

export function focusScore(img: RawImage): number {
  const g = grayScale(img)
  const w = img.width
  const h = img.height
  let mean = 0
  let m2 = 0
  let count = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]
      mean += lap
      m2 += lap * lap
      count++
    }
  }
  mean /= Math.max(1, count)
  return Math.max(0, m2 / Math.max(1, count) - mean * mean)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 1
}

function smoothFeather(edgePx: number): number {
  const t = Math.max(0, Math.min(1, edgePx / 34))
  return t * t * (3 - 2 * t)
}

export interface StitchOptions {
  onProgress?: (stage: string, percent: number) => void
}

export function stitchFrames(
  inputFrames: RawImage[],
  direction: Direction,
  options: StitchOptions = {},
): StitchResult {
  const started = now()
  const report = options.onProgress ?? (() => {})
  if (inputFrames.length < 2) throw new Error('至少需要两张重叠照片才能拼接')

  // Reverse captures are reversed to clockwise order before registration.
  const frames = direction === 'ccw' ? [...inputFrames].reverse() : [...inputFrames]
  const n = frames.length
  report('重叠配准', 4)

  const focusScoresRaw = frames.map(focusScore)
  const focusMedian = median(focusScoresRaw)
  const corrected = frames.map((frame) => {
    const score = focusScore(frame)
    const ratio = focusMedian / Math.max(1, score)
    if (ratio > 1.35) {
      const amount = Math.min(1.05, (ratio - 1) * 0.85)
      return unsharpMask(frame, amount, 1)
    }
    if (ratio < 0.42) return boxBlur(frame, 1, 1)
    return frame
  })
  report('对焦归一化', 18)

  const seams: SeamInfo[] = []
  const offsets: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const match = estimateHorizontalOffset(corrected[i], corrected[i + 1])
    offsets.push(match.dx)
    seams.push({ from: i, to: i + 1, dx: match.dx, score: match.score })
    report('重叠配准', 18 + Math.round(((i + 1) / n) * 42))
  }

  const closure = estimateHorizontalOffset(corrected[n - 1], corrected[0])
  const closureDx = closure.dx
  const circumferencePx = offsets.reduce((a, b) => a + b, 0) + closureDx
  if (!Number.isFinite(circumferencePx) || circumferencePx < FRAME_WIDTH * 0.8) {
    throw new Error('环形闭合失败：没有找到足够的重叠特征')
  }
  report('闭合差分配', 64)

  const positions: number[] = [0]
  for (const dx of offsets) positions.push(positions[positions.length - 1] + dx)

  // Exposure gains measured on the central band area.
  const exposureGains: number[] = []
  const means = corrected.map((img) => {
    let sum = 0
    let count = 0
    const y0 = Math.round(img.height * 0.28)
    const y1 = Math.round(img.height * 0.82)
    for (let y = y0; y < y1; y += 2) {
      for (let x = 0; x < img.width; x += 2) {
        const i = (y * img.width + x) * 4
        sum += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]
        count++
      }
    }
    return sum / Math.max(1, count)
  })
  const targetExposure = median(means)
  for (const mean of means) exposureGains.push(Math.max(0.72, Math.min(1.32, targetExposure / Math.max(1, mean))))

  const width = Math.max(1, Math.round(circumferencePx))
  const height = FRAME_HEIGHT
  const rgb = new Float32Array(width * height * 3)
  const weights = new Float32Array(width * height)

  for (let fi = 0; fi < n; fi++) {
    const img = corrected[fi]
    const gain = exposureGains[fi]
    const focusQuality = clamp(focusScoresRaw[fi] / Math.max(focusMedian, 1), 0, 1.4)
    const focusWeight = 0.72 + 0.28 * Math.min(1, focusQuality * 1.15)
    const p = Math.round(positions[fi])
    const fw = img.width || FRAME_WIDTH
    const fh = img.height || FRAME_HEIGHT
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        // Hann window prefers the central, least-distorted part of each macro
        // frame and prevents 3-4 overlapping frames from averaging into blur.
        const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / Math.max(1, fw - 1))
        const windowWeight = Math.pow(0.12 + 0.88 * hann, 3)
        const w = windowWeight * focusWeight
        let dx = p + x
        dx = ((dx % width) + width) % width
        const di = (y * width + dx) * 3
        const ii = (y * fw + x) * 4
        const ww = w
        rgb[di] += img.data[ii] * gain * ww
        rgb[di + 1] += img.data[ii + 1] * gain * ww
        rgb[di + 2] += img.data[ii + 2] * gain * ww
        weights[y * width + dx] += ww
      }
    }
    report('亮度融合', 66 + Math.round(((fi + 1) / n) * 22))
  }

  const image = createImage(width, height)
  for (let p = 0, i3 = 0, i4 = 0; p < width * height; p++, i3 += 3, i4 += 4) {
    const wsum = Math.max(1e-6, weights[p])
    image.data[i4] = rgb[i3] / wsum
    image.data[i4 + 1] = rgb[i3 + 1] / wsum
    image.data[i4 + 2] = rgb[i3 + 2] / wsum
    image.data[i4 + 3] = 255
  }
  report('长带生成', 94)

  return {
    image,
    width,
    height,
    circumferencePx,
    offsets,
    seams,
    closureDx,
    closureScore: closure.score,
    focusScores: focusScoresRaw,
    exposureGains,
    elapsedMs: now() - started,
    direction,
    frameCount: n,
  }
}
