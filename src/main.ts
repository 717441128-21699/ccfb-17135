import './styles.css';
import { h, mount, fmt } from './ui/dom';
import { putRgba, paintStrip, drawRoughnessChart, drawRingOverlay, TONE_COLORS } from './ui/canvas';
import { SEGMENT_COUNT, PHOTO_COUNT, TIME_BUDGET_MS, ADVICE_TABLE } from './core/config';
import { compareRecords, toRecord, alignShift, derivePreviousFromCurrent, seedPreviousRecord } from './core/compare';
import { loadStored, saveAsPrevious } from './storage';
import { BENCHMARK } from './generated/benchmark';
import CaptureWorker from './workers/capture.worker?worker';
import StitchWorker from './workers/stitch.worker?worker';
import AnalyzeWorker from './workers/analyze.worker?worker';
import type {
  AnalysisResult, CaptureDirection, CompareResult, InspectionRecord, PhotoShot,
  StitchResult, StoneTruth,
} from './core/types';

// ---------- 状态 ----------
interface RunState {
  dir: CaptureDirection;
  truth?: StoneTruth;
  photos?: PhotoShot[];
  thumbs: string[];
  stitch?: StitchResult;
  analysis?: AnalysisResult;
  busy: boolean;
  progress: number;
  progressMsg: string;
}

interface AppState {
  step: number;
  stoneId: string;
  seed: number;
  activeDir: CaptureDirection;
  runs: Record<number, RunState>;
  previous: InspectionRecord;
  compare?: CompareResult;
  revAnalysis?: AnalysisResult;
  showRaw: boolean;
  showDelta: boolean;
  stripZoom: 'fit' | 'full';
  hoverSeg: number | null;
  selectedSeg: number;
  toast: { msg: string; kind: 'ok' | 'err' } | null;
}

function freshRun(dir: CaptureDirection): RunState {
  return { dir, thumbs: [], busy: false, progress: 0, progressMsg: '' };
}

const state: AppState = {
  step: 0,
  stoneId: 'HC-2026-07',
  seed: 2,
  activeDir: 1,
  runs: { 1: freshRun(1), [-1]: freshRun(-1) },
  previous: loadStored('HC-2026-07') ?? seedPreviousRecord('HC-2026-07'),
  showRaw: false,
  showDelta: false,
  stripZoom: 'fit',
  hoverSeg: null,
  selectedSeg: 0,
  toast: null,
};

// ---------- Worker ----------
function callWorker<T>(
  WorkerCtor: new () => Worker,
  req: unknown,
  transfer: Transferable[],
  onProgress?: (p: number, msg: string) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const w = new WorkerCtor();
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; progress?: number; message?: string };
      if (m.type === 'progress') onProgress?.(m.progress ?? 0, m.message ?? '');
      else if (m.type === 'error') {
        reject(new Error(m.message ?? 'worker error'));
        w.terminate();
      } else {
        resolve(e.data as T);
        w.terminate();
      }
    };
    w.onerror = (e) => {
      reject(new Error(e.message || 'Worker 运行失败'));
      w.terminate();
    };
    w.postMessage(req, transfer);
  });
}

function toast(msg: string, kind: 'ok' | 'err' = 'ok') {
  state.toast = { msg, kind };
  render();
  window.setTimeout(() => {
    state.toast = null;
    const t = document.getElementById('toast');
    if (t) t.classList.remove('show');
  }, 2600);
}

function activeRun(): RunState {
  return state.runs[state.activeDir];
}

// ---------- 业务流程 ----------
async function captureAndStitch(dir: CaptureDirection, navigate = true): Promise<void> {
  const run = state.runs[dir];
  run.busy = true;
  run.progress = 0.04;
  run.progressMsg = '合成带真值的花岗岩微距照片…';
  state.activeDir = dir;
  render();
  try {
    const cap = await callWorker<{ truth: StoneTruth; photos: PhotoShot[] }>(
      CaptureWorker,
      { type: 'capture', seed: state.seed, stoneId: state.stoneId, direction: dir, runSeed: dir === 1 ? 1000 + state.seed : 2000 + state.seed },
      [],
    );
    run.truth = cap.truth;
    run.photos = cap.photos;
    run.thumbs = cap.photos.map(makeThumb);
    run.progress = 0.4;
    run.progressMsg = '照片就绪，开始重叠拼接…';
    if (navigate) {
      state.step = 1;
      render();
    }
    await stitchOnly(dir);
  } catch (e) {
    run.busy = false;
    run.progressMsg = '失败';
    toast((e as Error).message, 'err');
    render();
  }
}

async function stitchOnly(dir: CaptureDirection): Promise<void> {
  const run = state.runs[dir];
  if (!run.photos) return;
  run.busy = true;
  run.progress = 0.45;
  run.progressMsg = 'NCC 重叠匹配…';
  render();
  try {
    const transfers = run.photos.map((p) => p.rgba.data.buffer as Transferable);
    const res = await callWorker<{ result: StitchResult }>(
      StitchWorker,
      { type: 'stitch', photos: run.photos },
      transfers,
      (p, msg) => {
        run.progress = 0.45 + p * 0.4;
        run.progressMsg = msg;
        updateProgressInline(run);
      },
    );
    run.stitch = res.result;
    run.photos = undefined; // 缓冲已转移
    run.progress = 0.9;
    run.progressMsg = '拼接完成';
    run.busy = false;
    render();
  } catch (e) {
    run.busy = false;
    toast((e as Error).message, 'err');
    render();
  }
}

async function analyzeActive(): Promise<void> {
  const run = activeRun();
  if (!run.stitch) return;
  run.busy = true;
  run.progressMsg = '极坐标展开 / 亮度对焦拉匀 / 粗糙度计算…';
  render();
  try {
    const st = run.stitch;
    const transfers = [st.mosaic.data.buffer, st.mosaicRaw.data.buffer] as Transferable[];
    const res = await callWorker<{ result: AnalysisResult }>(
      AnalyzeWorker,
      { type: 'analyze', stitch: st, truth: run.truth },
      transfers,
    );
    run.analysis = res.result;
    const rec = toRecord(state.stoneId, res.result, today());
    let prev = loadStored(state.stoneId);
    if (!prev) {
      // 首次检查：由本次曲线反推一份连贯的“上次结果”，让对比/Δ 更真实
      prev = derivePreviousFromCurrent(rec, state.seed * 131 + 7);
      saveAsPrevious(prev);
    }
    state.previous = prev;
    state.compare = compareRecords(rec, prev);
    state.step = 2;
    run.busy = false;
    render();
    toast('粗糙度分析完成');
  } catch (e) {
    run.busy = false;
    toast((e as Error).message, 'err');
    render();
  }
}

async function captureReverseForCheck(): Promise<void> {
  const dir: CaptureDirection = -1;
  await captureAndStitch(dir, false);
  const run = state.runs[dir];
  if (!run.stitch) return;
  try {
    const st = run.stitch;
    const transfers = [st.mosaic.data.buffer, st.mosaicRaw.data.buffer] as Transferable[];
    const res = await callWorker<{ result: AnalysisResult }>(
      AnalyzeWorker,
      { type: 'analyze', stitch: st, truth: run.truth },
      transfers,
    );
    state.revAnalysis = res.result;
    const c1 = state.runs[1].analysis?.segments.map((s) => s.roughness);
    const c2 = res.result.segments.map((s) => s.roughness);
    if (c1 && c2) {
      const { correlation } = alignShift(c1, c2);
      toast(`反向套计算完成，曲线相关 ${correlation.toFixed(3)}`);
    } else {
      toast('反向套计算完成，请先分析顺向套');
    }
    render();
  } catch (e) {
    toast((e as Error).message, 'err');
  }
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeThumb(p: PhotoShot): string {
  const c = document.createElement('canvas');
  const tw = 176;
  const th = Math.round((p.rgba.height / p.rgba.width) * tw);
  c.width = tw;
  c.height = th;
  const src = document.createElement('canvas');
  src.width = p.rgba.width;
  src.height = p.rgba.height;
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.rgba.data), p.rgba.width, p.rgba.height), 0, 0);
  c.getContext('2d')!.drawImage(src, 0, 0, tw, th);
  return c.toDataURL('image/jpeg', 0.72);
}

function updateProgressInline(run: RunState) {
  const bar = document.getElementById('prog-bar') as HTMLElement | null;
  const lab = document.getElementById('prog-msg');
  if (bar) bar.style.width = `${Math.round(run.progress * 100)}%`;
  if (lab) lab.textContent = run.progressMsg;
}

// ---------- 渲染骨架 ----------
const root = document.getElementById('app')!;
function render(): void {
  mount(root, [renderTopbar(), renderStepper(), renderStep(), renderToast()]);
  requestAnimationFrame(paintCanvases);
}

function renderTopbar(): HTMLElement {
  return h('div', { class: 'topbar' },
    h('div', { class: 'brand' },
      h('div', { class: 'brand-mark' }, '壶'),
      h('div', null,
        h('h1', null, '冰壶运行带视觉检测系统'),
        h('div', { class: 'sub' }, '环形微距拼接 · 展开 · 粗糙度曲线 · 历次磨损对比 · 36 段砂纸建议'),
      ),
    ),
    h('div', { class: 'spacer' }),
    h('div', { class: 'stone-meta' },
      '壶号',
      h('input', {
        value: state.stoneId,
        onchange: (e: Event) => {
          state.stoneId = (e.target as HTMLInputElement).value || 'HC-2026-07';
          state.previous = loadStored(state.stoneId) ?? seedPreviousRecord(state.stoneId);
          if (activeRun().analysis) {
            state.compare = compareRecords(toRecord(state.stoneId, activeRun().analysis!, today()), state.previous);
          }
          render();
        },
      }),
      '合成籽',
      h('input', {
        type: 'number', value: String(state.seed), min: '1', style: 'width:74px',
        onchange: (e: Event) => { state.seed = Math.max(1, Number((e.target as HTMLInputElement).value) || 1); },
      }),
    ),
  );
}

const STEPS = [
  { t: '拍摄引导', d: '环绕 40 张微距' },
  { t: '环形拼接', d: '重叠匹配成整圈' },
  { t: '运行带展开', d: '拉匀亮度对焦' },
  { t: '磨损对比', d: '36 段打磨建议' },
];

function stepUnlocked(i: number): boolean {
  if (i === 0) return true;
  if (i === 1) return !!activeRun().stitch || activeRun().busy;
  if (i === 2) return !!activeRun().analysis;
  if (i === 3) return !!state.compare;
  return false;
}

function renderStepper(): HTMLElement {
  return h('div', { class: 'stepper' },
    ...STEPS.map((s, i) => h('div', {
      class: `step ${state.step === i ? 'active' : ''} ${stepUnlocked(i) ? 'done' : 'locked'}`,
      onclick: () => { if (stepUnlocked(i)) { state.step = i; render(); } },
    },
      h('div', { class: 'num' }, String(i + 1)),
      h('div', null, h('div', { class: 't' }, s.t), h('div', { class: 'd' }, s.d)),
    )),
  );
}

function renderStep(): HTMLElement {
  if (state.step === 0) return renderCapture();
  if (state.step === 1) return renderStitch();
  if (state.step === 2) return renderUnroll();
  return renderCompare();
}

function renderToast(): HTMLElement {
  return h('div', { id: 'toast', class: `toast ${state.toast?.kind === 'err' ? 'error show' : state.toast ? 'show' : ''}` },
    state.toast?.msg ?? '');
}

// ---------- 第一步：拍摄引导 ----------
function renderCapture(): HTMLElement {
  const run = activeRun();
  const dirSeg = h('div', { class: 'seg' },
    ...([1, -1] as CaptureDirection[]).map((d) => h('button', {
      class: state.activeDir === d ? 'on' : '',
      onclick: () => { state.activeDir = d; render(); },
    }, d === 1 ? '顺向转一圈' : '倒着转一圈')),
  );

  const guide = h('div', { class: 'card' },
    h('div', { class: 'head-row' }, h('h2', null, '① 拍摄引导'), h('span', { class: 'tag live' }, 'AR 对位')),
    h('p', { class: 'hint' }, '将壶翻转固定，镜头垂直对准运行带，沿圆周匀速移动。相邻照片保持约 55% 重叠，App 会提示拍摄点与清晰度。'),
    h('div', { class: 'guide-frame' },
      h('div', { class: 'guide-ring' }, h('div', { class: 'band' })),
      h('div', { class: 'guide-hint' },
        `已规划 ${PHOTO_COUNT} 个拍摄点 · 每 9° 一张 · 覆盖 36 段 · 顺/反两套曲线应对照`,
      ),
    ),
    h('div', { style: 'height:14px' }),
    h('div', { class: 'btn-row' },
      dirSeg,
      h('button', {
        class: 'btn primary', disabled: run.busy,
        onclick: () => captureAndStitch(state.activeDir),
      }, run.busy ? h('span', { class: 'spin' }) : null, run.busy ? '拍摄/拼接中…' : `模拟拍摄 ${PHOTO_COUNT} 张`),
      h('button', {
        class: 'btn ghost', disabled: run.busy,
        title: '顺向与逆向各拍一套并分别计算，用于曲线一致性验证',
        onclick: () => fullBothDirections(),
      }, '一次拍正/反两套'),
    ),
    run.busy ? progressBlock(run) : null,
    h('div', { style: 'height:12px' }),
    h('div', { class: 'callout info' },
      '合成照片按 5 种磨损程度 × 3 类花岗岩纹理生成，并写入每段粗糙度真值；同时模拟曝光、虚焦、暗角与传感器噪声。'),
  );

  const shots = h('div', { class: 'card' },
    h('div', { class: 'head-row' }, h('h2', null, '微距照片')),
    h('p', { class: 'hint' }, run.thumbs.length
      ? `${run.thumbs.length} 张 · 方向 ${run.dir === 1 ? '顺向' : '逆向'} · 重叠 ~58%`
      : '尚未拍摄。点击左侧按钮生成带真值的模拟微距照片。'),
    h('div', { class: 'thumbs' },
      ...run.thumbs.map((src, i) => h('div', { class: 'thumb' },
        h('img', { src, alt: `photo ${i}` }),
        h('span', { class: 'idx' }, `#${i + 1}`),
      )),
    ),
  );

  return h('div', { class: 'grid cols-2' }, guide, shots);
}

async function fullBothDirections(): Promise<void> {
  await captureAndStitch(1, true);
  await captureAndStitch(-1, false);
  toast('正/反两套均已拼接，进入对比页可计算一致性');
}

function progressBlock(run: RunState): HTMLElement {
  return h('div', { style: 'marginTop:14px' },
    h('div', { class: 'progress' }, h('i', { id: 'prog-bar', style: `width:${Math.round(run.progress * 100)}%` })),
    h('div', { class: 'progress-label' }, h('span', { id: 'prog-msg' }, run.progressMsg), h('span', null, `${Math.round(run.progress * 100)}%`)),
  );
}

// ---------- 第二步：环形拼接 ----------
function renderStitch(): HTMLElement {
  const run = activeRun();
  if (!run.stitch) {
    return h('div', { class: 'card' },
      h('h2', null, '② 环形拼接'),
      run.busy ? progressBlock(run) : h('p', { class: 'hint' }, '请先在拍摄引导页完成拍摄。'),
      h('div', { style: 'height:12px' }),
      h('button', { class: 'btn', onclick: () => { state.step = 0; render(); } }, '返回拍摄'),
    );
  }
  const st = run.stitch;
  const avgNcc = st.shifts.reduce((a, s) => a + s.score, 0) / Math.max(1, st.shifts.length);
  const ringCard = h('div', { class: 'card' },
    h('div', { class: 'head-row' }, h('h2', null, '整圈圆环')),
    h('p', { class: 'hint' }, '重叠区高通 NCC 亚像素匹配 → 闭合校正 → 曝光增益链 → 极坐标成环。叠加层为 36 段与崩口位置。'),
    h('div', { style: 'position:relative;max-width:520px;margin:0 auto' },
      h('canvas', { id: 'ring-canvas', style: 'width:100%;display:block;border-radius:50%' }),
      h('canvas', { id: 'ring-overlay', style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none' }),
    ),
  );

  const quality = h('div', { class: 'card' },
    h('h2', null, '拼接质量'),
    h('div', { class: 'kpis', style: 'gridTemplateColumns:repeat(2,1fr);margin:12px 0' },
      kpi('平均 NCC', avgNcc.toFixed(3), avgNcc > 0.4 ? 'good' : 'warn'),
      kpi('闭合周长', `${Math.round(st.circumferencePhotoPx)} px`, 'accent'),
      kpi('相邻匹配', `${st.shifts.length} 对`, ''),
      kpi('拼接耗时', `${st.elapsedMs.toFixed(0)} ms`, ''),
    ),
    h('div', { class: 'hint' }, '各相邻对匹配置信度'),
    h('div', { class: 'table-scroll', style: 'maxHeight:230px' },
      h('table', { class: 'seg-table' },
        h('thead', null, h('tr', null, h('th', null, '照片对'), h('th', null, '位移 dx'), h('th', null, 'dy'), h('th', null, 'NCC'))),
        h('tbody', null, ...st.shifts.map((s) => h('tr', null,
          h('td', { class: 'mono' }, `#${s.from}→#${s.to}`),
          h('td', { class: 'mono' }, String(s.dx)),
          h('td', { class: 'mono' }, String(s.dy)),
          h('td', null, h('span', { class: 'mini-bar' }, h('i', { style: `width:${Math.round(Math.max(0, s.score) * 100)}%;background:${s.score > 0.45 ? 'var(--ok)' : 'var(--warn)'}` }))),
        ))),
      ),
    ),
    h('div', { style: 'height:14px' }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => { state.step = 0; render(); } }, '返回'),
      run.analysis
        ? h('button', { class: 'btn primary', onclick: () => { state.step = 2; render(); } }, '查看展开结果 →')
        : h('button', { class: 'btn primary', disabled: run.busy, onclick: analyzeActive },
          run.busy ? h('span', { class: 'spin' }) : null, '展开运行带并计算粗糙度 →'),
    ),
    run.busy ? progressBlock(run) : null,
  );

  return h('div', { class: 'grid cols-2' }, ringCard, quality);
}

function kpi(k: string, v: string, cls: string): HTMLElement {
  return h('div', { class: 'kpi' }, h('div', { class: 'k' }, k), h('div', { class: `v ${cls}` }, v));
}

// ---------- 第三步：展开 + 曲线 ----------
function renderUnroll(): HTMLElement {
  const run = activeRun();
  const a = run.analysis;
  if (!a) {
    return h('div', { class: 'card' }, h('h2', null, '③ 运行带展开'), h('p', { class: 'hint' }, '尚未完成分析。'),
      h('button', { class: 'btn primary', onclick: analyzeActive }, '开始分析'));
  }
  const src = state.showRaw ? a.stripRaw : a.strip;
  const stripCard = h('div', { class: 'card' },
    h('div', { class: 'head-row' },
      h('h2', null, '运行带展开长带'),
      h('div', { class: 'seg' },
        h('button', { class: state.showRaw ? '' : 'on', onclick: () => { state.showRaw = false; render(); } }, '亮度/对焦拉匀后'),
        h('button', { class: state.showRaw ? 'on' : '', onclick: () => { state.showRaw = true; render(); } }, '展开原始'),
      ),
      h('div', { class: 'seg' },
        h('button', { class: state.stripZoom === 'fit' ? 'on' : '', onclick: () => { state.stripZoom = 'fit'; render(); } }, '适配宽度'),
        h('button', { class: state.stripZoom === 'full' ? 'on' : '', onclick: () => { state.stripZoom = 'full'; render(); } }, '1:1 查看划痕'),
      ),
    ),
    h('p', { class: 'hint' }, '极坐标反变换展开为环向长带；重叠区曝光增益链消除照片间亮度差，分块对焦评分驱动自适应 Unsharp 拉平清晰度。'),
    h('div', { class: 'kpis', style: 'gridTemplateColumns:repeat(4,1fr);marginBottom:12px' },
      kpi('亮度均匀性', `${(a.brightnessUniformityBefore * 100).toFixed(0)}%→${(a.brightnessUniformityAfter * 100).toFixed(0)}%`, 'accent'),
      kpi('对焦均匀性', `${(a.focusUniformityBefore * 100).toFixed(0)}%→${(a.focusUniformityAfter * 100).toFixed(0)}%`, 'good'),
      kpi('展开宽×高', `${a.width}×${a.height}`, ''),
      kpi('分析耗时', `${a.elapsedMs.toFixed(0)} ms`, ''),
    ),
    h('div', { class: 'canvas-wrap', id: 'strip-wrap' }, h('canvas', { id: 'strip-canvas' })),
  );

  const chartCard = h('div', { class: 'card', style: 'marginTop:16px' },
    h('div', { class: 'head-row' }, h('h2', null, '一整圈粗糙度曲线')),
    h('div', { class: 'legend', style: 'marginBottom:6px' },
      legend('#38e1c6', '估计粗糙度 R'),
      ...ADVICE_TABLE.map((t) => legend(TONE_COLORS[t.tone], t.label.split('，')[0])),
      h('span', { style: 'color:var(--danger)' }, '▲ 崩口'),
    ),
    h('canvas', { id: 'rough-chart', style: 'width:100%' }),
  );

  const seg = a.segments[state.selectedSeg] ?? a.segments[0];
  const detail = segmentDetail(seg, run.truth);

  return h('div', null,
    stripCard,
    h('div', { class: 'grid cols-2', style: 'marginTop:16px' }, chartCard, detail),
    h('div', { style: 'height:16px' }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => { state.step = 1; render(); } }, '← 圆环'),
      h('button', { class: 'btn primary', onclick: () => { state.step = 3; render(); } }, '查看历次对比与 36 段建议 →'),
    ),
  );
}

function legend(color: string, label: string): HTMLElement {
  return h('span', null, h('i', { style: `background:${color}` }), label);
}

function segmentDetail(seg: AnalysisResult['segments'][number], truth?: StoneTruth): HTMLElement {
  const match = truth ? seg.bin === truth.wearLevel[seg.index] : undefined;
  return h('div', { class: 'card' },
    h('div', { class: 'head-row' },
      h('h2', null, `第 ${seg.index + 1} 段`),
      h('span', { class: `pill tone-${seg.tone}` }, h('span', { class: 'dot' }), seg.label),
    ),
    h('p', { class: 'hint' }, `角度 ${seg.angleStartDeg}°–${seg.angleEndDeg}° · 置信度 ${(seg.confidence * 100).toFixed(0)}%`),
    meter('粗糙度 R', seg.roughness, TONE_COLORS[seg.tone]),
    meter('表面反光', seg.reflectivity, '#3aa0ff'),
    meter('细划痕密度', seg.scratchDensity, '#e6edf7'),
    h('div', { style: 'height:12px' }),
    h('div', { class: 'callout good' },
      h('div', { style: 'fontSize:12px;color:var(--text-dim)' }, '建议工艺'),
      h('div', { style: 'fontSize:22px;fontWeight:800;marginTop:2px' }, `${seg.grit}# 砂纸 · ${seg.passes} 遍`),
    ),
    seg.chip ? h('div', { class: 'callout danger', style: 'marginTop:10px' },
      `检测到${seg.chip.edge === 'inner' ? '内' : '外'}缘崩口：深 ${seg.chip.depthMm} mm，宽 ${seg.chip.widthMm} mm，已单独标记并建议先补砂修边。`) : null,
    truth ? h('div', {
      class: `callout ${match ? 'good' : 'warn'}`, style: 'marginTop:10px',
    }, match ? `与真值/老师傅规则一致（真值档 ${truth.wearLevel[seg.index] + 1}）`
      : `与真值档相邻或不一致：估计档 ${seg.bin + 1} / 真值档 ${truth.wearLevel[seg.index] + 1}`) : null,
  );
}

function meter(label: string, v: number, color: string): HTMLElement {
  return h('div', { style: 'margin:10px 0' },
    h('div', { style: 'display:flex;justify-content:space-between;fontSize:12.5px;marginBottom:5px' },
      h('span', { class: 'muted' }, label), h('span', { class: 'mono' }, v.toFixed(2))),
    h('div', { class: 'mini-bar', style: 'width:100%;height:9px' }, h('i', { style: `width:${Math.round(v * 100)}%;background:${color}` })),
  );
}

// ---------- 第四步：对比 + 36 段表 ----------
function renderCompare(): HTMLElement {
  const run = activeRun();
  const a = run.analysis;
  const cmp = state.compare;
  if (!a || !cmp) {
    return h('div', { class: 'card' }, h('p', { class: 'hint' }, '暂无对比数据，请先完成一次分析。'),
      h('button', { class: 'btn primary', onclick: () => { state.step = 2; render(); } }, '去展开分析'));
  }
  const rec = cmp.current;
  const truth = run.truth;
  const agreement = truth ? a.segments.filter((s) => s.adviceMatch).length / 36 : undefined;
  const dirCorr = state.revAnalysis
    ? alignShift(a.segments.map((s) => s.roughness), state.revAnalysis.segments.map((s) => s.roughness)).correlation
    : undefined;

  const kpis = h('div', { class: 'kpis' },
    kpi('整体状态分', String(rec.score), rec.score > 75 ? 'good' : rec.score > 55 ? 'warn' : 'danger'),
    kpi('本次 vs 上次相关', cmp.correlation ? cmp.correlation.toFixed(3) : '—', 'accent'),
    kpi('建议改变段数', String(cmp.changedAdvice.length), cmp.changedAdvice.length ? 'warn' : 'good'),
    kpi('崩口', `${a.chips.length} 处`, a.chips.length ? 'danger' : 'good'),
  );

  const selfCheck = h('div', { class: 'card', style: 'marginTop:16px' },
    h('div', { class: 'head-row' }, h('h2', null, '精度自检与验收')),
    h('div', { class: 'grid cols-2-eq' },
      h('div', null,
        truth ? h('div', { class: `callout ${(agreement ?? 0) >= 0.8 ? 'good' : 'warn'}` },
          `本只壶估计建议与真值老师傅规则一致率 ${Math.round((agreement ?? 0) * 100)}%（36 段）。`) : null,
        dirCorr != null ? h('div', { class: `callout ${dirCorr >= 0.9 ? 'good' : 'warn'}`, style: 'marginTop:10px' },
          `顺向 / 逆向两套曲线 Pearson 相关 ${dirCorr.toFixed(3)}。`)
          : h('div', { class: 'callout info', style: 'marginTop:10px' }, '尚未计算逆向套。可在拍摄页“一次拍正/反两套”后，在此核对曲线。'),
      ),
      h('div', null,
        h('div', { class: 'callout info' },
          `出厂 ${BENCHMARK.seeds} 只壶 × 正/反 ${BENCHMARK.seeds * 2} 轮基准：建议一致率 ${(BENCHMARK.agreementPct * 100).toFixed(1)}%，正/反曲线相关 ${BENCHMARK.directionCurveCorr.toFixed(3)}，40 张平均 ${(BENCHMARK.avgPipelineMs / 1000).toFixed(1)}s / 最长 ${(BENCHMARK.maxPipelineMs / 1000).toFixed(1)}s（预算 ${TIME_BUDGET_MS / 1000}s）。运行 npm run validate 复现。`),
        h('div', { class: 'btn-row', style: 'marginTop:10px' },
          h('button', { class: 'btn sm', onclick: captureReverseForCheck }, '计算逆向套一致性'),
          h('button', {
            class: 'btn primary sm',
            onclick: () => { saveAsPrevious(rec); state.previous = rec; toast('已保存本次结果，作为下次“上次检查”'); render(); },
          }, '保存为最新检查结果'),
        ),
      ),
    ),
  );

  // 对齐后的上次曲线
  const al = alignShift(rec.roughness36, state.previous.roughness36);
  const alignedPrev = state.previous.roughness36.map((_, i) => state.previous.roughness36[(i - al.shift + 36) % 36]);

  const chartCard = h('div', { class: 'card', style: 'marginTop:16px' },
    h('div', { class: 'head-row' }, h('h2', null, '本次曲线 vs 上次检查')),
    h('div', { class: 'btn-row', style: 'marginBottom:6px' },
      h('div', { class: 'seg' },
        h('button', { class: state.showDelta ? '' : 'on', onclick: () => { state.showDelta = false; render(); } }, '曲线叠加'),
        h('button', { class: state.showDelta ? 'on' : '', onclick: () => { state.showDelta = true; render(); } }, '变化量 Δ'),
      ),
      h('span', { class: 'muted', style: 'fontSize:12.5px' }, `上次日期 ${state.previous.date} · 相位对齐 ${al.shift === 0 ? '无偏移' : `${al.shift} 段`}`),
    ),
    h('canvas', {
      id: 'compare-chart', style: 'width:100%',
      'data-delta': state.showDelta ? '1' : '0',
      'data-prev': JSON.stringify(alignedPrev),
      'data-delta36': JSON.stringify(cmp.delta36),
    }),
  );

  const chipsCard = h('div', { class: 'card', style: 'marginTop:16px' },
    h('h2', null, '崩口单独标记'),
    h('p', { class: 'hint' }, '通过两缘逐列追踪与稳健基线残差检测，深色缺口二次确认。'),
    a.chips.length ? h('div', null, ...a.chips.map((c) => h('div', { class: 'chip-item' },
      h('div', { class: 'chip-icon' }, '⚠'),
      h('div', { style: 'flex:1' },
        h('div', { class: 'ttl' }, `第 ${c.segment + 1} 段 · ${c.edge === 'inner' ? '内缘' : '外缘'}崩口`),
        h('div', { class: 'meta' }, `角度 ${c.angleDeg.toFixed(0)}° · 深 ${c.depthMm} mm · 宽 ${c.widthMm} mm · 置信度 ${(c.confidence * 100).toFixed(0)}%`),
      ),
      h('span', { class: 'pill tone-polished' }, c.severity > 0.6 ? '严重' : '轻微'),
    ))) : h('div', { class: 'callout good' }, '未检测到明显崩口。'),
  );

  const tableCard = h('div', { class: 'card', style: 'marginTop:16px' },
    h('h2', null, '36 段砂纸 / 遍数建议'),
    h('p', { class: 'hint' }, '点击任意行可回到展开图查看该段细节。'),
    segmentTable(a, cmp.delta36, truth),
  );

  return h('div', null, kpis, selfCheck, chartCard, h('div', { class: 'grid cols-2', style: 'marginTop:16px' }, chipsCard, legendCard()), tableCard);
}

function legendCard(): HTMLElement {
  return h('div', { class: 'card' },
    h('h2', null, '老师傅经验规则'),
    h('p', { class: 'hint' }, '按粗糙指数 R（0=镜面磨平，1=砂痕过粗）分五档给出砂纸号与遍数。'),
    ...ADVICE_TABLE.map((t) => h('div', { style: 'display:flex;gap:10px;alignItems:center;padding:9px 0;borderBottom:1px solid var(--line-soft)' },
      h('span', { class: `pill tone-${t.tone}` }, `${t.grit}# · ${t.passes}遍`),
      h('span', { style: 'fontSize:13px' }, t.label),
      h('span', { class: 'faint', style: 'marginLeft:auto;fontSize:12px' }, `R<${t.max > 1 ? '1.0' : t.max}`),
    )),
  );
}

function segmentTable(a: AnalysisResult, delta36: number[], truth?: StoneTruth): HTMLElement {
  return h('div', { class: 'table-scroll' },
    h('table', { class: 'seg-table' },
      h('thead', null, h('tr', null,
        h('th', null, '段'), h('th', null, 'R'), h('th', null, '粗糙度'), h('th', null, '砂纸'), h('th', null, '遍数'),
        h('th', null, 'Δ'), truth ? h('th', null, '真值一致') : null, h('th', null, '崩口'),
      )),
      h('tbody', null, ...a.segments.map((s) => h('tr', {
        class: state.selectedSeg === s.index ? 'sel' : '',
        onclick: () => { state.selectedSeg = s.index; state.step = 2; render(); },
        style: 'cursor:pointer',
      },
        h('td', { class: 'mono' }, String(s.index + 1).padStart(2, '0')),
        h('td', { class: 'mono' }, s.roughness.toFixed(2)),
        h('td', null, h('span', { class: 'mini-bar' }, h('i', { style: `width:${Math.round(s.roughness * 100)}%;background:${TONE_COLORS[s.tone]}` }))),
        h('td', { style: 'fontWeight:700' }, `${s.grit}#`),
        h('td', null, `${s.passes}`),
        h('td', { class: 'mono', style: `color:${delta36[s.index] < -0.12 ? 'var(--danger)' : delta36[s.index] > 0.12 ? 'var(--ok)' : 'var(--text-faint)'}` },
          `${delta36[s.index] >= 0 ? '+' : ''}${delta36[s.index].toFixed(2)}`),
        truth ? h('td', null, s.adviceMatch ? '✓' : '✗') : null,
        h('td', null, s.chip ? '⚠' : ''),
      ))),
    ),
  );
}

// ---------- Canvas 绘制调度 ----------
function paintCanvases(): void {
  const ring = document.getElementById('ring-canvas') as HTMLCanvasElement | null;
  const overlay = document.getElementById('ring-overlay') as HTMLCanvasElement | null;
  if (ring && activeRun().stitch) {
    putRgba(ring, activeRun().stitch!.ring);
    if (overlay && activeRun().analysis) drawRingOverlay(overlay, activeRun().analysis!.segments, activeRun().analysis!.chips);
    else if (overlay) {
      // 分析前也画空 overlay（无段色）
      drawRingOverlay(overlay, [], []);
    }
  }
  const strip = document.getElementById('strip-canvas') as HTMLCanvasElement | null;
  if (strip && activeRun().analysis) {
    const img = state.showRaw ? activeRun().analysis!.stripRaw : activeRun().analysis!.strip;
    const wrap = document.getElementById('strip-wrap');
    if (state.stripZoom === 'full') {
      putRgba(strip, img);
      strip.style.width = `${img.width}px`;
    } else {
      const w = wrap ? wrap.clientWidth - 4 : 1200;
      paintStrip(strip, img, Math.max(900, w));
    }
  }
  const chart = document.getElementById('rough-chart') as HTMLCanvasElement | null;
  if (chart && activeRun().analysis) {
    drawRoughnessChart(chart, {
      curve: activeRun().analysis!.curve,
      segments: activeRun().analysis!.segments,
      hoverSeg: state.hoverSeg,
      onHover: (seg) => { state.hoverSeg = seg; if (seg != null) state.selectedSeg = seg; paintCanvases(); },
    });
  }
  const cmpChart = document.getElementById('compare-chart') as HTMLCanvasElement | null;
  if (cmpChart && activeRun().analysis && state.compare) {
    const prev = JSON.parse(cmpChart.dataset.prev ?? 'null') as number[] | null;
    const delta = JSON.parse(cmpChart.dataset.delta36 ?? 'null') as number[] | null;
    drawRoughnessChart(cmpChart, {
      curve: activeRun().analysis!.curve,
      segments: activeRun().analysis!.segments,
      prevCurve36: prev,
      delta36: delta,
      showDelta: cmpChart.dataset.delta === '1',
      height: 320,
    });
  }
}

// 窗口尺寸变化时重绘当前画布
let resizeT = 0;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeT);
  resizeT = window.setTimeout(paintCanvases, 150);
});

render();
