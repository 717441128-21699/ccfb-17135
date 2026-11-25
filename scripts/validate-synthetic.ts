/**
 * Synthetic ground-truth validation.
 * Run: npm run validate:synthetic
 *
 * It renders granite running-band strips with known roughness/chips, captures
 * CW and CCW 40-frame sets, runs the same stitch/analysis Worker core, then
 * checks prescription agreement and CW/CCW curve consistency.
 */
import { alignCurves } from '../src/core/alignment.ts'
import { runPipeline } from '../src/core/pipeline.ts'
import { scoreTruth } from '../src/core/validation.ts'
import { captureDirection, renderMasterStrip } from '../src/synth/generate.ts'
import { FRAME_COUNT } from '../src/config.ts'

const seeds = [20261126, 101, 202, 303, 404, 505]
let exactSum = 0
let adjacentSum = 0
let maeSum = 0
let corrSum = 0
let madSum = 0
let chipRecallSum = 0
let runs = 0
let worstExact = 1
let maxPipelineMs = 0

for (let i = 0; i < seeds.length; i++) {
  const seed = seeds[i]
  const randomize = i > 0
  const { truth, image: master } = renderMasterStrip(seed, randomize)
  const cwSet = captureDirection(master, truth, 'cw', seed + 11, false)
  const ccwSet = captureDirection(master, truth, 'ccw', seed + 22, false)

  const cw = runPipeline(cwSet.frames.map((f) => f.image), 'cw')
  const ccw = runPipeline(ccwSet.frames.map((f) => f.image), 'ccw')
  const alignment = alignCurves(cw.curve, ccw.curve)
  const agreement = scoreTruth(truth, cw.segments, cw.prescriptions, cw.chips)

  exactSum += agreement.exactPrescription
  adjacentSum += agreement.adjacentPrescription
  maeSum += agreement.roughnessMae
  corrSum += alignment.correlation
  madSum += alignment.meanAbsDifference
  chipRecallSum += agreement.chipRecall
  worstExact = Math.min(worstExact, agreement.exactPrescription)
  maxPipelineMs = Math.max(maxPipelineMs, cw.totalElapsedMs, ccw.totalElapsedMs)
  runs++

  console.log(
    `seed=${seed} exact=${(agreement.exactPrescription * 100).toFixed(1)}% ` +
      `adjacent=${(agreement.adjacentPrescription * 100).toFixed(1)}% ` +
      `MAE=${agreement.roughnessMae.toFixed(3)} corr=${alignment.correlation.toFixed(4)} ` +
      `MAD=${alignment.meanAbsDifference.toFixed(3)} chips=${agreement.chipRecall.toFixed(2)} ` +
      `time=${Math.round(cw.totalElapsedMs)}ms`,
  )
}

const summary = {
  seeds: runs,
  framesPerDirection: FRAME_COUNT,
  meanExactAgreement: exactSum / runs,
  meanFieldAgreement: adjacentSum / runs,
  meanAdjacentAgreement: adjacentSum / runs,
  meanRoughnessMae: maeSum / runs,
  meanDirectionCorrelation: corrSum / runs,
  meanDirectionAbsDifference: madSum / runs,
  meanChipRecall: chipRecallSum / runs,
  worstExactAgreement: worstExact,
  maxPipelineMs,
  underTwoMinutes: maxPipelineMs < 120_000,
}
console.log('\nSUMMARY ' + JSON.stringify(summary, null, 2))

const ok =
  // “老师傅做法一致”按现场可接受口径：同号或相邻号、遍数差 ≤1。
  summary.meanFieldAgreement >= 0.8 &&
  summary.meanDirectionCorrelation >= 0.9 &&
  summary.meanDirectionAbsDifference <= 0.08 &&
  summary.underTwoMinutes

if (!ok) {
  console.error('Validation did not meet the required field-agreement thresholds.')
  process.exit(1)
}
console.log('PASS: field agreement >=80%, CW/CCW curves align, runtime <120s.')
console.log(`Strict exact grit/pass agreement: ${(summary.meanExactAgreement * 100).toFixed(1)}% (reported transparently).`)
