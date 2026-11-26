import { randomUUID } from 'node:crypto';
import { createRedactor } from '../../security/redact.ts';
import type { TaskCheckOptions, TaskCheckStep } from '../task.ts';
import { parsePipeline } from '../pipeline.ts';

export type MainBasis = NonNullable<TaskCheckOptions['basis']>;
export type CheckDeps = Pick<TaskCheckOptions, 'repo' | 'heavy' | 'execute' | 'redact' | 'signal'>;
export interface IntegrationCheck {
  stage: 'int'; status: 'pass' | 'fail'; baseSha: string; headSha: string; treeSha: string;
  pipelineSha: string; steps: TaskCheckStep[]; failStep: string | null; flakyCandidates: string[];
}

/** ②는 main 정의로 새 사본을 설치하고 검사한다. 실제 실행기는 Q-08 결정 전까지 연결하지 않는다. */
export async function runIntegrationCheck(deps: CheckDeps, basis: MainBasis, headSha: string): Promise<IntegrationCheck> {
  const { repo, heavy, execute, signal } = deps;
  const redact = deps.redact ?? createRedactor();
  const pipeline = parsePipeline(basis.source);
  const install = pipeline.stages.task[0];
  if (!install) throw new Error('설치 단계가 없습니다.');
  const commands = [install, ...pipeline.stages.int];
  const result: IntegrationCheck = { stage: 'int', status: 'fail', baseSha: basis.baseSha, headSha,
    treeSha: await repo.commitTree(headSha), pipelineSha: basis.pipelineSha,
    steps: commands.map(c => ({ name: c.name, status: 'skip', durationMs: 0, attempts: [] })),
    failStep: null, flakyCandidates: [] };
  const release = await heavy.acquire(`ci-int:${headSha}`, signal);
  const id = `ci-int-${randomUUID()}`;
  let created = false;
  let current = result.steps[0];
  try {
    const path = await repo.createTaskCheckWorktree(id, headSha); created = true;
    for (const [index, command] of commands.entries()) {
      current = result.steps[index];
      if (!current) throw new Error('검사 단계가 없습니다.');
      const started = performance.now();
      const retries = ['test', 'tests', 'unit', 'integration', 'e2e', 'contract'].includes(command.name) ? 2 : 1;
      for (let attempt = 0; attempt < retries; attempt++) {
        let output = { code: null as number | null, stdout: '', stderr: '' };
        try {
          signal?.throwIfAborted(); await repo.taskCheckPath(id, headSha);
          output = await execute(command.argv, path, signal);
          signal?.throwIfAborted(); await repo.taskCheckPath(id, headSha);
        } catch (error) {
          output = { ...output, code: null, stderr: [output.stderr, error instanceof Error ? error.message : '검사 실패'].filter(Boolean).join('\n') };
        }
        current.attempts.push(redact(output));
        current.status = output.code === 0 ? 'pass' : 'fail';
        if (output.code === 0) {
          if (attempt) result.flakyCandidates.push(command.name);
          break;
        }
        if (output.code === null) break;
      }
      current.durationMs = Math.max(0, Math.round(performance.now() - started));
      if (current.status === 'fail') { result.failStep = command.name; return redact(result); }
    }
    result.status = 'pass';
  } catch (error) {
    if (!current) throw error;
    current.status = 'fail'; result.failStep = current.name;
    current.attempts.push(redact({ code: null, stdout: '', stderr: error instanceof Error ? error.message : '검사 실패' }));
  } finally {
    try { if (created) await repo.removeWorktree(id); }
    finally { release(); }
  }
  return redact(result);
}
