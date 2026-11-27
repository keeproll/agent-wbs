import { crc32, deflateSync } from 'node:zlib';

/** 시험용 PNG 인코더다. 8비트 RGBA, filter 지정(0~4), 압축만 쓴다. */
export function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number],
  { filter = 0, colorType = 6 }: { filter?: number; colorType?: 2 | 6 } = {}): Buffer {
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const plain = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = pixel(x, y);
    for (let c = 0; c < channels; c++) plain[y * stride + x * channels + c] = value[c] ?? 0;
  }
  const at = (y: number, i: number) => y < 0 || i < 0 ? 0 : plain[y * stride + i] ?? 0;
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const value = at(y, i); const a = at(y, i - channels); const b = at(y - 1, i); const c = at(y - 1, i - channels);
      const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter] ?? 0;
      raw[y * (stride + 1) + 1 + i] = (value - predictor) & 0xff;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = colorType; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** 시험용 기준 렌더러: HTML 파일 내용을 base64 PNG로 보고 그대로 돌려준다. 실제 렌더는 ci-night-render 시험이 다룬다. */
export const pngRenderer = async (request: { entry: string; read: (path: string) => Promise<Buffer> }): Promise<Buffer> =>
  Buffer.from((await request.read(request.entry)).toString(), 'base64');
