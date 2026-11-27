import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** 재실행과 다른 clone이 이전 실측 증거를 덮어쓰지 않게 실행마다 새 폴더를 쓴다. */
export async function hostArchive(): Promise<string> {
  const root = resolve(process.env.AWBS_HOST_ARCHIVE ?? 'test-results/host');
  await mkdir(root, { recursive: true });
  const archive = await mkdtemp(join(root, 'run-'));
  console.log(`host 증거: ${archive}`);
  return archive;
}
