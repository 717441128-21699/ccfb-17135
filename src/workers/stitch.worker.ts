/// <reference lib="webworker" />
import { stitchRing } from '../core/stitch';
import type { PhotoShot, StitchResult } from '../core/types';

export interface StitchRequest {
  type: 'stitch';
  photos: PhotoShot[];
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<StitchRequest>) => {
  const req = ev.data;
  if (req.type !== 'stitch') return;
  try {
    const result: StitchResult = stitchRing(req.photos, (p, msg) => {
      ctx.postMessage({ type: 'progress', progress: p, message: msg });
    });
    const transfers = [
      result.mosaic.data.buffer,
      result.mosaicRaw.data.buffer,
      result.ring.data.buffer,
    ] as ArrayBuffer[];
    ctx.postMessage({ type: 'stitched', result }, transfers);
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error).message ?? String(err), stack: (err as Error).stack });
  }
};
