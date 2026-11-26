// 可复现的伪随机与二维值噪声 / FBM

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 整数格哈希 -> [0,1)
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// 二维值噪声，周期 periodX（角度方向可平铺），periodY 可选
export function valueNoise2(x: number, y: number, seed: number, periodX = 0, periodY = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  let xa = x0;
  let xb = x0 + 1;
  if (periodX > 0) {
    xa = ((xa % periodX) + periodX) % periodX;
    xb = ((xb % periodX) + periodX) % periodX;
  }
  let ya = y0;
  let yb = y0 + 1;
  if (periodY > 0) {
    ya = ((ya % periodY) + periodY) % periodY;
    yb = ((yb % periodY) + periodY) % periodY;
  }
  const v00 = hash2(xa, ya, seed);
  const v10 = hash2(xb, ya, seed);
  const v01 = hash2(xa, yb, seed);
  const v11 = hash2(xb, yb, seed);
  return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy);
}

// 分形布朗运动，返回约 [0,1]
export function fbm2(
  x: number,
  y: number,
  seed: number,
  octaves = 4,
  periodX = 0,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const px = periodX > 0 ? periodX * freq : 0;
    sum += amp * valueNoise2(x * freq, y * freq, seed + o * 1013, px, 0);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// 近似正态（Box-Muller），均值 0 方差 1
export function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
