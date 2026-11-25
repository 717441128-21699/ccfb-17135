import { runPipeline } from '../src/core/pipeline.ts'
import { captureDirection, renderMasterStrip } from '../src/synth/generate.ts'

const seeds = [20261126, 101, 202, 303, 404, 505, 606, 707]
const rows: number[][] = []
const ys: number[] = []
for (let k=0;k<seeds.length;k++) {
  const seed=seeds[k]
  const {truth,image}=renderMasterStrip(seed,k>0)
  const cw=captureDirection(image,truth,'cw',seed+11,false)
  const out=runPipeline(cw.frames.map(f=>f.image),'cw')
  for (let i=0;i<36;i++) {
    const m=out.segments[i]
    rows.push([1,m.scratchDensity,m.scratchEnergy,m.anisotropy,m.rowEnergy,m.gloss,m.meanLuma,m.highlight])
    ys.push(truth.segments[i].roughness)
  }
}
function corr(xs:number[], ys:number[]):number {
  const mx=xs.reduce((a,b)=>a+b,0)/xs.length, my=ys.reduce((a,b)=>a+b,0)/ys.length
  let n=0,dx=0,dy=0
  for(let i=0;i<xs.length;i++){const x=xs[i]-mx,y=ys[i]-my;n+=x*y;dx+=x*x;dy+=y*y}
  return n/Math.sqrt(dx*dy)
}
for (let j=1;j<rows[0].length;j++) console.log('feature',j,'corr',corr(rows.map(r=>r[j]),ys).toFixed(4),'mean', (rows.reduce((a,r)=>a+r[j],0)/rows.length).toFixed(4))
// Solve least squares via normal equations.
const p=rows[0].length
const XtX=Array.from({length:p},()=>new Float64Array(p))
const Xty=new Float64Array(p)
for (let r=0;r<rows.length;r++) {
  for (let a=0;a<p;a++) {
    Xty[a]+=rows[r][a]*ys[r]
    for (let b=0;b<p;b++) XtX[a][b]+=rows[r][a]*rows[r][b]
  }
}
for (let i=0;i<p;i++) {
  let pivot=i
  for (let j=i+1;j<p;j++) if (Math.abs(XtX[j][i])>Math.abs(XtX[pivot][i])) pivot=j
  ;[XtX[i],XtX[pivot]]=[XtX[pivot],XtX[i]]
  const ti=Xty[i]; Xty[i]=Xty[pivot]; Xty[pivot]=ti
  for (let j=i+1;j<p;j++) {
    const f=XtX[j][i]/XtX[i][i]
    for (let c=i;c<p;c++) XtX[j][c]-=f*XtX[i][c]
    Xty[j]-=f*Xty[i]
  }
}
const beta=new Float64Array(p)
for (let i=p-1;i>=0;i--) {
  let sum=Xty[i]
  for (let j=i+1;j<p;j++) sum-=XtX[i][j]*beta[j]
  beta[i]=sum/XtX[i][i]
}
console.log('beta', Array.from(beta).map(x=>x.toFixed(4)).join(', '))
let mae=0
for (let r=0;r<rows.length;r++) {
  let y=0; for (let j=0;j<p;j++) y+=beta[j]*rows[r][j]
  y=Math.max(0,Math.min(1,y))
  mae+=Math.abs(y-ys[r])
}
console.log('fit MAE',mae/rows.length)
