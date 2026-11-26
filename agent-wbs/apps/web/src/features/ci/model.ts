/**
 * 빌드·통합 화면(UI-08) 계산 — 원본 P ciVM L4765–4801을 서버 계약(M7-04) 값으로 옮긴 순수 함수 모음.
 * 화면 파일(CiPage.tsx)은 그리기만 하고, 글자·색·건수는 여기서 정한다. 단위 시험: test/ci-model.test.ts.
 */
import type { ResponseOf } from '../../shared/api/contract.ts';
import { formatDateTime } from '../../shared/format.ts';

export type CiRun = ResponseOf<'getCiRun'>;
export type QueueItem = ResponseOf<'getMergeQueue'>['items'][number];
export type FlakyTest = ResponseOf<'listFlakyTests'>['items'][number];
export type Pipeline = ResponseOf<'getPipeline'>;
export type Stage = 'task' | 'int' | 'night' | 'deploy';

/** 단계 이름(P CI_STAGE L3523) */
export const STAGE_LABEL: Record<Stage, string> = { task: '① Task 검사', int: '② 통합 확인', night: '③ 야간 점검', deploy: '④ 배포 확인' };
export const STAGES: Stage[] = ['task', 'int', 'night', 'deploy'];
/** 결과 이름·색(P CI_ST L3524) */
const STATUS: Record<string, { l: string; c: string }> = {
  pass: { l: '통과', c: 'vf v-pass' }, fail: { l: '실패', c: 'vf v-fail' }, run: { l: '실행 중', c: 'vf v-run' },
  queued: { l: '대기', c: 'vf v-none' }, skip: { l: '건너뜀', c: 'vf v-none' },
};
export const statusLabel = (s: string) => STATUS[s] ?? { l: s, c: 'vf v-none' };

export const stageLabel = (s: string) => STAGE_LABEL[s as Stage] ?? s;
export const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '');
export const prLabel = (pr: number | null) => (pr === null ? '—' : `#${String(pr)}`);

/**
 * 실행 결과 표시. 기준선(main 기준 커밋 자체) 실패는 Task 탓 실패와 다르게 보인다(M7-04 조정자 결정, failScope=baseline).
 * 왜: 기준선 실패를 Task 실패로 보이면 팀장이 죄 없는 Task에 재작업을 시킨다.
 */
export function resultLabel(run: Pick<CiRun, 'status' | 'failScope'>): { l: string; c: string } {
  if (run.status === 'fail' && run.failScope === 'baseline') return { l: '기준선 실패', c: 'sc sc-warn' };
  return statusLabel(run.status);
}

export const runDurationMs = (run: CiRun): number | null => (run.steps.length ? run.steps.reduce((n, s) => n + s.durationMs, 0) : null);

/** 「3분 02초」「45초」(원본 dur 모양). 모르면 「—」 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${String(sec)}초`;
  return `${String(Math.floor(sec / 60))}분 ${String(sec % 60).padStart(2, '0')}초`;
}

export function runRows(runs: readonly CiRun[], stage: string): CiRun[] {
  return runs.filter((r) => !stage || r.stage === stage);
}

export function stageCounts(runs: readonly CiRun[]): Record<'' | Stage, number> {
  const out = { '': runs.length, task: 0, int: 0, night: 0, deploy: 0 };
  for (const r of runs) out[r.stage as Stage] += 1;
  return out;
}

export interface StepRow { name: string; l: string; c: string; dur: string }

/**
 * 상세의 단계 표(UAT-CI-01 c·d).
 * - 실패한 실행에서 실패 단계 뒤의 대기·실행 중 단계는 실제로 돌지 않았으므로 「건너뜀」으로 보인다.
 * - Runner가 실패 단계를 단계 목록에 보내지 않았으면(failStep만 보고) 맨 뒤에 실패 줄을 더한다.
 */
export function detailSteps(run: CiRun): StepRow[] {
  const steps = run.steps.map((s) => ({ name: s.name, status: String(s.status), durationMs: s.durationMs }));
  if (run.status === 'fail' && run.failStep && !steps.some((s) => s.name === run.failStep)) steps.push({ name: run.failStep, status: 'fail', durationMs: 0 });
  const failAt = run.status === 'fail' ? steps.findIndex((s) => s.status === 'fail') : -1;
  return steps.map((s, i) => {
    const status = failAt >= 0 && i > failAt && (s.status === 'queued' || s.status === 'run') ? 'skip' : s.status;
    const { l, c } = statusLabel(status);
    // 단계 시간은 원본처럼 초 단위 하나로 쓴다(P L4770 「136초」). 전체 소요만 「분 초」로 쓴다.
    return { name: s.name, l, c, dur: status === 'pass' || status === 'fail' ? `${String(Math.round(s.durationMs / 1000))}초` : '—' };
  });
}

export function position(ids: readonly string[], sel: string): { label: string; prev: string | null; next: string | null } {
  const i = ids.indexOf(sel);
  if (i < 0) return { label: '목록 밖', prev: null, next: null };
  return { label: `${String(i + 1)} / ${String(ids.length)}`, prev: ids[i - 1] ?? null, next: ids[i + 1] ?? null };
}

/** 같은 대상인지(같은 단계 + 같은 Task·PR). 원본은 stage + task로 봤다(P L4782). PR이 없으면 main 대상 하나로 본다. */
const sameTarget = (a: CiRun, b: CiRun) => a.stage === b.stage && a.taskKey === b.taskKey && a.pr === b.pr;

/** 미해결 실패: 서버 순서(최근 먼저)에서 앞쪽(더 최근)에 같은 대상의 통과가 없는 실패 */
export function openFailures(runs: readonly CiRun[]): number {
  return runs.filter((r, i) => r.status === 'fail' && !runs.slice(0, i).some((y) => y.status === 'pass' && sameTarget(r, y))).length;
}

/**
 * main 상태 배지. 원본은 Mock 값(main.st)을 그대로 썼다. 제품은 실행 기록에서 정한다.
 * - 가장 최근의 「main을 보는 실행」을 쓴다: 야간 점검(통과·실패), 병합된 통합 확인(통과 + 병합 SHA), 기준선 실패(Task 검사가 본 main 기준 커밋 자체가 실패).
 * - 통합 확인 실패는 병합되지 않았으므로 main을 깨지 않는다(G L475).
 * - 원본의 「E2E 12 / 12」는 계약에 숫자가 없어 보이지 않는다(보고 참고).
 */
export function mainStatus(runs: readonly CiRun[]): { l: string; c: string } {
  const r = runs.find((x) => (x.stage === 'night' && (x.status === 'pass' || x.status === 'fail'))
    || (x.stage === 'int' && x.status === 'pass' && x.mergeSha !== null)
    || (x.status === 'fail' && x.failScope === 'baseline'));
  if (!r) return { l: 'main 빌드 기록 없음', c: 'vf v-none' };
  const at = formatDateTime(r.startedAt);
  if (r.failScope === 'baseline') return { l: `main 깨짐 · 기준선 검사 실패 · ${short(r.baseSha)} · ${at}`, c: 'vf v-fail' };
  const commit = short(r.stage === 'int' ? r.mergeSha : r.headSha ?? r.baseSha);
  if (r.status === 'fail') return { l: `main 깨짐 · ${commit} · ${at}`, c: 'vf v-fail' };
  return { l: `main 정상 · ${commit} · ${at}`, c: 'vf v-pass' };
}

/** GitHub 칸(P ghL L4776). Runner가 PR 검사 상태(commit status)로 보고하는 이름과 상태 */
export function githubLabel(run: Pick<CiRun, 'pr' | 'stage' | 'status'>): string {
  if (run.pr === null) return 'main 대상 — PR 없음';
  const state = run.status === 'pass' ? 'success' : run.status === 'fail' ? 'failure' : 'pending';
  return `GitHub PR #${String(run.pr)} 검사 상태 보고: agentwbs/${run.stage} — ${state}`;
}

/** 병합 대기열 상태(P queue L4792의 문구를 계약 QueueStatus에 맞춤) */
const QUEUE: Record<string, { l: string; c: string }> = {
  waiting_verify: { l: '검증 대기', c: 'vf v-none' }, queued: { l: '대기', c: 'vf v-none' }, checking: { l: '통합 확인 중', c: 'vf v-run' },
  merged: { l: '병합됨', c: 'vf v-pass' }, failed: { l: '통합 실패 — 병합 보류', c: 'vf v-fail' }, removed: { l: '대기열에서 빠짐', c: 'vf v-none' },
};
const PENDING = new Set(['waiting_verify', 'queued', 'checking']);

export interface QueueRow { id: string; pr: string; taskKey: string; title: string; st: string; c: string; at: string; ciRunId: string | null; ciRunKey: string | null; mismatch: boolean; actualMergeSha: string | null }

/**
 * 병합 대기열 행.
 * - 시각: 계약의 대기열 행에 시각이 없어, 연결된 통합 확인 실행(ciRunId)의 시작 시각을 쓴다. 없으면 「—」(보고 참고).
 * - mismatch: 실제 병합 SHA가 기록됐는데 병합됨이 아니면, 서버가 MERGE_MISMATCH로 완료를 보류한 것이다(M7-04 조정자 결정 4).
 */
export function queueRows(queue: readonly QueueItem[], titles: ReadonlyMap<string, string>, runs: readonly CiRun[]): QueueRow[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  return queue.map((q) => {
    const s = QUEUE[q.status] ?? { l: String(q.status), c: 'vf v-none' };
    const linked = q.ciRunId ? byId.get(q.ciRunId) : undefined;
    const at = linked?.startedAt;
    return {
      id: q.id, pr: prLabel(q.pr), taskKey: q.taskKey, title: titles.get(q.taskKey) ?? '', st: s.l, c: s.c, at: at ? formatDateTime(at) : '—',
      ciRunId: q.ciRunId, ciRunKey: linked?.runKey ?? null, mismatch: q.actualMergeSha !== null && q.status !== 'merged', actualMergeSha: q.actualMergeSha,
    };
  });
}

export const lastDeploy = (runs: readonly CiRun[]) => runs.find((r) => r.stage === 'deploy') ?? null;

export function summaryLine(runs: readonly CiRun[], queue: readonly QueueItem[]): string {
  const dep = lastDeploy(runs);
  const pend = queue.filter((q) => PENDING.has(q.status)).length;
  return `실행 ${String(runs.length)} · 실패 미해결 ${String(openFailures(runs))} · 병합 대기 ${String(pend)} · 마지막 배포 확인 ${dep ? `${formatDateTime(dep.startedAt)} ${resultLabel(dep).l}` : '없음'}`;
}

export function tabBadges(runs: readonly CiRun[], queue: readonly QueueItem[], flaky: readonly FlakyTest[]) {
  return { runs: openFailures(runs), queue: queue.filter((q) => PENDING.has(q.status)).length, flaky: flaky.filter((f) => f.quarantined).length };
}

/**
 * Task 실행 탭의 CI 참조(원본 P L1310·5309 ciL·ciC, UAT-TASK-10-CI): 그 시도의 가장 최근 ① Task 검사.
 * runs는 서버 순서(최근 먼저)다. 없으면 null(표시 없음).
 */
export function attemptCiRef(runs: readonly CiRun[], attemptId: string): { id: string; l: string; c: string } | null {
  const r = runs.find((x) => x.stage === 'task' && x.attemptId === attemptId);
  if (!r) return null;
  const res = resultLabel(r);
  const c = r.status === 'fail' ? (r.failScope === 'baseline' ? 'sc sc-warn' : 'sc sc-bad') : 'sc sc-ok';
  return { id: r.id, l: `Task 검사 ${res.l} · ${r.runKey}`, c };
}
