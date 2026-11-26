import type { RgbaImage, SegmentStat } from '../core/types';

export const TONE_COLORS: Record<string, string> = {
  polished: '#fb7185',
  worn: '#fb923c',
  light: '#facc15',
  healthy: '#34d399',
  coarse: '#a78bfa',
};

export function putRgba(canvas: HTMLCanvasElement, img: RgbaImage): void {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  const imageData = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  ctx.putImageData(imageData, 0, 0);
}

// 长带按目标 CSS 宽等比设置位图宽度（保持高分辨率可横向滚动）
export function paintStrip(canvas: HTMLCanvasElement, img: RgbaImage, targetWidth?: number): void {
  if (!targetWidth || targetWidth >= img.width) {
    putRgba(canvas, img);
    canvas.style.width = `${img.width}px`;
    canvas.style.maxWidth = 'none';
    return;
  }
  const scale = targetWidth / img.width;
  const tw = Math.round(img.width * scale);
  const th = Math.round(img.height * scale);
  canvas.width = tw;
  canvas.height = th;
  const src = document.createElement('canvas');
  src.width = img.width;
  src.height = img.height;
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  canvas.getContext('2d')!.drawImage(src, 0, 0, tw, th);
  canvas.style.width = '100%';
}

export interface ChartOptions {
  curve: number[]; // 高分辨率当前曲线 0..1
  segments: SegmentStat[];
  prevCurve36?: number[] | null;
  delta36?: number[] | null;
  height?: number;
  showDelta?: boolean;
  hoverSeg?: number | null;
  onHover?: (seg: number | null) => void;
}

// 一整圈粗糙度曲线：36 段色带 + 阈值线 + 当前曲线 + 上次虚线 + 崩口标记
export function drawRoughnessChart(canvas: HTMLCanvasElement, opts: ChartOptions): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 900;
  const cssH = opts.height ?? 300;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const W = cssW;
  const H = cssH;
  const M = { l: 46, r: 18, t: 18, b: 34 };
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  ctx.clearRect(0, 0, W, H);

  const xSeg = (s: number) => M.l + (s / 36) * pw;
  const yVal = (v: number) => M.t + (1 - v) * ph;

  // 段色带
  opts.segments.forEach((s) => {
    ctx.fillStyle = hexA(TONE_COLORS[s.tone] ?? '#888', 0.09);
    ctx.fillRect(xSeg(s.index), M.t, pw / 36 + 0.6, ph);
  });
  // 悬停高亮
  if (opts.hoverSeg != null) {
    ctx.fillStyle = 'rgba(56,225,198,0.13)';
    ctx.fillRect(xSeg(opts.hoverSeg), M.t, pw / 36, ph);
  }

  // 横向网格 + y 标签
  ctx.font = '11px ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'middle';
  for (const v of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const y = yVal(v);
    ctx.strokeStyle = v === 0 || v === 1 ? '#2a3650' : '#1b253a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M.l, y + 0.5);
    ctx.lineTo(M.l + pw, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = '#7488a8';
    ctx.textAlign = 'right';
    ctx.fillText(v.toFixed(1), M.l - 8, y);
  }
  // 档界虚线
  for (const v of [0.2, 0.4, 0.6, 0.82]) {
    ctx.strokeStyle = 'rgba(148,163,184,0.25)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(M.l, yVal(v));
    ctx.lineTo(M.l + pw, yVal(v));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // x 轴段号（每 3 段）
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#7488a8';
  for (let s = 0; s < 36; s += 3) {
    ctx.fillText(String(s + 1), xSeg(s) + pw / 72, M.t + ph + 9);
  }

  // delta 柱
  if (opts.showDelta && opts.delta36) {
    opts.delta36.forEach((d, i) => {
      const x = xSeg(i) + pw / 72;
      const y0 = yVal(0.5);
      const y = yVal(0.5 + clamp(d / 0.5, -0.5, 0.5));
      ctx.fillStyle = d < -0.12 ? 'rgba(251,113,133,0.55)' : d > 0.12 ? 'rgba(52,211,153,0.5)' : 'rgba(148,163,184,0.25)';
      ctx.fillRect(x - 3, Math.min(y, y0), 6, Math.abs(y0 - y) || 1);
    });
  }

  // 上次 36 段阶梯虚线
  if (opts.prevCurve36 && opts.prevCurve36.length === 36) {
    ctx.strokeStyle = 'rgba(203,213,225,0.75)';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    opts.prevCurve36.forEach((v, i) => {
      const x = xSeg(i) + pw / 72;
      const y = yVal(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 当前高分辨率曲线
  const curve = opts.curve;
  if (curve.length > 1) {
    const grad = ctx.createLinearGradient(0, M.t, 0, M.t + ph);
    grad.addColorStop(0, 'rgba(56,225,198,0.35)');
    grad.addColorStop(1, 'rgba(56,225,198,0)');
    ctx.beginPath();
    curve.forEach((v, i) => {
      const x = M.l + (i / (curve.length - 1)) * pw;
      const y = yVal(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(M.l + pw, M.t + ph);
    ctx.lineTo(M.l, M.t + ph);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    curve.forEach((v, i) => {
      const x = M.l + (i / (curve.length - 1)) * pw;
      const y = yVal(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#38e1c6';
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(56,225,198,0.5)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // 每段均值点 + 崩口标记
  opts.segments.forEach((s) => {
    const x = xSeg(s.index) + pw / 72;
    const y = yVal(s.roughness);
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = TONE_COLORS[s.tone] ?? '#fff';
    ctx.fill();
    if (s.chip) {
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('▲', x, M.t - 4 + 12);
    }
  });

  // 交互
  canvas.onmousemove = (e) => {
    if (!opts.onHover) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < M.l || x > M.l + pw) return opts.onHover(null);
    const seg = Math.min(35, Math.max(0, Math.floor(((x - M.l) / pw) * 36)));
    opts.onHover(seg);
  };
  canvas.onmouseleave = () => opts.onHover?.(null);
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}
function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// 圆环叠加层：36 段分隔 + 崩口弧标记（与 1600 圆环同位坐标）
export function drawRingOverlay(canvas: HTMLCanvasElement, segments: SegmentStat[], chips: { angleDeg: number; edge: string; severity: number }[]): void {
  const S = 1600;
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, S, S);
  const cx = S / 2;
  const cy = S / 2;
  const rIn = 600 - (366 - 250) * 1.35; // 与 analyze ringDetected 近似
  const rOut = 600 - (122 - 250) * 1.35;

  // 段分隔与段号
  for (let s = 0; s < 36; s++) {
    const a0 = (s / 36) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((s + 1) / 36) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a0) * rIn, cy + Math.sin(a0) * rIn);
    ctx.lineTo(cx + Math.cos(a0) * rOut, cy + Math.sin(a0) * rOut);
    ctx.stroke();
    // 段底色弧
    const tone = segments[s]?.tone ?? 'healthy';
    ctx.strokeStyle = hexA(TONE_COLORS[tone], 0.5);
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, (rIn + rOut) / 2, a0 + 0.01, a1 - 0.01);
    ctx.stroke();
  }
  // 崩口红色弧
  chips.forEach((c) => {
    const a = (c.angleDeg / 360) * Math.PI * 2 - Math.PI / 2;
    const r = c.edge === 'inner' ? rIn - 6 : rOut + 6;
    ctx.fillStyle = '#fb7185';
    ctx.shadowColor = '#fb7185';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 12 + c.severity * 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  });
}
