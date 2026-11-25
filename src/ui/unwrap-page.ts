import { SEGMENT_COUNT } from '../config.ts'
import { gritLabel } from '../core/expert.ts'
import type { AppState } from '../state/store.ts'
import { drawBandCanvas, drawCurveChart, roughnessColor, type CurveSeries } from './charts.ts'

export function renderUnwrap(state: AppState): string {
  const result = state.activeDirection === 'cw' ? state.cwResult : state.ccwResult
  if (!result) {
    return `<div class="page"><div class="empty card" style="padding:70px 24px"><div class="big">📏</div><h2>展开带尚未生成</h2><p>请先完成环形拼接与 Worker 粗糙度计算。</p><button class="btn primary" data-action="run-both">一键生成</button></div></div>`
  }
  const i = state.selectedSegment
  const metric = result.segments[i]
  const recipe = result.prescriptions[i]
  const truth = state.showTruthOverlay ? state.captures?.truth : null

  return `
  <div class="page grid">
    <section class="card">
      <div class="card-title-row">
        <h2>③ 运行带展开与 36 段粗糙度</h2>
        <div class="inline-actions">
          <button class="btn small ${state.showHeatmap ? 'primary' : ''}" data-action="toggle-heatmap">粗糙度色罩</button>
          <button class="btn small ${state.showTruthOverlay ? 'primary' : ''}" data-action="toggle-truth">合成真值</button>
          <div>
            <button class="btn small ${state.activeDirection === 'cw' ? '' : 'ghost'}" data-action="direction" data-direction="cw">顺转</button>
            <button class="btn small ${state.activeDirection === 'ccw' ? '' : 'ghost'}" data-action="direction" data-direction="ccw">倒转</button>
          </div>
        </div>
      </div>
      <p class="sub">长带由环形拼接结果直接展开；色罩蓝=磨平/强反光，绿=目标窗口，红=粗糙/深划痕。点击段号可查看建议。</p>
      <div class="band-scroll"><canvas id="band-canvas"></canvas></div>
    </section>

    <section class="card">
      <div class="card-title-row"><h2>整圈粗糙度曲线</h2><span class="badge info">目标窗口 0.43–0.58</span></div>
      <div class="canvas-frame"><canvas id="roughness-curve"></canvas></div>
    </section>

    <section class="grid two">
      <div class="card">
        <div class="card-title-row"><h3>36 段打磨建议</h3><span class="badge">点击方块定位</span></div>
        <div class="segment-grid">
          ${result.segments
            .map(
              (s) => `
            <button class="segment-tile ${s.index === i ? 'selected' : ''}" data-action="select-segment" data-index="${s.index}" style="--tile:${roughnessColor(s.roughness)}">
              ${s.chip ? '<i class="chip-dot" title="崩口"></i>' : ''}
              <b>${String(s.index + 1).padStart(2, '0')}</b>
              <div class="r">R ${s.roughness.toFixed(2)}</div>
              <div class="recipe">${gritLabel(result.prescriptions[s.index].grit)} ×${result.prescriptions[s.index].passes}</div>
            </button>`,
            )
            .join('')}
        </div>
      </div>

      <aside class="grid" style="align-content:start">
        <div class="card">
          <div class="card-title-row">
            <h3>第 ${i + 1} 段诊断</h3>
            ${metric.chip ? '<span class="badge warn">边缘崩口</span>' : ''}
          </div>
          <div class="detail-grid">
            <div class="detail-item"><span>粗糙度指数</span><strong>${metric.roughness.toFixed(3)}</strong></div>
            <div class="detail-item"><span>段内不均匀</span><strong>${metric.unevenness.toFixed(2)}</strong></div>
            <div class="detail-item"><span>划痕密度</span><strong>${(metric.scratchDensity * 100).toFixed(2)}%</strong></div>
            <div class="detail-item"><span>反光覆盖</span><strong>${(metric.gloss * 100).toFixed(1)}%</strong></div>
            <div class="detail-item"><span>方向各向异性</span><strong>${metric.anisotropy.toFixed(3)}</strong></div>
            <div class="detail-item"><span>置信度</span><strong>${(metric.confidence * 100).toFixed(0)}%</strong></div>
          </div>
          <div class="recipe-box">
            <div style="display:flex;justify-content:space-between;gap:12px;align-items:center">
              <div class="grit">${gritLabel(recipe.grit)}</div>
              <div style="text-align:right"><div style="font-size:28px;font-weight:950">${recipe.passes} 遍</div><div>${recipe.action}</div></div>
            </div>
            ${recipe.finishGrit ? `<p>后续：${gritLabel(recipe.finishGrit)} × ${recipe.finishPasses} 遍收光。</p>` : ''}
            <p>${recipe.reason}</p>
          </div>
        </div>

        <div class="card">
          <h3>崩口单独标记</h3>
          ${
            result.chips.length
              ? result.chips
                  .map(
                    (c) => `
              <div class="notice warn" style="margin-bottom:9px">
                <strong>第 ${c.segment + 1} 段 · ${c.edge === 'upper' ? '上缘' : c.edge === 'lower' ? '下缘' : '上下缘'}</strong><br/>
                估算深度 ${(c.depthPx * 0.12).toFixed(1)} mm，宽度 ${(c.widthPx * 0.12).toFixed(1)} mm，置信度 ${(c.confidence * 100).toFixed(0)}%
              </div>`,
                  )
                  .join('')
              : '<p class="sub" style="margin:0">未检出达到阈值的边缘崩口。</p>'
          }
        </div>
      </aside>
    </section>
  </div>`
}

export function drawUnwrapAfterRender(state: AppState): void {
  const result = state.activeDirection === 'cw' ? state.cwResult : state.ccwResult
  if (!result) return
  const band = document.querySelector<HTMLCanvasElement>('#band-canvas')
  if (band) {
    drawBandCanvas(band, result.stitch.image, {
      segments: result.segments,
      chips: result.chips,
      selected: state.selectedSegment,
      heatmap: state.showHeatmap,
    })
  }
  const curve = document.querySelector<HTMLCanvasElement>('#roughness-curve')
  if (curve) {
    const series: CurveSeries[] = [
      { values: result.curve, color: '#0f766e', label: state.activeDirection.toUpperCase(), fill: true },
    ]
    if (state.showTruthOverlay && state.captures?.truth) {
      series.push({
        values: state.captures.truth.segments.map((s) => s.roughness),
        color: '#111827',
        dashed: true,
        label: '真值',
      })
    }
    drawCurveChart(curve, series, { selected: state.selectedSegment, chips: result.chips })
  }
}
