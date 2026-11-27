import { splitSettingsToDomain } from '@awbs/db';
import type { PoolClient } from '@awbs/db';
import { observePipeline, type PipelineObservation } from '../ci/pipeline.ts';
import { invalidateTaskGate } from '../execution/gate.ts';
import { recordDesignVersion } from '../design/version.ts';
import { snapshotHash, techSnapshot, wbsSnapshot } from '../planning/job-snapshot.ts';
import { lockGraph } from '../tasks/write.ts';
import type { Dependency } from '@awbs/shared';
import { createBaseline, type BaselineTask } from './baseline.ts';
import {
  assertCleanupDone, changeEvent, enqueueJob, isUuid, LEAD, leasedJob, lockProject, nextNumber, requireProject, sameTime, systemState, touchProject, type Db,
} from './db.ts';
import { draftErrors, draftHolds, draftSplitSummary, storeDraft, type DraftInput, type StoredDraft } from './draft.ts';
import { ProjectError } from './errors.ts';
import { nextMdList, type PathChange } from './inputs.ts';
import {
  bootstrapJob, createPlanningJob, currentRunnerJob, followUpJob, lockPlanningJob, log, resetSteps, setStep, steps, syncPlanningJob, type PlanningJob,
} from './jobs.ts';
import { analyzable, analyze, chainHead, receive, type CommitState, type Ledger } from './ledger.ts';
import { parseRepoUrl } from './repo.ts';
import { BOOT_STEPS, INPUT_STEPS, LEAD_STEPS, RERUN_STEPS, waitingForLead, type StepStatus } from './steps.ts';

const STEP_LABEL: Record<string, string> = {
  check: 'GitHub 접근 · 커밋 고정', unzip: '입력 자료 checkout', repo: '작업 준비', codex: 'Codex 독립 분석', claude: 'Claude 독립 분석',
  cross: '교차 검토 · 이견 조정', tech: '기술 결정 확정', draft: 'WBS 초안 작성', approve: '팀장 승인', diff: '이전 버전과 비교', impact: '영향 분석', cp: '변경 제안 작성',
};
const STATUS_LABEL: Record<StepStatus, string> = { wait: '대기', run: '시작', done: '완료', fail: '실패' };

async function splitSettings(db: Db) {
  const split = (await db.query<{ split: Record<string, unknown> }>('select split from app_settings where singleton')).rows[0]?.split;
  if (!split) throw new Error('분할 기준 설정이 필요합니다.');
  return splitSettingsToDomain(split);
}

/* ---------------- ① 저장소 확인 ---------------- */

export async function createRepoCheck(db: Db, url: string, epoch: number): Promise<{ id: string }> {
  const repo = parseRepoUrl(url);
  const project = (await db.query<{ id: string }>('select id from projects')).rows[0]?.id ?? null;
  const id = (await db.query<{ id: string }>("insert into repo_checks(project_id,url,status) values($1,$2,'queued') returning id", [project, repo.url])).rows[0]?.id;
  if (!id) throw new Error('저장소 확인 생성 실패');
  // 조회 전용 job. Runner가 GitHub 인증으로 접근·private·main 커밋·필수 구조를 확인한다(G§8.4).
  await enqueueJob(db, { projectId: project, kind: 'repo_check', payload: { url: repo.url, repoCheckId: id }, epoch, dedupKey: `repo_check:${id}` });
  return { id };
}

interface RepoStructure { uiux: boolean; uiuxFiles: number; docs: string[]; src: boolean; contracts: boolean; agentwbs: boolean }
interface RepoResult { access: boolean; private: boolean | null; commit: string | null; structure: RepoStructure | null; error?: string }

/** 등록을 막는 이유. 필수 구조가 없으면 무엇이 없는지 알린다(G§4.2). */
const isDesignDoc = (path: string) => path.startsWith('prototype/docs/') && path.toLowerCase().endsWith('.md');
/** 입력 자료는 prototype/ 전체다(G§4.2 「입력 변경 감지 · 보호 경로는 prototype/ 전체 기준」). */
const isInput = (path: string) => path.startsWith('prototype/');

function repoProblems(result: RepoResult): string[] {
  if (!result.access) return [result.error ?? '저장소에 접근할 수 없습니다. 설정의 GitHub 연결과 권한을 확인하세요.'];
  const problems: string[] = [];
  if (!result.commit) problems.push('main 브랜치의 최신 커밋을 확인하지 못했습니다');
  if (!result.structure?.uiux || result.structure.uiuxFiles === 0) problems.push('prototype/uiux/ 에 프로토타입 파일이 없습니다');
  // 문서는 경로 형식(RepoPath)만으로 부족하다. prototype/docs/ 아래 md가 하나 이상이어야 한다(G§4.2 디렉토리 규칙).
  if (!result.structure?.docs.some(isDesignDoc)) problems.push('prototype/docs/ 에 md 문서가 없습니다');
  // 작업 저장소는 private 저장소다(G§4.2). 공개 여부를 확인하지 못한 경우(null)도 통과시키지 않는다.
  if (result.private !== true) problems.push(result.private === false ? '공개 저장소입니다. private 저장소만 등록할 수 있습니다' : 'private 여부를 확인하지 못했습니다');
  if (result.error && problems.length) problems.push(result.error);
  return problems;
}

export async function reportRepoCheck(db: Db, id: string, body: RepoResult & { fence: number }, principal: string): Promise<void> {
  if (!isUuid(id) || !(await db.query('select 1 from repo_checks where id=$1 for update', [id])).rowCount) {
    throw new ProjectError('NOT_FOUND', { details: { resource: 'repo_check', id } });
  }
  await leasedJob(db, { repoCheckId: id }, ['repo_check'], body.fence, principal);
  const result: RepoResult = { access: body.access, private: body.private, commit: body.commit, structure: body.structure };
  const problems = repoProblems(body);
  await db.query('update repo_checks set status=$2,result=$3::jsonb,error=$4 where id=$1',
    [id, problems.length ? 'failed' : 'done', JSON.stringify(result), problems.length ? problems.join(' · ') : null]);
}

export async function getRepoCheck(db: Db, id: string) {
  const row = isUuid(id) ? (await db.query<{ id: string; url: string; status: string; result: RepoResult | null; error: string | null }>(
    'select id,url,status,result,error from repo_checks where id=$1', [id])).rows[0] : undefined;
  if (!row) throw new ProjectError('NOT_FOUND', { details: { resource: 'repo_check', id } });
  return { id: row.id, url: row.url, status: row.status, private: row.result?.private ?? null, commit: row.result?.commit ?? null,
    structure: row.result?.structure ?? null, error: row.error };
}

/* ---------------- ① 프로젝트 등록 ---------------- */

export interface Registration {
  name: string; url: string; targetDate?: string; instruction: string; repoCheckId: string;
  constraints: ({ name: string; level: 'must' | 'ban' } | { name: string; level: 'cond'; condition: string })[];
}

export async function createProject(db: Db, body: Registration, epoch: number) {
  // 등록끼리만 한 줄로 세운다. 프로젝트 행이 아직 없어 행 잠금을 쓸 수 없다.
  await db.query("select pg_advisory_xact_lock(hashtextextended('awbs:project-registration',0))");
  if (await lockProject(db)) throw new ProjectError('PROJECT_EXISTS');
  await assertCleanupDone(db);
  const check = isUuid(body.repoCheckId) ? (await db.query<{ url: string; status: string; result: RepoResult | null }>(
    'select url,status,result from repo_checks where id=$1 for update', [body.repoCheckId])).rows[0] : undefined;
  if (!check) throw new ProjectError('NOT_FOUND', { details: { resource: 'repo_check', id: body.repoCheckId } });
  const repo = parseRepoUrl(body.url);
  const commit = check.result?.commit;
  const structure = check.result?.structure;
  if (check.status !== 'done' || !commit || !structure) {
    throw new ProjectError('INVALID_TRANSITION', { message: '성공한 저장소 접근 확인이 없어 등록할 수 없습니다.', fix: '「저장소 접근 확인」을 다시 실행해 통과한 뒤 등록하세요.' });
  }
  if (check.url !== repo.url) {
    throw new ProjectError('INVALID_TRANSITION', { message: '저장소 확인을 한 주소와 등록하려는 주소가 다릅니다.', fix: '등록할 주소로 저장소 접근 확인을 다시 실행하세요.' });
  }
  const project = (await db.query<{ id: string; name: string }>(
    `insert into projects(name,repo_url,repo_owner,repo_name,base_commit,target_date,lead_instruction,phase)
     values($1,$2,$3,$4,$5,$6,$7,'boot') returning id,name`,
    [body.name, repo.url, repo.owner, repo.name, commit, body.targetDate ?? null, body.instruction])).rows[0];
  if (!project) throw new Error('프로젝트 생성 실패');
  await db.query('update repo_checks set project_id=$2 where id=$1', [body.repoCheckId, project.id]);
  for (const constraint of body.constraints) {
    // 한 트랜잭션의 now()는 모두 같으므로 입력 순서를 보존하려고 실제 시각(clock_timestamp)을 넣는다.
    await db.query('insert into tech_constraints(project_id,name,level,condition,created_at) values($1,$2,$3,$4,clock_timestamp())',
      [project.id, constraint.name, constraint.level, constraint.level === 'cond' ? constraint.condition : null]);
  }
  // 등록 시 main 최신 커밋을 입력 v1로 고정하고 초기화 기준 커밋으로 기록한다(G§4.2).
  await db.query("insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,1,$2,$3::jsonb,$4::jsonb,'[]'::jsonb,$5)",
    [project.id, commit, JSON.stringify({ uiuxFiles: structure.uiuxFiles }), JSON.stringify(structure.docs.filter(isDesignDoc).sort()), body.instruction]);
  const jobId = await createPlanningJob(db, { projectId: project.id, kind: 'bootstrap', instruction: body.instruction, stepKeys: BOOT_STEPS });
  await log(db, { id: jobId, project_id: project.id }, '프로젝트 등록 — Runner의 초기 분석을 기다립니다');
  const techConstraints = (await db.query('select id,name,level,condition from tech_constraints where project_id=$1 order by created_at,id', [project.id])).rows;
  const subagentDefs = (await db.query(`select distinct on (def_key) id,def_key as "defKey",version,agent,role from subagent_defs where allowed order by def_key,version desc`)).rows;
  await enqueueJob(db, { projectId: project.id, kind: 'bootstrap', epoch, dedupKey: `bootstrap:${jobId}:1`,
    payload: { planningJobId: jobId, runNo: 1, version: 1, commit, previousCommit: null, instruction: body.instruction, resumeStep: null,
      techConstraints, subagentDefs, ...await techSnapshot(db, project.id) } });
  await changeEvent(db, project.id, { kind: 'project', event: 'registered' });
  return { project, jobId };
}

/* ---------------- 초기 분석·차이 분석 진행 보고 ---------------- */

async function reportedJob(db: Db, jobId: string, fence: number, principal: string, kinds: readonly string[], allowDone = false) {
  const runnerJob = await leasedJob(db, { id: jobId }, kinds, fence, principal);
  const planningJobId = runnerJob.payload.planningJobId;
  if (typeof planningJobId !== 'string') throw new ProjectError('NOT_FOUND', { details: { resource: 'planning_job', id: jobId } });
  const job = await lockPlanningJob(db, planningJobId);
  // 같은 Planning 작업의 현재 실행(가장 최근에 만든 Runner job)만 보고할 수 있다. 재분석·다시 시도·기술 결정 확정으로
  // 새 job이 생기면 이전 job은 임대가 살아 있어도 늦은 보고를 거부한다(리뷰 1).
  if (await currentRunnerJob(db, job.id) !== runnerJob.id) {
    throw new ProjectError('LEASE_LOST', { message: '이 분석 작업은 새 실행으로 넘어가 이전 실행의 보고를 받지 않습니다.', details: { jobId } });
  }
  if (!['queued', 'running'].includes(job.status) && !(allowDone && job.kind === 'input_diff' && job.status === 'done')) throw new ProjectError('INVALID_TRANSITION', { message: `이 분석 작업은 이미 ${job.status === 'failed' ? '실패로 멈췄' : '끝났'}습니다.` });
  return job;
}

export async function reportProgress(db: Db, jobId: string, body: { fence: number; stepKey: string; status: StepStatus; note?: string }, principal: string): Promise<void> {
  const completing = body.stepKey === 'cp' && body.status === 'done';
  const job = await reportedJob(db, jobId, body.fence, principal, ['bootstrap', 'input_diff'], completing);
  const allowed: readonly string[] = job.kind === 'bootstrap' ? BOOT_STEPS.filter((key) => !LEAD_STEPS.has(key)) : INPUT_STEPS;
  // 초안 단계의 완료는 초안 등록(submitDraft)만 기록한다. 진행 보고로 끝내면 승인할 초안 없이 멈춘다.
  if (!allowed.includes(body.stepKey) || job.kind === 'bootstrap' && body.stepKey === 'draft' && body.status === 'done') {
    throw new ProjectError('VALIDATION_FAILED', { errors: [{ path: 'stepKey', rule: 'step', message: `${job.kind === 'bootstrap' ? '초기 분석' : '차이 분석'}에서 Runner가 보고할 수 있는 단계가 아닙니다.` }] });
  }
  if (job.kind === 'input_diff' && completing) {
    const state = await steps(db, job.id);
    if (INPUT_STEPS.filter((key) => key !== 'cp').some((key) => state.get(key) !== 'done')) {
      throw new ProjectError('INVALID_TRANSITION', { message: '차이 분석의 앞 단계를 모두 끝낸 뒤 변경 제안 작성을 완료하세요.' });
    }
    if (job.status === 'done') return;
  }
  await setStep(db, job.id, body.stepKey, body.status, body.note);
  await log(db, job, `${STEP_LABEL[body.stepKey] ?? body.stepKey} ${STATUS_LABEL[body.status]}${body.note ? ` — ${body.note}` : ''}`);
  if (body.status === 'fail') {
    await syncPlanningJob(db, jobId, 'failed', { code: 'STEP_FAILED', message: body.note ?? `${STEP_LABEL[body.stepKey] ?? body.stepKey} 단계가 실패했습니다.` });
  } else if (job.kind === 'input_diff' && completing) await syncPlanningJob(db, jobId, 'done');
  else if (job.status === 'queued') await db.query("update planning_jobs set status='running' where id=$1", [job.id]);
  await changeEvent(db, job.project_id, { kind: 'planning_job', id: job.id }, 'planning');
}

/* ---------------- 기술 결정(G§4.2·§4.12) ---------------- */

interface TechProposal { area: string; title: string; choice: string; reason: string; alternatives: string }

async function addDecision(db: Db, projectId: string, input: { title: string; authority: 'lead' | 'agent'; status: 'fixed' | 'pending'; content: Record<string, unknown> }) {
  const n = await nextNumber(db, projectId, 'td', "select coalesce(max((substring(td_key from 4))::bigint),0) from tech_decisions");
  const id = (await db.query<{ id: string }>(
    'insert into tech_decisions(project_id,td_key,title,authority,status,content) values($1,$2,$3,$4,$5,$6::jsonb) returning id',
    [projectId, `TD-${String(n).padStart(2, '0')}`, input.title, input.authority, input.status, JSON.stringify(input.content)])).rows[0]?.id;
  await db.query("insert into tech_decision_events(project_id,decision,actor,kind,detail) values($1,$2,$3,'propose',$4::jsonb)",
    [projectId, id, input.authority === 'lead' && input.status === 'fixed' ? LEAD : 'Planning Agent', JSON.stringify({ status: input.status })]);
}

/**
 * 기술 결정 제안을 받는다. 팀장이 등록한 제약 중 필수·금지는 그대로 확정되고, 조건부 선호는 조건 충족 판단을
 * 팀장이 승인하도록 대기로 둔다. Agent 제안(근거·대안)은 모두 대기다(G§4.12 결정 권한 3단계, P techProposal L3904).
 */
interface ConditionJudgement { constraintId: string; result: 'met' | 'not_met'; reason: string }

export async function submitTechProposals(db: Db, jobId: string, body: { fence: number; decisions: TechProposal[]; conditionJudgements?: ConditionJudgement[] }, principal: string): Promise<void> {
  const job = await reportedJob(db, jobId, body.fence, principal, ['bootstrap']);
  const state = await steps(db, job.id);
  if (state.get('cross') !== 'done' || state.get('tech') !== 'wait') {
    throw new ProjectError('INVALID_TRANSITION', { message: '교차 검토가 끝나고 기술 결정이 아직 제안되지 않았을 때만 받을 수 있습니다.' });
  }
  const at = new Date().toISOString();
  const constraints = (await db.query<{ id: string; name: string; level: 'must' | 'ban' | 'cond'; condition: string | null }>(
    'select id::text,name,level,condition from tech_constraints where project_id=$1 order by created_at,id', [job.project_id])).rows;
  // 조건부 선호마다 Planning의 조건 충족 판단과 근거가 정확히 하나 있어야 팀장이 보고 승인할 수 있다(G§4.12, 리뷰 4).
  const judgements = body.conditionJudgements ?? [];
  const condIds = new Set(constraints.filter((c) => c.level === 'cond').map((c) => c.id));
  const errors = judgements.flatMap((j, i) => {
    const path = `conditionJudgements.${String(i)}`;
    if (!condIds.has(j.constraintId)) return [{ path: `${path}.constraintId`, rule: 'reference', message: '등록한 조건부 선호가 아닙니다.' }];
    if (judgements.findIndex((other) => other.constraintId === j.constraintId) !== i) return [{ path: `${path}.constraintId`, rule: 'unique', message: '같은 제약의 판단은 하나만 적습니다.' }];
    return j.reason.trim() ? [] : [{ path: `${path}.reason`, rule: 'required', message: '판단 근거를 적으세요.' }];
  });
  for (const id of condIds) {
    if (!judgements.some((j) => j.constraintId === id)) errors.push({ path: 'conditionJudgements', rule: 'required', message: `조건부 선호(${id})의 조건 충족 판단이 없습니다.` });
  }
  if (errors.length) throw new ProjectError('VALIDATION_FAILED', { errors });
  for (const c of constraints) {
    const cond = c.level === 'cond';
    const judgement = judgements.find((j) => j.constraintId === c.id);
    await addDecision(db, job.project_id, {
      title: c.level === 'ban' ? '사용 금지' : cond ? '조건부 선호' : '필수 사용', authority: 'lead', status: cond ? 'pending' : 'fixed',
      content: { area: c.level === 'ban' ? '운영' : '데이터', choice: c.level === 'ban' ? `${c.name} — 사용 금지` : c.name, level: c.level, condition: c.condition ?? '',
        reason: judgement?.reason ?? '프로젝트 등록 시 기술 제약', alternatives: '', by: cond ? 'Planning Agent' : LEAD, at,
        constraintId: c.id, conditionResult: judgement?.result ?? null },
    });
  }
  for (const p of body.decisions) {
    await addDecision(db, job.project_id, { title: p.title, authority: 'agent', status: 'pending',
      content: { area: p.area, choice: p.choice, level: null, condition: '', reason: p.reason, alternatives: p.alternatives, by: 'Planning Agent', at } });
  }
  await setStep(db, job.id, 'tech', 'run', `제안 ${String(constraints.length + body.decisions.length)}건`);
  await log(db, job, `기술 결정 제안 ${String(body.decisions.length)}건 — 팀장 확인 대기`);
  await changeEvent(db, job.project_id, { kind: 'decision' }, 'design');
}

interface DecisionRow { id: string; td_key: string; status: string; updated_at: string }

export async function confirmTech(db: Db, projectId: string, body: { decisions: { id: string; choice: 'approve' | 'reject'; updatedAt: string }[] }, epoch: number) {
  const project = await lockProject(db);
  if (!project || project.id !== projectId) throw new ProjectError('PROJECT_NOT_FOUND', { details: { projectId } });
  const job = await bootstrapJob(db, project.id);
  if (project.phase !== 'boot' || !job || (await steps(db, job.id)).get('tech') !== 'run') {
    throw new ProjectError('INVALID_TRANSITION', { message: '기술 결정 확정 단계가 아닙니다.' });
  }
  const rows = (await db.query<DecisionRow>(
    `select id,td_key,status,to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') updated_at from tech_decisions where project_id=$1 order by td_key for update`, [project.id])).rows;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const errors = body.decisions.flatMap((item, index) => {
    const path = `decisions.${String(index)}.id`;
    if (seen.has(item.id)) return [{ path, rule: 'unique', message: '같은 결정을 두 번 보냈습니다.' }];
    seen.add(item.id);
    return byId.has(item.id) ? [] : [{ path, rule: 'reference', message: '없는 기술 결정입니다.' }];
  });
  if (errors.length) throw new ProjectError('VALIDATION_FAILED', { errors });
  for (const item of body.decisions) {
    const row = byId.get(item.id);
    if (row?.status !== 'pending') throw new ProjectError('INVALID_TRANSITION', { message: `${row?.td_key ?? item.id}은(는) 이미 정해진 결정입니다.`, details: { tdKey: row?.td_key } });
  }
  for (const item of body.decisions) {
    const row = byId.get(item.id);
    if (row && !(await sameTime(db, row.updated_at, item.updatedAt))) {
      throw new ProjectError('VERSION_CONFLICT', { details: { current: { id: row.id, tdKey: row.td_key, status: row.status, updatedAt: row.updated_at }, changes: [] } });
    }
  }
  const pending = rows.filter((row) => row.status === 'pending' && !seen.has(row.id)).map((row) => row.td_key);
  if (pending.length) throw new ProjectError('DECISIONS_PENDING', { details: { pending } });
  const at = new Date().toISOString();
  for (const item of body.decisions) {
    await db.query(`update tech_decisions set status=$2,content=content||jsonb_build_object('by',$3::text,'at',$4::text) where id=$1`,
      [item.id, item.choice === 'approve' ? 'approved' : 'rejected', LEAD, at]);
    await db.query('insert into tech_decision_events(project_id,decision,actor,kind,detail) values($1,$2,$3,$4,$5::jsonb)',
      [project.id, item.id, LEAD, item.choice, JSON.stringify({ step: 'boot' })]);
  }
  await setStep(db, job.id, 'tech', 'done', `확정 ${String(rows.length)}건`);
  await recordDesignVersion(db, project.id, { key: 'tech:confirm', kind: 'decision', compat: 'compatible', by: LEAD, note: '초기 기술 결정 확정' });
  await log(db, job, `기술 결정 확정 (팀장) — 승인 ${String(body.decisions.filter((d) => d.choice === 'approve').length)} · 반려 ${String(body.decisions.filter((d) => d.choice === 'reject').length)}`);
  // 확정된 결정 위에서 WBS 초안을 작성한다(G§4.2). Runner에게 초안 단계부터 이어 하라는 새 job을 준다.
  await followUpJob(db, job, epoch, { resumeStep: 'draft', base: await techSnapshot(db, project.id) });
  await changeEvent(db, project.id, { kind: 'decision' }, 'design');
}

/* ---------------- 초기 WBS 초안·승인 ---------------- */

export async function submitDraft(db: Db, jobId: string, body: DraftInput & { fence: number }, principal: string): Promise<{ revision: number }> {
  const job = await reportedJob(db, jobId, body.fence, principal, ['bootstrap']);
  const state = await steps(db, job.id);
  if (state.get('tech') !== 'done' || state.get('draft') === 'done') {
    throw new ProjectError('INVALID_TRANSITION', { message: '기술 결정이 확정되고 초안이 아직 없을 때만 초안을 받습니다.' });
  }
  const tech = await techSnapshot(db, job.project_id);
  const payload = (await db.query<{ payload: Record<string, unknown> }>('select payload from runner_jobs where id=$1', [jobId])).rows[0]?.payload;
  if (payload?.techDecisionVersion !== tech.techDecisionVersion || snapshotHash(payload.techDecisions) !== tech.techDecisionVersion) {
    throw new ProjectError('VERSION_CONFLICT', { message: '초안의 판단 전제인 기술 결정이 바뀌었습니다. 새 작업으로 다시 분석하세요.', details: { changes: [] } });
  }
  const draft: DraftInput = { phases: body.phases, wps: body.wps, tasks: body.tasks, deps: body.deps };
  const errors = draftErrors(draft);
  const subagentIds = [...new Set(draft.tasks.flatMap((task) => [...task.subagents.dev, ...task.subagents.qa]))];
  const known = new Set(subagentIds.length ? (await db.query<{ id: string }>('select id::text from subagent_defs where id::text=any($1::text[])', [subagentIds])).rows.map((row) => row.id) : []);
  draft.tasks.forEach((task, i) => {
    for (const role of ['dev', 'qa'] as const) {
      task.subagents[role].forEach((id, j) => {
        if (!known.has(id)) errors.push({ path: `tasks.${String(i)}.subagents.${role}.${String(j)}`, rule: 'reference', message: '없는 하위 Agent 정의입니다.' });
      });
    }
  });
  if (errors.length) throw new ProjectError('VALIDATION_FAILED', { errors });
  const stored = storeDraft(draft);
  const settings = await splitSettings(db);
  const revision = (await db.query<{ next: number }>('select coalesce(max(revision),0)+1 as next from wbs_drafts where job=$1', [job.id])).rows[0]?.next ?? 1;
  await db.query("update wbs_drafts set status='superseded' where job=$1 and status='pending'", [job.id]);
  await db.query("insert into wbs_drafts(project_id,job,revision,content,split_check,status) values($1,$2,$3,$4::jsonb,$5::jsonb,'pending')",
    [job.project_id, job.id, revision, JSON.stringify({ ...stored, techDecisionVersion: tech.techDecisionVersion }), JSON.stringify(draftSplitSummary(stored, settings))]);
  await setStep(db, job.id, 'draft', 'done', `Phase ${String(draft.phases.length)} · Work Package ${String(draft.wps.length)} · Task ${String(draft.tasks.length)} · 의존성 ${String(draft.deps.length)}`);
  await setStep(db, job.id, 'approve', 'run');
  await log(db, job, `WBS 초안 r${String(revision)} 등록 — 팀장 승인 대기`);
  await changeEvent(db, job.project_id, { kind: 'draft', revision }, 'planning');
  return { revision };
}

interface DraftRow { id: string; revision: number; content: StoredDraft & { techDecisionVersion: string } }
/** 승인 대기 중인 최신 초안. 초기 분석이 승인 단계가 아니면 없다. */
async function waitingDraft(db: Db, job: PlanningJob): Promise<DraftRow | undefined> {
  if ((await steps(db, job.id)).get('approve') !== 'run') return undefined;
  return (await db.query<DraftRow>("select id,revision,content from wbs_drafts where job=$1 and status='pending' order by revision desc limit 1 for update", [job.id])).rows[0];
}
async function bootstrapForLead(db: Db) {
  const project = await requireProject(db);
  const job = await bootstrapJob(db, project.id);
  if (project.phase !== 'boot' || !job) throw new ProjectError('INVALID_TRANSITION', { message: '초기 분석 중인 프로젝트가 아닙니다.' });
  return { project, job };
}

/**
 * 초기 WBS 승인(G§4.2). 켜진 규칙 5·7·9의 판단이 모두 유효한 충족이어야 하고(D-33),
 * WBS·Task·관계·기준 일정 v1을 한 트랜잭션으로 만든다. 승인한 Task는 실행 대기다(Q-05 1행).
 */
export async function approveBootstrap(db: Db, revision: number) {
  const { project, job } = await bootstrapForLead(db);
  const draft = await waitingDraft(db, job);
  if (!draft) throw new ProjectError('INVALID_TRANSITION', { message: '승인할 초안이 없습니다. 초기 분석이 끝나기를 기다리세요.' });
  if (draft.revision !== revision) throw new ProjectError('VERSION_CONFLICT', { details: { current: { revision: draft.revision }, changes: [] } });
  if (draft.content.techDecisionVersion !== (await techSnapshot(db, project.id)).techDecisionVersion) {
    throw new ProjectError('VERSION_CONFLICT', { message: '초안의 기술 결정이 바뀌었습니다. 다시 분석한 초안을 승인하세요.', details: { changes: [] } });
  }
  const settings = await splitSettings(db);
  const holds = draftHolds(draft.content, settings);
  if (holds.length) throw new ProjectError('SPLIT_JUDGEMENT_REQUIRED', { details: { items: holds } });

  const content = draft.content;
  const v1 = (await db.query<{ id: string }>('select id from input_versions where project_id=$1 and v=1', [project.id])).rows[0]?.id;
  const nodeOf = new Map<string, string>();
  const pathOf = new Map<string, string>();
  for (const [pi, phase] of content.phases.entries()) {
    const n = await nextNumber(db, project.id, 'phase', "select coalesce(max((substring(node_key from 4))::bigint),0) from wbs_nodes where kind='phase'");
    const id = (await db.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,$2,'phase',null,$3,$4) returning id",
      [project.id, `PH-${String(n)}`, phase.title, pi])).rows[0]?.id ?? '';
    nodeOf.set(`phase:${phase.ref}`, id);
    pathOf.set(`phase:${phase.ref}`, String(pi + 1));
  }
  for (const [wi, wp] of content.wps.entries()) {
    const n = await nextNumber(db, project.id, 'wp', "select coalesce(max((substring(node_key from 4))::bigint),0) from wbs_nodes where kind='work_package'");
    const id = (await db.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,$2,'work_package',$3,$4,$5) returning id",
      [project.id, `WP-${String(n).padStart(2, '0')}`, nodeOf.get(`phase:${wp.phaseRef}`), wp.title, wi])).rows[0]?.id ?? '';
    nodeOf.set(`wp:${wp.ref}`, id);
    pathOf.set(`wp:${wp.ref}`, `${pathOf.get(`phase:${wp.phaseRef}`) ?? ''}.${String(content.wps.filter((x, i) => x.phaseRef === wp.phaseRef && i <= wi).length)}`);
  }
  const keyOf = new Map<string, { id: string; key: string }>();
  const schedule: BaselineTask[] = [];
  for (const [ti, t] of content.tasks.entries()) {
    const n = await nextNumber(db, project.id, 'task', 'select coalesce(max((substring(task_key from 6))::bigint),0) from tasks where project_id=$1');
    const key = `TASK-${String(n).padStart(4, '0')}`;
    const id = (await db.query<{ id: string }>(
      `insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,
         status,verif_state,planning_approved_at,conflict_group,src_input_version)
       values($1,$2,$3,$4,$5,$6,$7,$8::domain[],$9,$10,$11,'ready','none',clock_timestamp(),$12,$13) returning id`,
      [project.id, key, nodeOf.get(`wp:${t.wpRef}`), ti, t.title, t.workType, t.primaryDomain, t.relatedDomains, t.priority, t.assigneeAgent, t.verifierAgent, t.conflictGroup, v1])).rows[0]?.id ?? '';
    keyOf.set(t.ref, { id, key });
    await db.query('insert into task_specs(project_id,task,overview,spec,ac,revision) values($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,1)', [project.id, id,
      JSON.stringify(t.overview ?? { purpose: '', background: '', scope: [], out: [], precond: '', doneCond: '' }), JSON.stringify(t.spec ?? {}), JSON.stringify(t.ac ?? [])]);
    for (const o of t.outputs) {
      await db.query('insert into task_outputs(project_id,task,name,kind,required,verify,delivered) values($1,$2,$3,$4,$5,$6,false)', [project.id, id, o.name, o.kind, o.required, o.verify]);
    }
    for (const [ci, item] of t.checklist.entries()) {
      await db.query('insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,sort_order) values($1,$2,$3,$4,$5,false,$6,$7)',
        [project.id, id, `CL-${key.slice(5)}-${String(ci + 1)}`, item.content, item.required, item.verifyMethod ?? '', ci]);
    }
    const e = t.estimate;
    await db.query('insert into task_estimates(project_id,task,est,lo,hi,tokens_k,confidence,basis,agreed_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [project.id, id, e.estHours, e.loHours, e.hiHours, e.tokensK ?? null, e.confidence, e.basis, e.agreedBy.join(' · ')]);
    for (const role of ['dev', 'qa'] as const) {
      const g = t.grades[role];
      await db.query('insert into task_grades(project_id,task,role,model_id,effort,reason,locked,effective_from) values($1,$2,$3,$4,$5,$6,false,clock_timestamp())',
        [project.id, id, role, g.modelId, g.effort, g.reason]);
      for (const sub of t.subagents[role]) {
        await db.query('insert into task_subagents(project_id,task,role,subagent_id,basis) values($1,$2,$3,$4,$5)', [project.id, id, role, sub, t.subagents.basis]);
      }
    }
    await db.query("insert into task_splits(project_id,task,basis,judged_rules,exceptions) values($1,$2,$3,$4::jsonb,'[]'::jsonb)",
      [project.id, id, t.splitBasis, JSON.stringify(t.judgedRules ?? { schemaVersion: 1, items: [] })]);
    for (const item of t.designItems) {
      await db.query('insert into task_design_items(project_id,task,item_key,change) values($1,$2,$3,$4)', [project.id, id, item.itemKey, item.change]);
    }
    await db.query(`insert into task_history(project_id,at,actor,task,kind,text,before,after,ref) values($1,clock_timestamp(),$2,$3,'생성',$4,null,$5::jsonb,$6::jsonb)`,
      [project.id, LEAD, id, `초기 분석 r${String(draft.revision)}에서 식별 (입력 자료 v1) — 초기 WBS 팀장 승인으로 생성`, JSON.stringify('ready'), JSON.stringify({ revision: draft.revision, ref: t.ref })]);
    schedule.push({ uuid: id, id: key, wbs: `${pathOf.get(`wp:${t.wpRef}`) ?? ''}.${String(content.tasks.filter((x, i) => x.wpRef === t.wpRef && i <= ti).length)}`,
      status: 'ready', priority: t.priority, assignee: t.assigneeAgent, est: e.estHours, lo: e.loHours, hi: e.hiHours, ...(t.conflictGroup && { cg: t.conflictGroup }) });
  }
  const deps: Dependency[] = [];
  for (const d of content.deps) {
    const pred = keyOf.get(d.predRef);
    const succ = keyOf.get(d.succRef);
    if (!pred || !succ) throw new Error('초안 참조가 저장 뒤 깨졌습니다.');
    await db.query('insert into task_dependencies(project_id,pred,succ,dep_type) values($1,$2,$3,$4)', [project.id, pred.id, succ.id, d.depType]);
    deps.push({ pred: pred.key, succ: succ.key, type: d.depType });
  }
  const baselineVersion = await createBaseline(db, project.id, schedule, deps, LEAD);
  const at = new Date().toISOString();
  if (v1) {
    await db.query('insert into input_version_results(project_id,input_version,result) values($1,$2,$3::jsonb)',
      [project.id, v1, JSON.stringify({ text: `초기 분석 r${String(draft.revision)} → 초기 WBS ${String(content.tasks.length)}건 팀장 승인 (${at})`, revision: draft.revision })]);
  }
  await db.query("update wbs_drafts set status='approved' where id=$1", [draft.id]);
  await setStep(db, job.id, 'approve', 'done', `Task ${String(content.tasks.length)}건 승인`);
  await db.query("update planning_jobs set status='done' where id=$1", [job.id]);
  await log(db, job, `초기 WBS 승인 (팀장) — Task ${String(content.tasks.length)}건 · 기준 일정 v${String(baselineVersion)}`);
  await db.query("update projects set phase='active' where id=$1", [project.id]);
  await touchProject(db, project.id);
  await changeEvent(db, project.id, { kind: 'wbs', event: 'approved' }, 'task');
  return { baselineVersion: 1 as const, taskCount: content.tasks.length };
}

/** 재분석 요청: Codex 독립 분석부터 새 회차로 다시 하고, 확정된 기술 결정은 유지한다(G§4.2, P reBoot). */
export async function rerunBootstrap(db: Db, body: { revision: number; instruction: string }, epoch: number) {
  const { job } = await bootstrapForLead(db);
  const draft = await waitingDraft(db, job);
  if (!draft) throw new ProjectError('INVALID_TRANSITION', { message: '초안 승인 대기 중에만 재분석을 요청할 수 있습니다.' });
  if (draft.revision !== body.revision) throw new ProjectError('VERSION_CONFLICT', { details: { current: { revision: draft.revision }, changes: [] } });
  await db.query("update wbs_drafts set status='superseded' where job=$1 and status='pending'", [job.id]);
  const next = (await db.query<{ run_no: number }>("update planning_jobs set run_no=run_no+1,status='queued',fail=null,instruction=$2 where id=$1 returning run_no", [job.id, body.instruction])).rows[0]?.run_no ?? job.run_no + 1;
  await resetSteps(db, job.id, RERUN_STEPS);
  await log(db, job, `팀장 재분석 요청 (${String(next - 1)}회) — ${body.instruction}`);
  await followUpJob(db, { ...job, run_no: next, instruction: body.instruction }, epoch, { resumeStep: 'codex', base: await techSnapshot(db, job.project_id) });
  await changeEvent(db, job.project_id, { kind: 'planning_job', id: job.id }, 'planning');
  return { jobId: job.id };
}

/**
 * 초기 분석 다시 시도: 실패한 단계부터 이어 한다. 초안이 있으면 그 revision, 없으면 분석 회차(runNo)를 비교한다(contracts §1.3).
 * 정리 대기 중에는 시작하지 않는다.
 */
export async function retryBootstrap(db: Db, body: { revision: number } | { revision: null; runNo: number }, epoch: number) {
  const { job } = await bootstrapForLead(db);
  if (job.status !== 'failed') throw new ProjectError('INVALID_TRANSITION', { message: '실패한 초기 분석만 다시 시도할 수 있습니다.' });
  const latest = (await db.query<{ revision: number }>("select revision from wbs_drafts where job=$1 and status='pending' order by revision desc limit 1", [job.id])).rows[0]?.revision ?? null;
  const same = latest === null ? body.revision === null && body.runNo === job.run_no : body.revision === latest;
  if (!same) throw new ProjectError('VERSION_CONFLICT', { details: { current: latest === null ? { revision: null, runNo: job.run_no } : { revision: latest }, changes: [] } });
  await assertCleanupDone(db);
  return { jobId: await resume(db, job, epoch) };
}

async function resume(db: Db, job: PlanningJob, epoch: number): Promise<string> {
  if (waitingForLead(job.kind, await steps(db, job.id))) {
    throw new ProjectError('INVALID_TRANSITION', { message: '팀장의 기술 결정 또는 초안 승인을 기다리고 있습니다.' });
  }
  const previous = (await db.query<{ payload: Record<string, unknown> }>('select payload from runner_jobs where id=$1', [await currentRunnerJob(db, job.id)])).rows[0]?.payload;
  let base: Record<string, unknown> | undefined;
  if (job.kind === 'input_diff') {
    await lockGraph(db as PoolClient, job.project_id);
    const wbs = await wbsSnapshot(db, job.project_id);
    if (snapshotHash(previous?.wbs) !== snapshotHash(wbs)) {
      base = { wbs };
      await resetSteps(db, job.id, ['diff', 'impact', 'cp']);
    }
  } else if ((await steps(db, job.id)).get('tech') === 'done') {
    const tech = await techSnapshot(db, job.project_id);
    if (previous?.techDecisionVersion !== tech.techDecisionVersion) {
      base = tech;
      await resetSteps(db, job.id, RERUN_STEPS);
      await db.query("update wbs_drafts set status='superseded' where job=$1 and status='pending'", [job.id]);
    }
  }
  const progress = await steps(db, job.id);
  const keys: readonly string[] = job.kind === 'bootstrap' ? BOOT_STEPS : INPUT_STEPS;
  const resumeStep = keys.find((key) => progress.get(key) !== 'done');
  if (!resumeStep || !progress.has(resumeStep) || resumeStep === 'approve') {
    throw new ProjectError('INVALID_TRANSITION', { message: '저장된 단계에서 재개할 수 있는 Runner 작업이 없습니다.' });
  }
  if (progress.get(resumeStep) === 'fail') await resetSteps(db, job.id, [resumeStep]);
  // 전제가 바뀌면 새 회차로 시작해야 Runner가 이전 분석 결과를 재사용하지 않는다.
  if (base) {
    const next = (await db.query<{ run_no: number }>('update planning_jobs set run_no=run_no+1 where id=$1 returning run_no', [job.id])).rows[0]?.run_no;
    job = { ...job, run_no: next ?? job.run_no + 1 };
  }
  await db.query("update planning_jobs set status='queued',fail=null where id=$1", [job.id]);
  await log(db, job, `팀장 다시 시도 — ${STEP_LABEL[resumeStep] ?? resumeStep}부터`);
  await followUpJob(db, job, epoch, { resumeStep, ...(base && { base }) });
  await changeEvent(db, job.project_id, { kind: 'planning_job', id: job.id }, 'planning');
  return job.id;
}

/* ---------------- ② 입력 자료 변경 ---------------- */

interface PushedCommit { sha: string; at: string; author: string; message: string }
interface InputDiff {
  status: 'A' | 'M' | 'D' | 'R' | 'T'; path: string; from?: string;
  oldBlob: string | null; newBlob: string | null; oldMode: string | null; newMode: string | null; added: number; deleted: number;
}
interface InputBody { base: string; head: string; baseIsAncestor: boolean; treeHash: string; changes: InputDiff[]; commits: PushedCommit[]; pipelineObservation?: PipelineObservation }
/** 저장하는 보고 하나(input_change_commits.files jsonb, sha = 보고의 head) */
interface StoredReport { seq: number; base: string; head: string; tree: string; changes: InputDiff[]; commits: PushedCommit[]; receivedAt: string }

/**
 * Runner의 입력 변경 보고(비교 후 갱신, 한 트랜잭션). 정답은 base와 head의 prototype/ 트리 차이다(ledger.ts).
 * - base가 지금 입력 head와 다르면 409 VERSION_CONFLICT와 현재 head. 늦게·중복으로 다시 온 옛 보고도 여기서 걸러진다.
 * - base가 main의 조상이 아니면(금지된 이력 재작성) 받지 않고 팀장 경고를 남긴다.
 * - 그 밖에는 head를 언제나 옮기고(빈 차이 포함), 차이가 있을 때만 팀장 확인 항목이 생긴다.
 */
export async function reportInputChanges(db: Db, body: InputBody): Promise<{ head: string; recorded: boolean; historyRewritten: boolean }> {
  // 차이는 `-- prototype/`으로 계산한 결과다. 그 밖의 경로가 있으면 계산이 잘못된 보고다.
  const outside = body.changes.flatMap((c, i) => [c.path, ...(c.from ? [c.from] : [])].filter((p) => !isInput(p)).map(() => ({ path: `changes.${String(i)}.path`, rule: 'prototype', message: 'prototype/ 밖 경로는 입력 차이가 아닙니다.' })));
  if (outside.length) throw new ProjectError('VALIDATION_FAILED', { errors: outside });
  const project = await requireProject(db);
  const before = await loadLedger(db, project.id);
  const result = receive(before, { base: body.base, head: body.head, baseIsAncestor: body.baseIsAncestor, treeHash: body.treeHash, changes: body.changes });
  if (result.kind === 'stale') {
    throw new ProjectError('VERSION_CONFLICT', { message: 'base가 서버의 입력 head와 다릅니다. 응답의 head로 다시 계산해 보고하세요.', details: { current: { base: result.head }, changes: [] } });
  }
  if (result.kind === 'invalid') throw new ProjectError('VALIDATION_FAILED', { errors: [result.error] });
  if (result.kind === 'rewritten') {
    // 이력 재작성은 금지된 상황이다(G§4.2 강제 push 금지). 자동 복구하지 않고 입력 변경을 받지 않은 채 팀장에게 알린다.
    // 열린 경고가 있으면 새 관측(head·문구)으로 갱신하고 복구 확인 번호(recheck)는 유지한다. 없으면 새로 연다.
    const target = { base: body.base, head: body.head, message: `main 이력이 바뀌었습니다: 마지막 입력 커밋 ${body.base}가 새 main ${body.head}의 조상이 아닙니다. 입력 변경을 받지 않습니다.` };
    const updated = await db.query("update alerts set target=target||$2::jsonb,updated_at=clock_timestamp() where project_id=$1 and key='input_history_rewritten' and resolved_at is null", [project.id, JSON.stringify(target)]);
    if (!updated.rowCount) await db.query("insert into alerts(project_id,key,severity,target) values($1,'input_history_rewritten','error',$2::jsonb)", [project.id, JSON.stringify({ ...target, recheck: 0 })]);
    await changeEvent(db, project.id, { kind: 'alert', key: 'input_history_rewritten' }, 'alert');
    return { head: result.head, recorded: false, historyRewritten: true };
  }
  // 유효한 관측 시각만 적는다. 0023이 편집 버전을 유지하며, 단순 관측은 변경 이벤트를 만들지 않는다.
  await db.query('update projects set input_checked_at=clock_timestamp() where id=$1', [project.id]);
  // 유효한 보고를 받아들였다: 열린 이력 재작성 경고는 이 트랜잭션에서 해소한다(조정자 결정 2026-11-26, 복구 확인 뒤 Runner 재관측).
  const resolved = await db.query("update alerts set resolved_at=clock_timestamp(),updated_at=clock_timestamp() where project_id=$1 and key='input_history_rewritten' and resolved_at is null", [project.id]);
  if (resolved.rowCount) await changeEvent(db, project.id, { kind: 'alert', key: 'input_history_rewritten' }, 'alert');
  if (result.report) {
    const r = result.report;
    const stored: StoredReport = { seq: r.seq, base: r.base, head: r.head, tree: r.tree, changes: body.changes, commits: body.commits, receivedAt: new Date().toISOString() };
    await db.query('insert into input_change_commits(project_id,sha,files,state) values($1,$2,$3::jsonb,$4)', [project.id, r.head, JSON.stringify(stored), r.state]);
    if (r.state === 'pending') await changeEvent(db, project.id, { kind: 'input_changes' });
  }
  // 팀장 확인 항목은 분석이 볼 내용이 바뀐 보고에만 생긴다(실행 권한만 바뀐 보고는 head·트리만 옮김).
  if (body.pipelineObservation) await observePipeline(db,project.id,body.head,body.pipelineObservation);
  return { head: result.head, recorded: result.report?.state === 'pending', historyRewritten: false };
}

/**
 * 입력 이력 재작성 「복구 확인·입력 확인 다시 시도」(contracts recheckInputs).
 * owner가 정상 merge·복원 커밋으로 연결을 되돌린 뒤 팀장이 누른다. 열린 경고의 recheck를 1 올리면 Runner 정책 inputRecheck가 바뀌어
 * Runner가 다시 관측한다. 경고 해소는 서버가 유효한 보고를 받아들일 때(reportInputChanges) 한다. 재작성 이력을 자동으로 받지 않는다.
 */
export async function recheckInputs(db: Db, body: { updatedAt: string }): Promise<{ inputRecheck: number }> {
  const project = await requireProject(db);
  if (!(await sameTime(db, project.updated_at, body.updatedAt))) throw new ProjectError('VERSION_CONFLICT', { details: { current: { updatedAt: project.updated_at }, changes: [] } });
  const alert = (await db.query<{ recheck: number }>(
    `update alerts set target=jsonb_set(target,'{recheck}',to_jsonb(coalesce((target->>'recheck')::int,0)+1)) || jsonb_build_object('recheckAt',clock_timestamp()),updated_at=clock_timestamp()
     where project_id=$1 and key='input_history_rewritten' and resolved_at is null returning (target->>'recheck')::int as recheck`, [project.id])).rows[0];
  if (!alert) throw new ProjectError('INVALID_TRANSITION', { message: '열린 입력 이력 재작성 경고가 없습니다.' });
  await touchProject(db, project.id);
  await changeEvent(db, project.id, { kind: 'alert', key: 'input_history_rewritten' }, 'alert');
  return { inputRecheck: alert.recheck };
}

/** DB의 입력 버전·입력 보고를 원장으로 읽는다. lock이면 보고 행을 잠근다. */
async function loadLedger(db: Db, projectId: string, lock = true): Promise<Ledger> {
  const rows = (await db.query<{ files: StoredReport; state: CommitState; v: number | null }>(
    `select c.files,c.state,v.v from input_change_commits c left join input_versions v on v.id=c.analyzed_in_version
     where c.project_id=$1 ${lock ? 'for update of c' : ''}`, [projectId])).rows;
  const versions = (await db.query<{ v: number; sha: string; tree: string | null }>(
    "select v,commit_sha sha,files->>'treeHash' tree from input_versions where project_id=$1 order by v", [projectId])).rows;
  return {
    versions,
    reports: rows.map((r) => ({ seq: r.files.seq, base: r.files.base, head: r.files.head, tree: r.files.tree, changes: r.files.changes, state: r.state, version: r.v })),
  };
}
/** 원장에서 상태·포함 버전이 바뀐 보고만 DB에 쓴다. */
async function persistLedger(db: Db, projectId: string, before: Ledger, after: Ledger): Promise<void> {
  const versionIds = new Map((await db.query<{ v: number; id: string }>('select v,id from input_versions where project_id=$1', [projectId])).rows.map((r) => [r.v, r.id]));
  for (const r of after.reports) {
    const old = before.reports.find((b) => b.head === r.head);
    if (old && (old.state !== r.state || old.version !== r.version)) {
      await db.query('update input_change_commits set state=$3,analyzed_in_version=$4 where project_id=$1 and sha=$2',
        [projectId, r.head, r.state, r.version === null ? null : versionIds.get(r.version) ?? null]);
    }
  }
}

/** 입력 head(조회용) */
export async function inputHead(db: Db, projectId: string): Promise<string> {
  return chainHead(await loadLedger(db, projectId, false));
}

async function pendingShas(db: Db, projectId: string): Promise<string[]> {
  return (await db.query<{ sha: string }>("select sha from input_change_commits where project_id=$1 and state='pending' order by sha for update", [projectId])).rows.map((r) => r.sha);
}
/** 「확인한 커밋 목록 + projects.updatedAt」 비교(contracts §1.3). 새 커밋이 들어왔으면 화면이 다시 보게 한다. */
async function assertSeen(db: Db, project: { id: string; updated_at: string }, updatedAt: string, commits: readonly string[]) {
  const pending = await pendingShas(db, project.id);
  const seen = [...commits].sort();
  if (!(await sameTime(db, project.updated_at, updatedAt)) || pending.length !== seen.length || pending.some((sha, i) => sha !== seen[i])) {
    throw new ProjectError('VERSION_CONFLICT', { details: { current: { updatedAt: project.updated_at, commits: pending }, changes: [] } });
  }
}

/** 「분석 안 함」: 확인함으로 남기고, 다음 분석 때 이 변경도 함께 비교한다(G§4.2 ②). */
export async function skipInputs(db: Db, body: { updatedAt: string; commits: string[] }): Promise<void> {
  const project = await requireProject(db);
  await assertSeen(db, project, body.updatedAt, body.commits);
  await db.query("update input_change_commits set state='skipped' where project_id=$1 and sha=any($2::text[])", [project.id, body.commits]);
  await touchProject(db, project.id);
}

/**
 * 「이 버전으로 분석」: 커밋을 새 입력 버전으로 고정하고 이전 버전과의 차이 분석 job을 만든다(G§4.2 ②).
 * 아직 분석하지 않은 커밋(대기·분석 안 함)의 변경을 모두 합쳐 비교한다.
 */
export async function analyzeInputs(db: Db, body: { updatedAt: string; commit: string; commits: string[]; instr?: string }, epoch: number) {
  const project = await requireProject(db);
  if ((await db.query('select 1 from input_versions where project_id=$1 and commit_sha=$2', [project.id, body.commit])).rowCount) throw new ProjectError('INPUT_UNCHANGED');
  await assertCleanupDone(db);
  await assertSeen(db, project, body.updatedAt, body.commits);
  // 원장 규칙: 입력 사슬의 끝(head)만 고정한다. head는 이전 버전의 자손이라 버전이 앞으로만 간다(입력 원장).
  const ledger = await loadLedger(db, project.id);
  const plan = analyze(ledger, body.commit);
  if ('error' in plan) {
    if (plan.error === 'unchanged') throw new ProjectError('INPUT_UNCHANGED');
    throw new ProjectError('VALIDATION_FAILED', { errors: [{ path: 'commit', rule: plan.error === 'latest' ? 'latest' : 'reference', message: '입력 사슬의 끝(inputHead) 커밋으로 분석해야 합니다.' }], details: { latest: analyzable(ledger) ?? null } });
  }
  if (project.phase !== 'active') throw new ProjectError('INVALID_TRANSITION', { message: '초기 WBS를 승인한 뒤에 입력 변경을 분석합니다.' });
  if ((await db.query("select 1 from planning_jobs where project_id=$1 and kind='input_diff' and status in ('queued','running')", [project.id])).rowCount) {
    throw new ProjectError('INVALID_TRANSITION', { message: '진행 중인 차이 분석이 끝난 뒤 다시 분석하세요.' });
  }
  await lockGraph(db as PoolClient, project.id);
  const previous = (await db.query<{ v: number; commit_sha: string; md_list: string[] }>(
    'select v,commit_sha,md_list from input_versions where project_id=$1 order by v desc limit 1', [project.id])).rows[0];
  if (!previous) throw new Error('입력 v1이 없습니다.');
  // 순 변경 = 마지막 입력 버전 → head의 prototype/ 트리 차이(원장이 보고 차이를 blob 단위로 이어 붙인 값).
  const changes: PathChange[] = [...plan.net].map(([path, change]) => ({ path, change }));
  const lines = new Map<string, { added: number; deleted: number }>();
  for (const report of plan.reports) {
    const stored = (await db.query<{ files: StoredReport }>('select files from input_change_commits where project_id=$1 and sha=$2', [project.id, report.head])).rows[0]?.files;
    for (const c of stored?.changes ?? []) {
      const sum = lines.get(c.path) ?? { added: 0, deleted: 0 };
      lines.set(c.path, { added: sum.added + c.added, deleted: sum.deleted + c.deleted });
    }
  }
  const stats = changes.map((c) => ({ ...c, ...(lines.get(c.path) ?? { added: 0, deleted: 0 }) }));
  const version = previous.v + 1;
  // 새 버전 행을 먼저 만든다. persistLedger가 버전 번호로 이 행을 찾아 보고들을 묶는다.
  await db.query(
    'insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7)',
    [project.id, version, body.commit, JSON.stringify({ treeHash: plan.version.tree, paths: stats }), JSON.stringify(nextMdList(previous.md_list, changes)), JSON.stringify(changes), body.instr ?? '']);
  if (plan.version.v !== version) throw new Error('입력 버전 번호가 원장과 다릅니다.');
  await persistLedger(db, project.id, ledger, plan.ledger);
  // M2-06 P3-1: 새 입력 버전은 Gate 근거(입력 버전)를 바꾼다. 같은 트랜잭션에서 Gate의 Task마다 무효화 판정을 부른다.
  // 판정은 invalidateTaskGate가 한다(근거가 그대로인 Task — 고정된 원본 입력 버전을 쓰는 Task — 는 Gate에 남는다).
  for (const gate of (await db.query<{ task_key: string }>("select task_key from tasks where project_id=$1 and status='gate' and deleted_at is null order by id", [project.id])).rows) {
    await invalidateTaskGate(db as PoolClient, gate.task_key);
  }
  const jobId = await createPlanningJob(db, { projectId: project.id, kind: 'input_diff', instruction: body.instr ?? '', stepKeys: INPUT_STEPS });
  await log(db, { id: jobId, project_id: project.id }, `입력 v${String(version)} 고정 — 차이 분석 대기`);
  await enqueueJob(db, { projectId: project.id, kind: 'input_diff', epoch, dedupKey: `input_diff:${jobId}:1`,
    payload: { planningJobId: jobId, runNo: 1, version, commit: body.commit, previousCommit: previous.commit_sha, instruction: body.instr ?? '', resumeStep: null,
      wbs: await wbsSnapshot(db, project.id) } });
  await touchProject(db, project.id);
  return { jobId };
}

/** 차이 분석 다시 시도(끝난 단계는 건너뜀). version은 실패한 입력 버전이다(contracts §1.3). */
export async function retryInputs(db: Db, body: { updatedAt: string; version: number }, epoch: number) {
  const project = await requireProject(db);
  if (!(await sameTime(db, project.updated_at, body.updatedAt))) throw new ProjectError('VERSION_CONFLICT', { details: { current: { updatedAt: project.updated_at }, changes: [] } });
  const job = (await db.query<PlanningJob & { version: string | null }>(
    `select j.id,j.project_id,j.kind,j.run_no,j.status,j.instruction,
       (select payload->>'version' from runner_jobs r where r.payload->>'planningJobId'=j.id::text order by r.record_no limit 1) version
     from planning_jobs j where j.project_id=$1 and j.kind='input_diff' order by j.record_no desc limit 1 for update`, [project.id])).rows[0];
  if (!job || job.status !== 'failed' || Number(job.version) !== body.version) {
    throw new ProjectError('INVALID_TRANSITION', { message: `입력 v${String(body.version)}의 실패한 차이 분석이 없습니다.` });
  }
  await assertCleanupDone(db);
  const jobId = await resume(db, job, epoch);
  await touchProject(db, project.id);
  return { jobId };
}

export { systemState };
