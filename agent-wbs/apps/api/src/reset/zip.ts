import { crc32 } from 'node:zlib';

/** ZIP의 무압축 저장 형식. PDF·이미지는 이미 압축되어 있으므로 다시 압축하지 않는다. */
// shortcut: ZIP32와 메모리 크기 안에서만 내보낸다. 큰 보관 자료가 생기면 스트리밍 ZIP64로 바꾼다.
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  if (files.length > 65_535) throw new Error('ZIP 파일 수 한도 초과');
  const chunks: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    if (name.length > 65_535 || file.data.length > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP 크기 한도 초과');
    const header = Buffer.alloc(30), central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc32(file.data), 14);
    header.writeUInt32LE(file.data.length, 18); header.writeUInt32LE(file.data.length, 22); header.writeUInt16LE(name.length, 26);
    // 「만든 OS」를 Unix(3)로 둔다(0x0314). MS-DOS(0)면 Info-ZIP unzip이 UTF-8 표시(0x800)를 무시하고 한글 이름을 CP437로 푼다(M2-04 리뷰 P3-5).
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); header.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    chunks.push(header, name, file.data); directory.push(central, name);
    offset += header.length + name.length + file.data.length;
  }
  const size = directory.reduce((sum, chunk) => sum + chunk.length, 0);
  if (offset + size > 0xffffffff) throw new Error('ZIP 크기 한도 초과');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...directory, end]);
}
