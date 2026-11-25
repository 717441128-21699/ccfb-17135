import { runPipeline } from '../src/core/pipeline.ts'
import { captureDirection, renderMasterStrip } from '../src/synth/generate.ts'

const samples: Array<{ x: number; y: number }> = []
const classIndex = { glazed:0, smooth:1, lightly_smooth:2, uniform:3, rough:4, scratched:5, coarse:6 } as const
for (let k=0;k<24;k++) {
  const seed=4242+k*101
  const {truth,image}=renderMasterStrip(seed,true)
  const cap=captureDirection(image,truth,'cw',seed+7,false)
  const out=runPipeline(cap.frames.map(f=>f.image),'cw')
  out.segments.forEach((m,i)=>samples.push({x:m.roughness,y:classIndex[truth.segments[i].wearClass]}))
}
samples.sort((a,b)=>a.x-b.x)
const n=samples.length, K=7
const prefix=Array.from({length:7},()=>new Int32Array(n+1))
for(let c=0;c<7;c++) for(let i=0;i<n;i++) prefix[c][i+1]=prefix[c][i]+(samples[i].y===c?1:0)
function cost(l:number,r:number,c:number){ const count=prefix[c][r]-prefix[c][l]; return (r-l)-count }
// dp[k][i] min errors assigning first i sorted samples to k ordered classes
const dp=Array.from({length:K+1},()=>new Float64Array(n+1).fill(Infinity))
const parent=Array.from({length:K+1},()=>new Int32Array(n+1).fill(-1))
dp[0][0]=0
for(let k=1;k<=K;k++){
  for(let i=k;i<=n;i++){
    for(let j=k-1;j<i;j++){
      const v=dp[k-1][j]+cost(j,i,k-1)
      if(v<dp[k][i]){dp[k][i]=v;parent[k][i]=j}
    }
  }
}
console.log('best class accuracy',1-dp[K][n]/n)
const bounds:number[]=[]
let i=n
for(let k=K;k>=1;k--){ const j=parent[k][i]; if(k>1 && j>0) bounds.unshift((samples[j-1].x+samples[j].x)/2); i=j }
console.log('bounds',bounds.map(x=>x.toFixed(4)).join(', '))
// confusion after bounds
let exactRecipe=0, total=0
const recipe= [[120,6],[180,5],[240,4],[400,2],[400,4],[600,4],[400,5]] as const
for(let k=0;k<6;k++){}
for (let s=0;s<samples.length;s++) {
  let c=0; while(c<6 && samples[s].x>bounds[c]) c++
  // We do not have recipe labels here; class accuracy is the output.
  total++
  if(c===samples[s].y) exactRecipe++
}
console.log('check',exactRecipe/total)
