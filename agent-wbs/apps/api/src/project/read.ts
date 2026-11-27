import { iso, systemState, type Db } from './db.ts';
import { substantive } from './ledger.ts';
import { inputHead } from './service.ts';
import type { StoredDraft } from './draft.ts';
import { jobView, type PlanningJob } from './jobs.ts';
import { BOOT_STEPS, INPUT_STEPS } from './steps.ts';

/*
 * GET /api/project — 등록 전(none) / 초기 분석(boot) / 진행 중(active). 모양은 shared `ProjectState`가 정본이다.
 * 저장하지 않는 값(초기 분석 하위 상태, 입력 버전별 Task 수)은 여기서 계산한다.
 */

async function view(db: Db, job: PlanningJob, order: readonly string[]) {
  const { stepRows, ...rest } = await jobView(db, job);
  const steps = order.map((key) => {
    const row = stepRows.find((item) => item.key === key);
    return { key, status: row?.status ?? 'wait', at: row?.at ?? null, note: row?.note ?? '' };
  });
  return { ...rest, steps };
}

const DECISION_FIELDS = ['area', 'choice', 'level', 'condition', 'reason', 'alternatives', 'by', 'at', 'constraintId', 'conditionResult'] as const;
export async function decisions(db: Db, projectId: string) {
  const rows = (await db.query<{ id: string; td_key: string; title: string; authority: 'lead' | 'agent' | 'free'; status: string; content: Record<string, unknown>; updated_at: string }>(
    `select id,td_key,title,authority,status,content,${iso('updated_at')} as updated_at from tech_decisions where project_id=$1 order by td_key`, [projectId])).rows;
  return rows.map((row) => {
    const c = Object.fromEntries(DECISION_FIELDS.map((key) => [key, row.content[key]]));
    return { id: row.id, tdKey: row.td_key, area: String(c.area ?? ''), title: row.title, choice: String(c.choice ?? ''), authority: row.authority,
      level: (c.level ?? null) as string | null, condition: String(c.condition ?? ''), status: row.status, reason: String(c.reason ?? ''),
      alternatives: String(c.alternatives ?? ''), by: String(c.by ?? ''), at: new Date(String(c.at ?? row.updated_at)).toISOString(), updatedAt: row.updated_at,
      constraintId: (c.constraintId ?? null) as string | null, conditionResult: (c.conditionResult ?? null) as 'met' | 'not_met' | null,
      ...(row.content.change ? { change: row.content.change } : {}),
      ...(typeof row.content.itemKey === 'string' && typeof row.content.driftId === 'string' ? { itemKey: row.content.itemKey, driftId: row.content.driftId } : {}) };
  });
}

/** 저장 때 붙인 Task별 hash는 서버 내부 값이라 응답에서 뺀다(판단 기록 안의 subjectHash는 보인다). */
function publicDraft(draft: StoredDraft) {
  return { phases: draft.phases, wps: draft.wps, deps: draft.deps, tasks: draft.tasks.map((task) => {
    const copy: Partial<typeof task> = { ...task };
    delete copy.subjectHash;
    return copy;
  }) };
}

export async function projectState(db: Db) {
  const system = await systemState(db);
  const base = { epoch: system.epoch, cleanup: system.cleanup };
  const p = (await db.query<{ id: string; name: string; repo_url: string; repo_owner: string; repo_name: string; base_commit: string | null; target_date: string | null;
    description: string; start_date: string; input_checked_at: string | null;
    lead_instruction: string; phase: 'boot' | 'active'; created_at: string; updated_at: string }>(
    `select id,name,repo_url,repo_owner,repo_name,base_commit,to_char(target_date,'YYYY-MM-DD') target_date,lead_instruction,phase,
       description,to_char(start_date,'YYYY-MM-DD') start_date,${iso('input_checked_at')} input_checked_at,
       ${iso('created_at')} created_at,${iso('updated_at')} updated_at from projects`)).rows[0];
  if (!p) return { state: 'none' as const, ...base };

  const constraints = (await db.query<{ id: string; name: string; level: 'must' | 'cond' | 'ban'; condition: string | null }>(
    'select id::text,name,level,condition from tech_constraints where project_id=$1 order by created_at,id', [p.id])).rows.map((c) => ({ ...c, condition: c.condition ?? '' }));
  const inputs = (await db.query<{ v: number; at: string; commit: string; mdList: string[]; changes: { path: string; change: string }[]; instruction: string; result: string | null; taskCount: number }>(
    `select v.v,${iso('v.created_at')} at,v.commit_sha commit,v.md_list "mdList",v.changes,v.instruction,r.result->>'text' result,
       (select count(*)::int from tasks t where t.src_input_version=v.id and t.deleted_at is null) "taskCount"
     from input_versions v left join input_version_results r on r.input_version=v.id where v.project_id=$1 order by v.v`, [p.id])).rows;
  // 입력 변경 항목 = 차이가 있는 Runner 보고(키는 그 보고의 head). 받은 순서(seq)대로 보인다.
  // 커밋 정보는 참고용 목록의 마지막 커밋에서, 이름 변경은 화면 값(added·modified·deleted)에 맞춰 삭제 + 추가로 보인다.
  interface Raw { status: 'A' | 'M' | 'D' | 'R' | 'T'; path: string; from?: string; oldBlob: string | null; newBlob: string | null; oldMode: string | null; newMode: string | null; added: number; deleted: number }
  const kind = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' } as const;
  const changeCommits = (await db.query<{ sha: string; state: 'pending' | 'skipped' | 'analyzed';
    files: { receivedAt: string; changes: Raw[]; commits: { at: string; author: string; message: string }[] } }>(
    "select sha,state,files from input_change_commits where project_id=$1 and jsonb_array_length(files->'changes')>0 order by (files->>'seq')::int", [p.id])).rows
    // 실행 권한만 바뀐 보고는 팀장 확인 항목이 아니다.
    .filter((c) => c.files.changes.some((f) => substantive(f)))
    .map((c) => {
      const last = c.files.commits.at(-1);
      return { sha: c.sha, at: last?.at ?? c.files.receivedAt, author: last?.author ?? '', message: last?.message ?? '', state: c.state,
        files: c.files.changes.flatMap((f) => f.status === 'R' && f.from
          ? [{ path: f.from, change: 'deleted' as const, added: 0, deleted: f.deleted }, { path: f.path, change: 'added' as const, added: f.added, deleted: 0 }]
          : [{ path: f.path, change: kind[f.status as 'A' | 'M' | 'D' | 'T'], added: f.added, deleted: f.deleted }]) };
    });
  const inputPlanning = (await db.query<PlanningJob & { version: string | null; proposal_id: string | null }>(
    `select j.id,j.project_id,j.kind,j.run_no,j.status,j.instruction,
       (select payload->>'version' from runner_jobs r where r.payload->>'planningJobId'=j.id::text order by r.record_no limit 1) version,
       (select c.id from change_proposals c where c.project_id=j.project_id and c.source='input' and c.source_id=j.id::text and c.deleted_at is null order by c.record_no desc limit 1) proposal_id
     from planning_jobs j where j.project_id=$1 and j.kind='input_diff' order by j.record_no desc limit 1`, [p.id])).rows[0];
  const registered = {
    ...base, id: p.id, name: p.name, description: p.description, startDate: p.start_date, inputCheckedAt: p.input_checked_at,
    repo: { url: p.repo_url, owner: p.repo_owner, name: p.repo_name, branch: 'main' as const, baseCommit: p.base_commit },
    targetDate: p.target_date, instruction: p.lead_instruction, constraints, registeredAt: p.created_at, inputs, changeCommits,
    inputJob: inputPlanning ? { ...(await view(db, inputPlanning, INPUT_STEPS)), version: Number(inputPlanning.version), proposalId: inputPlanning.proposal_id } : null,
    inputHead: await inputHead(db, p.id),
    updatedAt: p.updated_at,
  };

  const job = (await db.query<PlanningJob>(
    "select id,project_id,kind,run_no,status,instruction from planning_jobs where project_id=$1 and kind='bootstrap' order by record_no desc limit 1", [p.id])).rows[0];
  if (p.phase === 'active') {
    const approved = (await db.query<{ at: string; n: number }>(
      `select ${iso('max(planning_approved_at)')} at,count(*)::int n from tasks t join input_versions v on v.id=t.src_input_version where v.project_id=$1 and v.v=1`, [p.id])).rows[0];
    return { state: 'active' as const, ...registered, approvedAt: approved?.at ?? p.updated_at, approvedTaskCount: approved?.n ?? 0 };
  }
  const draft = job ? (await db.query<{ revision: number; content: StoredDraft; split_check: { pass: number; suspect: number; violation: number } }>(
    "select revision,content,split_check from wbs_drafts where job=$1 and status='pending' order by revision desc limit 1", [job.id])).rows[0] : undefined;
  if (!job) throw new Error('초기 분석 작업이 없는 boot 프로젝트');
  return {
    state: 'boot' as const, ...registered,
    bootstrap: { ...(await view(db, job, BOOT_STEPS)), decisions: await decisions(db, p.id), revision: draft?.revision ?? null,
      draft: draft ? { ...publicDraft(draft.content), splitCheck: draft.split_check } : null },
  };
}
