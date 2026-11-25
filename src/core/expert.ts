import type { ChipMark, Prescription, SegmentMetric, SegmentTruth } from '../types.ts'
import { clamp } from '../lib/rng.ts'

/**
 * 老器材员口头规则固化成的规则卡。
 * 粗糙度 0 = 磨平/镜面，1 = 粗糙/深划痕；目标窗口约 0.43–0.58。
 */
export const VETERAN_RULE_CARD = [
  { condition: '镜面发亮、手感发滑 (R<0.16)', grit: 120, passes: 6, action: '粗砂开刃' },
  { condition: '明显磨平 (0.16≤R<0.30)', grit: 180, passes: 5, action: '重新造砂' },
  { condition: '偏光滑 (0.30≤R<0.43)', grit: 240, passes: 4, action: '均匀找粗' },
  { condition: '粗细合适且均匀 (0.43≤R<0.58)', grit: 400, passes: 2, action: '轻走保养' },
  { condition: '合适但段内不均', grit: 240, passes: 4, action: '找平均匀', finishGrit: 400, finishPasses: 2 },
  { condition: '偏糙、细划痕多 (0.58≤R<0.70)', grit: 400, passes: 4, action: '细化划痕' },
  { condition: '粗糙 (0.70≤R<0.85)', grit: 600, passes: 4, action: '细砂收光' },
  { condition: '深划痕/过粗 (R≥0.85)', grit: 400, passes: 5, action: '先找平', finishGrit: 800, finishPasses: 2 },
  { condition: '边缘崩口', grit: 180, passes: 3, action: '崩口修形过渡', finishGrit: 400, finishPasses: 2 },
] as const

export interface Prescribable {
  roughness: number
  unevenness?: number
  chip?: ChipMark | null
}

export function prescribe(input: Prescribable): Prescription {
  const r = clamp(input.roughness)
  const uneven = input.unevenness ?? 0
  const chip = input.chip ?? null

  if (chip && chip.severity >= 0.45) {
    return {
      ruleId: 'chip-repair',
      grit: 180,
      passes: chip.severity > 0.75 ? 4 : 3,
      finishGrit: 400,
      finishPasses: 2,
      action: '崩口修形',
      reason: `边缘崩口深度约 ${(chip.depthPx * 0.12).toFixed(1)} mm；先从崩口两侧弧形过渡，禁止原地重压。`,
    }
  }

  if (r < 0.16) {
    return {
      ruleId: 'glazed',
      grit: 120,
      passes: 6,
      action: '粗砂开刃',
      reason: '强反光、划痕几乎消失，运行带已经釉化；用粗砂重新切出均匀牙口。',
    }
  }
  if (r < 0.3) {
    return {
      ruleId: 'worn-flat',
      grit: 180,
      passes: 5,
      action: '重新造砂',
      reason: '表面偏平、反光连片；180 号沿圆周方向走砂，恢复粗糙度。',
    }
  }
  if (r < 0.43) {
    return {
      ruleId: 'smooth',
      grit: 240,
      passes: 4,
      action: '均匀找粗',
      reason: '略偏光滑，尚不需重砂；240 号补足均匀细牙。',
    }
  }
  if (r < 0.58) {
    if (uneven >= 0.82) {
      return {
        ruleId: 'ideal-uneven',
        grit: 240,
        passes: 4,
        finishGrit: 400,
        finishPasses: 2,
        action: '找平均匀',
        reason: '整段均值尚可，但四段粗细差偏大；先交叉找平均匀，再用 400 号收一遍。',
      }
    }
    return {
      ruleId: 'ideal',
      grit: 400,
      passes: 2,
      action: '轻走保养',
      reason: '反光柔和、划痕细密连续，处于目标粗糙度窗口；轻走两遍即可。',
    }
  }
  if (r < 0.7) {
    return {
      ruleId: 'slightly-rough',
      grit: 400,
      passes: 4,
      action: '细化划痕',
      reason: '细划痕密度偏高、反光偏弱；400 号把峰尖打掉并统一走向。',
    }
  }
  if (r < 0.85) {
    return {
      ruleId: 'rough',
      grit: 600,
      passes: 4,
      action: '细砂收光',
      reason: '手感明显发糙；600 号逐遍收细，避免留下同向深痕。',
    }
  }
  return {
    ruleId: 'deep-score',
    grit: 400,
    passes: 5,
    finishGrit: 800,
    finishPasses: 2,
    action: '找平后收光',
    reason: '存在密集深划痕；先用 400 号找平，检查划痕消失后再用 800 号收光。',
  }
}

export function prescribeMetric(metric: SegmentMetric): Prescription {
  return prescribe({ roughness: metric.roughness, unevenness: metric.unevenness, chip: metric.chip })
}

export function prescribeTruth(truth: SegmentTruth, chip: ChipMark | null): Prescription {
  const values = truth.subRoughness
  const unevenness = clamp((Math.max(...values) - Math.min(...values)) / 0.42)
  return prescribe({ roughness: truth.roughness, unevenness, chip })
}

export function samePrescription(a: Prescription, b: Prescription): boolean {
  return a.grit === b.grit && a.passes === b.passes
}

export function adjacentPrescription(a: Prescription, b: Prescription): boolean {
  const grits = [120, 180, 240, 320, 400, 600, 800]
  const ai = grits.indexOf(a.grit)
  const bi = grits.indexOf(b.grit)
  return Math.abs(ai - bi) <= 1 && Math.abs(a.passes - b.passes) <= 1
}

export function gritLabel(grit: number): string {
  return `${grit}#`
}
