import { runPipeline } from '../src/core/pipeline.ts'
import { captureDirection, renderMasterStrip } from '../src/synth/generate.ts'
import type { SegmentMetric, WearClass } from '../src/types.ts'

const classes: WearClass[] = ['glazed','smooth','lightly_smooth','uniform','rough','scratched','coarse']
const featureKeys = ['roughness','scratchDensity','scratchEnergy','anisotropy','gloss','meanLuma','highlight'] as const
type Key = typeof featureKeys[number]
function vec(m: SegmentMetric): number[] { return featureKeys.map(k => m[k] as number) }

const trainSeeds = [11,22,33,44,55,66,77,88]
const testSeeds: Array<[number,boolean]> = [[20261126,false],[101,true],[202,true],[303,true],[404,true],[505,true]]
const train: Array<{x:number[]; y:WearClass}> = []
for (const seed of trainSeeds) {
  const {truth,image}=renderMasterStrip(seed,true)
  const cap=captureDirection(image,truth,'cw',seed+9,false)
  const out=runPipeline(cap.frames.map(f=>f.image),'cw')
  out.segments.forEach((m,i)=>train.push({x:vec(m),y:truth.segments[i].wearClass}))
}
const dim=featureKeys.length
const mean=Array.from({length:dim},(_,j)=>train.reduce((a,r)=>a+r.x[j],0)/train.length)
const std=Array.from({length:dim},(_,j)=>Math.sqrt(train.reduce((a,r)=>a+(r.x[j]-mean[j])**2,0)/train.length)||1)
const centroids=Object.fromEntries(classes.map(c=>{
  const rows=train.filter(r=>r.y===c)
  return [c, Array.from({length:dim},(_,j)=>rows.reduce((a,r)=>a+(r.x[j]-mean[j])/std[j],0)/rows.length)]
})) as Record<WearClass,number[]>
function predict(m:SegmentMetric):WearClass {
  const x=vec(m).map((v,j)=>(v-mean[j])/std[j])
  let best=classes[0], bd=Infinity
  for (const c of classes) {
    let d=0
    for(let j=0;j<dim;j++){const z=x[j]-centroids[c][j];d+=z*z}
    if(d<bd){bd=d;best=c}
  }
  return best
}
const recipe: Record<WearClass,[number,number]> = {
  glazed:[120,6], smooth:[180,5], lightly_smooth:[240,4], uniform:[400,2], rough:[400,4], scratched:[600,4], coarse:[400,5],
}
let total=0, exact=0, correctClass=0
for (const [seed,rand] of testSeeds) {
  const {truth,image}=renderMasterStrip(seed,rand)
  const cap=captureDirection(image,truth,'cw',seed+11,false)
  const out=runPipeline(cap.frames.map(f=>f.image),'cw')
  let seedExact=0
  for(let i=0;i<36;i++){
    total++
    const pc=predict(out.segments[i])
    if(pc===truth.segments[i].wearClass) correctClass++
    let [g,p]=recipe[pc]
    if(out.segments[i].chip){g=180;p=3}
    const tv=truth.segments[i].veteran
    const ok=g===tv.grit && p===tv.passes
    if(ok){exact++;seedExact++}
  }
  console.log(seed, 'exact', seedExact/36)
}
console.log('class acc',correctClass/total,'recipe exact',exact/total)
console.log('mean',mean.map(x=>x.toFixed(3)).join(','))
console.log('std',std.map(x=>x.toFixed(3)).join(','))
for(const c of classes) console.log(c, centroids[c].map(x=>x.toFixed(2)).join(','))
