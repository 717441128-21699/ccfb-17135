/**
 * Last `npm run validate:synthetic` summary for the deterministic six-seed
 * calibration run. Re-run the script after changing renderer/analysis.
 */
export const FIELD_VALIDATION = {
  exactAgreement: 0.662,
  fieldAgreement: 0.87,
  roughnessMae: 0.073,
  directionCorrelation: 0.983,
  directionMeanAbsDifference: 0.027,
  chipRecall: 1,
  maxMs: 433,
  frameCount: 40,
  segmentCount: 36,
} as const
