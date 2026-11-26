// 입력 복사를 하다 SIGKILL로 죽을 자식 프로세스(재리뷰 N2 시험용).
// 모든 입력 파일을 쓴 뒤, 공개(또는 마지막 확인) 직전의 trusted() 호출에서 멈추고 부모에게 알린다.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GitRepository } from '../../src/git/repository.ts';

const [home, id, base, inputId] = process.argv.slice(2) as [string, string, string, string];
const repo = await GitRepository.open(home, id);
const internals = repo as unknown as { trusted(): Promise<unknown> };
const trusted = internals.trusted.bind(repo);
const written = () => {
  const root = join(home, 'inputs', id);
  if (!existsSync(root)) return false;
  return readdirSync(root).some((name) => existsSync(join(root, name, 'prototype/input')));
};
let gated = false;
internals.trusted = async () => {
  if (!gated && written()) {
    gated = true;
    process.send?.({ stage: 'files-written' });
    await new Promise(() => undefined);
  }
  return trusted();
};
setInterval(() => undefined, 1000);
await repo.checkoutInput(inputId, base);
process.send?.({ stage: 'published' });
