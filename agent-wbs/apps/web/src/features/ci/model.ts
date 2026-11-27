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

/** 소요 시간. Runner가 끝난 시각(finishedAt)을 보고했으면 시작~끝, 아니면 보고된 단계 시간의 합. */
export function runDurationMs(run: CiRun): number | null {
  if (run.finishedAt) return Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
  return run.steps.length ? run.steps.reduce((n, s) => n + s.durationMs, 0) : null;
}

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
 * 기준선 실패가 아직 유효한가. 서버는 같은 main(기준 커밋)에서 올바른 정의로 실행한 더 나중의 ① PASS가 오면 기준 경보를 해소한다(M7-04 결정 11).
 * 화면은 같은 기준 커밋(baseSha)·같은 정의(pipelineSha)로 **더 나중에 시작한** ① PASS가 있으면 해소로 본다.
 * - 다른 정의의 PASS, 다른 기준의 PASS, 더 먼저 시작해 늦게 끝난 옛 PASS는 해소하지 않는다.
 * - 한계: 「올바른 정의」를 서버는 관측한 main 정의로 판정한다. 화면은 실패한 실행과 같은 정의인지로만 본다(보고 참고).
 * runs는 서버 순서(최근 시작 먼저)다.
 */
export function baselineActive(runs: readonly CiRun[], fail: CiRun): boolean {
  const i = runs.indexOf(fail);
  return !runs.some((r, j) => r.stage === 'task' && r.status === 'pass' && r.baseSha === fail.baseSha && r.pipelineSha === fail.pipelineSha
    && (i < 0 ? Date.parse(r.startedAt) > Date.parse(fail.startedAt) : j < i && Date.parse(r.startedAt) >= Date.parse(fail.startedAt)));
}

/**
 * main 상태 배지. 원본은 Mock 값(main.st·commit·e2e·at)을 그대로 썼다. 제품은 실행 기록에서 정한다.
 * - 가장 최근의 「main을 보는 실행」을 쓴다.
 *   - 야간 점검(통과·실패)
 *   - 병합된 통합 확인: ② PASS이고 **연결된 대기열 행이 병합됨**이어야 한다. 병합 불일치로 보류된 행이면 「main 확인 필요」다(리뷰 fix1 P2-1).
 *     왜: 실행의 mergeSha만으로는 실제 병합이 검증 근거와 같은지 모른다. 서버는 불일치면 병합됨으로 바꾸지 않는다.
 *   - 아직 유효한 기준선 실패(baselineActive)
 * - 통합 확인 실패는 병합되지 않았으므로 main을 깨지 않는다(G L475).
 * - E2E 수는 Runner가 구조화해 보고한 값(e2e)이 있을 때만 보인다. 시각은 끝난 시각, 없으면 시작 시각이다(M7-04 fix2 계약 1).
 */
export function mainStatus(runs: readonly CiRun[], queue: readonly QueueItem[] = []): { l: string; c: string } {
  const linked = (r: CiRun) => queue.find((q) => q.ciRunId === r.id);
  const mismatched = (q: QueueItem | undefined) => q !== undefined && q.actualMergeSha !== null && q.status !== 'merged';
  const r = runs.find((x) => (x.stage === 'night' && (x.status === 'pass' || x.status === 'fail'))
    || (x.stage === 'int' && x.status === 'pass' && x.mergeSha !== null && (linked(x)?.status === 'merged' || mismatched(linked(x))))
    || (x.status === 'fail' && x.failScope === 'baseline' && baselineActive(runs, x)));
  if (!r) return { l: 'main 빌드 기록 없음', c: 'vf v-none' };
  const at = formatDateTime(r.finishedAt ?? r.startedAt);
  if (r.failScope === 'baseline') return { l: `main 깨짐 · 기준선 검사 실패 · ${short(r.baseSha)} · ${at}`, c: 'vf v-fail' };
  const q = r.stage === 'int' ? linked(r) : undefined;
  if (q && mismatched(q)) return { l: `main 확인 필요 · 병합 불일치 · ${short(q.actualMergeSha)} · ${at}`, c: 'vf v-fail' };
  const commit = short(r.stage === 'int' ? r.mergeSha : r.headSha ?? r.baseSha);
  const e2e = r.e2e ? ` · E2E ${String(r.e2e.passed)} / ${String(r.e2e.total)}` : '';
  if (r.status === 'fail') return { l: `main 깨짐 · ${commit}${e2e} · ${at}`, c: 'vf v-fail' };
  return { l: `main 정상 · ${commit}${e2e} · ${at}`, c: 'vf v-pass' };
}

/**
 * 보류 때문에 「다시 실행」을 막는가(리뷰 fix1 P2-4).
 * 서버가 보류 조건(실제 병합 SHA·불일치 경보·대조 대기)을 검사하는 것은 기준선 실패의 재통합 경로뿐이다. 일반 실패의 CI 재시도는 막지 않는다.
 */
export const retryHeld = (run: CiRun, holds: ReadonlySet<string>) =>
  run.status === 'fail' && run.failScope === 'baseline' && run.taskKey !== null && holds.has(run.taskKey);

/**
 * GitHub 칸(P ghL L4776). Runner가 GitHub에 실제로 보고하고 응답을 확인한 상태(githubStatus)만 「보고」로 보인다.
 * 값이 없으면 전송 여부를 모르는 것이다. CI 결과로 GitHub 상태를 추측하지 않는다(M7-04 fix2 계약 6).
 */
export function githubLabel(run: Pick<CiRun, 'pr' | 'stage' | 'githubStatus'>): string {
  const g = run.githubStatus;
  const target = run.pr === null ? 'main 커밋' : `GitHub PR #${String(run.pr)}`;
  if (g) return `${target} 검사 상태 보고: ${g.context} — ${g.state} · ${formatDateTime(g.reportedAt)}`;
  if (run.pr === null) return 'main 대상 — PR 없음';
  return `${target} 검사 상태 보고 확인 전 (agentwbs/${run.stage})`;
}

/** 병합 대기열 상태(P queue L4792의 문구를 계약 QueueStatus에 맞춤) */
const QUEUE: Record<string, { l: string; c: string }> = {
  waiting_verify: { l: '검증 대기', c: 'vf v-none' }, queued: { l: '대기', c: 'vf v-none' }, checking: { l: '통합 확인 중', c: 'vf v-run' },
  merged: { l: '병합됨', c: 'vf v-pass' }, failed: { l: '통합 실패 — 병합 보류', c: 'vf v-fail' }, removed: { l: '대기열에서 빠짐', c: 'vf v-none' },
};
const BASELINE_AUTO = { l: '기준선 실패 — main 수정 뒤 자동 재통합', c: 'sc sc-warn' };
const BASELINE_PAST = { l: '기준선 실패', c: 'sc sc-warn' };
const PENDING = new Set(['waiting_verify', 'queued', 'checking']);

export interface QueueRow { id: string; pr: string; taskKey: string; title: string; st: string; c: string; at: string; ciRunId: string | null; ciRunKey: string | null; autoReintegrate: boolean; mismatch: boolean; actualMergeSha: string | null }

/**
 * 병합 대기열 행.
 * - 시각: 병합됨은 실제 병합 시각(mergedAt), 그 밖은 대기열에 들어온 시각(queuedAt). 원본도 같은 칸에 두 시각을 썼다(P L3545).
 *   병합됐는데 실제 병합 시각을 아직 확인하지 못했으면 「병합 시각 미확인」이다(서버 수신 시각으로 대신하지 않는다, M7-04 fix2 계약 3).
 * - 기준선 실패: 연결된 실행이 failScope=baseline으로 실패했으면 Task 탓이 아니다(노란색).
 *   「main 수정 뒤 자동 재통합」은 서버가 실제로 자동 재통합하는 경우에만 붙인다(M7-04 fix3, 리뷰 fix1 P2-3):
 *   그 Task의 최신 차수(가장 큰 position)이고, Task가 gate에 있고, 같은 Task에 병합 불일치 보류가 없을 때.
 *   그 밖(새 차수가 생김·Task 완료·보류 중)은 지난 결과일 뿐이라 「기준선 실패」만 보인다.
 * - mismatch: 실제 병합 SHA가 기록됐는데 병합됨이 아니면, 서버가 MERGE_MISMATCH로 완료를 보류한 것이다(M7-04 조정자 결정 4).
 * taskStatus: Task 키 → 상태(listTasks의 lifecycleStatus). 모르면 자동 재통합 안내를 붙이지 않는다.
 */
export function queueRows(queue: readonly QueueItem[], titles: ReadonlyMap<string, string>, runs: readonly CiRun[], taskStatus: ReadonlyMap<string, string> = new Map()): QueueRow[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const isMismatch = (q: QueueItem) => q.actualMergeSha !== null && q.status !== 'merged';
  const held = new Set(queue.filter(isMismatch).map((q) => q.taskKey));
  const latest = new Map<string, QueueItem>();
  for (const q of queue) { const cur = latest.get(q.taskKey); if (!cur || q.position >= cur.position) latest.set(q.taskKey, q); }
  return queue.map((q) => {
    const linked = q.ciRunId ? byId.get(q.ciRunId) : undefined;
    const baseline = q.status === 'failed' && linked?.status === 'fail' && linked.failScope === 'baseline';
    const auto = baseline && latest.get(q.taskKey) === q && taskStatus.get(q.taskKey) === 'gate' && !held.has(q.taskKey);
    const s = baseline ? (auto ? BASELINE_AUTO : BASELINE_PAST) : QUEUE[q.status] ?? { l: String(q.status), c: 'vf v-none' };
    const time = q.status === 'merged' ? q.mergedAt : q.queuedAt;
    const at = time ? formatDateTime(time) : q.status === 'merged' ? '병합 시각 미확인' : '—';
    return {
      id: q.id, pr: prLabel(q.pr), taskKey: q.taskKey, title: titles.get(q.taskKey) ?? '', st: s.l, c: s.c, at,
      ciRunId: q.ciRunId, ciRunKey: linked?.runKey ?? null, autoReintegrate: auto, mismatch: isMismatch(q), actualMergeSha: q.actualMergeSha,
    };
  });
}

/**
 * 실행 상세의 「병합」 줄(재리뷰 P2-1). 통합 확인 실행의 mergeSha는 「검사한 병합본」일 뿐이다.
 * 실제로 main에 병합됐는지는 연결된 대기열 행의 서버 상태로만 말한다. 화면이 따로 판정하지 않는다.
 * - merged → 「병합됨 → main @ 실제 병합 SHA」
 * - 실제 병합 SHA가 있는데 merged가 아님 → 서버가 MERGE_MISMATCH로 완료를 보류한 상태
 * - 그 밖 → 대기열 상태 이름 + 병합 전
 * - 대기열 행이 없으면 병합 여부를 모른다고 쓴다.
 * ② 통합 확인 실행이 아니거나 mergeSha가 없으면 null(줄 없음).
 */
export function mergeLine(run: CiRun, queue: readonly QueueItem[]): string | null {
  if (run.stage !== 'int' || !run.mergeSha) return null;
  const tested = `검사한 병합본 ${short(run.mergeSha)}`;
  const q = queue.find((x) => x.ciRunId === run.id);
  if (!q) return `대기열 기록 없음 — 병합 여부 미확인 (${tested})`;
  if (q.status === 'merged') return `병합됨 → main @ ${short(q.actualMergeSha ?? run.mergeSha)}`;
  if (q.actualMergeSha) return `병합 불일치 — 실제 병합 ${short(q.actualMergeSha)} · 완료 보류 (${tested})`;
  return `${QUEUE[q.status]?.l ?? String(q.status)} — 병합 전 (${tested})`;
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
