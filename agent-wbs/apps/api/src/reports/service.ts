import type { Pool, PoolClient } from '@awbs/db';
import { customPeriodProblem, duePeriodic, reportKey, seoulDay, snapshotProblem, type ReportKind, type ReportSnapshotData } from '@awbs/shared';
import { ApiError, invalid } from '../changes/http.ts';
import { decodeCursor, encodeCursor, InputProblem } from '../changes/history.ts';
import { deferChange } from '../changes/events.ts';
import { inEpoch } from '../platform/transaction.ts';
import { scheduleView } from '../planning/schedule.ts';
import { buildSnapshot } from './snapshot.ts';
import { enqueueReportMail } from '../mail/queue.ts';

/**
 * 보고서 생성·조회(G§4.11, §8.5, §9.6, contracts §2.3, data-model §2.7 `reports`).
 *
 * - 보고서는 **추가만** 한다. 수정·삭제 API가 없고, DB 트리거도 앱 권한의 UPDATE·DELETE를 거부한다(G§9.6-1).
 * - 같은 종류·기간의 정기 보고서는 하나다. 막는 것은 DB 고유 인덱스(`one_periodic_report`)다.
 *   왜 DB인가: worker가 둘 떠도, 서버 시작 보충과 정기 점검이 겹쳐도 중복이 생기지 않는다(architecture §2 worker).
 */
export const REASON = {
  startup: '서버 시작 시 누락분 보충',
  late: '누락분 보충',
  scheduled: '정기 생성',
  custom: '팀장 지정',
} as const;
/** 예정 시각보다 이만큼 늦게 만들면 「누락분 보충」으로 표시한다. worker 점검 주기(20초)보다 넉넉하다. */
const LATE_MS = 30 * 60_000;

const iso = (column: string) => `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const SUMMARY = `id,report_key "reportKey",kind,to_char("from",'YYYY-MM-DD') "from",to_char("to",'YYYY-MM-DD') "to",view,
  ${iso('generated_at')} "generatedAt",${iso('due_at')} "dueAt",reason`;

export interface ReportSummary { id: string; reportKey: string; kind: ReportKind; from: string; to: string; view: 'int' | 'ext'; generatedAt: string; dueAt: string | null; reason: string | null }
/** 응답 모양(계약 reportSummary). */
const summaryOf = (row: ReportSummary) => ({ id: row.id, reportKey: row.reportKey, kind: row.kind, from: row.from, to: row.to, view: row.view, generatedAt: row.generatedAt, dueAt: row.dueAt, reason: row.reason });

async function insertReport(client: PoolClient, projectId: string, row: { key: string; kind: ReportKind; from: string; to: string; view: 'int' | 'ext'; snapshot: ReportSnapshotData; at: string; dueAt: string | null; reason: string }) {
  // 쓰기 전에 계약 스키마로 검사한다(data-model §1: jsonb는 쓰기 시 TypeBox 검증).
  const problem = snapshotProblem(row.snapshot);
  if (problem) throw new Error(`보고서 스냅샷이 계약과 다릅니다: ${problem}`);
  const inserted = (await client.query<ReportSummary>(
    `insert into reports(project_id,report_key,kind,"from","to",view,snapshot,generated_at,due_at,reason) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
     on conflict do nothing returning ${SUMMARY}`,
    [projectId, row.key, row.kind, row.from, row.to, row.view, JSON.stringify(row.snapshot), row.at, row.dueAt, row.reason])).rows[0];
  if (inserted) deferChange(client, projectId, 'report', { id: inserted.id });
  return inserted;
}

/**
 * 정기 보고서 점검(worker가 주기마다, 그리고 서버 시작 때 부른다). 새로 만든 건수를 돌려준다.
 * - now: 점검 시각. 없으면 DB 시계. 시험은 시각을 정해 부른다.
 * - startup: 서버 시작 직후 점검이면 모든 보충분에 「서버 시작 시 누락분 보충」을 적는다(G L377).
 */
export async function generateDueReports(pool: Pool, epoch: number, options: { now?: string; startup?: boolean } = {}): Promise<number> {
  return inEpoch(pool, epoch, async (client) => {
    // 같은 순간의 두 점검을 차례로 세운다. 중복 자체는 고유 인덱스가 막고, 잠금은 헛 계산을 줄인다.
    await client.query("select pg_advisory_xact_lock(hashtextextended('awbs:reports',0))");
    const project = (await client.query<{ id: string; start: string }>("select id,to_char(start_date,'YYYY-MM-DD') start from projects where phase='active'")).rows[0];
    if (!project) return 0;
    const now = options.now ?? (await client.query<{ now: string }>(`select ${iso('clock_timestamp()')} now`)).rows[0]?.now ?? new Date().toISOString();
    const last = (await client.query<{ kind: 'daily' | 'weekly'; to: string }>(
      `select kind,to_char(max("to"),'YYYY-MM-DD') "to" from reports where project_id=$1 and kind in ('daily','weekly') group by kind`, [project.id])).rows;
    const due = duePeriodic({ now, start: project.start, lastDaily: last.find((r) => r.kind === 'daily')?.to ?? null, lastWeekly: last.find((r) => r.kind === 'weekly')?.to ?? null });
    let created = 0;
    for (const d of due) {
      const snapshot = await buildSnapshot(client, project.id, { kind: d.kind, from: d.from, to: d.to, at: now });
      const reason = options.startup ? REASON.startup : Date.parse(now) - Date.parse(d.dueAt) > LATE_MS ? REASON.late : REASON.scheduled;
      const inserted = await insertReport(client, project.id, { key: reportKey(d.kind, d.from), kind: d.kind, from: d.from, to: d.to, view: 'int', snapshot, at: now, dueAt: d.dueAt, reason });
      if (!inserted) continue;
      created++;
      // M6-03: 생성 직후 구독자를 메일 큐에 넣는다(같은 트랜잭션, SMTP 호출 없음 — G L401·L1050).
      await enqueueReportMail(client, inserted);
    }
    return created;
  });
}

/** 기간 지정 보고서(POST /api/projects/:projectId/reports). 공통 관문이 연 트랜잭션 안에서 실행한다. */
export async function createCustomReport(client: PoolClient, projectId: string, input: { from: string; to: string; view: 'int' | 'ext' }) {
  const project = (await client.query<{ id: string }>('select id from projects where id=$1', [projectId])).rows[0];
  if (!project) throw new ApiError('PROJECT_NOT_FOUND', {}, [], '프로젝트를 찾을 수 없습니다.');
  const now = (await client.query<{ now: string }>(`select ${iso('clock_timestamp()')} now`)).rows[0]?.now ?? new Date().toISOString();
  const problem = customPeriodProblem(input.from, input.to, seoulDay(now));
  if (problem) throw invalid([{ path: problem.path, rule: problem.rule, message: problem.message }], problem.message);
  const seq = (await client.query<{ value: number }>(
    `insert into counters(project_id,kind,value) values($1,'report_custom',1)
     on conflict (project_id,kind) do update set value=counters.value+1 returning value::int value`, [projectId])).rows[0]?.value ?? 1;
  const snapshot = await buildSnapshot(client, projectId, { kind: 'custom', from: input.from, to: input.to, at: now });
  const row = await insertReport(client, projectId, { key: reportKey('custom', input.from, seq), kind: 'custom', ...input, snapshot, at: now, dueAt: null, reason: REASON.custom });
  if (!row) throw new Error('기간 지정 보고서 번호가 겹쳤습니다.');
  return summaryOf(row);
}

const PAGE = 50;

/** 목록: 기간 끝이 늦은 것부터(최신순, G§8.5). 같으면 생성 시각·id 내림차순. */
export async function listReports(client: PoolClient, projectId: string, input: { kind?: ReportKind | undefined; limit?: number | undefined; cursor?: string | undefined }) {
  const limit = Math.min(input.limit ?? PAGE, 200);
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor, 3);
  if (input.cursor !== undefined && !after) throw new InputProblem('cursor', 'format', '보고서 커서가 올바르지 않습니다.');
  const values: unknown[] = [projectId];
  const where = ['project_id=$1'];
  if (input.kind) { values.push(input.kind); where.push(`kind=$${String(values.length)}`); }
  if (after) { values.push(...after); where.push(`("to",generated_at,id)<($${String(values.length - 2)}::date,$${String(values.length - 1)}::timestamptz,$${String(values.length)}::uuid)`); }
  values.push(limit + 1);
  const rows = (await client.query<ReportSummary>(`select ${SUMMARY} from reports where ${where.join(' and ')} order by "to" desc,generated_at desc,id desc limit $${String(values.length)}`, values)).rows;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { items: page.map(summaryOf), nextCursor: rows.length > limit && last ? encodeCursor([last.to, last.generatedAt, last.id]) : null };
}

/**
 * 한 보고서: 저장한 스냅샷 + 「생성 이후 변경」(G L374).
 * changesSince는 스냅샷이 아니다. 지금 기준 값이라 열 때마다 계산한다(스냅샷은 바꾸지 않는다).
 */
export async function getReport(client: PoolClient, reportId: string) {
  const row = (await client.query<ReportSummary & { snapshot: ReportSnapshotData; projectId: string }>(
    `select ${SUMMARY},snapshot,project_id "projectId" from reports where id=$1`, [reportId])).rows[0];
  if (!row) throw new ApiError('NOT_FOUND', { reportId }, [], '보고서를 찾을 수 없습니다.');
  const replans = (await client.query<{ n: number }>("select count(*)::int n from replans where project_id=$1 and status='applied' and created_at>$2::timestamptz", [row.projectId, row.generatedAt])).rows[0]?.n ?? 0;
  // 일정을 지금 계산할 수 없으면(순환 등) 현재 완료 예상을 비운다. 보고서 조회는 막지 않는다.
  const currentEnd = await scheduleView(client, row.projectId).then((v) => v.project.end, () => null);
  return { ...summaryOf(row), snapshot: row.snapshot, changesSince: { replans, currentEnd, reportEnd: row.snapshot.summary.forecast } };
}
