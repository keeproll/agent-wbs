import { afterEach, beforeEach, expect, test } from 'vitest';
import { required } from '../src/runner/repository.ts';
import { readFileSync } from 'node:fs';
import { installRunner } from '../src/runner/routes.ts';
import { watchRunner } from '../src/runner/watch.ts';
import { harness, projectWith, type Harness, type Body } from './m208-fixture.ts';

let h: Harness;
let project: string;
let jobId: string;
let n = 0;
const base = '/api/projects/';
const sha = (char: string) => char.repeat(40);
const fields = [{ path: '/response/id', type: 'string', required: false }];
const path = 'contracts/api/openapi.yaml';
const rest = { type: 'REST', auth: 'session', request: '', response: '{}', validation: [], errors: [], tables: ['postgres:users'] };
const item = (extracted: unknown = { fields }) => ({ itemKey: 'GET /users', name: '사용자', kind: 'REST', path, taskKey: 'TASK-0001', content: rest, contract: { fields }, extracted });
const snapshot = (commit: string, extra: Body = {}) => ({ jobId, fence: 1, commit, ref: 'main', files: [{ path, kind: 'REST', format: 'OpenAPI 3.1', status: 'ok', raw: 'openapi: 3.1.0' }], items: [item()], drifts: [], ...extra });
const report = (body: Body, key?: string) => h.runner('POST', '/api/runner/design/snapshot', body, key);
const get = (suffix = '') => h.lead('GET', `${base}${project}/design${suffix}`);
const decision = async (authority = 'agent') => h.runner('POST', `${base}${project}/design/decisions`, {
  jobId, fence: 1, authority, area: '통신', title: '통신 방식', choice: 'REST', reason: '외부 인터페이스', alternatives: 'GraphQL',
});

beforeEach(async () => {
  h = await harness(`m605_${String(++n)}`, installRunner);
  project = (await projectWith(h.owner, ['ready'])).project;
  await grantExternal();
  jobId = required((await h.owner.query<{ id: string }>(
    "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key,fence,lease_owner,lease_until,generation) values($1,'merge_followup','{\"pr\":1}','started',1,gen_random_uuid()::text,1,'runner:runner-1',now()+interval '1 hour',1) returning id", [project])).rows[0]).id;
});
afterEach(async () => { await h?.close(); });

async function grantExternal() {
  if ((await h.owner.query('select 1 from external_write_authority')).rowCount) return;
  await h.owner.query("insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at) values('m605-host','m605-boot','fake',4,16,0,100,'Linux',1,now())");
  await h.owner.query("insert into external_write_authority(singleton,host_id,state,generation) values(true,'m605-host','granted',1)");
}
const lease = (id: string) => h.owner.query("update runner_jobs set state='started',fence=1,lease_owner='runner:runner-1',lease_until=now()+interval '1 hour',generation=1 where id=$1", [id]);
const apply = (drift: Body, extra: Body = {}) => h.lead('POST', `${base}${project}/design/drifts/${drift.id}/resolve`, { updatedAt: drift.updatedAt, how: 'contract', ...extra });
const attemptJob = async (branch: string) => required((await h.owner.query<{ id: string }>("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key,fence,lease_owner,lease_until) values($1,'attempt',$2::jsonb,'started',1,gen_random_uuid()::text,1,'runner:runner-1',now()+interval '1 hour') returning id", [project, JSON.stringify({ taskKey: 'TASK-0001', branch })])).rows[0]).id;

test('커밋 캐시는 재보고해도 버전을 늘리지 않고 브랜치와 확정 설계를 분리한다', async () => {
  expect((await get()).body).toMatchObject({ version: null, decisions: 0, pending: 0, drifts: 0, files: [] });
  expect((await report(snapshot(sha('a')))).status).toBe(204);
  expect((await report(snapshot(sha('a')))).status).toBe(204);
  const same = snapshot(sha('a'));
  same.items[0].content = { tables: ['postgres:users'], errors: [], validation: [], response: '{}', request: '', auth: 'session', type: 'REST' };
  expect((await report(same)).status).toBe(204);
  expect((await get()).body).toMatchObject({ version: 1, files: [{ commit: sha('a'), itemCount: 1 }] });
  const branch = snapshot(sha('b'), { jobId: await attemptJob('agent/TASK-0001'), ref: 'agent/TASK-0001', items: [{ ...item(), name: '브랜치 사용자' }] });
  expect((await report(branch)).status).toBe(204);
  expect((await get('/interfaces')).body.items).toMatchObject([{ key: 'GET /users', name: '사용자', taskKey: 'TASK-0001' }]);
  expect((await get('/interfaces?ref=agent%2FTASK-0001')).body.items).toMatchObject([{ name: '브랜치 사용자', status: 'draft' }]);
  expect((await get('/interfaces/GET%20%2Fusers')).body).toMatchObject({ content: rest, source: { path, commit: sha('a'), status: 'ok', raw: 'openapi: 3.1.0' } });
  expect((await get('/interfaces?kind=Kafka')).body).toEqual({ items: [] });
  expect((await get('/interfaces/missing')).status).toBe(404);
  expect((await report(snapshot(sha('a'), { items: [{ ...item(), name: '몰래 바꿈' }] }))).body.error.code).toBe('VERSION_CONFLICT');
});

test('읽기 실패는 마지막 성공 내용과 원래 커밋을 유지하고 대시보드 경고를 열었다가 닫는다', async () => {
  expect((await report(snapshot(sha('a')))).status).toBe(204);
  expect((await report(snapshot(sha('b'), { files: [{ path, kind: 'REST', format: 'OpenAPI 3.1', status: 'error', error: '문법 오류' }], items: [] }))).status).toBe(204);
  expect((await get('/interfaces/GET%20%2Fusers')).body).toMatchObject({ name: '사용자', content: rest, source: { commit: sha('a'), status: 'error', raw: 'openapi: 3.1.0' } });
  expect((await get()).body.files[0]).toMatchObject({ status: 'error', error: '문법 오류', itemCount: 1 });
  expect((await h.owner.query("select 1 from alerts where key='design_parse' and resolved_at is null")).rowCount).toBe(1);
  expect((await report(snapshot(sha('b')))).status).toBe(204);
  expect((await h.owner.query("select 1 from alerts where key='design_parse' and resolved_at is null")).rowCount).toBe(0);
  expect((await get('/interfaces/GET%20%2Fusers')).body.source).toMatchObject({ commit: sha('b'), status: 'ok' });
  expect((await report(snapshot(sha('c'), { files: [], items: [] }))).status).toBe(204);
  expect((await report(snapshot(sha('d'), { files: [{ path, kind: 'REST', format: 'OpenAPI 3.1', status: 'error', error: '다시 문법 오류' }], items: [] }))).status).toBe(204);
  expect((await get('/interfaces/GET%20%2Fusers')).body).toMatchObject({ name: '사용자', content: rest, source: { commit: sha('b'), status: 'error' } });
});

test('Runner가 호환이라고 해도 삭제·타입 변경·필수화는 깨짐이며 추출 불가는 unchecked다', async () => {
  const forged = [{ itemKey: 'GET /users', kind: 'REST', where: path, text: '필드 차이', compat: 'compatible' }];
  expect((await report(snapshot(sha('a'), { items: [item({ fields: [] })], drifts: forged }))).status).toBe(204);
  expect((await get('/drifts')).body.items).toMatchObject([{ compat: 'breaking', status: 'open' }]);
  expect((await report(snapshot(sha('b'), { items: [item(null)] }))).status).toBe(204);
  expect((await get('/drifts')).body.items).toMatchObject([{ compat: 'unchecked' }]);
  expect((await get()).body.drifts).toBe(1);
});

test('필수 참조·중복·다른 Runner·낡은 fence를 거부하고 캐시를 남기지 않는다', async () => {
  for (const body of [snapshot(sha('a'), { fence: 0 }), snapshot(sha('a'), { items: [item(), item()] }), snapshot(sha('a'), { files: [] })]) {
    expect((await report(body)).status).toBe(body.fence === 0 ? 409 : 400);
  }
  await h.owner.query("update runner_jobs set lease_owner='runner:other' where id=$1", [jobId]);
  expect((await report(snapshot(sha('a')))).body.error.code).toBe('LEASE_LOST');
  expect((await h.owner.query('select 1 from design_snapshots')).rowCount).toBe(0);
  expect((await h.lead('POST', '/api/runner/design/snapshot', snapshot(sha('a')))).body.error.code).toBe('RUNNER_UNAUTHORIZED');
  await h.owner.query("update runner_jobs set lease_owner='runner:runner-1',lease_until=now()-interval '1 second' where id=$1", [jobId]);
  expect((await report(snapshot(sha('a')))).body.error.code).toBe('LEASE_LOST');
});

test('Agent 제안은 승인 대기·재량은 기록이며 변경 반려는 원래 결정을 보존한다', async () => {
  const added = await decision();
  expect(added.status).toBe(201);
  expect(added.body).toMatchObject({ tdKey: 'TD-01', authority: 'agent', status: 'pending' });
  expect((await decision('free')).body.status).toBe('noted');
  const id = added.body.id;
  const approved = await h.lead('POST', `/api/design/decisions/${id}/approve`, { updatedAt: added.body.updatedAt });
  expect(approved.body).toMatchObject({ status: 'approved', choice: 'REST' });
  expect((await h.lead('POST', `/api/design/decisions/${id}/change`, { updatedAt: added.body.updatedAt, choice: 'Kafka', reason: '비동기' })).body.error.code).toBe('VERSION_CONFLICT');
  const changed = await h.lead('POST', `/api/design/decisions/${id}/change`, { updatedAt: approved.body.updatedAt, choice: 'Kafka', reason: '비동기' });
  expect(changed.body).toMatchObject({ status: 'change', choice: 'REST' });
  const rejected = await h.lead('POST', `/api/design/decisions/${id}/reject`, { updatedAt: changed.body.updatedAt });
  expect(rejected.body).toMatchObject({ status: 'approved', choice: 'REST' });
  expect((await get()).body).toMatchObject({ pending: 0, decisions: 2, version: 2 });
  const fixed = required((await h.owner.query<{ id: string }>("insert into tech_decisions(project_id,td_key,title,authority,status,content) values($1,'TD-03','필수','lead','fixed','{\"level\":\"must\"}') returning id", [project])).rows[0]).id;
  const fixedView = (await get('/decisions')).body.items.find((d: Body) => d.id === fixed);
  expect((await h.lead('POST', `/api/design/decisions/${fixed}/change`, { updatedAt: fixedView.updatedAt, choice: '다른 DB', reason: '변경' })).status).toBe(409);
});

test('계약 반영은 job만 만들고 그 job의 다른 결과 커밋을 보고한 뒤 완료한다', async () => {
  const changedFields = [...fields, { path: '/response/name', type: 'string', required: false }];
  expect((await report(snapshot(sha('a'), { items: [item({ fields: changedFields })] }))).status).toBe(204);
  const drift = (await get('/drifts')).body.items[0];
  expect(drift.compat).toBe('compatible');
  const result = await h.lead('POST', `${base}${project}/design/drifts/${drift.id}/resolve`, { updatedAt: drift.updatedAt, how: 'contract' });
  expect(result.status).toBe(202);
  expect((await get('/drifts')).body.items[0].status).toBe('open');
  const job = required((await h.owner.query('select * from runner_jobs where id=$1', [result.body.jobId])).rows[0]);
  expect(job).toMatchObject({ kind: 'design_apply', payload: { driftId: drift.id, itemKey: 'GET /users' } });
  await h.owner.query("update runner_jobs set state='started',fence=1,lease_owner='runner:runner-1',lease_until=now()+interval '1 hour',generation=1 where id=$1", [job.id]);
  const done = snapshot(sha('b'), { jobId: job.id, items: [{ ...item(), contract: { fields: changedFields }, extracted: { fields: changedFields } }] });
  const wrong = snapshot(sha('b'), { jobId: job.id, items: [] });
  expect((await report(wrong)).body.error.code).toBe('INVALID_TRANSITION');
  expect((await h.owner.query('select 1 from design_snapshots where commit=$1', [sha('b')])).rowCount).toBe(0);
  const unrelated = await report(snapshot(sha('b'), { jobId: job.id }));
  expect(unrelated.status, JSON.stringify(unrelated.body)).toBe(409);
  expect(unrelated.body.error.code).toBe('INVALID_TRANSITION');
  expect((await report(done)).status).toBe(204);
  expect((await get('/drifts')).body.items[0]).toMatchObject({ status: 'done' });
});

test('깨짐의 계약 반영은 결정 승인 없이는 막고 코드 수정은 실제 메시지를 만든다', async () => {
  expect((await report(snapshot(sha('a'), { items: [item({ fields: [] })] }))).status).toBe(204);
  const drift = (await get('/drifts')).body.items[0];
  expect((await h.lead('POST', `${base}${project}/design/drifts/${drift.id}/resolve`, { updatedAt: drift.updatedAt, how: 'contract' })).status).toBe(409);
  const requested = await h.lead('POST', `${base}${project}/design/drifts/${drift.id}/resolve`, { updatedAt: drift.updatedAt, how: 'code' });
  expect(requested.status).toBe(200);
  expect(requested.body.status).toBe('done');
  const message = (await h.owner.query('select body,delivery from messages')).rows[0];
  expect(message?.body).toContain('GET /users');
  expect(message?.delivery).toBe('Queued');
});

test('저장소·연결·소유권을 같은 커밋으로 읽고 해석기 없는 파일은 원문만 보존한다', async () => {
  const pgPath = 'contracts/db/postgres/migrations/001.sql';
  const pg = { itemKey: 'postgres:users', name: '사용자 표', kind: 'postgres', path: pgPath, content: { type: 'postgres', columns: [], constraints: [], indexes: [], usedBy: [] } };
  const ownership = [{ data: 'postgres:users', source: 'postgres', copy: 'redis', sync: 'event', lag: '1초' }];
  const components = [{ id: 'api', layer: '서버', name: 'API', tech: 'Node', note: '', decisionId: null }];
  expect((await report(snapshot(sha('a'), { files: [snapshot(sha('a')).files[0], { path: pgPath, kind: 'postgres', format: 'SQL', status: 'ok', raw: 'create table users' }, { path: 'contracts/model.other', kind: 'model', format: 'other', status: 'ok', raw: '<raw>' }], items: [item(), pg], ownership, components, edges: [{ from: 'GET /users', to: 'postgres:users', kind: 'read' }] }))).status).toBe(204);
  expect((await get('/data?store=postgres')).body.items).toMatchObject([{ key: 'postgres:users', name: '사용자 표', taskKey: null }]);
  expect((await get('/data/postgres%3Ausers')).body.content.usedBy).toEqual(['GET /users']);
  expect((await get('/ownership')).body).toEqual({ items: ownership });
  expect((await get()).body.components).toEqual(components);
  expect((await h.owner.query('select 1 from design_edges')).rowCount).toBe(1);
  expect((await h.owner.query('select 1 from design_ownership')).rowCount).toBe(1);
  expect((await get()).body.files.find((file: Body) => file.path === 'contracts/model.other')).toMatchObject({ raw: '<raw>', sourceCommit: sha('a') });
  expect((await get('/drifts')).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ itemKey: 'file:contracts/model.other', compat: 'unchecked' })]));
  expect((await report(snapshot(sha('b'), { items: [], files: [] }))).status).toBe(204);
  expect((await get('/data')).body.items).toEqual([]);
  expect((await get()).body.versions[0].breaking).toBe(true);
  expect((await get('/ownership')).body.items).toEqual([]);
});

test('깨진 표시 내용·필드 중복·계약 밖 경로는 400으로 거절한다', async () => {
  const bodies = [
    snapshot(sha('a'), { items: [{ ...item(), content: { type: 'REST', errors: 'bad' } }] }),
    snapshot(sha('a'), { items: [{ ...item(), contract: { fields: [fields[0], fields[0]] } }] }),
    snapshot(sha('a'), { files: [{ path: 'src/api.ts', kind: 'REST', format: 'OpenAPI', status: 'ok' }], items: [] }),
    snapshot(sha('a'), { edges: [{ from: 'GET /users', to: 'missing', kind: 'read' }] }),
    snapshot(sha('a'), { items: [{ ...item(), kind: 'postgres', itemKey: 'postgres:', content: {} }] }),
  ];
  for (const body of bodies) expect((await report(body)).status).toBe(400);
  expect((await h.owner.query('select 1 from design_snapshots')).rowCount).toBe(0);
});

test('변경 승인에는 새 선택을 적용하고 깨짐 버전을 남긴다', async () => {
  const added = (await decision()).body;
  const approved = (await h.lead('POST', `/api/design/decisions/${added.id}/approve`, { updatedAt: added.updatedAt })).body;
  const changed = (await h.lead('POST', `/api/design/decisions/${added.id}/change`, { updatedAt: approved.updatedAt, choice: 'Kafka', reason: '비동기' })).body;
  expect(changed.change).toMatchObject({ choice: 'Kafka', reason: '비동기' });
  const final = (await h.lead('POST', `/api/design/decisions/${added.id}/approve`, { updatedAt: changed.updatedAt })).body;
  expect(final).toMatchObject({ status: 'approved', choice: 'Kafka', reason: '비동기' });
  expect(final.change).toBeUndefined();
  expect((await get()).body.versions[0]).toMatchObject({ v: 2, by: '팀장', breaking: true });
  expect((await report(snapshot(sha('a'), { items: [item({ fields: [] })] }))).status).toBe(204);
  const drift = (await get('/drifts')).body.items[0];
  expect((await apply(drift, { decisionId: final.id })).status).toBe(409);
  const linked = (await h.lead('POST', `/api/design/decisions/${added.id}/change`, { updatedAt: final.updatedAt, choice: 'Kafka v2', reason: '응답 변경', itemKey: drift.itemKey, driftId: drift.id })).body;
  const bound = (await h.lead('POST', `/api/design/decisions/${added.id}/approve`, { updatedAt: linked.updatedAt })).body;
  expect(bound).toMatchObject({ itemKey: drift.itemKey, driftId: drift.id });
  expect((await apply(drift, { decisionId: bound.id })).status).toBe(202);
});

test('계약 반영 job이 실패하면 현재 버전으로 다시 요청할 수 있다', async () => {
  expect((await report(snapshot(sha('a'), { items: [item({ fields: [...fields, { path: '/name', type: 'string', required: false }] })] }))).status).toBe(204);
  const drift = (await get('/drifts')).body.items[0];
  const first = await h.lead('POST', `${base}${project}/design/drifts/${drift.id}/resolve`, { updatedAt: drift.updatedAt, how: 'contract' });
  await h.owner.query("update runner_jobs set state='failed' where id=$1", [first.body.jobId]);
  const current = (await get('/drifts')).body.items[0];
  const retry = await h.lead('POST', `${base}${project}/design/drifts/${drift.id}/resolve`, { updatedAt: current.updatedAt, how: 'contract' });
  expect(retry.status).toBe(202);
  expect(retry.body.jobId).not.toBe(first.body.jobId);
});

test('기록 시각이 앞선 캐시가 있어도 새로 받은 커밋을 최신 설계로 고른다', async () => {
  await h.owner.query("insert into design_snapshots(project_id,commit,ref,parse_status,content,created_at) values($1,$2,'main','ok','{\"itemKeys\":[],\"sequence\":1}',now()+interval '1 hour')", [project, sha('a')]);
  expect((await report(snapshot(sha('b')))).status).toBe(204);
  expect((await get()).body.files[0]?.commit).toBe(sha('b'));
});

test('같은 커밋은 unchecked 항목만 checked로 올리고 대조된 항목·원문·계약은 보존한다', async () => {
  const second = { ...item(), itemKey: 'GET /fixed', name: '고정' };
  expect((await report(snapshot(sha('a'), { items: [item(null), second] }))).status).toBe(204);
  const changed = { fields: [{ ...fields[0], type: 'integer' }] };
  for (const items of [
    [item(), { ...second, extracted: changed }],
    [{ ...item(), contract: changed }, second],
    [{ ...item(), name: '다른 설계' }, second],
  ]) expect((await report(snapshot(sha('a'), { items }))).body.error.code).toBe('VERSION_CONFLICT');
  expect((await report(snapshot(sha('a'), { items: [item(), second], files: [{ ...snapshot(sha('a')).files[0], raw: '변경된 원문' }] }))).body.error.code).toBe('VERSION_CONFLICT');
  expect((await report(snapshot(sha('a'), { items: [item(), second] }))).status).toBe(204);
  expect((await get()).body).toMatchObject({ version: 1, drifts: 0 });
  expect((await get('/drifts')).body.items[0]).toMatchObject({ compat: 'compatible', status: 'done' });
  expect((await report(snapshot(sha('a'), { items: [item(null), second] }))).body.error.code).toBe('VERSION_CONFLICT');
  expect((await report(snapshot(sha('a'), { items: [item(changed), second] }))).body.error.code).toBe('VERSION_CONFLICT');
});

test('같은 커밋의 unchecked를 깨짐으로 대조해도 정상 접수하고 깨짐을 표시한다', async () => {
  expect((await report(snapshot(sha('a'), { items: [item(null)] }))).status).toBe(204);
  expect((await report(snapshot(sha('a'), { items: [item({ fields: [] })] }))).status).toBe(204);
  expect((await get('/drifts')).body.items[0]).toMatchObject({ compat: 'breaking', status: 'open' });
});

test('다른 파일이 실패한 채로 남아도 정상 파일의 unchecked를 checked로 올릴 수 있다', async () => {
  const pg = { itemKey: 'postgres:users', kind: 'postgres', path: 'contracts/db/postgres/001.sql', content: {} };
  const file = { path: pg.path, kind: 'postgres', format: 'SQL', status: 'ok', raw: 'create table users' };
  const components = [{ id: 'api', layer: '서버', name: 'API', tech: 'Fastify', note: '', decisionId: null }];
  expect((await report(snapshot(sha('a'), { components, files: [...snapshot(sha('a')).files, file], items: [item(), pg], edges: [{ from: 'GET /users', to: pg.itemKey, kind: 'read' }] }))).status).toBe(204);
  const files = [...snapshot(sha('b')).files, { ...file, status: 'error', error: 'SQL 문법 오류', raw: 'broken SQL' }];
  expect((await report(snapshot(sha('b'), { files, items: [item(null)] }))).status).toBe(204);
  const upgraded = await report(snapshot(sha('b'), { files, items: [item()] }));
  expect(upgraded.status, JSON.stringify(upgraded.body)).toBe(204);
  expect((await get('/data/postgres%3Ausers')).body.source).toMatchObject({ status: 'error', raw: 'create table users', commit: sha('a') });
  expect((await get()).body.components).toEqual(components);
});

test('같은 커밋의 배열 순서와 Runner 참고값 차이는 충돌이 아니다', async () => {
  const pg = { itemKey: 'postgres:users', kind: 'postgres', path: 'contracts/db/postgres/001.sql', content: {} };
  const files = [...snapshot(sha('a')).files, { path: pg.path, kind: 'postgres', format: 'SQL', status: 'ok', raw: 'SQL' }];
  expect((await report(snapshot(sha('a'), { files, items: [item(), pg] }))).status).toBe(204);
  expect((await report(snapshot(sha('a'), { files: [...files].reverse(), items: [pg, item()], drifts: [{ itemKey: 'GET /users', kind: 'REST', where: '/', text: '표시용 참고값', compat: 'breaking' }] }))).status).toBe(204);
});

test('옛 커밋의 늦은 재해석은 최신 불일치·경고·버전을 바꾸지 않는다', async () => {
  expect((await report(snapshot(sha('a'), { files: [{ path, kind: 'REST', format: 'OpenAPI 3.1', status: 'error', error: '문법 오류' }], items: [] }))).status).toBe(204);
  expect((await report(snapshot(sha('b')))).status).toBe(204);
  const before = (await get()).body;
  expect((await report(snapshot(sha('a'), { items: [item({ fields: [] })] }))).status).toBe(204);
  expect((await get()).body).toMatchObject({ version: before.version, drifts: 0, files: [{ commit: sha('b') }], versions: before.versions });
  expect((await h.owner.query("select 1 from alerts where key like 'design_%' and resolved_at is null")).rowCount).toBe(0);
});

test('임대 만료와 reconcile none 뒤 새 반영 job을 연결하고 재요청은 같은 job을 반환한다', async () => {
  await grantExternal();
  const more = [...fields, { path: '/response/name', type: 'string', required: false }];
  expect((await report(snapshot(sha('a'), { items: [item({ fields: more })] }))).status).toBe(204);
  const drift = (await get('/drifts')).body.items[0];
  const first = (await apply(drift)).body.jobId;
  await lease(first);
  await h.owner.query("update runner_jobs set lease_until=now()-interval '1 minute' where id=$1", [first]);
  expect(await watchRunner(h.pool, 1)).toBe(1);
  expect((await h.runner('POST', `/api/runner/jobs/${first}/reconcile`, { fence: 1, evidence: { outcome: 'none', checkedAt: new Date().toISOString(), detail: {} } })).status).toBe(204);
  const jobs = (await h.owner.query("select id,state from runner_jobs where kind='design_apply' and state in ('queued','leased','started','reconcile')")).rows;
  expect(jobs).toHaveLength(1);
  const next = required(jobs[0]).id as string;
  const current = (await get('/drifts')).body.items[0];
  expect(current.resolution.jobId).toBe(next);
  expect((await apply(current)).body.jobId).toBe(next);
  expect((await apply(drift)).body.jobId).toBe(next);
  await lease(next);
  expect((await report(snapshot(sha('b'), { jobId: next, items: [{ ...item(), contract: { fields: more }, extracted: { fields: more } }] }))).status).toBe(204);
  expect((await get()).body.drifts).toBe(0);
});

test('동시 반영 요청도 진행 중인 job 하나를 공유한다', async () => {
  await grantExternal();
  expect((await report(snapshot(sha('a'), { items: [item({ fields: [...fields, { path: '/response/name', type: 'string', required: false }] })] }))).status).toBe(204);
  const drift = (await get('/drifts')).body.items[0];
  const responses = await Promise.all([apply(drift), apply(drift)]);
  expect(responses.map(response => response.status)).toEqual([202, 202]);
  expect(responses[0]?.body.jobId).toBe(responses[1]?.body.jobId);
  expect((await h.owner.query("select 1 from runner_jobs where kind='design_apply' and state='queued'")).rowCount).toBe(1);
});

test.each(['done', 'failed', 'cancelled'])('결과 미확인 job이 %s이면 새 main 대조로 불일치를 닫는다', async state => {
  await grantExternal();
  const more = [...fields, { path: '/response/name', type: 'string', required: false }];
  expect((await report(snapshot(sha('a'), { items: [item({ fields: more })] }))).status).toBe(204);
  const drift = (await get('/drifts')).body.items[0];
  const id = (await apply(drift)).body.jobId;
  await h.owner.query('update runner_jobs set state=$2 where id=$1', [id, state]);
  expect((await report(snapshot(sha('b'), { items: [{ ...item(), contract: { fields: more }, extracted: { fields: more } }] }))).status).toBe(204);
  expect((await get()).body.drifts).toBe(0);
  expect((await h.owner.query("select 1 from alerts where key='design_drift' and resolved_at is null")).rowCount).toBe(0);
});

test('결과 미확인 job이 끝난 뒤 항목이 사라져도 불일치를 닫는다', async () => {
  await grantExternal();
  expect((await report(snapshot(sha('a'), { items: [item({ fields: [...fields, { path: '/response/name', type: 'string', required: false }] })] }))).status).toBe(204);
  const id = (await apply((await get('/drifts')).body.items[0])).body.jobId;
  await h.owner.query("update runner_jobs set state='done' where id=$1", [id]);
  expect((await report(snapshot(sha('b'), { files: [], items: [] }))).status).toBe(204);
  expect((await get()).body.drifts).toBe(0);
});

test('외부 쓰기가 막혔으면 요청 즉시 거절하고 반영 job을 만들지 않는다', async () => {
  await grantExternal();
  expect((await report(snapshot(sha('a'), { items: [item({ fields: [...fields, { path: '/response/name', type: 'string', required: false }] })] }))).status).toBe(204);
  await h.owner.query("update external_write_authority set state='blocked'");
  expect(await apply((await get('/drifts')).body.items[0])).toMatchObject({ body: { error: { code: 'EXTERNAL_WRITE_BLOCKED' } } });
  expect((await h.owner.query("select 1 from runner_jobs where kind='design_apply'")).rowCount).toBe(0);
});

test('attempt는 자기 브랜치만 보고하고 planning은 main을 보고하지 못한다', async () => {
  const attempt = required((await h.owner.query<{ id: string }>("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key,fence,lease_owner,lease_until) values($1,'attempt','{\"taskKey\":\"TASK-0001\",\"branch\":\"agent/TASK-0001-h1\"}','started',1,gen_random_uuid()::text,1,'runner:runner-1',now()+interval '1 hour') returning id", [project])).rows[0]).id;
  expect((await report(snapshot(sha('a'), { jobId: attempt }))).body.error.code).toBe('INVALID_TRANSITION');
  expect((await report(snapshot(sha('a'), { jobId: attempt, ref: 'agent/TASK-0002-h1' }))).body.error.code).toBe('INVALID_TRANSITION');
  expect((await report(snapshot(sha('a'), { jobId: attempt, ref: 'agent/TASK-0001-h1' }))).status).toBe(204);
  const planning = required((await h.owner.query<{ id: string }>("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key,fence,lease_owner,lease_until) values($1,'planning','{}','started',1,gen_random_uuid()::text,1,'runner:runner-1',now()+interval '1 hour') returning id", [project])).rows[0]).id;
  expect((await report(snapshot(sha('b'), { jobId: planning }))).body.error.code).toBe('INVALID_TRANSITION');
});

test('승인 결정은 같은 itemKey와 driftId에만 쓴다', async () => {
  await grantExternal();
  expect((await report(snapshot(sha('a'), { items: [item({ fields: [] }), { ...item({ fields: [] }), itemKey: 'GET /orders' }] }))).status).toBe(204);
  const drifts = (await get('/drifts')).body.items;
  const target = drifts.find((drift: Body) => drift.itemKey === 'GET /users');
  const other = drifts.find((drift: Body) => drift.itemKey === 'GET /orders');
  const added = await h.runner('POST', `${base}${project}/design/decisions`, { jobId, fence: 1, authority: 'agent', area: '통신', title: '응답 변경', choice: 'id 삭제', reason: '변경 승인', alternatives: '', itemKey: target.itemKey, driftId: target.id });
  expect(added.status).toBe(201);
  const approved = (await h.lead('POST', `/api/design/decisions/${added.body.id}/approve`, { updatedAt: added.body.updatedAt })).body;
  expect((await apply(other, { decisionId: approved.id })).body.error.code).toBe('INVALID_TRANSITION');
  expect((await apply(target, { decisionId: approved.id })).status).toBe(202);
});

test('화면 계약은 설명·DR 표시 번호·메시지 결정 연결·job 상태를 함께 보여 준다', async () => {
  const more = [...fields, { path: '/response/name', type: 'string', required: false }];
  const message = { itemKey: 'created', kind: 'Kafka', path, description: null, content: { type: 'message', auth: '', messages: [], rules: [], topic: null, decisionKeys: ['TD-07'] } };
  expect((await report(snapshot(sha('a'), { items: [{ ...item({ fields: more }), description: '사용자 목록을 조회한다.' }, message] }))).status).toBe(204);
  expect((await get('/interfaces/GET%20%2Fusers')).body.description).toBe('사용자 목록을 조회한다.');
  expect((await get('/interfaces/created')).body).toMatchObject({ description: null, content: { decisionKeys: ['TD-07'] } });
  const drift = (await get('/drifts')).body.items.find((value: Body) => value.itemKey === 'GET /users');
  expect(drift.displayKey).toBe('DR-01');
  const job = (await apply(drift)).body.jobId;
  expect((await get()).body.driftItems.find((value: Body) => value.id === drift.id).resolution.jobStatus).toBe('queued');
  await lease(job);
  expect((await get('/drifts')).body.items.find((value: Body) => value.id === drift.id).resolution.jobStatus).toBe('running');
  await h.owner.query("update runner_jobs set state='failed' where id=$1", [job]);
  expect((await get()).body.driftItems.find((value: Body) => value.id === drift.id).resolution.jobStatus).toBe('failed');
  expect((await report(snapshot(sha('b'), { items: [{ ...item(), contract: { fields: more }, extracted: { fields: more } }] }))).status).toBe(204);
  expect((await get('/drifts')).body.items.find((value: Body) => value.id === drift.id).displayKey).toBe('DR-01');
  expect((await report(snapshot(sha('c'), { items: [item({ fields: more })] }))).status).toBe(204);
  const next = (await get('/drifts')).body.items.find((value: Body) => value.itemKey === 'GET /users' && value.status === 'open');
  expect(next.displayKey).toBe('DR-03');
});

test.each(['finish', 'reconcile'])('일치하는 캐시를 먼저 받아도 %s 뒤 재보고로 불일치를 닫는다', async mode => {
  const more = [...fields, { path: '/response/name', type: 'string', required: false }];
  expect((await report(snapshot(sha('a'), { items: [item({ fields: more })] }))).status).toBe(204);
  const drift = (await get('/drifts')).body.items[0];
  const id = (await apply(drift)).body.jobId;
  await lease(id);
  const matching = snapshot(sha('b'), { items: [{ ...item(), contract: { fields: more }, extracted: { fields: more } }] });
  expect((await report(matching)).status).toBe(204);
  expect((await get()).body.drifts).toBe(1);
  if (mode === 'finish') expect((await h.runner('POST', `/api/runner/jobs/${id}/finish`, { fence: 1, status: 'done' })).status).toBe(204);
  else {
    await h.owner.query("update runner_jobs set lease_until=now()-interval '1 minute' where id=$1", [id]);
    await watchRunner(h.pool, 1);
    expect((await h.runner('POST', `/api/runner/jobs/${id}/reconcile`, { fence: 1, evidence: { outcome: 'done', checkedAt: new Date().toISOString(), detail: {} } })).status).toBe(204);
  }
  expect((await report(matching)).status).toBe(204);
  expect((await get()).body).toMatchObject({ drifts: 0, driftItems: [{ resolution: { jobStatus: 'done' } }] });
});

test('같은 항목이어도 다른 불일치의 승인 결정은 다시 쓰지 않는다', async () => {
  expect((await report(snapshot(sha('a'), { items: [item({ fields: [] })] }))).status).toBe(204);
  const first = (await get('/drifts')).body.items[0];
  const proposed = (await h.runner('POST', `${base}${project}/design/decisions`, { jobId, fence: 1, authority: 'agent', area: '통신', title: '변경', choice: '응답 변경', reason: '검토', alternatives: '', itemKey: first.itemKey, driftId: first.id })).body;
  const approved = (await h.lead('POST', `/api/design/decisions/${proposed.id}/approve`, { updatedAt: proposed.updatedAt })).body;
  expect((await h.lead('POST', `${base}${project}/design/drifts/${first.id}/resolve`, { updatedAt: first.updatedAt, how: 'code' })).status).toBe(200);
  expect((await report(snapshot(sha('b'), { items: [item({ fields: [] })] }))).status).toBe(204);
  const next = (await get('/drifts')).body.items.find((value: Body) => value.status === 'open');
  expect(next.id).not.toBe(first.id);
  expect(await apply(next, { decisionId: approved.id })).toMatchObject({ status: 409, body: { error: { code: 'INVALID_TRANSITION' } } });
});

test('읽기 재시도는 실패 파일의 연결만 갱신하고 사라진 연결을 표시하지 않는다', async () => {
  const pg = { itemKey: 'postgres:users', kind: 'postgres', path: 'contracts/db/postgres/001.sql', content: { type: 'postgres', columns: [], indexes: [], constraints: [], usedBy: [] } };
  const pgFile = { path: pg.path, kind: 'postgres', format: 'SQL', status: 'ok', raw: 'create table users' };
  expect((await report(snapshot(sha('a'), { files: [...snapshot(sha('a')).files, pgFile], items: [item(), pg], edges: [{ from: 'GET /users', to: pg.itemKey, kind: 'read' }] }))).status).toBe(204);
  expect((await report(snapshot(sha('b'), { files: [{ path, kind: 'REST', format: 'OpenAPI 3.1', status: 'error', error: '문법 오류' }, pgFile], items: [pg] }))).status).toBe(204);
  const next = { ...item(), itemKey: 'GET /orders' };
  const result = await report(snapshot(sha('b'), { files: [...snapshot(sha('b')).files, pgFile], items: [next, pg], edges: [{ from: next.itemKey, to: pg.itemKey, kind: 'read' }] }));
  expect(result.status, JSON.stringify(result.body)).toBe(204);
  expect((await get('/interfaces/GET%20%2Fusers')).status).toBe(404);
  expect((await get('/data/postgres%3Ausers')).body.content.usedBy).toEqual(['GET /orders']);
  expect((await report(snapshot(sha('c'), { files: [{ path, kind: 'REST', format: 'OpenAPI 3.1', status: 'error', error: '문법 오류' }, pgFile], items: [pg] }))).status).toBe(204);
  expect((await report(snapshot(sha('c'), { files: [...snapshot(sha('c')).files, pgFile], items: [next, pg], edges: [] }))).status).toBe(204);
  expect((await get('/data/postgres%3Ausers')).body.content.usedBy).toEqual([]);
});

test('공용 fixture의 정상·위반 보고는 서버에서도 같은 결과가 된다', async () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/design-snapshot.json', import.meta.url), 'utf8')) as { id: string; body: Body; expectedStatus: number; expectedRule?: string; expectedConflicts?: Body[] }[];
  for (const fixture of fixtures) {
    const result = await report({ ...fixture.body, jobId });
    expect(result.status, `${fixture.id}: ${JSON.stringify(result.body)}`).toBe(fixture.expectedStatus);
    if (fixture.expectedRule) expect(result.body.error.errors, fixture.id).toEqual(expect.arrayContaining([expect.objectContaining({ rule: fixture.expectedRule })]));
    if (fixture.expectedConflicts) expect(result.body.error.details.conflicts, fixture.id).toEqual(fixture.expectedConflicts);
    if (fixture.id === 'neo4j-raw-with-checked-rest') {
      expect((await get('/interfaces')).body.items).toMatchObject([{ key: 'GET /users' }]);
      expect((await get('/drifts')).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ itemKey: 'file:contracts/db/neo4j/model.cypher', compat: 'unchecked' })]));
    }
  }
});
