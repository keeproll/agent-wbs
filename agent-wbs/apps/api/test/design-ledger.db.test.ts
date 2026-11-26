import { afterEach, beforeEach, expect, test } from 'vitest';
import { required } from '../src/runner/repository.ts';
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
  h = await harness(`m605_${String(++n)}`);
  project = (await projectWith(h.owner, ['ready'])).project;
  jobId = required((await h.owner.query<{ id: string }>(
    "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key,fence,lease_owner,lease_until) values($1,'planning','{}','started',1,gen_random_uuid()::text,1,'runner:runner-1',now()+interval '1 hour') returning id", [project])).rows[0]).id;
});
afterEach(async () => { await h?.close(); });

test('커밋 캐시는 재보고해도 버전을 늘리지 않고 브랜치와 확정 설계를 분리한다', async () => {
  expect((await get()).body).toMatchObject({ version: null, decisions: 0, pending: 0, drifts: 0, files: [] });
  expect((await report(snapshot(sha('a')))).status).toBe(204);
  expect((await report(snapshot(sha('a')))).status).toBe(204);
  const same = snapshot(sha('a'));
  same.items[0].content = { tables: ['postgres:users'], errors: [], validation: [], response: '{}', request: '', auth: 'session', type: 'REST' };
  expect((await report(same)).status).toBe(204);
  expect((await get()).body).toMatchObject({ version: 1, files: [{ commit: sha('a'), itemCount: 1 }] });
  const branch = snapshot(sha('b'), { ref: 'agent/TASK-0001', items: [{ ...item(), name: '브랜치 사용자' }] });
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
  await h.owner.query("insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at) values('m605-host','m605-boot','fake',4,16,0,100,'Linux',1,now())");
  await h.owner.query("insert into external_write_authority(singleton,host_id,state,generation) values(true,'m605-host','granted',1)");
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
  expect((await h.lead('POST', `${base}${project}/design/drifts/${drift.id}/resolve`, { updatedAt: drift.updatedAt, how: 'contract', decisionId: final.id })).status).toBe(202);
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
