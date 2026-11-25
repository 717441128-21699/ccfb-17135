import { PNG } from 'pngjs'
import { writeFileSync } from 'node:fs'
import { renderMasterStrip } from '../src/synth/generate.ts'
import { captureDirection } from '../src/synth/generate.ts'

const seed = Number(process.argv[2] ?? 20261126)
const random = process.argv[3] === 'rand'
const { image, truth } = renderMasterStrip(seed, random)
const png = new PNG({ width: image.width, height: image.height })
png.data.set(image.data)
writeFileSync('debug-strip.png', PNG.sync.write(png))
const cap = captureDirection(image, truth, 'cw', seed + 1, false)
const f = cap.frames[0].image
const fpng = new PNG({ width: f.width, height: f.height })
fpng.data.set(f.data)
writeFileSync('debug-frame.png', PNG.sync.write(fpng))
console.log('wrote debug-strip.png and debug-frame.png')
