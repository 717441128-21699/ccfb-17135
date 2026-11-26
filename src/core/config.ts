// 全局几何与经验规则常量 —— 单一事实来源

export const SEGMENT_COUNT = 36; // 运行带一圈均分 36 段

// 合成“标准展开世界”的分辨率（角度 × 径向）
export const WORLD_W = 7200; // 一圈的角度采样，每段 200 px
export const WORLD_H = 460; // 径向上下文（含两侧花岗岩）
export const BAND_TOP = 158; // 运行带上边缘（世界坐标行）
export const BAND_H = 168; // 运行带径向宽度
export const BAND_BOTTOM = BAND_TOP + BAND_H; // 326

// 模拟微距照片
export const PHOTO_W = 640;
export const PHOTO_H = 440;
export const PHOTO_COUNT = 40; // 一圈约 40 张
export const PHOTO_ANG_WIN = 430; // 每张照片覆盖的世界角度宽（≈21.5°）
export const PHOTO_RAD_WIN = 300; // 每张照片覆盖的世界径向高
export const CAPTURE_STEP = WORLD_W / PHOTO_COUNT; // 相邻拍摄点角度间隔 180（9°），重叠约 58%

// 拼接 / 展开输出
export const MOSAIC_W = 9000; // 近源分辨率的角度长图
export const MOSAIC_H = 460;
export const RING_SIZE = 1600; // 圆环展示画布
export const STRIP_W = 9000; // 展开长带（保留高分辨率用于划痕检测）
export const STRIP_H = 246;
export const CURVE_SAMPLES = 720; // 一圈高分辨率曲线点（每段 20 点）

// 运行带物理宽度（毫米，用于崩口尺寸换算的示意标定）
export const BAND_WIDTH_MM = 12; // 只保留运行带接触区

// 性能预算：40 张两分钟
export const TIME_BUDGET_MS = 120_000;

// 老器材员经验决策表（按“粗糙指数” R：0=磨平镜面，1=粗糙/砂痕重）
// 阈值与砂纸号 / 遍数。该表同时作为“真值老师傅”和 App 建议的规则，
// 验证脚本用估计值决策 vs 用真值决策的一致率。
export interface AdviceBin {
  max: number; // R < max 命中
  grit: number; // 砂纸号
  passes: number; // 打磨遍数
  label: string;
  tone: 'polished' | 'worn' | 'light' | 'healthy' | 'coarse';
}

export const ADVICE_TABLE: AdviceBin[] = [
  { max: 0.2, grit: 60, passes: 5, label: '镜面磨平，需重造粗糙面', tone: 'polished' },
  { max: 0.4, grit: 100, passes: 4, label: '明显发亮磨平，粗化处理', tone: 'worn' },
  { max: 0.6, grit: 150, passes: 3, label: '局部磨损，均匀走砂', tone: 'light' },
  { max: 0.82, grit: 240, passes: 2, label: '纹理尚可，维护性匀砂', tone: 'healthy' },
  { max: 1.01, grit: 320, passes: 1, label: '砂痕过深过密，细砂收平', tone: 'coarse' },
];

export function adviceForRoughness(r: number): { grit: number; passes: number; label: string; tone: AdviceBin['tone']; bin: number } {
  const rr = Math.max(0, Math.min(1, r));
  for (let i = 0; i < ADVICE_TABLE.length; i++) {
    if (rr < ADVICE_TABLE[i].max) {
      const b = ADVICE_TABLE[i];
      return { grit: b.grit, passes: b.passes, label: b.label, tone: b.tone, bin: i };
    }
  }
  const b = ADVICE_TABLE[ADVICE_TABLE.length - 1];
  return { grit: b.grit, passes: b.passes, label: b.label, tone: b.tone, bin: ADVICE_TABLE.length - 1 };
}
