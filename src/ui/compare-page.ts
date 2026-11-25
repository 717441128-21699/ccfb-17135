import { SEGMENT_COUNT } from '../config.ts'
import { gritLabel } from '../core/expert.ts'
import { registeredReverseCurve } from '../core/alignment.ts'
import { getComparisonReport, type AppState } from '../state/store.ts'
import { formatDate } from '../state/reports.ts'
import type { InspectionReport, Prescription } from '../types.ts'
import { drawCurveChart, roughnessColor } from './charts.ts'
import { FIELD_VALIDATION } from '../generated/validation-metrics.ts'

function prescriptionEqual(a: Prescription, b: Prescription): boolean {
  return a.grit === b.grit && a.passes === b.passes
}

export function renderCompare(state: AppState): string {
  const activeResult = state.activeDirection === 'cw' ? state.cwResult : state.ccwResult
  const previous = getComparisonReport()
  const current: InspectionReport | null = state.currentReport
  const alignment = state.cwResult?.alignment ?? state.ccwResult?.alignment

  if (!activeResult || !current) {
    return `<div class="page"><div class="empty card" style="padding:70px 24px"><div class="big">📊</div><h2>还没有本次检查结果</h2><p>运行一套 40 张照片后，这里会对比上次检查、配准顺/倒转曲线，并逐段给出打磨量。</p><button class="btn primary" data-action="run-both">一键分析两套照片</button></div></div>`
  }

  const currentCurve = activeResult.curve
  const currentPrescriptions = activeResult.prescriptions
  let changed = 0
  let worse = 0
  let deltaSum = 0
  const rows = Array.from({ length: SEGMENT_COUNT }, (_, i) => {
    const nowR = currentCurve[i]
    const prevR = previous.curve[i] ?? 0.5
    const delta = nowR - prevR
    deltaSum += Math.abs(delta)
    if (delta > 0.12) worse++
    const nowP = currentPrescriptions[i]
    const prevP = previous.prescriptions[i]
    if (!prevP || !prescriptionEqual(nowP, prevP)) changed++
    return { i, nowR, prevR, delta, nowP, prevP }
  })
  const unevenSpots = activeResult.segments.filter((s) => s.unevenness >= 0.82).map((s) => s.index + 1)
  const meanDelta = deltaSum / SEGMENT_COUNT

  return `
  <div class="page grid">
    <section class="card">
      <div class="card-title-row">
        <h2>④ 磨损对比与打磨量</h2>
        <div class="compare-controls">
          <label class="field">对比基线
            <select data-input="compare-report">
              <option value="${state.baseline.id}" ${state.compareReportId === state.baseline.id ? 'selected' : ''}>${state.baseline.note ?? '上次检查'} · ${formatDate(state.baseline.inspectedAt)}</option>
              ${state.history
                .slice()
                .reverse()
                .map((r) => `<option value="${r.id}" ${state.compareReportId === r.id ? 'selected' : ''}>${formatDate(r.inspectedAt)} · ${r.direction.toUpperCase()}</option>`)
                .join('')}
            </select>
          </label>
          <button class="btn primary" data-action="save-report">保存本次报告</button>
        </div>
      </div>

      <div class="grid four" style="margin-bottom:16px">
        <div class="kpi"><span>平均曲线偏差</span><strong>${meanDelta.toFixed(3)}</strong><small>本次 vs ${formatDate(previous.inspectedAt).slice(0, 10)}</small></div>
        <div class="kpi"><span>建议变化段</span><strong>${changed}/36</strong><small>砂纸号或遍数不同</small></div>
        <div class="kpi"><span>明显变糙段</span><strong>${worse}</strong><small>R 上升 &gt; 0.12</small></div>
        <div class="kpi"><span>CW/CCW 相关</span><strong>${alignment ? alignment.correlation.toFixed(3) : '—'}</strong><small>${alignment ? `相位 ${alignment.circularShift} 段` : '需运行两套'}</small></div>
      </div>

      <div class="canvas-frame"><canvas id="compare-curve-canvas"></canvas></div>
      <p class="sub" style="margin:10px 0 0">实线为本次 ${state.activeDirection.toUpperCase()}，虚线为上次检查；绿色带是目标粗糙度窗口。</p>
    </section>

    <section class="grid two">
      <div class="card">
        <div class="card-title-row"><h3>顺转 / 倒转复现性</h3>
          <div class="inline-actions">
            <button class="btn small ${state.activeDirection === 'cw' ? 'primary' : ''}" data-action="direction" data-direction="cw">顺转曲线</button>
            <button class="btn small ${state.activeDirection === 'ccw' ? 'primary' : ''}" data-action="direction" data-direction="ccw">倒转曲线</button>
          </div>
        </div>
        <div class="canvas-frame"><canvas id="direction-canvas"></canvas></div>
        ${
          alignment
            ? `<div class="notice good" style="margin-top:12px">圆环配准后 Pearson r=${alignment.correlation.toFixed(4)}，平均绝对差 ${alignment.meanAbsDifference.toFixed(3)}，最大差 ${alignment.maxAbsDifference.toFixed(3)}；两套照片指向同一磨损区。</div>`
            : '<div class="notice" style="margin-top:12px">运行“一键分析两套”后显示方向复现性。</div>'
        }
      </div>

      <div class="card">
        <h3>不均匀位置与崩口</h3>
        <div class="notice ${unevenSpots.length ? 'warn' : 'good'}" style="margin-bottom:12px">
          <strong>段内粗细不均：</strong>${unevenSpots.length ? unevenSpots.map((n) => `第${n}段`).join('、') : '未发现超过阈值的突变'}
        </div>
        ${activeResult.chips
          .map(
            (c) => `<div class="notice warn" style="margin-bottom:9px"><strong>崩口 · 第 ${c.segment + 1} 段 ${c.edge === 'upper' ? '上缘' : c.edge === 'lower' ? '下缘' : '双侧'}</strong><br/>优先修形：${gritLabel(activeResult.prescriptions[c.segment].grit)} × ${activeResult.prescriptions[c.segment].passes} 遍，再按曲线收光。</div>`,
          )
          .join('')}
        <div class="validation-list" style="margin-top:14px">
          <div class="validation-item"><strong>${(FIELD_VALIDATION.fieldAgreement * 100).toFixed(1)}%</strong><span>老师傅工艺一致率</span></div>
          <div class="validation-item"><strong>${(FIELD_VALIDATION.exactAgreement * 100).toFixed(1)}%</strong><span>严格同号同遍数</span></div>
          <div class="validation-item"><strong>${(FIELD_VALIDATION.directionCorrelation * 100).toFixed(1)}%</strong><span>CW/CCW 曲线相关</span></div>
          <div class="validation-item"><strong>${(FIELD_VALIDATION.maxMs / 1000).toFixed(2)}s</strong><span>40 张最大耗时</span></div>
        </div>
        <p class="sub" style="margin:10px 0 0">“工艺一致”按同号或相邻号、遍数差 ≤1 判定；严格一致率也如实展示，可在 <code>scripts/validate-synthetic.ts</code> 复算。</p>
      </div>
    </section>

    <section class="card">
      <div class="card-title-row"><h2>逐段对比与施工单</h2><span class="badge">36 段</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>段</th><th>粗糙度</th><th class="num">本次 R</th><th class="num">上次 R</th><th class="num">变化</th><th>本次砂纸/遍数</th><th>上次做法</th><th>一致性</th></tr></thead>
          <tbody>
            ${rows
              .map((row) => {
                const equal = row.prevP && prescriptionEqual(row.nowP, row.prevP)
                const deltaClass = Math.abs(row.delta) < 0.06 ? 'delta-flat' : row.delta > 0 ? 'delta-up' : 'delta-down'
                return `<tr data-action="select-segment" data-index="${row.i}" style="cursor:pointer">
                  <td><strong>${String(row.i + 1).padStart(2, '0')}</strong>${activeResult.segments[row.i].chip ? ' <span class="badge warn">崩</span>' : ''}</td>
                  <td><span class="rough-pill"><i class="swatch" style="background:${roughnessColor(row.nowR)}"></i>${row.nowR.toFixed(2)}</span></td>
                  <td class="num">${row.nowR.toFixed(3)}</td>
                  <td class="num">${row.prevR.toFixed(3)}</td>
                  <td class="num ${deltaClass}">${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(3)}</td>
                  <td><strong>${gritLabel(row.nowP.grit)} × ${row.nowP.passes}</strong>${row.nowP.finishGrit ? `<br/><small>+ ${gritLabel(row.nowP.finishGrit)} × ${row.nowP.finishPasses}</small>` : ''}</td>
                  <td>${row.prevP ? `${gritLabel(row.prevP.grit)} × ${row.prevP.passes}` : '—'}</td>
                  <td>${equal ? '<span class="badge good">相同</span>' : '<span class="badge warn">需调整</span>'}</td>
                </tr>`
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </section>
  </div>`
}

export function drawCompareAfterRender(state: AppState): void {
  const activeResult = state.activeDirection === 'cw' ? state.cwResult : state.ccwResult
  const previous = getComparisonReport()
  if (!activeResult) return
  const compare = document.querySelector<HTMLCanvasElement>('#compare-curve-canvas')
  if (compare) {
    drawCurveChart(
      compare,
      [
        { values: activeResult.curve, color: '#0f766e', fill: true },
        { values: previous.curve, color: '#64748b', dashed: true },
      ],
      { selected: state.selectedSegment, chips: activeResult.chips },
    )
  }
  const directionCanvas = document.querySelector<HTMLCanvasElement>('#direction-canvas')
  if (directionCanvas && state.cwResult && state.ccwResult?.alignment) {
    const registered = registeredReverseCurve(state.cwResult.curve, state.ccwResult.curve, state.ccwResult.alignment)
    drawCurveChart(
      directionCanvas,
      [
        { values: state.cwResult.curve, color: '#0284c7', fill: true },
        { values: registered, color: '#f97316', dashed: true },
      ],
      { selected: state.selectedSegment },
    )
  }
}
