/**
 * 검증 화면(UI-07)의 화면 없는 계산. 원본 vfVM(P L6334–6369)을 서버 계약 모양에 맞춰 옮겼다.
 *
 * 원본과 다른 점(서버 계약 때문):
 * - 검증 표시 번호(V-0007-1)는 서버가 주지 않는다. 같은 Task의 검증을 시각 순서로 세어 만든 「표시용」 번호다.
 *   검증은 덧붙이기만 하므로(append-only) 번호가 바뀌지 않는다. 선택·주소에는 서버 id를 쓴다.
 * - 검증 Agent·실행 시도 번호는 검증 응답에 없다. 그 검증의 실행 시도(GET /api/tasks/:taskKey/attempts)에서 읽는다.
 * - Evidence에는 파일 경로가 없다(계약: kind·sha256·size). 그래서 종류와 지문 앞자리로 보이고 원본은 내려받기로 연다.
 */
import type { ResponseOf } from '../../shared/api/contract.ts';
import { GATE_KEYS } from './labels.ts';

export type VerificationItem = ResponseOf<'listVerifications'>['items'][number];
export type EvidenceItem = ResponseOf<'listEvidence'>['items'][number];
export type GateItem = ResponseOf<'listGates'>['items'][number];
export type TaskItem = ResponseOf<'listTasks'>['tasks'][number];
export interface AttemptInfo { attemptKey: string; agent: string }

export interface ResultFilter { result: string; agent: string }
export const EMPTY_RESULT_FILTER: ResultFilter = { result: '', agent: '' };

const byNewest = (a: { at: string; id: string }, b: { at: string; id: string }) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

/** 검증 id → 표시 번호 `V-<Task 번호>-<그 Task의 n번째 검증>` */
export function verificationKeys(verifs: readonly VerificationItem[]): Map<string, string> {
  const keys = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const x of [...verifs].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
    const n = (seen.get(x.taskKey) ?? 0) + 1;
    seen.set(x.taskKey, n);
    // M3 통합: 서버 후속 3차가 검증 번호(verificationKey)를 준다. 있으면 그 값을 쓴다(대시보드와 같은 번호, 필터·쪽과 무관).
    keys.set(x.id, x.verificationKey ?? `V-${x.taskKey.replace(/^TASK-/, '')}-${String(n)}`);
  }
  return keys;
}

export function resultRows(verifs: readonly VerificationItem[], attempts: ReadonlyMap<string, AttemptInfo>, f: ResultFilter): VerificationItem[] {
  return [...verifs].sort(byNewest).filter((x) =>
    (!f.result || String(x.result) === f.result) && (!f.agent || attempts.get(x.attemptId)?.agent === f.agent));
}

export interface Position { index: number; label: string; prev: string | null; next: string | null }
export function position(rows: readonly { id: string }[], selected: string): Position {
  const index = rows.findIndex((r) => r.id === selected);
  if (index < 0) return { index, label: '목록 밖 (필터에 맞지 않음)', prev: null, next: null };
  return { index, label: `${String(index + 1)} / ${String(rows.length)}`, prev: rows[index - 1]?.id ?? null, next: rows[index + 1]?.id ?? null };
}

export interface EvidenceRow extends EvidenceItem { checklist: string; linked: boolean }
/** Evidence 탭 행. 검증 최신순으로 묶고, 어느 검증에도 속하지 않은 Evidence는 맨 뒤에 둔다. */
export function evidenceRows(list: readonly EvidenceItem[], verifs: readonly VerificationItem[]): EvidenceRow[] {
  const order = new Map([...verifs].sort(byNewest).map((x, i) => [x.id, i]));
  const rank = (e: EvidenceItem) => (e.verificationId === null ? Number.MAX_SAFE_INTEGER : order.get(e.verificationId) ?? Number.MAX_SAFE_INTEGER - 1);
  return [...list]
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
    .map((e) => ({ ...e, checklist: e.checklistItemKey ?? '미연결', linked: e.checklistItemKey !== null }));
}

/** 체크리스트 한 항목의 Evidence 참조(TaskDetail.checklistItems의 일부) */
export interface ChecklistRef { itemKey: string; evidence: string | null }
export interface OrphanRef { taskKey: string; itemKey: string; ref: string }

/**
 * 검증 결과에 없는 체크리스트 Evidence(P orphan L6354–6355와 같은 판정).
 * 체크리스트 항목의 evidence 값(Evidence id 또는 경로)이 같은 Task의 「검증에 속한 Evidence」 어디에도 없으면 고아다.
 * 왜 Evidence 목록만으로 판정하지 않나: 체크리스트가 존재하지 않는 경로를 가리키면 Evidence 행 자체가 없어 놓친다(리뷰 3).
 * ref: 맞는 Evidence 행이 있으면(검증 없음) 그 이름, 없으면 참조 문자열 그대로.
 */
export function orphanChecklist(checklists: ReadonlyMap<string, readonly ChecklistRef[]>, evidence: readonly EvidenceItem[]): OrphanRef[] {
  const out: OrphanRef[] = [];
  for (const [taskKey, items] of checklists) {
    const own = evidence.filter((e) => e.taskKey === taskKey);
    const verified = own.filter((e) => e.verificationId !== null);
    const matches = (e: EvidenceItem, ref: string) => e.id === ref || (e.path ?? null) === ref;
    for (const c of items) {
      const ref = c.evidence?.trim();
      if (!ref || ref === '—' || verified.some((e) => matches(e, ref))) continue;
      const row = own.find((e) => matches(e, ref));
      out.push({ taskKey, itemKey: c.itemKey, ref: row ? evidenceName(row) : ref });
    }
  }
  return out;
}

/** 실행 시도를 아직 못 읽어(불러오는 중·실패) Agent를 모르는 검증 수. 0이 아니면 Agent 필터 결과를 「조건 불일치」로 단정하지 않는다. */
export const unknownAgentCount = (verifs: readonly VerificationItem[], attempts: ReadonlyMap<string, AttemptInfo>): number =>
  verifs.filter((v) => !attempts.has(v.attemptId)).length;

export interface GateCell { key: string; result: string; reason: string }
export interface GateRow { taskKey: string; title: string; status: string; cells: GateCell[]; passedN: number; total: string; all: boolean }

const taskNo = (key: string) => Number(key.replace(/^TASK-/, '')) || 0;

export function gateRows(gates: readonly GateItem[], tasks: readonly TaskItem[], onlyUnpassed: boolean): GateRow[] {
  const byKey = new Map(tasks.map((t) => [t.taskKey, t]));
  return gates
    .filter((g) => byKey.get(g.taskKey)?.lifecycleStatus !== 'cancelled')
    .map((g) => {
      const t = byKey.get(g.taskKey);
      const cells = GATE_KEYS.map((key) => {
        const c = g.conditions.find((x) => x.key === key);
        return { key, result: c ? String(c.result) : '—', reason: c?.reason ?? '서버 판정 없음' };
      });
      const passedN = cells.filter((c) => c.result === 'PASS').length;
      return { taskKey: g.taskKey, title: t?.title ?? '', status: String(t?.lifecycleStatus ?? ''), cells, passedN, total: `${String(passedN)}/5`, all: g.passed };
    })
    .filter((g) => !onlyUnpassed || !g.all)
    .sort((a, b) => taskNo(a.taskKey) - taskNo(b.taskKey));
}

export function tabCounts(verifs: readonly VerificationItem[], evidence: readonly EvidenceItem[], gates: readonly GateItem[], tasks: readonly TaskItem[]) {
  return { results: verifs.length, evidence: evidence.length, gateUnpassed: gateRows(gates, tasks, true).length };
}

/**
 * Evidence 한 개의 짧은 이름. 팀장이 연결한 경로·링크(path)는 그대로, Runner가 올린 파일은 「종류 · 지문(sha256) 앞 12자리」.
 */
export const evidenceName = (e: Pick<EvidenceItem, 'kind' | 'sha256' | 'path'>) =>
  e.path ? e.path : `${e.kind} · ${(e.sha256 ?? '').slice(0, 12)}`;

/** 화면에 보이는 종류. 경로 참조는 원본 evKind(P L4371)처럼 확장자로 정한다. */
export function evidenceKind(e: Pick<EvidenceItem, 'kind' | 'path'>): string {
  const p = e.path;
  if (!p) return e.kind;
  return /\.(png|jpe?g|gif)$/i.test(p) ? '스크린샷' : /\.(log|txt)$/i.test(p) ? '로그' : /\.json$/i.test(p) ? '측정 데이터'
    : /\.sql$/i.test(p) ? 'SQL' : /\.md$/i.test(p) ? '문서' : '파일';
}
