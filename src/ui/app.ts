import type { Direction, RawImage } from '../types.ts'
import {
  emit,
  generateCaptures,
  navigate,
  runAnalysis,
  runUploadedFrames,
  saveCurrentReport,
  selectSegment,
  setActiveDirection,
  setComparisonReport,
  state,
  subscribe,
  syncPageFromHash,
  toggleHeatmap,
  toggleTruthOverlay,
} from '../state/store.ts'
import { renderCompare, drawCompareAfterRender } from './compare-page.ts'
import { renderGuide } from './guide-page.ts'
import { drawStitchAfterRender, renderStitch } from './stitch-page.ts'
import { drawUnwrapAfterRender, renderUnwrap } from './unwrap-page.ts'

const TABS: Array<{ id: typeof state.page; label: string }> = [
  { id: 'guide', label: '1 拍摄引导' },
  { id: 'stitch', label: '2 环形拼接' },
  { id: 'unwrap', label: '3 展开 / 粗糙度' },
  { id: 'compare', label: '4 磨损对比' },
]

function shell(content: string): string {
  return `
  <header class="app-header">
    <div class="brand">
      <div class="brand-mark">壶</div>
      <div>
        <h1>冰壶运行带巡检工作台</h1>
        <small>环形微距拼接 · 纹理抑制粗糙度 · 36 段施工建议</small>
      </div>
    </div>
    <nav class="nav-tabs" aria-label="主导航">
      ${TABS.map((t) => `<button class="nav-tab ${state.page === t.id ? 'active' : ''}" data-page="${t.id}">${t.label}</button>`).join('')}
    </nav>
    <div class="header-meta">
      <strong>${state.stoneId}</strong>
      <span>Web Worker 计算 · TypeScript</span>
    </div>
  </header>
  <main>${content}</main>`
}

function afterRender(): void {
  if (state.page === 'stitch') drawStitchAfterRender(state)
  if (state.page === 'unwrap') drawUnwrapAfterRender(state)
  if (state.page === 'compare') drawCompareAfterRender(state)
}

async function filesToRawImages(files: FileList): Promise<RawImage[]> {
  const raws: RawImage[] = []
  for (const file of Array.from(files)) {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 240
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height)
    const sw = canvas.width / scale
    const sh = canvas.height / scale
    ctx.drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, 0, 0, 320, 240)
    const data = ctx.getImageData(0, 0, 320, 240)
    raws.push({ width: 320, height: 240, data: data.data })
    bitmap.close?.()
  }
  return raws
}

export function mountApp(root: HTMLElement): void {
  const render = (): void => {
    const page =
      state.page === 'guide'
        ? renderGuide(state)
        : state.page === 'stitch'
          ? renderStitch(state)
          : state.page === 'unwrap'
            ? renderUnwrap(state)
            : renderCompare(state)
    root.innerHTML = shell(page)
    requestAnimationFrame(afterRender)
  }
  subscribe(render)
  window.addEventListener('hashchange', syncPageFromHash)
  render()

  root.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-page],[data-action]')
    if (!target) return
    const page = target.dataset.page as typeof state.page | undefined
    const action = target.dataset.action
    if (page) {
      navigate(page)
      return
    }
    if (!action) return

    switch (action) {
      case 'generate-captures':
        generateCaptures()
        break
      case 'run-both':
        await runAnalysis('both')
        break
      case 'run-cw':
        await runAnalysis('cw')
        break
      case 'run-ccw':
        await runAnalysis('ccw')
        break
      case 'direction':
        setActiveDirection((target.dataset.direction ?? 'cw') as Direction)
        break
      case 'select-segment':
        selectSegment(Number(target.dataset.index ?? 0))
        break
      case 'save-report':
        saveCurrentReport()
        break
      case 'toggle-heatmap':
        toggleHeatmap()
        break
      case 'toggle-truth':
        toggleTruthOverlay()
        break
    }
  })

  root.addEventListener('change', async (event) => {
    const input = event.target as HTMLInputElement | HTMLSelectElement
    if (input.dataset.input === 'compare-report') {
      setComparisonReport(input.value)
      return
    }
    if (input instanceof HTMLInputElement && input.id === 'real-files' && input.files?.length) {
      try {
        const frames = await filesToRawImages(input.files)
        if (frames.length >= 2) await runUploadedFrames(frames)
      } catch (error) {
        state.progress.error = error instanceof Error ? error.message : String(error)
        emit()
      } finally {
        input.value = ''
      }
    }
  })
}
