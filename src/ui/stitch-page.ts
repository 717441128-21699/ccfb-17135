import { CIRCUMFERENCE_MM, MM_PER_PX } from '../config.ts'
import type { AppState } from '../state/store.ts'
import { drawRingCanvas } from './charts.ts'

export function renderStitch(state: AppState): string {
  const result = state.activeDirection === 'cw' ? state.cwResult : state.ccwResult
  const p = state.progress

  if (!result) {
    return `
    <div class="page">
      <div class="empty card" style="padding:70px 24px">
        <div class="big">🧩</div>
        <h2>还没有可展示的环形拼接结果</h2>
        <p>先合成 40 张带重叠的微距照片，并交由 Web Worker 完成 NCC 配准、闭合差分配、曝光和对焦归一化。</p>
        <div class="inline-actions">
          <button class="btn primary" data-action="run-both" ${p.running ? 'disabled' : ''}>${p.running ? p.stage : '一键生成并拼接'}</button>
          <button class="btn" data-page="guide">返回拍摄引导</button>
        </div>
        ${p.running ? `<div style="width:min(420px,100%)"><div class="progress-track"><div class="progress-fill" style="width:${p.percent}%"></div></div><div class="progress-line"><span>${p.stage}</span><strong>${p.percent}%</strong></div></div>` : ''}
      </div>
    </div>`
  }

  const avgScore = result.stitch.seams.reduce((a, s) => a + s.score, 0) / Math.max(1, result.stitch.seams.length)
  const alignment = state.cwResult?.alignment
  return `
  <div class="page grid two">
    <section class="card">
      <div class="card-title-row">
        <h2>② 环形拼接</h2>
        <div class="inline-actions">
          <div class="segmented">
            <button class="btn small ${state.activeDirection === 'cw' ? 'primary' : ''}" data-action="direction" data-direction="cw">顺时针</button>
            <button class="btn small ${state.activeDirection === 'ccw' ? 'primary' : ''}" data-action="direction" data-direction="ccw">逆时针</button>
          </div>
        </div>
      </div>
      <p class="sub">Worker 按重叠区做归一化互相关配准，将首尾闭合差均匀分配到接缝，再把长带按极坐标映射为整圈。黄圈为边缘崩口。</p>
      <div class="canvas-frame ring-canvas"><canvas id="ring-canvas"></canvas></div>
      <div class="inline-actions" style="justify-content:center;margin-top:12px">
        <button class="btn" data-action="run-cw">重算顺转</button>
        <button class="btn" data-action="run-ccw">重算倒转</button>
        <button class="btn primary" data-page="unwrap">进入展开与粗糙度</button>
      </div>
    </section>

    <aside class="grid" style="align-content:start">
      <div class="grid two">
        <div class="kpi"><span>闭合周长</span><strong>${(result.stitch.circumferencePx * MM_PER_PX / 10).toFixed(1)} cm</strong><small>标定真值 ${(CIRCUMFERENCE_MM / 10).toFixed(1)} cm</small></div>
        <div class="kpi"><span>平均接缝 NCC</span><strong>${(avgScore * 100).toFixed(1)}%</strong><small>首尾 ${(result.stitch.closureScore * 100).toFixed(1)}%</small></div>
        <div class="kpi"><span>拼接+分析</span><strong>${(result.totalElapsedMs / 1000).toFixed(2)}s</strong><small>40 张远低于 2 分钟</small></div>
        <div class="kpi"><span>CW/CCW 相关</span><strong>${alignment ? alignment.correlation.toFixed(3) : '—'}</strong><small>${alignment ? `平均差 ${alignment.meanAbsDifference.toFixed(3)}` : '运行两套后显示'}</small></div>
      </div>

      <div class="card" style="padding:16px">
        <div class="card-title-row"><h3>接缝配准质量</h3><span class="badge good">${result.stitch.seams.length + 1} 个闭合关系</span></div>
        <div class="seam-list">
          ${result.stitch.seams
            .map(
              (s) => `
            <div class="seam-row">
              <span>#${s.from + 1}→${s.to + 1}</span>
              <div class="seam-meter"><i style="width:${Math.max(0, Math.min(100, s.score * 100))}%"></i></div>
              <strong>${s.score.toFixed(3)}</strong>
            </div>`,
            )
            .join('')}
          <div class="seam-row">
            <span>末→首</span>
            <div class="seam-meter"><i style="width:${result.stitch.closureScore * 100}%"></i></div>
            <strong>${result.stitch.closureScore.toFixed(3)}</strong>
          </div>
        </div>
      </div>

      <div class="notice">
        曝光增益范围 ${Math.min(...result.stitch.exposureGains).toFixed(2)}–${Math.max(...result.stitch.exposureGains).toFixed(2)}；
        对焦分已用于锐化/柔化补偿与融合权重，避免把明暗或虚焦差异误读成磨损。
      </div>
    </aside>
  </div>`
}

export function drawStitchAfterRender(state: AppState): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#ring-canvas')
  const result = state.activeDirection === 'cw' ? state.cwResult : state.ccwResult
  if (canvas && result) {
    drawRingCanvas(canvas, result.stitch.image, {
      segments: result.segments,
      chips: result.chips,
      selected: state.selectedSegment,
      heatmap: state.showHeatmap,
    })
  }
}
