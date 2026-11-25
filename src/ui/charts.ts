import { BAND_BOTTOM, BAND_HEIGHT, BAND_TOP, SEGMENT_COUNT } from '../config.ts'
import type { RawImage, SegmentMetric } from '../types.ts'

export function roughnessColor(r: number, alpha = 1): string {
  // 0 蓝灰(磨平/釉化) -> 青/绿(理想) -> 琥珀 -> 红(过粗/深划痕)
  const stops = [
    { p: 0, c: [54, 116, 181] },
    { p: 0.28, c: [72, 187, 196] },
    { p: 0.5, c: [76, 175, 110] },
    { p: 0.68, c: [232, 176, 64] },
    { p: 0.84, c: [224, 103, 52] },
    { p: 1, c: [190, 45, 54] },
  ]
  let a = stops[0]
  let b = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (r >= stops[i].p && r <= stops[i + 1].p) {
      a = stops[i]
      b = stops[i + 1]
      break
    }
  }
  const t = Math.max(0, Math.min(1, (r - a.p) / Math.max(0.001, b.p - a.p)))
  const rgb = a.c.map((v, i) => Math.round(v + (b.c[i] - v) * t))
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`
}

export function setupHiDpi(canvas: HTMLCanvasElement, cssHeight: number): { ctx: CanvasRenderingContext2D; width: number; height: number } {
  const cssWidth = canvas.clientWidth || canvas.parentElement?.clientWidth || 900
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.max(1, Math.round(cssWidth * dpr))
  canvas.height = Math.max(1, Math.round(cssHeight * dpr))
  canvas.style.height = `${cssHeight}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { ctx, width: cssWidth, height: cssHeight }
}

export interface CurveSeries {
  values: number[]
  color: string
  label?: string
  dashed?: boolean
  fill?: boolean
}

export function drawCurveChart(
  canvas: HTMLCanvasElement,
  series: CurveSeries[],
  options: { selected?: number; chips?: Array<{ segment: number }>; height?: number; showIdeal?: boolean } = {},
): void {
  const { ctx, width, height } = setupHiDpi(canvas, options.height ?? 280)
  ctx.clearRect(0, 0, width, height)
  const padL = 42
  const padR = 16
  const padT = 18
  const padB = 34
  const plotW = width - padL - padR
  const plotH = height - padT - padB
  const x = (i: number): number => padL + (i / (SEGMENT_COUNT - 1)) * plotW
  const y = (v: number): number => padT + (1 - Math.max(0, Math.min(1, v))) * plotH

  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim() || '#f4f6f8'
  ctx.fillRect(padL, padT, plotW, plotH)

  if (options.showIdeal !== false) {
    const y1 = y(0.58)
    const y2 = y(0.43)
    ctx.fillStyle = 'rgba(54, 170, 110, 0.13)'
    ctx.fillRect(padL, y1, plotW, y2 - y1)
    ctx.strokeStyle = 'rgba(54,170,110,.45)'
    ctx.setLineDash([5, 5])
    ctx.beginPath()
    ctx.moveTo(padL, y(0.43))
    ctx.lineTo(padL + plotW, y(0.43))
    ctx.moveTo(padL, y(0.58))
    ctx.lineTo(padL + plotW, y(0.58))
    ctx.stroke()
    ctx.setLineDash([])
  }

  ctx.strokeStyle = 'rgba(120,130,145,.28)'
  ctx.lineWidth = 1
  ctx.font = '11px system-ui, sans-serif'
  ctx.fillStyle = '#667085'
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    ctx.beginPath()
    ctx.moveTo(padL, y(v))
    ctx.lineTo(padL + plotW, y(v))
    ctx.stroke()
    ctx.textAlign = 'right'
    ctx.fillText(v.toFixed(2), padL - 7, y(v) + 4)
  }
  for (let s = 0; s < SEGMENT_COUNT; s += 6) {
    ctx.textAlign = 'center'
    ctx.fillText(`${s + 1}`, x(s), height - 12)
    ctx.strokeStyle = 'rgba(120,130,145,.16)'
    ctx.beginPath()
    ctx.moveTo(x(s), padT)
    ctx.lineTo(x(s), padT + plotH)
    ctx.stroke()
  }
  ctx.textAlign = 'left'
  ctx.fillText('段号', padL + plotW - 28, height - 12)

  for (const chip of options.chips ?? []) {
    const cx = x(chip.segment)
    ctx.fillStyle = 'rgba(20,22,26,.72)'
    ctx.beginPath()
    ctx.moveTo(cx, padT + plotH + 2)
    ctx.lineTo(cx - 6, padT + plotH + 12)
    ctx.lineTo(cx + 6, padT + plotH + 12)
    ctx.closePath()
    ctx.fill()
  }

  for (const s of series) {
    if (s.fill) {
      const gradient = ctx.createLinearGradient(0, padT, 0, padT + plotH)
      gradient.addColorStop(0, s.color.replace('1)', '.28)'))
      gradient.addColorStop(1, s.color.replace('1)', '.02)'))
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.moveTo(x(0), y(s.values[0] ?? 0))
      for (let i = 1; i < s.values.length; i++) ctx.lineTo(x(i), y(s.values[i]))
      ctx.lineTo(x(s.values.length - 1), padT + plotH)
      ctx.lineTo(x(0), padT + plotH)
      ctx.closePath()
      ctx.fill()
    }
    ctx.strokeStyle = s.color
    ctx.lineWidth = 2.4
    ctx.lineJoin = 'round'
    if (s.dashed) ctx.setLineDash([7, 5])
    ctx.beginPath()
    s.values.forEach((v, i) => {
      if (i === 0) ctx.moveTo(x(i), y(v))
      else ctx.lineTo(x(i), y(v))
    })
    ctx.stroke()
    ctx.setLineDash([])
    for (let i = 0; i < s.values.length; i++) {
      ctx.fillStyle = roughnessColor(s.values[i], 0.95)
      ctx.beginPath()
      ctx.arc(x(i), y(s.values[i]), 2.7, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  if (options.selected !== undefined) {
    const sx = x(options.selected)
    ctx.strokeStyle = '#111827'
    ctx.lineWidth = 1.4
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(sx, padT)
    ctx.lineTo(sx, padT + plotH)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#111827'
    ctx.beginPath()
    ctx.arc(sx, y(series[0]?.values[options.selected] ?? 0.5), 5.5, 0, Math.PI * 2)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.stroke()
  }
}

export interface BandOptions {
  segments?: SegmentMetric[]
  selected?: number
  heatmap?: boolean
  chips?: Array<{ segment: number; edge: string; severity: number }>
}

export function drawBandCanvas(canvas: HTMLCanvasElement, image: RawImage, options: BandOptions = {}): void {
  canvas.width = image.width
  canvas.height = image.height + 34
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const imageData = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height)
  ctx.putImageData(imageData, 0, 0)
  const segW = image.width / SEGMENT_COUNT

  if (options.heatmap && options.segments) {
    options.segments.forEach((s, i) => {
      ctx.fillStyle = roughnessColor(s.roughness, 0.24)
      ctx.fillRect(i * segW, BAND_TOP, segW + 0.5, BAND_BOTTOM - BAND_TOP)
    })
  }

  ctx.strokeStyle = 'rgba(255,255,255,.72)'
  ctx.lineWidth = 1
  for (let i = 0; i <= SEGMENT_COUNT; i++) {
    const x = i * segW
    ctx.beginPath()
    ctx.moveTo(x, BAND_TOP - 8)
    ctx.lineTo(x, BAND_BOTTOM + 8)
    ctx.strokeStyle = i % 9 === 0 ? 'rgba(17,24,39,.75)' : 'rgba(17,24,39,.28)'
    ctx.stroke()
    if (i < SEGMENT_COUNT && i % 3 === 0) {
      ctx.fillStyle = '#111827'
      ctx.font = '16px system-ui, sans-serif'
      ctx.fillText(`${i + 1}`, x + 5, image.height + 24)
    }
  }

  for (const chip of options.chips ?? []) {
    const cx = (chip.segment + 0.5) * segW
    ctx.strokeStyle = 'rgba(255, 196, 0, .95)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(cx, chip.edge === 'lower' ? BAND_BOTTOM : BAND_TOP, 12 + chip.severity * 8, 0, Math.PI * 2)
    ctx.stroke()
  }

  if (options.selected !== undefined) {
    const x = options.selected * segW
    ctx.strokeStyle = '#0f172a'
    ctx.lineWidth = 4
    ctx.strokeRect(x + 1, BAND_TOP - 10, segW - 2, BAND_HEIGHT + 20)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.strokeRect(x + 3, BAND_TOP - 8, segW - 6, BAND_HEIGHT + 16)
  }
}

export function drawRingCanvas(canvas: HTMLCanvasElement, image: RawImage, options: BandOptions = {}): void {
  const size = 760
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = size * dpr
  canvas.height = size * dpr
  canvas.style.aspectRatio = '1 / 1'
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, size, size)
  const cx = size / 2
  const cy = size / 2
  const outer = size * 0.43
  const inner = outer - 118
  const ring = ctx.createImageData(size, size)
  const w = image.width
  const h = image.height

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const r = Math.sqrt(dx * dx + dy * dy)
      const p = (y * size + x) * 4
      if (r < inner || r > outer) {
        ring.data[p + 3] = 0
        continue
      }
      let f = (Math.atan2(dy, dx) + Math.PI / 2) / (Math.PI * 2)
      f = (f + 1) % 1
      const sx = Math.min(w - 1, Math.floor(f * w))
      const t = (outer - r) / (outer - inner)
      const sy = Math.max(0, Math.min(h - 1, Math.floor(BAND_TOP + t * (BAND_BOTTOM - BAND_TOP))))
      const si = (sy * w + sx) * 4
      ring.data[p] = image.data[si]
      ring.data[p + 1] = image.data[si + 1]
      ring.data[p + 2] = image.data[si + 2]
      ring.data[p + 3] = 255
    }
  }
  const tmp = document.createElement('canvas')
  tmp.width = size
  tmp.height = size
  tmp.getContext('2d')?.putImageData(ring, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(tmp, 0, 0, size, size)

  const angleFor = (s: number): number => -Math.PI / 2 + (s / SEGMENT_COUNT) * Math.PI * 2
  ctx.lineWidth = 1.4
  for (let s = 0; s < SEGMENT_COUNT; s++) {
    const a = angleFor(s)
    ctx.strokeStyle = s % 9 === 0 ? 'rgba(15,23,42,.8)' : 'rgba(255,255,255,.55)'
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner)
    ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer)
    ctx.stroke()
  }

  if (options.heatmap && options.segments) {
    options.segments.forEach((seg, i) => {
      const a0 = angleFor(i)
      const a1 = angleFor(i + 1)
      ctx.beginPath()
      ctx.arc(cx, cy, outer - 2, a0, a1)
      ctx.arc(cx, cy, inner + 2, a1, a0, true)
      ctx.closePath()
      ctx.fillStyle = roughnessColor(seg.roughness, 0.22)
      ctx.fill()
    })
  }

  for (const chip of options.chips ?? []) {
    const a = angleFor(chip.segment + 0.5)
    const r = chip.edge === 'lower' ? inner + 8 : outer - 8
    const x = cx + Math.cos(a) * r
    const y = cy + Math.sin(a) * r
    ctx.fillStyle = '#ffc400'
    ctx.strokeStyle = '#111827'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(x, y, 8 + chip.severity * 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  if (options.selected !== undefined) {
    const a0 = angleFor(options.selected)
    const a1 = angleFor(options.selected + 1)
    ctx.strokeStyle = '#0f172a'
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.arc(cx, cy, (inner + outer) / 2, a0, a1)
    ctx.stroke()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.stroke()
  }

  ctx.fillStyle = 'rgba(255,255,255,.86)'
  ctx.beginPath()
  ctx.arc(cx, cy, inner - 8, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#334155'
  ctx.font = '600 22px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('运行带', cx, cy - 4)
  ctx.font = '13px system-ui, sans-serif'
  ctx.fillStyle = '#64748b'
  ctx.fillText('36 段闭合', cx, cy + 18)
}
