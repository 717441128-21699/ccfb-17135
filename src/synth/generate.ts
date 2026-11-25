import {
  BAND_BOTTOM,
  BAND_TOP,
  FRAME_COUNT,
  FRAME_HEIGHT,
  FRAME_STEP,
  FRAME_WIDTH,
  MASTER_HEIGHT,
  MASTER_WIDTH,
  SEGMENT_COUNT,
} from '../config.ts'
import { prescribeTruth } from '../core/expert.ts'
import { clamp, mulberry32 } from '../lib/rng.ts'
import {
  adjustGain,
  boxBlur,
  createImage,
  cropWrapX,
  drawLine,
  fillEllipse,
  fillPolygon,
} from '../lib/raster.ts'
import type {
  ChipMark,
  ChipTruth,
  Direction,
  GroundTruth,
  RawImage,
  SegmentTruth,
  WearClass,
} from '../types.ts'

interface WearLevel {
  roughness: number
  wearClass: WearClass
}

const WEAR_LEVELS: WearLevel[] = [
  { roughness: 0.08, wearClass: 'glazed' },
  { roughness: 0.23, wearClass: 'smooth' },
  { roughness: 0.36, wearClass: 'lightly_smooth' },
  { roughness: 0.5, wearClass: 'uniform' },
  { roughness: 0.64, wearClass: 'rough' },
  { roughness: 0.78, wearClass: 'scratched' },
  { roughness: 0.92, wearClass: 'coarse' },
]

function hashNoise(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function smoothNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = x - x0
  const ty = y - y0
  const sx = tx * tx * (3 - 2 * tx)
  const sy = ty * ty * (3 - 2 * ty)
  const n00 = hashNoise(x0, y0, seed)
  const n10 = hashNoise(x0 + 1, y0, seed)
  const n01 = hashNoise(x0, y0 + 1, seed)
  const n11 = hashNoise(x0 + 1, y0 + 1, seed)
  const top = n00 + (n10 - n00) * sx
  const bottom = n01 + (n11 - n01) * sx
  return top + (bottom - top) * sy
}

function fbm(x: number, y: number, seed: number): number {
  let value = 0
  let amplitude = 0.55
  let frequency = 1
  let norm = 0
  for (let octave = 0; octave < 4; octave++) {
    value += smoothNoise(x * frequency, y * frequency, seed + octave * 101) * amplitude
    norm += amplitude
    amplitude *= 0.5
    frequency *= 2.07
  }
  return value / norm
}

function defaultLevelPattern(): number[] {
  // Deliberately covers every wear class and creates easy-to-see uneven zones.
  return [
    3, 3, 2, 1, 0, 0, 1, 3, 3, 2, 2, 5,
    6, 5, 4, 4, 3, 3, 3, 3, 3, 3, 2, 2,
    1, 0, 0, 2, 3, 4, 5, 5, 6, 6, 4, 3,
  ]
}

export function createGroundTruth(seed = 20261126, randomize = false): GroundTruth {
  const rng = mulberry32(seed)
  const pattern = defaultLevelPattern()
  let profileLevels = pattern
  if (randomize) {
    // Real wear occurs in contiguous zones, not independent coin flips.
    profileLevels = new Array<number>(SEGMENT_COUNT).fill(3)
    let pos = 0
    while (pos < SEGMENT_COUNT) {
      const length = 2 + Math.floor(rng() * 5)
      const roll = rng()
      const level = roll < 0.14 ? 0 : roll < 0.28 ? 1 : roll < 0.42 ? 2 : roll < 0.6 ? 3 : roll < 0.75 ? 4 : roll < 0.9 ? 5 : 6
      for (let k = 0; k < length && pos + k < SEGMENT_COUNT; k++) profileLevels[pos + k] = level
      pos += length
    }
  }
  const roughness = new Float32Array(MASTER_WIDTH)
  const segments: SegmentTruth[] = []

  for (let s = 0; s < SEGMENT_COUNT; s++) {
    const levelIndex = profileLevels[s]
    const level = WEAR_LEVELS[levelIndex]
    const base = clamp(level.roughness + (rng() - 0.5) * 0.045, 0.03, 0.98)
    const uneven = randomize ? rng() < 0.16 : s === 20 || s === 21
    let sub: [number, number, number, number]
    if (uneven) {
      // Zero-mean modulation: the segment label remains the true mean, while
      // four quarters contain visible smooth/rough alternation.
      const amplitude = Math.min(0.22, base * 0.85, (1 - base) * 0.85)
      const deltas = [-amplitude, amplitude, -0.5 * amplitude, 0.5 * amplitude]
      sub = deltas.map((d) => clamp(base + d)) as [number, number, number, number]
    } else {
      const raw = [0, 1, 2, 3].map(() => (rng() - 0.5) * 0.05)
      const meanDelta = raw.reduce((a, b) => a + b, 0) / 4
      sub = raw.map((d) => clamp(base + d - meanDelta)) as [number, number, number, number]
    }

    const segStart = Math.floor((s * MASTER_WIDTH) / SEGMENT_COUNT)
    const segEnd = Math.floor(((s + 1) * MASTER_WIDTH) / SEGMENT_COUNT)
    for (let x = segStart; x < segEnd; x++) {
      const local = (x - segStart) / Math.max(1, segEnd - segStart)
      const q = Math.min(3, Math.floor(local * 4))
      roughness[x] = sub[q]
    }

    segments.push({
      index: s,
      roughness: base,
      subRoughness: sub,
      wearClass: level.wearClass,
      // Filled after chip truth is built.
      veteran: undefined as unknown as SegmentTruth['veteran'],
    })
  }

  const chips: ChipTruth[] = []
  if (randomize) {
    const count = 3 + Math.floor(rng() * 4)
    for (let i = 0; i < count; i++) {
      chips.push({
        segment: Math.floor(rng() * SEGMENT_COUNT),
        x01: 0.18 + rng() * 0.64,
        edge: rng() < 0.42 ? 'upper' : rng() < 0.78 ? 'lower' : 'both',
        widthPx: 26 + rng() * 42,
        depthPx: 9 + rng() * 15,
      })
    }
  } else {
    chips.push(
      { segment: 7, x01: 0.46, edge: 'upper', widthPx: 46, depthPx: 17 },
      { segment: 17, x01: 0.62, edge: 'lower', widthPx: 58, depthPx: 21 },
      { segment: 24, x01: 0.32, edge: 'upper', widthPx: 34, depthPx: 12 },
      { segment: 31, x01: 0.55, edge: 'both', widthPx: 50, depthPx: 16 },
    )
  }

  const chipMarks = chips.map((c, i): ChipMark => {
    const segW = MASTER_WIDTH / SEGMENT_COUNT
    return {
      id: `truth-chip-${i}`,
      segment: c.segment,
      x01: c.x01,
      x: (c.segment + c.x01) * segW,
      edge: c.edge,
      severity: clamp(c.depthPx / 22),
      widthPx: c.widthPx,
      depthPx: c.depthPx,
      confidence: 1,
    }
  })

  for (const seg of segments) {
    const chip = chipMarks.find((c) => c.segment === seg.index) ?? null
    seg.veteran = prescribeTruth(seg, chip)
  }

  return { seed, roughness, segments, chips }
}

function renderGraniteBase(img: RawImage, seed: number): void {
  const { width: w, height: h, data } = img
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = fbm(x * 0.012, y * 0.035, seed)
      const cloud = fbm(x * 0.0035 + 40, y * 0.012, seed + 77)
      const grain = hashNoise(x, y, seed + 9) - 0.5
      const base = 116 + n * 34 + cloud * 24 + grain * 15
      const warm = hashNoise(x >> 3, y >> 3, seed + 123)
      const i = (y * w + x) * 4
      data[i] = base + warm * 7
      data[i + 1] = base + warm * 4
      data[i + 2] = base + 2 - warm * 5
      data[i + 3] = 255
    }
  }

  const rng = mulberry32(seed + 9001)
  // Isotropic black mica and white quartz spots: these are the texture the
  // roughness estimator must ignore.
  for (let k = 0; k < 15000; k++) {
    const x = rng() * w
    const y = rng() * h
    const big = rng() > 0.94
    const rx = big ? 1.8 + rng() * 4.8 : 0.45 + rng() * 1.7
    const ry = rx * (0.55 + rng() * 0.8)
    const roll = rng()
    const color: [number, number, number] =
      roll < 0.42 ? [28 + rng() * 28, 29 + rng() * 25, 31 + rng() * 24]
      : roll < 0.74 ? [205 + rng() * 35, 205 + rng() * 32, 198 + rng() * 30]
      : [105 + rng() * 55, 108 + rng() * 50, 110 + rng() * 48]
    fillEllipse(img, x, y, rx, ry, color, 0.42 + rng() * 0.48)
  }

  // Slight dark water/film on the actual running band.
  for (let y = BAND_TOP - 8; y <= BAND_BOTTOM + 8; y++) {
    for (let x = 0; x < w; x++) {
      const edgeDist = Math.min(y - (BAND_TOP - 8), BAND_BOTTOM + 8 - y)
      const alpha = clamp(edgeDist / 10) * 0.16
      const i = (y * w + x) * 4
      data[i] = data[i] * (1 - alpha) + 88 * alpha
      data[i + 1] = data[i + 1] * (1 - alpha) + 92 * alpha
      data[i + 2] = data[i + 2] * (1 - alpha) + 96 * alpha
    }
  }
}

function applyPolishAndSpecular(img: RawImage, truth: GroundTruth): void {
  const blurred = boxBlur(img, 3, 2)
  const { width: w } = img
  for (let x = 0; x < w; x++) {
    const r = truth.roughness[x]
    const polish = clamp((0.66 - r) / 0.5)
    if (polish <= 0) continue
    for (let y = BAND_TOP + 2; y < BAND_BOTTOM - 2; y++) {
      const i = (y * w + x) * 4
      const a = polish * 0.94
      img.data[i] = img.data[i] * (1 - a) + blurred.data[i] * a
      img.data[i + 1] = img.data[i + 1] * (1 - a) + blurred.data[i + 1] * a
      img.data[i + 2] = img.data[i + 2] * (1 - a) + blurred.data[i + 2] * a
    }
  }

  const rng = mulberry32(truth.seed + 31337)
  for (let s = 0; s < SEGMENT_COUNT; s++) {
    const r = truth.segments[s].roughness
    const gloss = clamp((0.62 - r) / 0.5)
    if (gloss <= 0.05) continue
    const segX = (s + 0.5) * (w / SEGMENT_COUNT)
    fillEllipse(
      img,
      segX,
      BAND_TOP + BAND_HEIGHT * (0.38 + rng() * 0.24),
      (w / SEGMENT_COUNT) * 0.72,
      24 + rng() * 22,
      [246, 249, 252],
      0.28 + gloss * 0.34,
    )
    const count = Math.round(5 + gloss * 8)
    for (let k = 0; k < count; k++) {
      const cx = segX + (rng() - 0.5) * 150
      const cy = BAND_TOP + 14 + rng() * (BAND_HEIGHT - 28)
      const rx = 70 + rng() * 150
      const ry = 14 + rng() * 30
      fillEllipse(img, cx, cy, rx, ry, [248, 250, 252], 0.34 + gloss * 0.46 + rng() * 0.08)
      if (rng() < 0.8) {
        drawLine(
          img,
          cx - rx * 0.72,
          cy + (rng() - 0.5) * 8,
          cx + rx * 0.72,
          cy + (rng() - 0.5) * 8,
          [255, 255, 255],
          0.16 + gloss * 0.34,
          1.5 + rng() * 3,
        )
      }
    }
  }
}

const BAND_HEIGHT = BAND_BOTTOM - BAND_TOP

function drawScratches(img: RawImage, truth: GroundTruth): void {
  const rng = mulberry32(truth.seed + 5150)
  const w = img.width
  for (let s = 0; s < SEGMENT_COUNT; s++) {
    const r = truth.segments[s].roughness
    const segStart = (s * w) / SEGMENT_COUNT
    const segW = w / SEGMENT_COUNT
    const count = Math.round(4 + r * 320)
    for (let k = 0; k < count; k++) {
      const x = segStart + rng() * segW
      const y = BAND_TOP + 7 + rng() * (BAND_HEIGHT - 14)
      const len = 16 + rng() * (34 + r * 125)
      const slope = (rng() - 0.5) * (2.5 + r * 4)
      const darkAlpha = 0.16 + r * (0.42 + rng() * 0.2)
      const thickness = r > 0.82 && rng() < 0.28 ? 1.7 : 1
      drawLine(img, x, y, x + len, y + slope, [38, 40, 43], darkAlpha, thickness)
      if (rng() < 0.58) {
        drawLine(img, x + 1, y + 1.2, x + len + 1, y + slope + 1.2, [218, 220, 218], darkAlpha * 0.42, 1)
      }
    }
  }
}

function drawSandingGrain(img: RawImage, truth: GroundTruth): void {
  const rng = mulberry32(truth.seed + 8675309)
  const rows = new Float32Array(BAND_HEIGHT)
  for (let y = 0; y < BAND_HEIGHT; y++) rows[y] = (rng() - 0.5) * 2
  // Light vertical smoothing turns white noise into abrasive-sized ridges.
  const smoothRows = new Float32Array(BAND_HEIGHT)
  for (let y = 0; y < BAND_HEIGHT; y++) {
    smoothRows[y] = (rows[Math.max(0, y - 1)] + rows[y] * 2 + rows[Math.min(BAND_HEIGHT - 1, y + 1)]) / 4
  }
  const { width: w, data } = img
  for (let x = 0; x < w; x++) {
    const r = truth.roughness[x]
    if (r <= 0.02) continue
    const amplitude = 10 + 58 * r + 22 * r * r
    for (let yy = 0; yy < BAND_HEIGHT; yy++) {
      const y = BAND_TOP + yy
      if (y >= BAND_BOTTOM) break
      const fine = (hashNoise(x, y, truth.seed + 4242) - 0.5) * 13 * r
      const delta = smoothRows[yy] * amplitude + fine
      const i = (y * w + x) * 4
      data[i] += delta
      data[i + 1] += delta
      data[i + 2] += delta * 0.96
    }
  }
}

function drawChip(img: RawImage, chip: ChipTruth): void {
  const segW = img.width / SEGMENT_COUNT
  const cx = (chip.segment + chip.x01) * segW
  const w = chip.widthPx
  const d = chip.depthPx
  const rng = mulberry32(Math.floor(cx * 17 + d * 101))

  const drawUpper = (): void => {
    const y0 = BAND_TOP
    const points: Array<[number, number]> = [
      [cx - w / 2, y0 - 5],
      [cx - w * 0.28, y0 + d * (0.35 + rng() * 0.25)],
      [cx - w * 0.08, y0 + d],
      [cx + w * 0.12, y0 + d * 0.78],
      [cx + w * 0.28, y0 + d * 0.52],
      [cx + w / 2, y0 - 2],
      [cx + w * 0.38, y0 - 7],
      [cx - w * 0.4, y0 - 7],
    ]
    fillPolygon(img, points, [24, 26, 29], 0.97)
    drawLine(img, cx - w * 0.42, y0 + 1, cx - w * 0.08, y0 + d, [205, 210, 210], 0.5, 1.4)
    drawLine(img, cx + w * 0.08, y0 + d * 0.8, cx + w * 0.42, y0, [190, 195, 196], 0.42, 1.2)
  }
  const drawLower = (): void => {
    const y0 = BAND_BOTTOM
    const points: Array<[number, number]> = [
      [cx - w / 2, y0 + 5],
      [cx - w * 0.25, y0 - d * 0.42],
      [cx - w * 0.05, y0 - d],
      [cx + w * 0.16, y0 - d * 0.72],
      [cx + w / 2, y0 + 2],
      [cx + w * 0.38, y0 + 7],
      [cx - w * 0.4, y0 + 7],
    ]
    fillPolygon(img, points, [22, 25, 28], 0.97)
    drawLine(img, cx - w * 0.4, y0, cx - w * 0.05, y0 - d, [210, 214, 214], 0.48, 1.3)
    drawLine(img, cx + w * 0.06, y0 - d * 0.8, cx + w * 0.42, y0 + 1, [196, 200, 202], 0.4, 1.2)
  }
  if (chip.edge === 'upper' || chip.edge === 'both') drawUpper()
  if (chip.edge === 'lower' || chip.edge === 'both') drawLower()
}

let cachedMaster: { seed: number; randomize: boolean; truth: GroundTruth; image: RawImage } | null = null

export function renderMasterStrip(seed = 20261126, randomize = false): { truth: GroundTruth; image: RawImage } {
  if (cachedMaster && cachedMaster.seed === seed && cachedMaster.randomize === randomize) {
    return { truth: cachedMaster.truth, image: cachedMaster.image }
  }
  const truth = createGroundTruth(seed, randomize)
  const image = createImage(MASTER_WIDTH, MASTER_HEIGHT)
  renderGraniteBase(image, seed)
  applyPolishAndSpecular(image, truth)
  drawScratches(image, truth)
  drawSandingGrain(image, truth)
  for (const chip of truth.chips) drawChip(image, chip)
  cachedMaster = { seed, randomize, truth, image }
  return { truth, image }
}

export interface CapturedFrame {
  index: number
  direction: Direction
  physicalX: number
  image: RawImage
  exposure: number
  blurIterations: number
  thumbnail?: string
}

export interface CaptureSet {
  direction: Direction
  frames: CapturedFrame[]
  truth: GroundTruth
  master: RawImage
}

function addSensorNoise(img: RawImage, rng: () => number, amount = 5): void {
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rng() - 0.5) * amount * 2
    img.data[i] += n
    img.data[i + 1] += n
    img.data[i + 2] += n
  }
}

export function captureDirection(
  master: RawImage,
  truth: GroundTruth,
  direction: Direction,
  seed: number,
  withThumbnails = false,
): CaptureSet {
  const rng = mulberry32(seed + (direction === 'cw' ? 17 : 919))
  const frames: CapturedFrame[] = []
  for (let i = 0; i < FRAME_COUNT; i++) {
    // CW moves to increasing x; CCW starts at the same mark and moves backwards.
    const physicalX =
      direction === 'cw'
        ? Math.round(i * FRAME_STEP + (rng() - 0.5) * 3)
        : ((-Math.round(i * FRAME_STEP + (rng() - 0.5) * 3)) % MASTER_WIDTH + MASTER_WIDTH) % MASTER_WIDTH
    let image = cropWrapX(master, physicalX, FRAME_WIDTH, FRAME_HEIGHT, 0)
    const exposure = 0.82 + rng() * 0.36
    image = adjustGain(image, exposure)
    const blurRoll = rng()
    const blurIterations = blurRoll < 0.22 ? 2 : blurRoll < 0.58 ? 1 : 0
    if (blurIterations > 0) image = boxBlur(image, 1, blurIterations)
    addSensorNoise(image, rng, 4)
    let thumbnail: string | undefined
    if (withThumbnails && typeof document !== 'undefined') {
      const c = document.createElement('canvas')
      c.width = 80
      c.height = 60
      const ctx = c.getContext('2d')
      if (ctx) {
        const full = document.createElement('canvas')
        full.width = image.width
        full.height = image.height
        full.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
        ctx.drawImage(full, 0, 0, 80, 60)
        thumbnail = c.toDataURL('image/jpeg', 0.72)
      }
    }
    frames.push({ index: i, direction, physicalX, image, exposure, blurIterations, thumbnail })
  }
  return { direction, frames, truth, master }
}

export function captureBothDirections(seed = 20261126, withThumbnails = true): {
  truth: GroundTruth
  master: RawImage
  cw: CaptureSet
  ccw: CaptureSet
} {
  const { truth, image: master } = renderMasterStrip(seed, false)
  return {
    truth,
    master,
    cw: captureDirection(master, truth, 'cw', seed, withThumbnails),
    ccw: captureDirection(master, truth, 'ccw', seed + 5000, withThumbnails),
  }
}
