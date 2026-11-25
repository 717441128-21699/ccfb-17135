import { analyzeRoughness } from '../src/core/analysis.ts'
import { renderMasterStrip } from '../src/synth/generate.ts'
import { scoreTruth } from '../src/core/validation.ts'
import { prescribeMetric } from '../src/core/expert.ts'

for (const [seed, rand] of [[20261126,false],[101,true],[202,true]] as const) {
  const {truth,image}=renderMasterStrip(seed,rand)
  const {segments,chips}=analyzeRoughness(image)
  const pres=segments.map(prescribeMetric)
  const ag=scoreTruth(truth,segments,pres,chips)
  console.log('seed',seed,'MAE',ag.roughnessMae,'exact',ag.exactPrescription)
  for(let i=0;i<36;i++) console.log(i,'T',truth.segments[i].roughness.toFixed(2),'M',segments[i].roughness.toFixed(2),'gl',segments[i].gloss.toFixed(2),'sd',segments[i].scratchDensity.toFixed(3))
}
