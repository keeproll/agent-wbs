import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApiClient, type ApiClient, type ApiResponse } from '../../../agent-runner/src/api/client.ts';
import type { Agent, ClaimedJob } from '../../../agent-runner/src/api/generated/client.ts';
import { Secret } from '../../../agent-runner/src/security/secret.ts';

export interface Running {
  job: Extract<ClaimedJob, { kind: 'attempt' }>;
  attemptId: string;
  grade: ApiResponse<'getRunGrade'>['body'];
  bootId: string;
  processGroup: number;
  headSha: string;
}

/** 실행 파일·유료 Agent를 호출하지 않는다. Runner의 계약만 써서 실제 HTTP 서버에 보고한다. */
export class FakeRunner {
  online = true;
  readonly api: ApiClient;
  readonly hostId = 'm209-fake-host';
  bootId = randomUUID();
  private processGroup = 1000;
  private readonly runnerId = 'm209-fake';

  constructor(baseUrl: string, token: string) {
    this.api = createApiClient({ baseUrl, token: new Secret(token), fetch: (input, init) => {
      if (!this.online) return Promise.reject(new TypeError('가짜 Runner 연결 끊김'));
      return fetch(input, init);
    } });
  }

  private write() { return { epoch: 1, idempotencyKey: randomUUID() }; }

  async initialize() {
    await this.reconnect();
    await this.host();
    for (const [agent, model] of [['Claude', 'claude-sonnet-5-5'], ['Codex', 'gpt-6.1-sol']] as const) {
      await this.api('reportModels', { ...this.write(), body: { agent, models: [{ id: model, label: '무료 시나리오 모델', efforts: ['low','medium','high','xhigh','max'] }] } });
      await this.usage(agent, 100);
    }
    await this.api('reportReadiness', { ...this.write(), body: { at: new Date().toISOString(), items: (['claude','codex','git','node','pnpm','pg','repo','disk','subs'] as const).map(key => ({ key, status: 'ok' as const, detail: '가짜 실행 환경' })) } });
  }

  async reconnect() {
    await this.api('reportSession', { ...this.write(), body: { runnerId: this.runnerId, event: 'start', at: new Date().toISOString() } });
    await this.api('heartbeat', { ...this.write(), body: { runnerId: this.runnerId, version: 'fake', epoch: 1 } });
  }

  private async host() {
    await this.api('reportHost', { ...this.write(), body: { hostId: this.hostId, bootId: this.bootId, cpu: 'fake', cores: 20, memGB: 32, swapGB: 0, diskFreeGB: 100, os: 'fake' } });
  }

  async reboot() {
    await this.api('reportSession', { ...this.write(), body: { runnerId: this.runnerId, event: 'stop', at: new Date().toISOString(), reason: 'reboot' } });
    this.bootId = randomUUID();
    await this.host();
    await this.reconnect();
  }

  async usage(agent: Agent, remainPct: number, resetAt?: string) {
    await this.api('reportUsage', { ...this.write(), body: { agent, remainPct, ...(resetAt && { resetAt }) } });
  }

  async startNext(headSha?: string): Promise<Running | undefined> {
    const claimed = await this.api('claimJob', { ...this.write(), body: { kinds: ['attempt'], capacity: 20 } });
    if (claimed.status === 204) return undefined;
    const job = claimed.body.job;
    assert.equal(job.kind, 'attempt');
    assert(job.kind === 'attempt');
    headSha ??= job.payload.baseCommit;
    const role = job.payload.kind === 'dev' || job.payload.kind === 'rework' ? 'dev' : 'qa';
    const params = { taskKey: job.payload.taskKey };
    const grade = await this.api('getRunGrade', { epoch: 1, params, query: { role } });
    const subs = await this.api('getTaskSubagents', { epoch: 1, params, query: { role } });
    assert.equal(subs.body.items.length, 0, '이 시나리오는 하위 Agent 없는 준비 자료를 사용합니다.');
    const started = await this.api('startJob', { ...this.write(), params: { id: job.id }, body: { fence: job.fence, hostId: this.hostId, bootId: this.bootId, headSha, installedSubagents: [] } });
    assert(started.body.attemptId, '시작 응답에 시도 ID가 없습니다.');
    const attemptId = started.body.attemptId;
    await this.api('reportAttemptStatus', { ...this.write(), params: { attemptId }, body: { fence: job.fence, status: 'running', at: new Date().toISOString(), model: grade.body.model, effort: grade.body.effort } });
    const processGroup = ++this.processGroup;
    await this.api('reportJobProcess', { ...this.write(), params: { id: job.id }, body: { fence: job.fence, processGroup, cgroup: null } });
    return { job, attemptId, grade: grade.body, bootId: this.bootId, processGroup, headSha };
  }

  async releaseAfterReboot(a: Running) {
    await this.api('releaseJob', { ...this.write(), params: { id: a.job.id }, body: { fence: a.job.fence, hostId: this.hostId, proof: { kind: 'boot_changed', bootId: a.bootId, currentBootId: this.bootId, processGroup: a.processGroup }, at: new Date().toISOString() } });
  }

  async result(a: Running, result: 'PASS' | 'FAIL' | 'BLOCKED' = 'PASS', checked = false) {
    await this.api('releaseJobSlots', { ...this.write(), params: { id: a.job.id }, body: { fence: a.job.fence, hostId: this.hostId, proof: { kind: 'group_empty', bootId: a.bootId, processGroup: a.processGroup }, at: new Date().toISOString() } });
    const qa = a.job.payload.kind === 'qa' || a.job.payload.kind === 'reverify';
    // 흐름만 보는 M2 시험 자료다. 실제 ①은 attempt-complete에서 실행한다.
    if (!qa && !checked) {
      const run = await this.api('startCiRun', { ...this.write(), body: { jobId:a.job.id,fence:a.job.fence,stage:'task',taskKey:a.job.payload.taskKey,
        attemptId:a.attemptId,ref:a.job.payload.branch,trigger:'fixture',pipelineSha:'c'.repeat(40),headSha:a.job.payload.baseCommit } });
      for (const status of ['run','pass'] as const) await this.api('updateCiRun', { ...this.write(),params:{ id:run.body.id },body:{ fence:a.job.fence,status } });
    }
    await this.api('reportAttemptResult', { ...this.write(), params: { attemptId: a.attemptId }, body: {
      fence: a.job.fence, summary: '무료 가짜 실행 결과', changedFiles: qa ? [] : ['src/result.ts'], evidence: [],
      ...(qa && { verification: { headSha: a.headSha, specRevision: 1, result, cmd: 'fake check', expected: '수용 기준 충족', actual: result,
        defects: result === 'FAIL' ? [{ text: '수용 기준 미충족', blocking: true }] : [], checklist: [{ itemKey: 'CL-1', done: result === 'PASS' }] } }),
    } });
  }

  async messages() { return (await this.api('pollMessages', { epoch: 1 })).body.messages; }
  async ack(messageId: string) { await this.api('ackMessage', { ...this.write(), params: { messageId } }); }
}
