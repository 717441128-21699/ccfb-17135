// 核心共享类型：全部使用不依赖 DOM 的 RgbaImage，便于在 Node 中直接验证算法

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // length = width*height*4
}

export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array; // 0..255
}

export type CaptureDirection = 1 | -1; // 1=顺角度递增，-1=倒着转

export interface ChipTruth {
  segment: number; // 主属段 0..35
  edge: 'inner' | 'outer'; // 运行带内缘 / 外缘
  angleWorldX: number; // 在 WORLD_W 坐标中的角度位置
  widthWorld: number; // 崩口角度宽（世界 px）
  depthWorld: number; // 径向深度（世界 px）
}

export interface StoneTruth {
  stoneId: string;
  seed: number;
  textureKind: number; // 0 细芝麻 / 1 粗黑白斑 / 2 云母片麻
  roughness: number[]; // 36 段真值 0..1（0 磨平，1 粗糙）
  wearLevel: number[]; // 36 段真值磨损等级 0..4（对应建议表五档）
  chips: ChipTruth[];
  previous?: InspectionRecord;
}

export interface PhotoShot {
  id: number;
  order: number; // 拍摄顺序 0..n-1
  direction: CaptureDirection;
  angleCenter: number; // WORLD_W 坐标（角度），合成真值 / 引导位置
  brightness: number; // 合成曝光增益（真值，不参与估计）
  focusSigma: number; // 合成虚化 sigma（真值）
  rgba: RgbaImage;
  thumb?: string;
}

export interface ShiftEstimate {
  from: number;
  to: number;
  dx: number; // 后一张相对前一张沿角度方向的位移（输出 mosaic px 前的 photo px）
  dy: number;
  score: number; // NCC 0..1
}

export interface Placement {
  photoId: number;
  x: number; // mosaic 坐标（角度）
  y: number; // 径向偏移
  scale: number;
  exposure: number; // 校正增益
  focus: number; // 聚焦评分（越大越清晰）
}

export interface StitchResult {
  mosaic: RgbaImage; // 闭合校正后的角度-径向拼接长图（曝光校正）
  mosaicRaw: RgbaImage; // 未做曝光校正的融合长图（用于“校正前”对比）
  ring: RgbaImage; // 极坐标映射出的整圈圆环（展示用）
  ringCx: number;
  ringCy: number;
  ringRCenter: number;
  ringRadialScale: number;
  placements: Placement[];
  shifts: ShiftEstimate[];
  circumferencePhotoPx: number;
  elapsedMs: number;
}

export interface ChipMark {
  segment: number;
  angleDeg: number; // 0..360
  edge: 'inner' | 'outer';
  depthMm: number;
  widthMm: number;
  severity: number; // 0..1
  confidence: number;
}

export interface SegmentStat {
  index: number;
  angleStartDeg: number;
  angleEndDeg: number;
  roughness: number; // 估计 0..1
  reflectivity: number; // 归一化反光 0..1
  scratchDensity: number; // 归一化细划痕密度 0..1
  matte: number;
  confidence: number;
  grit: number;
  passes: number;
  label: string;
  tone: string;
  bin: number;
  chip: ChipMark | null;
  truthRoughness?: number; // 仅合成自测时附带
  truthBin?: number;
  adviceMatch?: boolean;
}

export interface AnalysisResult {
  stripRaw: RgbaImage; // 展开原始（未均化）
  strip: RgbaImage; // 亮度/对焦拉匀后
  width: number;
  height: number;
  curve: number[]; // 高分辨率粗糙度曲线（CURVE_SAMPLES 点）
  curveReflect: number[];
  curveScratch: number[];
  segments: SegmentStat[];
  chips: ChipMark[];
  focusBefore: number[];
  focusAfter: number[];
  brightnessUniformityBefore: number;
  brightnessUniformityAfter: number;
  focusUniformityBefore: number;
  focusUniformityAfter: number;
  elapsedMs: number;
  ringDetected: { rInner: number; rOuter: number; cx: number; cy: number };
}

export interface InspectionRecord {
  stoneId: string;
  date: string;
  roughness36: number[];
  grit: number[];
  passes: number[];
  bins: number[];
  chips: ChipMark[];
  score: number; // 整体状态分
  note?: string;
}

export interface CompareResult {
  current: InspectionRecord;
  previous: InspectionRecord | null;
  delta36: number[]; // current - previous
  worsened: number[];
  improved: number[];
  changedAdvice: number[];
  correlation?: number;
}
