import { createHash } from 'node:crypto';
import type { ApiClient } from '../api/client.ts';
import type { Runner } from '../api/runner.ts';
import type { Execution } from '../exec/session.ts';
import type { GitRepository } from '../git/repository.ts';
import { reportEvent, type AttemptContext, type AttemptFlowOptions, type AttemptReport } from './attempt-flow.ts';
import { checklistOf, fixPrompt, isVerify, parseOutput, specRevisionOf, type DevOutput, type QaOutput } from './output.ts';
import type { AttemptWorkspace } from './workspace.ts';

/*
 * 결과 수집기(contracts §5 · jobs/README.md 「결과 수집과 나가는 값」).
 * 1. 종료 메시지를 스키마로 검사한다. 맞지 않으면 같은 세션에 한 번만 수정 요청을 보낸다(`Execution.followUp`).
 * 2. 개발: 변경 파일은 Agent 자기보고가 아니라 Runner bare 저장소의 git diff다. 입력은 ①이 래퍼 git-bundle로 가져온 결과 커밋이다.
 * 3. 검증: headSha(준비 때 고정한 커밋)·specRevision(지시문의 명세 버전)을 고정하고, 끝난 폴더의 HEAD·청결을 Agent 계정 git으로 다시 본다.
 * 4. Evidence: 검증한 종료 메시지와 Runner 관측을 JSON 파일 하나로 올리고 그 ID를 보고한다.
 * 결과를 모르면 지어내지 않는다: 확인하지 못한 것은 예외로 멈추고(시도 중단), 체크리스트 키도 서버가 준 것만 쓴다.
 */

export interface CollectDeps {
  api: ApiClient;
  runner: Runner;
  execution: Execution;
  repo: () => Promise<GitRepository>;
  workspace: AttemptWorkspace;
}
/** 앱 밖(main)이 넘기는 수집 공급원. 공유 인스턴스(api·runner·execution)는 앱이 채운다(`bindTaskCheck`와 같은 방식). */
export type CollectSources = Omit<CollectDeps, 'api' | 'runner' | 'execution'>;

/** 확인할 수 없어 결과를 만들지 않았다. 시도는 중단(interrupted)으로 끝난다. */
export class CollectError extends Error { override name = 'CollectError'; }

/** 수정 요청 뒤에도 형식이 맞지 않았다는 표시(개발 시도의 failure 문구). */
export const FORMAT_FAILURE = 'Agent 종료 메시지 형식 오류(수정 요청 1회 뒤에도 계약과 다름)';

export function bindCollect(d: CollectDeps): AttemptFlowOptions['collect'] {
  return async (context: AttemptContext) => {
    const { job, output, epoch, signal, messages } = context;
    const delivered = messages.map(m => m.id);
    let parsed = parseOutput(job, output.text, delivered);
    let fixed = false;
    if (!parsed.ok) {
      // 횟수 규칙: 시도마다 한 번. 이 함수 밖에서 다시 부르지 않는다(contracts §5 「1회 수정 요청, 이후 실패」).
      const again = await d.execution.followUp(job, epoch, output, fixPrompt(job, parsed.problems), signal);
      signal.throwIfAborted();
      fixed = true;
      parsed = again.ok ? parseOutput(job, again.text, delivered) : { ok: false, problems: [`수정 요청 실행이 실패했습니다(종료 코드 ${String(again.code)}).`] };
    }
    const git = await d.repo();
    const upload = async (kind: string, value: object) => {
      const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const response = await reportEvent(d, 'uploadEvidence', { epoch, params: { attemptId: output.attemptId },
        body: { file: new Blob([bytes], { type: 'application/json' }), kind, sha256, size: bytes.length, fence: job.fence } }, signal);
      return response.body.id;
    };

    if (!isVerify(job)) {
      const work = d.workspace.worktree(job);
      // ①이 Agent 계정 git-bundle로 가져와 검사·push한 커밋. 다시 가져오지 않는다(검사한 것과 보고하는 것이 같아야 한다).
      const head = await git.resultHead(work.id);
      if (!head) throw new CollectError('①이 가져온 개발 결과 커밋이 없어 변경 파일을 볼 수 없습니다.');
      // 수정 요청 세션이 파일을 바꾸거나 커밋했으면 검사하지 않은 코드다. HEAD·청결은 Agent 계정 git으로 본다.
      if (fixed) await git.taskCheckPath(work.id, head).catch((error: unknown) => { throw new CollectError('수정 요청 뒤 작업 폴더가 검사한 커밋과 다릅니다.', { cause: error }); });
      const changedFiles = await git.changedPaths(job.payload.baseCommit, head);
      if (!parsed.ok) {
        const evidence = await upload('agent-output-invalid', { headSha: head, changedFiles, problems: parsed.problems, fixRequested: fixed });
        return { report: { summary: '종료 메시지 형식 오류', failure: FORMAT_FAILURE, changedFiles, evidence: [evidence] } };
      }
      const value = parsed.value as DevOutput;
      const evidence = await upload('dev-report', { headSha: head, baseCommit: job.payload.baseCommit, changedFiles, fixRequested: fixed,
        selfCheck: value.selfCheck, followups: value.followups, designItems: value.designItems });
      return { report: { summary: value.summary, changedFiles, evidence: [evidence] }, responses: value.responses ?? [] };
    }

    // 검증: 서버가 qa 결과에 failure를 받지 않는다. 형식이 끝내 맞지 않으면 판정을 지어내지 않고 멈춘다.
    if (!parsed.ok) throw new CollectError(`${FORMAT_FAILURE}: ${parsed.problems.slice(0, 5).join(' / ')}`);
    const value = parsed.value as QaOutput;
    // 종료 때 HEAD·청결 재확인(contracts §4.1 「코드 근거 고정」 1). 다르면 이 판정은 검사한 코드의 것이 아니다.
    await git.taskCheckPath(d.workspace.verifyWorktree(job), output.headSha).catch((error: unknown) => {
      throw new CollectError('QA가 끝난 작업 폴더가 검사한 커밋과 다르거나 커밋하지 않은 변경이 있습니다.', { cause: error });
    });
    const specRevision = specRevisionOf(job);
    const known = new Set(checklistOf(job).map(i => i.itemKey));
    const evidence = await upload('qa-report', { headSha: output.headSha, specRevision, inputVersion: job.payload.inputVersion, clean: true, fixRequested: fixed,
      verdict: value.verdict, criteria: value.criteria, defects: value.defects });
    const report: AttemptReport = {
      summary: `QA ${value.verdict}: ${String(value.criteria.filter(c => c.result === 'PASS').length)}/${String(value.criteria.length)} 항목 통과`,
      changedFiles: [], evidence: [evidence],
      verification: {
        headSha: output.headSha, specRevision, result: value.verdict,
        cmd: value.criteria.map(c => `[${c.acId}] ${c.cmd}`).join('\n') || '(검사 명령 없음)',
        expected: value.criteria.map(c => `[${c.acId}] ${c.expected}`).join('\n') || '(체크리스트 없음)',
        actual: value.criteria.map(c => `[${c.acId}] ${c.result}: ${c.actual}`).join('\n') || '(관측 없음)',
        defects: value.defects,
        checklist: value.criteria.filter(c => known.has(c.acId)).map(c => ({ itemKey: c.acId, done: c.result === 'PASS', evidence,
          ...(c.evidence.length && { note: `Agent가 적은 근거: ${c.evidence.join(', ')}`.slice(0, 2000) }) })),
      },
    };
    return { report, responses: value.responses ?? [] };
  };
}
