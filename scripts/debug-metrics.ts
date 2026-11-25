import { runPipeline } from '../src/core/pipeline.ts'
import { captureDirection, renderMasterStrip } from '../src/synth/generate.ts'

const seed = Number(process.argv[2] ?? 20261126)
const randomize = process.argv[3] === 'rand'
const { truth, image } = renderMasterStrip(seed, randomize)
const cw = captureDirection(image, truth, 'cw', seed + 11, false)
const ccw = captureDirection(image, truth, 'ccw', seed + 22, false)
const a = runPipeline(cw.frames.map((f) => f.image), 'cw')
const b = runPipeline(ccw.frames.map((f) => f.image), 'ccw')

console.log('circ', a.stitch.circumferencePx.toFixed(1), b.stitch.circumferencePx.toFixed(1), 'closure', a.stitch.closureDx.toFixed(1), b.stitch.closureDx.toFixed(1))
console.log('seam dx first 12', a.stitch.seams.slice(0, 12).map(s => s.dx.toFixed(1)).join(','))
console.log('seam score min/avg', Math.min(...a.stitch.seams.map(s=>s.score)).toFixed(3), (a.stitch.seams.reduce((x,s)=>x+s.score,0)/39).toFixed(3))
for (let i=0;i<36;i++) {
  const m=a.segments[i], n=b.segments[i]
  console.log(
    String(i).padStart(2),
    'T', truth.segments[i].roughness.toFixed(2),
    'A', m.roughness.toFixed(2),
    'B', n.roughness.toFixed(2),
    'sd', m.scratchDensity.toFixed(4),
    'en', m.scratchEnergy.toFixed(2),
    'gl', m.gloss.toFixed(2),
    'un', m.unevenness.toFixed(2),
    truth.segments[i].veteran.grit + '/' + truth.segments[i].veteran.passes,
    '=>', a.prescriptions[i].grit + '/' + a.prescriptions[i].passes,
  )
}
