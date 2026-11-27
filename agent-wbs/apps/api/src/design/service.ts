import { DRIFT_COMPAT, type PoolClient } from '@awbs/db';
import { displayKey } from '@awbs/shared';
import type { DesignShapeInput, DesignSnapshotInput } from '@awbs/shared/api';
import { ApiError, assertSameVersion, invalid, isUuid } from '../changes/http.ts';
import { deferChange } from '../changes/events.ts';
import { enqueueJob, iso, nextNumber } from '../project/db.ts';
import { assertExternal, checkedJob } from '../runner/service.ts';
import { required, RunnerRepository, type Job } from '../runner/repository.ts';
import { createDraft, leadAction } from '../messages/service.ts';
import { compareDesign } from './compare.ts';
import { checkCachedSnapshot, designHash, normalizedSnapshot } from './cache.ts';
import { activeDesignApply, linkDesignApply } from './jobs.ts';
import { recordDesignVersion as version } from './version.ts';
import { decisions, drifts, latestSnapshot, projectExists, snapshotItems, type SnapshotRow, type StoredItem } from './read.ts';

const JOBS = ['planning', 'estimate', 'split', 'bootstrap', 'input_diff', 'attempt', 'integrate', 'deploy_check', 'ci_retry', 'design_apply', 'merge_followup'];
const badState = (message: string) => new ApiError('INVALID_TRANSITION', {}, [], message);

export async function designJob(db: PoolClient, jobId: string, fence: number, principal: string) {
  const repo = new RunnerRepository(db);
  await repo.lock();
  if (!isUuid(jobId)) throw new ApiError('NOT_FOUND');
  const job = await checkedJob(repo, jobId, fence, principal);
  if (!job.project_id || !JOBS.includes(job.kind)) throw new ApiError('NOT_FOUND');
  await projectExists(db, job.project_id, true);
  return job;
}

function validate(body: DesignSnapshotInput) {
  const errors: { path: string; rule: string; message: string }[] = [];
  const mark = (path: string, rule: string, message: string) => errors.push({ path, rule, message });
  const unique = (values: string[], path: string) => values.forEach((value, i) => { if (values.indexOf(value) !== i) mark(`${path}.${String(i)}`, 'unique', '같은 항목은 한 번만 보내세요.'); });
  unique(body.files.map(file => file.path), 'files');
  unique(body.items.map(item => item.itemKey), 'items');
  unique(body.drifts.map(drift => drift.itemKey), 'drifts');
  body.items.forEach((item, i) => {
    const at = `items.${String(i)}`;
    if (!body.files.some(file => file.path === item.path && file.status !== 'error')) mark(`${at}.path`, 'reference', '읽기에 성공한 계약 파일을 지정하세요.');
    for (const field of ['contract', 'extracted'] as const) {
      const fields = item[field]?.fields;
      if (!fields) continue;
      unique(fields.map(value => value.path), `${at}.${field}.fields`);
    }
  });
  for (const [i, edge] of (body.edges ?? []).entries()) {
    if (![edge.from, edge.to].every(key => body.items.some(item => item.itemKey === key))) mark(`edges.${String(i)}`, 'reference', '연결의 양쪽 항목이 보고에 있어야 합니다.');
  }
  body.drifts.forEach((drift, i) => { if (!body.items.some(item => item.itemKey === drift.itemKey)) mark(`drifts.${String(i)}.itemKey`, 'reference', '불일치의 설계 항목이 없습니다.'); });
  if (errors.length) throw invalid(errors);
}

async function alert(db: PoolClient, projectId: string, key: string, open: boolean, message: string) {
  if (open) {
    const updated = await db.query('update alerts set target=$3::jsonb where project_id=$1 and key=$2 and resolved_at is null', [projectId, key, JSON.stringify({ message })]);
    if (!updated.rowCount) await db.query("insert into alerts(project_id,key,severity,target) values($1,$2,'error',$3::jsonb)", [projectId, key, JSON.stringify({ message })]);
  } else await db.query('update alerts set resolved_at=clock_timestamp() where project_id=$1 and key=$2 and resolved_at is null', [projectId, key]);
  deferChange(db, projectId, 'alert', { key });
}

export async function saveSnapshot(db: PoolClient, body: DesignSnapshotInput, principal: string) {
  validate(body);
  const job = await designJob(db, body.jobId, body.fence, principal);
  const projectId = required(job.project_id);
  const ref = body.ref;
  if (ref === 'main' ? !['design_apply', 'merge_followup'].includes(job.kind) : job.kind !== 'attempt' || job.payload.branch !== ref) {
    throw badState('이 job이 해석할 수 있는 브랜치의 보고가 아닙니다.');
  }
  for (const item of body.items) if (item.taskKey && !(await db.query('select 1 from tasks where project_id=$1 and task_key=$2 and deleted_at is null', [projectId, item.taskKey])).rowCount) throw invalid([{ path: 'items.taskKey', rule: 'reference', message: '이 프로젝트의 Task가 아닙니다.' }]);
  const hash = designHash(normalizedSnapshot(body));
  const head = await latestSnapshot(db, projectId, ref);
  const cached = (await db.query<SnapshotRow>('select * from design_snapshots where project_id=$1 and commit=$2 and ref=$3', [projectId, body.commit, ref])).rows[0];
  const latest = !cached || !head || cached.id === head.id;
  if (cached && (cached.content.hash === hash || await checkCachedSnapshot(db, cached, body))) {
    const terminal = latest && (await db.query(`select 1 from design_drifts d where d.project_id=$1 and d.status='open' and coalesce(d.resolution->>'ref','main')=$2 and d.resolution ? 'jobId'
      and not exists(select 1 from runner_jobs j where j.project_id=d.project_id and j.kind='design_apply' and j.payload->>'driftId'=d.id::text and j.state in ('queued','leased','started','reconcile')) limit 1`, [projectId, ref])).rowCount;
    if (!latest) { if (job.kind === 'design_apply') await completeStaleApply(db, job, body, ref, head); return; }
    if (!terminal && job.kind !== 'design_apply') return;
  }
  const previous = cached ?? head;
  const oldItems = await snapshotItems(db, previous);
  const parseError = body.files.some(file => file.status === 'error');
  const lastFiles = new Map<string, { raw?: string; sourceCommit: string; kind: string }>();
  const carried: StoredItem[] = [];
  for (const file of body.files.filter(file => file.status === 'error')) {
    const last = (await db.query<{ last_success: { raw?: string; sourceCommit: string; kind: string } }>(`select f.last_success from design_files f join design_snapshots s on s.id=f.snapshot
      where s.project_id=$1 and s.ref=$2 and f.path=$3 and f.last_success is not null order by coalesce((s.content->>'sequence')::bigint,0) desc,s.created_at desc,s.id desc limit 1`, [projectId, ref, file.path])).rows[0]?.last_success;
    if (!last) continue;
    lastFiles.set(file.path, last);
    const previousItems = (await db.query<{ content: StoredItem }>(`select i.content from design_items i join design_files f on f.id=i.file join design_snapshots s on s.id=i.snapshot
      where s.project_id=$1 and s.ref=$2 and s.commit=$3 and f.path=$4 and i.item_key=any(array(select jsonb_array_elements_text(s.content->'itemKeys')))`, [projectId, ref, last.sourceCommit, file.path])).rows;
    carried.push(...previousItems.map(item => item.content).filter(item => !body.items.some(next => next.itemKey === item.itemKey)));
  }
  const active: StoredItem[] = [...body.items.map(item => ({ ...item, sourceCommit: body.commit })), ...carried];
  const oldEdges = parseError && previous ? previous.content.edges ?? (await db.query<{ from: string; to: string; kind: string }>(`select a.item_key "from",b.item_key "to",e.kind from design_edges e
    join design_items a on a.id=e.from_item join design_items b on b.id=e.to_item where e.snapshot=$1`, [previous.id])).rows : [];
  const carriedKeys = new Set(carried.map(item => item.itemKey));
  const edges = [...(body.edges ?? []), ...oldEdges.filter(edge => carriedKeys.has(edge.from) || carriedKeys.has(edge.to))]
    .filter(edge => [edge.from, edge.to].every(key => active.some(item => item.itemKey === key)));
  // 서버 시각이 뒤로 가거나 요청이 잠금을 기다려도 수신 순서는 뒤집히지 않는다.
  const sequence = cached ? cached.content.sequence ?? 0 : await nextNumber(db, projectId, 'design_snapshot', "select coalesce(max((content->>'sequence')::bigint),0) from design_snapshots");
  // 읽기 실패 때 화면에 남기는 자료와 Runner가 실제 보낸 자료를 구별해야 재대조가 충돌하지 않는다.
  const reported = { edges: body.edges ?? [], components: body.components ?? [], links: body.links ?? [], ownership: body.ownership ?? [] };
  const metadata = { hash, sequence, itemKeys: active.map(item => item.itemKey), edges, reported, components: body.components ?? (parseError ? previous?.content.components : []) ?? [],
    links: body.links ?? (parseError ? previous?.content.links : []) ?? [], ownership: body.ownership ?? (parseError ? previous?.content.ownership : []) ?? [] };
  const snapshotId = required((await db.query<{ id: string }>(`insert into design_snapshots(project_id,commit,ref,parse_status,error,content,created_at) values($1,$2,$3,$4,$5,$6::jsonb,clock_timestamp())
    on conflict(project_id,commit,ref) do update set parse_status=excluded.parse_status,error=excluded.error,content=excluded.content returning id`,
  [projectId, body.commit, ref, parseError ? 'error' : 'ok', body.files.find(file => file.error)?.error ?? null, JSON.stringify(metadata)])).rows[0]).id;
  for (const file of body.files) {
    const last = lastFiles.get(file.path);
    const status = file.status === 'error' ? 'error' : ref === 'main' ? file.status : 'draft';
    const content = file.status === 'error' ? { ...last, kind: last?.kind ?? file.kind, sourceCommit: last?.sourceCommit ?? null, reported: { kind: file.kind, raw: file.raw } } : { raw: file.raw, kind: file.kind, sourceCommit: body.commit };
    const fileId = required((await db.query<{ id: string }>(`insert into design_files(project_id,snapshot,path,format,parse_status,error,content,last_success) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
      on conflict(snapshot,path) do update set format=excluded.format,parse_status=excluded.parse_status,error=excluded.error,content=excluded.content,last_success=excluded.last_success returning id`,
    [projectId, snapshotId, file.path, file.format, status, file.error ?? null, JSON.stringify(content), JSON.stringify(file.status === 'error' ? last ?? null : content)])).rows[0]).id;
    for (const item of active.filter(item => item.path === file.path)) await db.query(`insert into design_items(project_id,snapshot,file,item_key,kind,content) values($1,$2,$3,$4,$5,$6::jsonb)
      on conflict(snapshot,item_key) do update set file=excluded.file,kind=excluded.kind,content=excluded.content`, [projectId, snapshotId, fileId, item.itemKey, item.kind, JSON.stringify(item)]);
  }
  for (const edge of edges) await db.query(`insert into design_edges(project_id,snapshot,from_item,to_item,kind)
    select $1,$2,a.id,b.id,$5 from design_items a,design_items b where a.snapshot=$2 and b.snapshot=$2 and a.item_key=$3 and b.item_key=$4
    and not exists(select 1 from design_edges e where e.snapshot=$2 and e.from_item=a.id and e.to_item=b.id and e.kind=$5)`, [projectId, snapshotId, edge.from, edge.to, edge.kind]);
  for (const owner of body.ownership ?? []) await db.query(`insert into design_ownership(project_id,snapshot,item_key,owner) select $1,$2,$3,$4
    where not exists(select 1 from design_ownership where snapshot=$2 and item_key=$3 and owner=$4)`, [projectId, snapshotId, owner.data, owner.source]);
  if (!latest) {
    if (job.kind === 'design_apply') await completeStaleApply(db, job, body, ref, head);
    deferChange(db, projectId, 'design', { commit: body.commit, ref });
    return;
  }
  // 항목을 추출하지 못한 파일도 unchecked로 남겨 「불일치 0건」처럼 보이지 않게 한다.
  const uncheckedFiles = body.files.filter(file => !active.some(item => item.path === file.path)).map(file => ({ itemKey: `file:${file.path}`, kind: file.kind, path: file.path, content: {} }));
  const compared: (Omit<DesignSnapshotInput['items'][number], 'kind' | 'content'> & { kind: string })[] = [...body.items, ...uncheckedFiles];
  for (const item of compared) {
    const comparison = compareDesign(item.contract, item.extracted, item.kind);
    const submitted = body.drifts.find(drift => drift.itemKey === item.itemKey);
    const current = (await db.query<{ id: string; resolution: Record<string, unknown> }>(`select id,resolution from design_drifts where project_id=$1 and item_key=$2 and status='open'
      and coalesce(resolution->>'ref','main')=$3 order by created_at desc limit 1 for update`, [projectId, item.itemKey, ref])).rows[0];
    if (!comparison.changed) {
      if (current && !await activeDesignApply(db, projectId, current.id)) await db.query("update design_drifts set status='done',compat=$3,resolution=resolution||$2::jsonb where id=$1", [current.id, JSON.stringify({ commit: body.commit, resultCommit: body.commit, resolvedBy: 'comparison', extracted: item.extracted }), DRIFT_COMPAT[comparison.compat]]);
      continue;
    }
    const detail = { ...current?.resolution, ref, commit: body.commit, where: submitted?.where ?? item.path, text: submitted?.text ?? (comparison.compat === 'unchecked' ? '코드에서 명세를 추출하지 못해 대조하지 않았습니다.' : '계약과 추출 명세의 필드가 다릅니다.'), taskKey: submitted?.taskKey ?? item.taskKey ?? null, extracted: item.extracted ?? null };
    if (current) await db.query('update design_drifts set compat=$2,resolution=$3::jsonb where id=$1', [current.id, DRIFT_COMPAT[comparison.compat], JSON.stringify(detail)]);
    else {
      const n = await nextNumber(db, projectId, 'dr', "select coalesce(max((substring(resolution->>'displayKey' from 4))::bigint),0) from design_drifts");
      await db.query("insert into design_drifts(project_id,item_key,kind,compat,status,resolution) values($1,$2,$3,$4,'open',$5::jsonb)", [projectId, item.itemKey, item.kind, DRIFT_COMPAT[comparison.compat], JSON.stringify({ ...detail, displayKey: displayKey('DR', n) })]);
    }
  }
  await db.query(`update design_drifts d set status='done',resolution=resolution||$4::jsonb where project_id=$1 and status='open'
    and coalesce(resolution->>'ref','main')=$2 and not (item_key=any($3::text[]))
    and not exists(select 1 from runner_jobs j where j.project_id=d.project_id and j.kind='design_apply' and j.payload->>'driftId'=d.id::text and j.state in ('queued','leased','started','reconcile'))`,
  [projectId, ref, [...active.map(item => item.itemKey), ...uncheckedFiles.map(item => item.itemKey)], JSON.stringify({ resolvedBy: 'removed', resultCommit: body.commit })]);
  if (job.kind === 'design_apply') await completeApply(db, job, body, ref);
  if (ref === 'main') {
    if (!parseError && !(await db.query('select 1 from design_versions where snapshot=$1', [snapshotId])).rowCount) {
      const changes = body.items.map(item => compareDesign(oldItems.find(old => old.item_key === item.itemKey)?.content.contract ?? item.contract, item.contract, item.kind));
      const removed = oldItems.some(old => !body.items.some(item => item.itemKey === old.item_key));
      await version(db, projectId, { snapshot: snapshotId, key: '*', kind: 'snapshot', compat: removed || changes.some(change => change.compat === 'breaking') ? 'breaking' : changes.some(change => change.compat === 'unchecked') ? 'unchecked' : 'compatible', by: principal, note: `계약 ${body.commit}` });
    }
    await alert(db, projectId, 'design_parse', parseError, '계약 파일 읽기 실패 — 마지막 성공 결과를 표시합니다.');
    await alert(db, projectId, 'design_drift', (await drifts(db, projectId)).some(drift => drift.status === 'open'), '계약과 코드의 불일치 또는 대조하지 못한 항목이 있습니다.');
  }
  deferChange(db, projectId, 'design', { commit: body.commit, ref });
}

/**
 * 최신이 아닌 커밋을 보고한 반영 job(M6 통합, M6-05 리뷰2 P3-2).
 * 예: merge_followup이 결과와 같은 커밋 b·c를 먼저 보고한 뒤 design_apply가 b를 보고한다. 예전에는 204인데 불일치가 열린 채였다.
 * - 보고한 커밋이 목표 명세를 대조 성공했고(completeApply 규칙), 지금 최신 캐시의 같은 항목도 대조 성공·목표와 같으면 완료한다.
 * - 최신 캐시가 목표와 다르면 409 INVALID_TRANSITION으로 알린다. Runner는 최신 커밋 기준으로 다시 보고해야 한다.
 * 왜 최신도 보나: b 뒤에 누가 계약을 다시 바꿨으면(c ≠ 목표) 불일치는 아직 해소되지 않았다. 그때 닫으면 거짓 완료가 된다.
 */
async function completeStaleApply(db: PoolClient, job: Job, body: DesignSnapshotInput, ref: string, head: SnapshotRow | undefined) {
  const row = (await db.query<{ status: string; resolution: Record<string, unknown> }>('select status,resolution from design_drifts where id::text=$1 and project_id=$2', [job.payload.driftId, job.project_id])).rows[0];
  if (row?.status === 'done' && row.resolution.jobId === job.id && row.resolution.resultCommit) return;
  const target = row?.resolution.target as DesignShapeInput | undefined;
  // 최신 항목은 행 전체로 본다. 그 파일을 최신 커밋에서 읽는 데 성공했고 자료도 최신 커밋에서 온 것이어야 「최신도 목표와 같다」고 말할 수 있다.
  // 왜: 최신 파일 읽기가 실패하면 화면 표시용으로 과거 성공 자료(다른 sourceCommit)가 남는다. 그것으로 완료를 확정하면 확인하지 못한 최신 상태를 과거 성공으로 덮는다(Codex 리뷰 P2-2).
  const latestRow = (await snapshotItems(db, head)).find(item => item.item_key === job.payload.itemKey);
  const now = latestRow && latestRow.parse_status !== 'error' && latestRow.content.sourceCommit === head?.commit ? latestRow.content : undefined;
  if (!now || !now.contract || !now.extracted || compareDesign(now.contract, now.extracted, now.kind).changed
    || compareDesign(target, now.contract, now.kind).changed || compareDesign(now.contract, target, now.kind).changed) {
    throw badState('보고한 커밋이 최신이 아니고, 최신 커밋의 계약 파일을 읽지 못했거나 최신 설계가 요청한 명세와 다릅니다. 최신 커밋 기준으로 다시 보고하세요.');
  }
  await completeApply(db, job, body, ref);
  // 늦은 결과로 마지막 불일치를 닫았으면 대시보드 경고도 같은 트랜잭션에서 맞춘다(Codex 리뷰 P3-1). 아래 이벤트도 커밋 때 함께 나간다.
  const projectId = required(job.project_id);
  await alert(db, projectId, 'design_drift', (await drifts(db, projectId)).some(drift => drift.status === 'open'), '계약과 코드의 불일치 또는 대조하지 못한 항목이 있습니다.');
  deferChange(db, projectId, 'design', { commit: body.commit, ref });
}

async function completeApply(db: PoolClient, job: Job, body: DesignSnapshotInput, ref: string) {
  const row = (await db.query<{ id: string; resolution: Record<string, unknown> }>('select id,resolution from design_drifts where id::text=$1 and project_id=$2 for update', [job.payload.driftId, job.project_id])).rows[0];
  const item = body.items.find(item => item.itemKey === job.payload.itemKey);
  const target = row?.resolution.target as DesignShapeInput | undefined;
  if (!row || row.resolution.jobId !== job.id || ref !== 'main' || row.resolution.sourceCommit === body.commit || !item || compareDesign(item.contract, item.extracted, item.kind).changed
    || compareDesign(target, item.contract, item.kind).changed || compareDesign(item.contract, target, item.kind).changed) throw badState('계약 반영 job의 새 결과 커밋과 요청한 명세의 대조 성공이 필요합니다.');
  await db.query("update design_drifts set status='done',resolution=resolution||$2::jsonb where id=$1", [row.id, JSON.stringify({ resultCommit: body.commit })]);
}

interface DecisionTarget { itemKey?: string; driftId?: string }
async function checkDecisionTarget(db: PoolClient, projectId: string, body: DecisionTarget) {
  if (body.itemKey === undefined && body.driftId === undefined) return;
  if (!body.itemKey || !body.driftId || !(await db.query("select 1 from design_drifts where project_id=$1 and id::text=$2 and item_key=$3 and status='open'", [projectId, body.driftId, body.itemKey])).rowCount) {
    throw invalid([{ path: 'driftId', rule: 'reference', message: '같은 프로젝트의 열린 불일치와 항목을 함께 지정하세요.' }]);
  }
}

export async function createDecision(db: PoolClient, projectId: string, body: { jobId: string; fence: number; authority: 'agent' | 'free'; area: string; title: string; choice: string; reason: string; alternatives: string } & DecisionTarget, principal: string) {
  const job = await designJob(db, body.jobId, body.fence, principal);
  if (job.project_id !== projectId) throw new ApiError('PROJECT_NOT_FOUND');
  await checkDecisionTarget(db, projectId, body);
  const n = await nextNumber(db, projectId, 'td', 'select coalesce(max((substring(td_key from 4))::bigint),0) from tech_decisions');
  const { authority, title, area, choice, reason, alternatives } = body;
  const content = { area, choice, reason, alternatives, ...(body.itemKey ? { itemKey: body.itemKey, driftId: body.driftId } : {}) };
  const status = authority === 'free' ? 'noted' : 'pending';
  const id = required((await db.query<{ id: string }>('insert into tech_decisions(project_id,td_key,title,authority,status,content) values($1,$2,$3,$4,$5,$6::jsonb) returning id',
    [projectId, `TD-${String(n).padStart(2, '0')}`, title, authority, status, JSON.stringify({ ...content, by: principal, at: new Date().toISOString() })])).rows[0]).id;
  await db.query("insert into tech_decision_events(project_id,decision,actor,kind,detail) values($1,$2,$3,'propose',$4::jsonb)", [projectId, id, principal, JSON.stringify({ status })]);
  deferChange(db, projectId, 'design', { id });
  return (await decisions(db, projectId)).find(decision => decision.id === id);
}

export async function decide(db: PoolClient, id: string, action: 'approve' | 'reject' | 'change', body: { updatedAt: string; choice?: string; reason?: string; comment?: string } & DecisionTarget) {
  if (!isUuid(id)) throw new ApiError('NOT_FOUND');
  const projectId = (await db.query<{ project_id: string }>('select project_id from tech_decisions where id=$1', [id])).rows[0]?.project_id;
  if (!projectId) throw new ApiError('NOT_FOUND');
  await projectExists(db, projectId, true);
  const row = required((await db.query<{ status: string; authority: string; content: Record<string, unknown>; updated_at: string; td_key: string }>(`select *,${iso('updated_at')} updated_at from tech_decisions where id=$1 for update`, [id])).rows[0]);
  await assertSameVersion(db, row.updated_at, body.updatedAt);
  const content = { ...row.content };
  let status: string;
  let breaking = false;
  if (action === 'change') {
    if (!['approved', 'fixed'].includes(row.status) || row.authority === 'free' || row.authority === 'lead' && content.level !== 'cond') throw badState('확정된 Agent 제안 또는 조건부 선호만 변경 제안할 수 있습니다.');
    await checkDecisionTarget(db, projectId, body);
    content.change = { choice: body.choice, reason: body.reason, previousStatus: row.status, ...(body.itemKey ? { itemKey: body.itemKey, driftId: body.driftId } : {}) };
    status = 'change';
  } else {
    if (!['pending', 'change'].includes(row.status)) throw badState('승인 또는 변경 대기 중인 결정이 아닙니다.');
    if (row.status === 'change') {
      const change = content.change as { choice: string; reason: string; previousStatus: string } & DecisionTarget;
      status = action === 'approve' ? 'approved' : change.previousStatus;
      if (action === 'approve') {
        await checkDecisionTarget(db, projectId, change);
        content.choice = change.choice; content.reason = change.reason; breaking = true;
        if (change.itemKey) { content.itemKey = change.itemKey; content.driftId = change.driftId; }
      }
      delete content.change;
    } else status = action === 'approve' ? 'approved' : 'rejected';
    content.by = '팀장';
    content.at = new Date().toISOString();
    await version(db, projectId, { key: `decision:${row.td_key}`, kind: 'decision', compat: breaking ? 'breaking' : 'compatible', by: '팀장', note: `${row.td_key} ${action}` });
  }
  await db.query('update tech_decisions set status=$2,content=$3::jsonb where id=$1', [id, status, JSON.stringify(content)]);
  await db.query('insert into tech_decision_events(project_id,decision,actor,kind,detail) values($1,$2,\'팀장\',$3,$4::jsonb)', [projectId, id, action, JSON.stringify({ ...body, status })]);
  deferChange(db, projectId, 'design', { id });
  return (await decisions(db, projectId)).find(decision => decision.id === id);
}

export async function resolve(db: PoolClient, projectId: string, id: string, body: { updatedAt: string; how: 'contract' | 'code'; decisionId?: string }, epoch: number) {
  const repo = new RunnerRepository(db);
  await repo.lock();
  await projectExists(db, projectId, true);
  if (!isUuid(id)) throw new ApiError('NOT_FOUND');
  const row = (await db.query<{ item_key: string; compat: string; status: string; resolution: Record<string, unknown>; updated_at: string }>(`select *,${iso('updated_at')} updated_at from design_drifts where id=$1 and project_id=$2 for update`, [id, projectId])).rows[0];
  if (!row) throw new ApiError('NOT_FOUND');
  if ((row.resolution.ref ?? 'main') !== 'main') throw badState('진행 중인 브랜치 불일치는 main 반영 대상으로 요청할 수 없습니다.');
  if (body.how === 'contract') await assertExternal(repo);
  const active = await activeDesignApply(db, projectId, id);
  if (active) {
    if (body.how !== 'contract') throw badState('이미 계약 반영을 기다리는 불일치입니다.');
    if (row.resolution.jobId !== active) await linkDesignApply(db, projectId, id, active);
    return { jobId: active };
  }
  await assertSameVersion(db, row.updated_at, body.updatedAt);
  if (row.status !== 'open') throw badState('이미 처리한 불일치입니다.');
  if (body.how === 'contract') {
    if (row.compat === '대조 안 함') throw badState('코드에서 명세를 추출해 대조한 뒤 계약에 반영하세요.');
    if (row.compat === '깨짐' && (!body.decisionId || !(await db.query("select 1 from tech_decisions where id::text=$1 and project_id=$2 and status='approved' and content->>'itemKey'=$3 and content->>'driftId'=$4", [body.decisionId, projectId, row.item_key, id])).rowCount)) throw badState('이 항목과 불일치를 가리키는 승인된 기술 결정이 필요합니다.');
    const jobId = await enqueueJob(db, { projectId, kind: 'design_apply', payload: { itemKey: row.item_key, driftId: id }, epoch, dedupKey: `design-apply:${id}:${row.updated_at}` });
    await db.query('update design_drifts set resolution=resolution||$2::jsonb where id=$1', [id, JSON.stringify({ how: 'contract', jobId, decisionId: body.decisionId ?? null, sourceCommit: row.resolution.commit, target: row.resolution.extracted })]);
    deferChange(db, projectId, 'design', { id });
    return { jobId };
  }
  const taskKey = row.resolution.taskKey;
  const task = (await db.query<{ assignee_agent: string }>('select assignee_agent from tasks where project_id=$1 and task_key=$2 and deleted_at is null', [projectId, taskKey])).rows[0];
  if (!task) throw badState('코드 수정을 요청할 담당 Task가 없습니다.');
  const draft = await createDraft(db, { taskKey: String(taskKey), type: '수정 요청', toAgent: task.assignee_agent, body: `설계 불일치 코드 수정 요청: ${row.item_key}\n${String(row.resolution.text ?? '')}` });
  await leadAction(db, draft.id, 'send', draft.updatedAt);
  await db.query("update design_drifts set status='done',resolution=resolution||$2::jsonb where id=$1", [id, JSON.stringify({ how: 'code', messageId: draft.id })]);
  await alert(db, projectId, 'design_drift', (await drifts(db, projectId)).some(drift => drift.status === 'open'), '계약과 코드의 불일치 또는 대조하지 못한 항목이 있습니다.');
  deferChange(db, projectId, 'design', { id });
  return required((await drifts(db, projectId, String(row.resolution.ref ?? 'main'))).find(drift => drift.id === id));
}
