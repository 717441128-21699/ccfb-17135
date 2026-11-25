export interface RawImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

export type Direction = 'cw' | 'ccw'

export type WearClass =
  | 'glazed'
  | 'smooth'
  | 'lightly_smooth'
  | 'uniform'
  | 'rough'
  | 'scratched'
  | 'coarse'

export interface ChipTruth {
  segment: number
  /** 0..1 position inside the segment in clockwise direction. */
  x01: number
  edge: 'upper' | 'lower' | 'both'
  widthPx: number
  depthPx: number
}

export interface SegmentTruth {
  index: number
  roughness: number
  subRoughness: [number, number, number, number]
  wearClass: WearClass
  veteran: Prescription
}

export interface GroundTruth {
  seed: number
  roughness: Float32Array
  segments: SegmentTruth[]
  chips: ChipTruth[]
}

export interface ChipMark {
  id: string
  segment: number
  x01: number
  x: number
  edge: 'upper' | 'lower' | 'both'
  severity: number
  widthPx: number
  depthPx: number
  confidence: number
}

export interface SegmentMetric {
  index: number
  /** Calibrated roughness, 0=镜面磨平, 1=粗糙深划痕. */
  roughness: number
  scratchDensity: number
  scratchEnergy: number
  anisotropy: number
  rowEnergy: number
  gloss: number
  meanLuma: number
  highlight: number
  unevenness: number
  subRoughness: [number, number, number, number]
  chip: ChipMark | null
  confidence: number
}

export interface Prescription {
  grit: number
  passes: number
  action: string
  finishGrit?: number
  finishPasses?: number
  reason: string
  ruleId: string
}

export interface SeamInfo {
  from: number
  to: number
  dx: number
  score: number
}

export interface StitchResult {
  image: RawImage
  width: number
  height: number
  circumferencePx: number
  offsets: number[]
  seams: SeamInfo[]
  closureDx: number
  closureScore: number
  focusScores: number[]
  exposureGains: number[]
  elapsedMs: number
  direction: Direction
  frameCount: number
}

export interface AnalysisResult {
  direction: Direction
  stitch: StitchResult
  segments: SegmentMetric[]
  prescriptions: Prescription[]
  chips: ChipMark[]
  curve: number[]
  elapsedMs: number
  totalElapsedMs: number
  alignment?: DirectionAlignment
  truthAgreement?: TruthAgreement
}

export interface DirectionAlignment {
  circularShift: number
  correlation: number
  meanAbsDifference: number
  maxAbsDifference: number
  reversed: boolean
}

export interface TruthAgreement {
  segmentCount: number
  roughnessMae: number
  exactPrescription: number
  adjacentPrescription: number
  chipRecall: number
  chipPrecision: number
}

export interface InspectionReport {
  id: string
  stoneId: string
  inspectedAt: string
  direction: Direction
  seed?: number
  frameCount: number
  elapsedMs: number
  curve: number[]
  segments: SegmentMetric[]
  prescriptions: Prescription[]
  chips: ChipMark[]
  cwAlignment?: DirectionAlignment
  note?: string
}

export interface WorkerRequestBase {
  id: number
}

export type WorkerRequest =
  | {
      id: number
      type: 'analyze-frames'
      direction: Direction
      frames: RawImage[]
      seed?: number
      compareReverseCurve?: number[]
    }
  | {
      id: number
      type: 'analyze-strip'
      direction: Direction
      strip: RawImage
      frameCount?: number
    }

export type WorkerResponse =
  | { id: number; type: 'progress'; stage: string; percent: number }
  | { id: number; type: 'result'; result: AnalysisResult }
  | { id: number; type: 'error'; message: string }
