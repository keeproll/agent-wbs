import { iso, systemState, type Db } from './db.ts';
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
async function decisions(db: Db, projectId: string) {
  const rows = (await db.query<{ id: string; td_key: string; title: string; authority: 'lead' | 'agent' | 'free'; status: string; content: Record<string, unknown>; updated_at: string }>(
    `select id,td_key,title,authority,status,content,${iso('updated_at')} as updated_at from tech_decisions where project_id=$1 order by td_key`, [projectId])).rows;
  return rows.map((row) => {
    const c = Object.fromEntries(DECISION_FIELDS.map((key) => [key, row.content[key]]));
    return { id: row.id, tdKey: row.td_key, area: String(c.area ?? ''), title: row.title, choice: String(c.choice ?? ''), authority: row.authority,
      level: (c.level ?? null) as string | null, condition: String(c.condition ?? ''), status: row.status, reason: String(c.reason ?? ''),
      alternatives: String(c.alternatives ?? ''), by: String(c.by ?? ''), at: new Date(String(c.at ?? row.updated_at)).toISOString(), updatedAt: row.updated_at,
      constraintId: (c.constraintId ?? null) as string | null, conditionResult: (c.conditionResult ?? null) as 'met' | 'not_met' | null };
  });
}

/** 저장 때 붙인 Task별 hash는 서버 내부 값이라 응답에서 뺀다(판단 기록 안의 subjectHash는 보인다). */
function publicDraft(draft: StoredDraft) {
  return { ...draft, tasks: draft.tasks.map((task) => {
    const copy: Partial<typeof task> = { ...task };
    delete copy.subjectHash;
    return copy;
  }) };
}

export async function projectState(db: Db) {
  const system = await systemState(db);
  const base = { epoch: system.epoch, cleanup: system.cleanup };
  const p = (await db.query<{ id: string; name: string; repo_url: string; repo_owner: string; repo_name: string; base_commit: string | null; target_date: string | null;
    lead_instruction: string; phase: 'boot' | 'active'; created_at: string; updated_at: string }>(
    `select id,name,repo_url,repo_owner,repo_name,base_commit,to_char(target_date,'YYYY-MM-DD') target_date,lead_instruction,phase,
       ${iso('created_at')} created_at,${iso('updated_at')} updated_at from projects`)).rows[0];
  if (!p) return { state: 'none' as const, ...base };

  const constraints = (await db.query<{ id: string; name: string; level: 'must' | 'cond' | 'ban'; condition: string | null }>(
    'select id::text,name,level,condition from tech_constraints where project_id=$1 order by created_at,id', [p.id])).rows.map((c) => ({ ...c, condition: c.condition ?? '' }));
  const inputs = (await db.query<{ v: number; at: string; commit: string; mdList: string[]; changes: { path: string; change: string }[]; instruction: string; result: string | null; taskCount: number }>(
    `select v.v,${iso('v.created_at')} at,v.commit_sha commit,v.md_list "mdList",v.changes,v.instruction,r.result->>'text' result,
       (select count(*)::int from tasks t where t.src_input_version=v.id and t.deleted_at is null) "taskCount"
     from input_versions v left join input_version_results r on r.input_version=v.id where v.project_id=$1 order by v.v`, [p.id])).rows;
  // 커밋 순서는 depth(main 첫 부모 이력의 깊이)다. 입력 파일이 없는 행은 확정 커밋의 깊이만 기록한 것이라 목록에 넣지 않는다.
  const changeCommits = (await db.query<{ sha: string; state: 'pending' | 'skipped' | 'analyzed'; files: { at: string; author: string; message: string; files: unknown[] } }>(
    "select sha,state,files from input_change_commits where project_id=$1 and jsonb_array_length(files->'files')>0 order by (files->>'depth')::int", [p.id])).rows
    .map((c) => ({ sha: c.sha, at: c.files.at, author: c.files.author, message: c.files.message, state: c.state, files: c.files.files }));
  const inputPlanning = (await db.query<PlanningJob & { version: string | null }>(
    `select j.id,j.project_id,j.kind,j.run_no,j.status,j.instruction,
       (select payload->>'version' from runner_jobs r where r.payload->>'planningJobId'=j.id::text order by r.created_at limit 1) version
     from planning_jobs j where j.project_id=$1 and j.kind='input_diff' order by j.created_at desc limit 1`, [p.id])).rows[0];
  const registered = {
    ...base, id: p.id, name: p.name,
    repo: { url: p.repo_url, owner: p.repo_owner, name: p.repo_name, branch: 'main' as const, baseCommit: p.base_commit },
    targetDate: p.target_date, instruction: p.lead_instruction, constraints, registeredAt: p.created_at, inputs, changeCommits,
    // 차이 분석의 결과 CP 연결은 M2-07(Planning·CP)이 채운다.
    inputJob: inputPlanning ? { ...(await view(db, inputPlanning, INPUT_STEPS)), version: Number(inputPlanning.version), proposalId: null } : null,
    updatedAt: p.updated_at,
  };

  const job = (await db.query<PlanningJob>(
    "select id,project_id,kind,run_no,status,instruction from planning_jobs where project_id=$1 and kind='bootstrap' order by created_at desc limit 1", [p.id])).rows[0];
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
