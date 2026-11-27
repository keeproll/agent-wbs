import { crc32, inflateSync } from 'node:zlib';

export interface Image { width: number; height: number; data: Uint8Array }
export interface ImageDiff { sizeMatch: boolean; diffPixels: number; ratio: number }

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 50_000_000;
const bad = (): never => { throw new TypeError('PNG 파일이 올바르지 않습니다.'); };

/**
 * 8비트 RGB·RGBA, 비interlace PNG만 읽는다. Playwright 스크린샷 형식이다.
 * 왜 직접 읽나: 비교 판정을 Runner가 하려면 픽셀이 필요하고, 그 때문에 이미지 라이브러리를 더 들이지 않는다.
 */
export function decodePng(buffer: Buffer): Image {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) return bad();
  let offset = 8; let header: Buffer | null = null; const data: Buffer[] = []; let ended = false;
  while (offset + 12 <= buffer.length && !ended) {
    const length = buffer.readUInt32BE(offset);
    if (offset + 12 + length > buffer.length) return bad();
    const body = buffer.subarray(offset + 4, offset + 8 + length);
    if (crc32(body) !== buffer.readUInt32BE(offset + 8 + length)) return bad();
    const type = body.subarray(0, 4).toString('ascii'); const chunk = body.subarray(4);
    if (type === 'IHDR') header = chunk; else if (type === 'IDAT') data.push(chunk); else if (type === 'IEND') ended = true;
    offset += 12 + length;
  }
  if (!header || header.length !== 13 || !ended || data.length === 0) return bad();
  const width = header.readUInt32BE(0); const height = header.readUInt32BE(4);
  const [depth, colorType, compression, filterMethod, interlace] = [header[8], header[9], header[10], header[11], header[12]];
  if (!width || !height || width * height > MAX_PIXELS || depth !== 8 || (colorType !== 2 && colorType !== 6) ||
    compression !== 0 || filterMethod !== 0 || interlace !== 0) return bad();
  const channels = colorType === 6 ? 4 : 3; const stride = width * channels;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height + 1 }); } catch { return bad(); }
  if (raw.length !== (stride + 1) * height) return bad();
  const plain = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= channels ? plain[y * stride + i - channels] ?? 0 : 0;
      const b = y > 0 ? plain[(y - 1) * stride + i] ?? 0 : 0;
      const c = y > 0 && i >= channels ? plain[(y - 1) * stride + i - channels] ?? 0 : 0;
      let predictor: number;
      switch (filter) {
        case 0: predictor = 0; break;
        case 1: predictor = a; break;
        case 2: predictor = b; break;
        case 3: predictor = (a + b) >> 1; break;
        case 4: {
          const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
          predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; break;
        }
        default: return bad();
      }
      plain[y * stride + i] = (value + predictor) & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: plain };
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = plain[p * 3] ?? 0; rgba[p * 4 + 1] = plain[p * 3 + 1] ?? 0; rgba[p * 4 + 2] = plain[p * 3 + 2] ?? 0; rgba[p * 4 + 3] = 255;
  }
  return { width, height, data: rgba };
}

/** 픽셀 단위로 비교한다. 크기가 다르면 큰 쪽 넓이 전체를 차이로 본다. */
export function compareImages(actual: Image, expected: Image): ImageDiff {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    return { sizeMatch: false, diffPixels: Math.max(actual.width * actual.height, expected.width * expected.height), ratio: 1 };
  }
  let diffPixels = 0; const pixels = actual.width * actual.height;
  for (let p = 0; p < pixels; p++) {
    for (let c = 0; c < 4; c++) {
      if (actual.data[p * 4 + c] !== expected.data[p * 4 + c]) { diffPixels++; break; }
    }
  }
  return { sizeMatch: true, diffPixels, ratio: diffPixels / pixels };
}
