/**
 * M6 통합 Codex 독립 리뷰(review-codex.md) 재현을 시험으로 남긴다.
 * - P2-2: 최신 커밋의 계약 파일을 읽지 못했으면, 늦게 온 design_apply 결과를 과거 성공 자료로 완료 확정하지 않는다(409, 불일치 열림).
 * - P3-1: 늦은 결과로 마지막 불일치를 닫으면 design_drift 대시보드 경고도 닫힌다.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { required } from '../src/runner/repository.ts';
import { installRunner } from '../src/runner/routes.ts';
import { harness, projectWith, type Body, type Harness } from './m208-fixture.ts';

let h: Harness;
let project: string;
let jobId: string;
let sequence = 0;
const sha = (c: string) => c.repeat(40);
const path = 'contracts/api/openapi.yaml';
const fields = [{ path: '/response/id', type: 'string', required: false }];
const more = [...fields, { path: '/response/name', type: 'string', required: false }];
const item = (changed = false) => ({ itemKey: 'GET /users', kind: 'REST', path, taskKey: 'TASK-0001',
  content: { type: 'REST', auth: 'session', request: '', response: '{}', validation: [], errors: [], tables: [] }, contract: { fields: changed ? more : fields }, extracted: { fields: more } });
const snapshot = (commit: string, extra: Body = {}) => ({ jobId, fence: 1, commit, ref: 'main', files: [{ path, kind: 'REST', format: 'OpenAPI 3.1', status: 'ok', raw: 'openapi: 3.1.0' }], items: [item(true)], drifts: [], ...extra });
const report = (body: Body) => h.runner('POST', '/api/runner/design/snapshot', body);
const drifts = () => h.lead('GET', `/api/projects/${project}/design/drifts`);

beforeEach(async () => {
  h = await harness(`m6int_review_${String(++sequence)}`, installRunner);
  project = (await projectWith(h.owner, ['ready'])).project;
  await h.owner.query("insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at) values('review-host','review-boot','fake',4,16,0,100,'Linux',1,now())");
  await h.owner.query("insert into external_write_authority(singleton,host_id,state,generation) values(true,'review-host','granted',1)");
  await h.owner.query("insert into github_settings(mode,status,scopes) values('gh','ok',$1) on conflict(singleton) do nothing", [{ contents: 'verified', pulls: 'verified', statuses: 'verified', metadata: 'verified' }]);
  jobId = required((await h.owner.query<{ id: string }>("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key,fence,lease_owner,lease_until,generation) values($1,'merge_followup','{\"pr\":1}','started',1,gen_random_uuid()::text,1,'runner:runner-1',now()+interval '1 hour',1) returning id", [project])).rows[0]).id;
});
afterEach(async () => { await h?.close(); });

/** A에서 불일치 → 계약 반영 job → merge_followup이 목표와 같은 B를 먼저 보고(job 진행 중이라 불일치는 열림). */
async function prepare() {
  expect((await report(snapshot(sha('a'), { items: [item(false)] }))).status).toBe(204);
  const drift = (await drifts()).body.items[0];
  const apply = (await h.lead('POST', `/api/projects/${project}/design/drifts/${String(drift.id)}/resolve`, { updatedAt: drift.updatedAt, how: 'contract' })).body.jobId as string;
  await h.owner.query("update runner_jobs set state='started',fence=1,lease_owner='runner:runner-1',lease_until=now()+interval '1 hour',generation=1 where id=$1", [apply]);
  expect((await report(snapshot(sha('b')))).status).toBe(204);
  return apply;
}

test('[리뷰 P3-1] 늦은 design_apply 결과로 마지막 불일치를 닫으면 design_drift 경고도 닫힌다', async () => {
  const apply = await prepare();
  expect((await report(snapshot(sha('c')))).status).toBe(204);
  expect((await h.owner.query("select 1 from alerts where key='design_drift' and resolved_at is null")).rowCount).toBe(1);
  expect((await report(snapshot(sha('b'), { jobId: apply }))).status).toBe(204);
  expect((await drifts()).body.items[0].status).toBe('done');
  expect((await h.owner.query("select 1 from alerts where key='design_drift' and resolved_at is null")).rowCount).toBe(0);
  expect((await h.runner('POST', `/api/runner/jobs/${apply}/finish`, { fence: 1, status: 'done' })).status).toBe(204);
  expect((await report(snapshot(sha('c')))).status).toBe(204);
  expect((await h.owner.query("select 1 from alerts where key='design_drift' and resolved_at is null")).rowCount).toBe(0);
});

test('[리뷰 P2-2] 최신 커밋의 계약 파일 읽기가 실패했으면 늦은 design_apply 결과를 과거 성공 자료로 완료하지 않는다', async () => {
  const apply = await prepare();
  // 최신 C는 같은 파일을 읽지 못한다. 서버는 화면 표시용으로 B의 성공 자료를 남긴다.
  expect((await report(snapshot(sha('c'), { files: [{ path, kind: 'REST', format: 'OpenAPI 3.1', status: 'error', error: 'invalid YAML' }], items: [] }))).status).toBe(204);
  const response = await report(snapshot(sha('b'), { jobId: apply }));
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('INVALID_TRANSITION');
  const drift = (await drifts()).body.items[0];
  expect(drift.status).toBe('open');
  expect(drift.resolution.resultCommit ?? null).toBeNull();
  // 화면은 「읽기 실패(마지막 성공 커밋 표시)」 상태다: 파일 상태 error, 표시 자료의 출처는 B.
  const overview = (await h.lead('GET', `/api/projects/${project}/design`)).body;
  expect(overview.files).toMatchObject([{ path, status: 'error' }]);
  // 최신 C를 다시 읽는 데 성공하면 그때 완료로 볼 수 있다.
  expect((await report(snapshot(sha('d')))).status).toBe(204);
  expect((await report(snapshot(sha('b'), { jobId: apply }))).status).toBe(204);
  expect((await drifts()).body.items[0].status).toBe('done');
});
