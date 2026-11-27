import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runTaskCheck } from '../../src/ci/task.ts';
import { definition, fixture } from './int-fixture.ts';

test('main이 이동해도 ①은 대기열이 고정한 A의 정의로 검사한다', async () => {
  const f = await fixture();
  try {
    const basis = await f.repo.mainPipeline();
    await f.repo.createWorktree('pinned', 'agent/pinned', f.head);
    await f.advance('.agentwbs/pipeline.yaml', JSON.stringify({ ...definition, version: 99 }));
    const result = await runTaskCheck({ ...f.deps, worktreeId: 'pinned', branch: 'agent/pinned', basis });
    expect(result).toMatchObject({ status: 'pass', baseSha: f.base, pipelineSha: basis.pipelineSha });
    expect(f.calls.every(c => c.cwd !== join(f.root, 'source'))).toBe(true);
  } finally { await f.close(); }
});
