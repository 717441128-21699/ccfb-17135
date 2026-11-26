import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import type { RgbaImage } from '../src/core/types';

// 最小 PNG 编码器（RGBA8），仅用于诊断导出
export function writePng(path: string, img: RgbaImage): void {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });

  const chunks: Buffer[] = [];
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunks.push(chunk('IHDR', ihdr(width, height)));
  chunks.push(chunk('IDAT', idat));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  writeFileSync(path, Buffer.concat(chunks));
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, body, crc]);
}

function ihdr(w: number, h: number): Buffer {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0);
  b.writeUInt32BE(h, 4);
  b[8] = 8; // bit depth
  b[9] = 6; // color type RGBA
  b[10] = 0;
  b[11] = 0;
  b[12] = 0;
  return b;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 最近邻缩放成便于查看的宽度
export function downscale(img: RgbaImage, newW: number): RgbaImage {
  const k = img.width / newW;
  const newH = Math.max(1, Math.round(img.height / k));
  const out = { width: newW, height: newH, data: new Uint8ClampedArray(newW * newH * 4) };
  for (let y = 0; y < newH; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y * k));
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x * k));
      const si = (sy * img.width + sx) * 4;
      const di = (y * newW + x) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  return out;
}
