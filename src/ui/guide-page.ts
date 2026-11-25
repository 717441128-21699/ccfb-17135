import { FRAME_COUNT, SEGMENT_COUNT } from '../config.ts'
import type { AppState } from '../state/store.ts'

export function renderGuide(state: AppState): string {
  const caps = state.captures?.cw.frames ?? []
  const mainThumb = caps[12]?.thumbnail ?? caps[0]?.thumbnail
  const p = state.progress

  return `
  <div class="page grid">
    <section class="capture-layout">
      <div class="card">
        <div class="card-title-row">
          <div>
            <h2>① 拍摄引导</h2>
            <p class="sub" style="margin-bottom:0">壶底朝上，镜头与运行带垂直；顺时针和逆时针各拍一套，相邻照片保留约 55%–70% 重叠。</p>
          </div>
          <span class="badge info">${FRAME_COUNT} 张 / 圈</span>
        </div>

        <div class="viewfinder">
          ${mainThumb ? `<img class="main-frame" src="${mainThumb}" alt="合成微距拍摄预览" />` : ''}
          <div class="guide-ring"></div>
          ${
            !mainThumb
              ? `<div class="vf-overlay"><div class="big" style="font-size:46px">🥌</div><h3>尚未生成拍摄样片</h3><p>系统会按 7 种磨损程度、花岗岩黑白斑、亮度/对焦差异和边缘崩口合成带真值照片。</p></div>`
              : ''
          }
          <div class="vf-hint">
            <span>对齐两条运行带边界</span>
            <span>重叠 ≥ 40%</span>
          </div>
        </div>

        <div style="margin-top:14px">
          <div class="card-title-row"><h3>接触片（顺时针）</h3><span class="badge">${caps.length} 张</span></div>
          ${
            caps.length
              ? `<div class="thumb-grid">${caps
                  .map(
                    (f) => `
                <div class="thumb ${f.blurIterations >= 2 ? 'focus-bad' : ''} ${f.exposure < 0.88 || f.exposure > 1.13 ? 'exposure-bad' : ''}" title="曝光增益 ${f.exposure.toFixed(2)}，模糊 ${f.blurIterations} 次">
                  <span>${f.index + 1}</span>
                  ${f.thumbnail ? `<img loading="lazy" src="${f.thumbnail}" alt="第${f.index + 1}张" />` : ''}
                </div>`,
                  )
                  .join('')}</div>`
              : `<div class="empty"><span class="big">📷</span><div>点击右侧“合成 40 张真值照片”开始。</div></div>`
          }
        </div>
      </div>

      <aside class="grid" style="align-content:start">
        <div class="card">
          <h2>拍摄动作</h2>
          <div class="steps">
            <div class="step"><div><strong>翻壶并清洁表面浮水</strong><p>不要擦掉黑色崩口和深划痕；拍摄前放好 36 段定位标。</p></div></div>
            <div class="step"><div><strong>沿圆周匀速移动</strong><p>每圈 ${FRAME_COUNT} 张，单张覆盖约 3–4 个检查段，保持运行带在辅助线内。</p></div></div>
            <div class="step"><div><strong>顺转、倒转各一套</strong><p>两套曲线需圆环配准后一致，用来排除单方向反光和拼接偏差。</p></div></div>
            <div class="step"><div><strong>边缘崩口特写</strong><p>崩口不按普通粗糙度处理，系统会单独圈出并给修形过渡建议。</p></div></div>
          </div>
          <div class="inline-actions" style="margin-top:16px">
            <button class="btn blue" data-action="generate-captures">合成/重排照片</button>
            <button class="btn primary" data-action="run-both" ${p.running ? 'disabled' : ''}>一键分析两套</button>
          </div>
          <div style="margin-top:12px">
            <label class="btn small ghost" for="real-files">导入实拍照片</label>
            <input id="real-files" type="file" accept="image/*" multiple hidden />
            <span style="color:var(--muted);font-size:12px;margin-left:8px">可选，建议 30–60 张</span>
          </div>
        </div>

        <div class="card">
          <h3>任务进度</h3>
          <div class="progress-track"><div class="progress-fill" style="width:${p.percent}%"></div></div>
          <div class="progress-line"><span>${p.stage}</span><strong>${p.percent}%</strong></div>
          ${p.error ? `<div class="notice warn" style="margin-top:12px">${p.error}</div>` : ''}
          <div class="detail-grid" style="margin-bottom:0">
            <div class="detail-item"><span>检查段数</span><strong>${SEGMENT_COUNT}</strong></div>
            <div class="detail-item"><span>两分钟预算</span><strong>40 张</strong></div>
          </div>
        </div>

        <div class="card">
          <h3>真值合成覆盖</h3>
          <div class="validation-list">
            <div class="validation-item"><strong>7 级</strong><span>釉化 → 深划痕</span></div>
            <div class="validation-item"><strong>黑白斑</strong><span>石英/云母/黑云母</span></div>
            <div class="validation-item"><strong>4 处</strong><span>默认崩口真值</span></div>
            <div class="validation-item"><strong>CW/CCW</strong><span>独立曝光与对焦</span></div>
          </div>
          <p class="sub" style="margin:12px 0 0">运行 <code>npm run validate:synthetic</code> 可复跑 6 组带真值验证。</p>
        </div>
      </aside>
    </section>
  </div>`
}
