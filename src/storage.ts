import type { InspectionRecord } from './core/types';
import { seedPreviousRecord } from './core/compare';

const KEY = 'curling-band-inspections-v1';

interface StoreShape {
  previous: Record<string, InspectionRecord>; // by stoneId
  latest?: InspectionRecord;
}

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function read(): StoreShape {
  if (!hasLocalStorage()) return { previous: {} };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { previous: {} };
    return JSON.parse(raw) as StoreShape;
  } catch {
    return { previous: {} };
  }
}

function write(s: StoreShape): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 配额或隐私模式：忽略 */
  }
}

export function loadPrevious(stoneId: string): InspectionRecord {
  const s = read();
  if (s.previous[stoneId]) return s.previous[stoneId];
  // 首次使用：种入一份“上次检查”，让对比页开箱即用
  const seeded = seedPreviousRecord(stoneId);
  s.previous[stoneId] = seeded;
  write(s);
  return seeded;
}

// 只读已保存记录；没有则返回 null（不写入随机种子）
export function loadStored(stoneId: string): InspectionRecord | null {
  return read().previous[stoneId] ?? null;
}

export function saveAsPrevious(rec: InspectionRecord): void {
  const s = read();
  s.previous[rec.stoneId] = rec;
  s.latest = rec;
  write(s);
}

export function loadLatest(): InspectionRecord | null {
  return read().latest ?? null;
}
