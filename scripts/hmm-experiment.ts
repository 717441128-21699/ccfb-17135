import { runPipeline } from '../src/core/pipeline.ts'
import { captureDirection, renderMasterStrip } from '../src/synth/generate.ts'
import type { SegmentMetric, WearClass } from '../src/types.ts'

const classes: WearClass[] = ['glazed','smooth','lightly_smooth','uniform','rough','scratched','coarse']
const keys = ['roughness','scratchDensity','scratchEnergy','anisotropy','rowEnergy','gloss','meanLuma','highlight'] as const
function vec(m: SegmentMetric) { return keys.map(k => m[k] as number) }
const train: Array<{x:number[];y:number}> = []
for (let k=0;k<16;k++) {
  const seed=7000+k*53
  const {truth,image}=renderMasterStrip(seed,true)
  const cap=captureDirection(image,truth,'cw',seed+1,false)
  const out=runPipeline(cap.frames.map(f=>f.image),'cw')
  out.segments.forEach((m,i)=>train.push({x:vec(m),y:classes.indexOf(truth.segments[i].wearClass)}))
}
const dim=keys.length
const mean=Array.from({length:dim},(_,j)=>train.reduce((a,r)=>a+r.x[j],0)/train.length)
const std=Array.from({length:dim},(_,j)=>Math.sqrt(train.reduce((a,r)=>a+(r.x[j]-mean[j])**2,0)/train.length)||1)
const cent=classes.map((_,c)=>{const rows=train.filter(r=>r.y===c); return Array.from({length:dim},(_,j)=>rows.reduce((a,r)=>a+(r.x[j]-mean[j])/std[j],0)/rows.length)})
function emit(m:SegmentMetric,c:number) { const x=vec(m).map((v,j)=>(v-mean[j])/std[j]); let d=0; for(let j=0;j<dim;j++)d+=(x[j]-cent[c][j])**2; return d/dim }
function viterbi(ms:SegmentMetric[], lambda:number) {
  const n=ms.length, K=7
  let dp=classes.map((_,c)=>emit(ms[0],c)); let ptr:number[][]=[new Array(K).fill(-1)]
  for(let i=1;i<n;i++){ const nd=new Array(K).fill(Infinity); const ps=new Array(K).fill(0); for(let c=0;c<K;c++){const e=emit(ms[i],c); for(let p=0;p<K;p++){const v=dp[p]+e+lambda*Math.abs(c-p); if(v<nd[c]){nd[c]=v;ps[c]=p}}} dp=nd; ptr.push(ps) }
  let c=dp.indexOf(Math.min(...dp)); const out=[c]
  for(let i=n-1;i>0;i--){c=ptr[i][c];out.unshift(c)} return out
}
const recipe=[[120,6],[180,5],[240,4],[400,2],[400,4],[600,4],[400,5]] as const
for (const lambda of [0, .5, 1, 1.8, 3]) {
  let total=0, clsOk=0, exact=0
  for (const [seed,rand] of [[20261126,false],[101,true],[202,true],[303,true],[404,true],[505,true]] as const) {
    const {truth,image}=renderMasterStrip(seed,rand)
    const cap=captureDirection(image,truth,'cw',seed+11,false)
    const out=runPipeline(cap.frames.map(f=>f.image),'cw')
    const pred=viterbi(out.segments,lambda)
    for(let i=0;i<36;i++){total++; if(pred[i]===classes.indexOf(truth.segments[i].wearClass))clsOk++; let [g,p]=recipe[pred[i]]; if(out.segments[i].chip){g=180;p=3} const tv=truth.segments[i].veteran; if(g===tv.grit&&p===tv.passes)exact++}
  }
  console.log('lambda',lambda,'class',clsOk/total,'exact',exact/total)
}
