import type { RawImage } from '../types.ts'
import { clamp } from './rng.ts'

export function createImage(width: number, height: number, fill?: [number, number, number]): RawImage {
  const data = new Uint8ClampedArray(width * height * 4)
  if (fill) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0]
      data[i + 1] = fill[1]
      data[i + 2] = fill[2]
      data[i + 3] = 255
    }
  } else {
    for (let i = 3; i < data.length; i += 4) data[i] = 255
  }
  return { width, height, data }
}

export function cloneImage(img: RawImage): RawImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
}

export function grayScale(img: RawImage): Float32Array {
  const out = new Float32Array(img.width * img.height)
  const d = img.data
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    out[p] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  }
  return out
}

export function pixelIndex(width: number, x: number, y: number): number {
  return (y * width + x) * 4
}

export function blendPixel(
  img: RawImage,
  x: number,
  y: number,
  color: [number, number, number],
  alpha: number,
): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || alpha <= 0) return
  const i = pixelIndex(img.width, x | 0, y | 0)
  const a = clamp(alpha, 0, 1)
  img.data[i] = img.data[i] * (1 - a) + color[0] * a
  img.data[i + 1] = img.data[i + 1] * (1 - a) + color[1] * a
  img.data[i + 2] = img.data[i + 2] * (1 - a) + color[2] * a
}

export function fillEllipse(
  img: RawImage,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: [number, number, number],
  alpha: number,
): void {
  const x0 = Math.max(0, Math.floor(cx - rx - 1))
  const x1 = Math.min(img.width - 1, Math.ceil(cx + rx + 1))
  const y0 = Math.max(0, Math.floor(cy - ry - 1))
  const y1 = Math.min(img.height - 1, Math.ceil(cy + ry + 1))
  const rxE = Math.max(0.001, rx * rx)
  const ryE = Math.max(0.001, ry * ry)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const q = (dx * dx) / rxE + (dy * dy) / ryE
      if (q <= 1) {
        const edge = clamp((1 - q) * Math.min(rx, ry) * 0.9, 0, 1)
        blendPixel(img, x, y, color, alpha * edge)
      }
    }
  }
}

/** Filled polygon using scanline membership. Points are integer-ish pixel centers. */
export function fillPolygon(
  img: RawImage,
  points: Array<[number, number]>,
  color: [number, number, number],
  alpha: number,
): void {
  let minY = Infinity
  let maxY = -Infinity
  for (const [, y] of points) {
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  minY = Math.max(0, Math.floor(minY))
  maxY = Math.min(img.height - 1, Math.ceil(maxY))
  for (let y = minY; y <= maxY; y++) {
    const intersections: number[] = []
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i]
      const [x2, y2] = points[(i + 1) % points.length]
      if ((y1 <= y + 0.5 && y2 > y + 0.5) || (y2 <= y + 0.5 && y1 > y + 0.5)) {
        const t = (y + 0.5 - y1) / (y2 - y1)
        intersections.push(x1 + t * (x2 - x1))
      }
    }
    intersections.sort((a, b) => a - b)
    for (let k = 0; k + 1 < intersections.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(intersections[k] - 0.5))
      const x1 = Math.min(img.width - 1, Math.floor(intersections[k + 1] - 0.5))
      for (let x = x0; x <= x1; x++) blendPixel(img, x, y, color, alpha)
    }
  }
}

export function drawLine(
  img: RawImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: [number, number, number],
  alpha: number,
  thickness = 1,
): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.2))
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    const x = x0 + (x1 - x0) * t
    const y = y0 + (y1 - y0) * t
    if (thickness <= 1) {
      blendPixel(img, Math.round(x), Math.round(y), color, alpha)
    } else {
      fillEllipse(img, x, y, thickness * 0.55, thickness * 0.55, color, alpha)
    }
  }
}

/** Separable box blur. Radius 1 is a 3x3 blur; repeated calls approximate larger kernels. */
export function boxBlur(src: RawImage, radius: number, iterations = 1): RawImage {
  if (radius < 1 || iterations < 1) return cloneImage(src)
  let current = cloneImage(src)
  const { width: w, height: h } = current
  for (let iter = 0; iter < iterations; iter++) {
    const tmp = createImage(w, h)
    const out = createImage(w, h)
    const r = Math.round(radius)
    const window = 2 * r + 1
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0
        for (let x = -r; x <= r; x++) {
          const xx = Math.min(w - 1, Math.max(0, x))
          sum += current.data[(y * w + xx) * 4 + c]
        }
        for (let x = 0; x < w; x++) {
          tmp.data[(y * w + x) * 4 + c] = sum / window
          const xRemove = Math.min(w - 1, Math.max(0, x - r))
          const xAdd = Math.min(w - 1, Math.max(0, x + r + 1))
          sum += current.data[(y * w + xAdd) * 4 + c] - current.data[(y * w + xRemove) * 4 + c]
        }
      }
    }
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0
        for (let y = -r; y <= r; y++) {
          const yy = Math.min(h - 1, Math.max(0, y))
          sum += tmp.data[(yy * w + x) * 4 + c]
        }
        for (let y = 0; y < h; y++) {
          out.data[(y * w + x) * 4 + c] = sum / window
          const yRemove = Math.min(h - 1, Math.max(0, y - r))
          const yAdd = Math.min(h - 1, Math.max(0, y + r + 1))
          sum += tmp.data[(yAdd * w + x) * 4 + c] - tmp.data[(yRemove * w + x) * 4 + c]
        }
      }
    }
    current = out
  }
  return current
}

export function unsharpMask(src: RawImage, amount: number, radius = 1): RawImage {
  if (amount <= 0.01) return cloneImage(src)
  const blurred = boxBlur(src, radius)
  const out = cloneImage(src)
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const sharpened = src.data[i + c] + amount * (src.data[i + c] - blurred.data[i + c])
      out.data[i + c] = sharpened
    }
  }
  return out
}

export function adjustGain(src: RawImage, gain: number): RawImage {
  const out = cloneImage(src)
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] *= gain
    out.data[i + 1] *= gain
    out.data[i + 2] *= gain
  }
  return out
}

/** Horizontal wrapped crop used by the circular capture path. */
export function cropWrapX(
  src: RawImage,
  startX: number,
  width: number,
  height = src.height,
  startY = 0,
): RawImage {
  const out = createImage(width, height)
  const sw = src.width
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.max(0, y + startY))
    for (let x = 0; x < width; x++) {
      let sx = (startX + x) % sw
      if (sx < 0) sx += sw
      const si = (sy * sw + sx) * 4
      const di = (y * width + x) * 4
      out.data[di] = src.data[si]
      out.data[di + 1] = src.data[si + 1]
      out.data[di + 2] = src.data[si + 2]
      out.data[di + 3] = src.data[si + 3]
    }
  }
  return out
}

export function downsampleGray(img: RawImage, factor: number): { gray: Float32Array; width: number; height: number } {
  const width = Math.floor(img.width / factor)
  const height = Math.floor(img.height / factor)
  const gray = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      let count = 0
      for (let dy = 0; dy < factor; dy++) {
        const sy = y * factor + dy
        if (sy >= img.height) continue
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx
          if (sx >= img.width) continue
          const i = (sy * img.width + sx) * 4
          sum += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]
          count++
        }
      }
      gray[y * width + x] = sum / Math.max(1, count)
    }
  }
  return { gray, width, height }
}

export function imageToCanvas(img: RawImage, canvas?: HTMLCanvasElement): HTMLCanvasElement {
  const el = canvas ?? document.createElement('canvas')
  el.width = img.width
  el.height = img.height
  const ctx = el.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  const imageData = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height)
  ctx.putImageData(imageData, 0, 0)
  return el
}

export function canvasToImage(canvas: HTMLCanvasElement): RawImage {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { width: canvas.width, height: canvas.height, data: data.data }
}
