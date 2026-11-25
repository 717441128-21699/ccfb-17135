import { analyzeRoughness } from '../src/core/analysis.ts'
import { renderMasterStrip } from '../src/synth/generate.ts'

const groups: Record<string, Array<[number,number,number]>> = {}
for (let k=0;k<20;k++) {
  const seed=1000+k*37
  const {truth,image}=renderMasterStrip(seed,true)
  const out=analyzeRoughness(image)
  for (let i=0;i<36;i++) {
    const wc=truth.segments[i].wearClass
    groups[wc] ??= []
    groups[wc].push([out.segments[i].scratchDensity,out.segments[i].scratchEnergy,out.segments[i].gloss])
  }
}
for (const wc of ['glazed','smooth','lightly_smooth','uniform','rough','scratched','coarse']) {
  const g=groups[wc]
  const avg=(j:number)=>g.reduce((a,x)=>a+x[j],0)/g.length
  const sd=(j:number)=>Math.sqrt(g.reduce((a,x)=>a+(x[j]-avg(j))**2,0)/g.length)
  console.log(wc.padEnd(15),'n',g.length,'sd',avg(0).toFixed(4),'±',sd(0).toFixed(4),'en',avg(1).toFixed(3),'gl',avg(2).toFixed(3),'±',sd(2).toFixed(3))
}
