/// <reference lib="webworker" />
import { makeTruth, renderWorld, shootSet } from '../core/synth';
import type { CaptureDirection, PhotoShot, StoneTruth } from '../core/types';

export interface CaptureRequest {
  type: 'capture';
  seed: number;
  stoneId: string;
  direction: CaptureDirection;
  runSeed: number;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<CaptureRequest>) => {
  const req = ev.data;
  if (req.type !== 'capture') return;
  try {
    const truth: StoneTruth = makeTruth(req.seed, req.stoneId);
    const world = renderWorld(truth);
    const photos: PhotoShot[] = shootSet(world, { runSeed: req.runSeed, direction: req.direction });
    // world 不回传；转移照片缓冲
    const transfers: ArrayBuffer[] = photos.map((p) => p.rgba.data.buffer as ArrayBuffer);
    ctx.postMessage({ type: 'captured', truth, photos }, transfers);
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};
