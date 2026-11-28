import assert from 'node:assert/strict';
import type { Pool, PoolClient } from '@awbs/db';
import { completionGate, DomainError } from '@awbs/shared';
import { OPERATIONS } from '@awbs/shared/api';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PlatformError } from '../platform/errors.ts';
import { DATA_ROOT } from '../reset/files.ts';
import { inEpoch } from '../platform/transaction.ts';
import { required, RunnerRepository } from '../runner/repository.ts';
import { TaskError } from '../tasks/errors.ts';
import { assertVersion, changed, lockTask } from '../tasks/write.ts';
import { addEvidenceReference, checkEvidence, evidenceContent, multipartBody, removeUploads, uploadEvidence } from './evidence.ts';
import { completeMergedTask, enqueueIntegration, gateInputs, taskGate } from './gate.ts';
import { attempts, evidenceList, verifications, type PageFilter } from './read.ts';
import { reportResult, type ResultReport } from './result.ts';

export interface ExecutionOptions {
  /** 서버 파일 루트(기본 ~/.agentwbs/wbs). Evidence 저장·내보내기(M2-04)·파일 삭제 큐가 모두 이 루트를 쓴다. */
  dataRoot?: string;
  /** Runner가 기준 main A에서 실행하며 고정한 파이프라인 정의를 저장 기록에서 찾는다. */
  resolveBasePipelineSha?: (client: PoolClient, baseSha: string, projectId: string) => Promise<string | null>;
}

export function installExecution(app: FastifyInstance, pool: Pool, options: ExecutionOptions = {}) {
  const root = options.dataRoot ?? DATA_ROOT;
  const uploads = new WeakMap<FastifyRequest,string[]>();
  app.addContentTypeParser('multipart/form-data',{ parseAs:'buffer' },(r,body,done) => {
    void multipartBody(String(r.headers['content-type']),body as Buffer).then(b => done(null,b),done);
  });
  app.addHook('onError',async r => { await removeUploads(uploads.get(r) ?? []); });
  const route = (id: string, handler: (client: PoolClient, r: FastifyRequest, reply: FastifyReply) => Promise<unknown>, status = 200) => {
    const op = OPERATIONS.find(o => o.id === id); assert(op);
    app.route({ method:op.method,url:op.path,
      schema:{ ...(op.body && { body:op.body }),...(op.query && { querystring:op.query }) },
      handler:async (r,reply) => {
        const execute = async (client: PoolClient) => {
          try { return await handler(client,r,reply); }
          catch (error) {
            if (error instanceof DomainError || error instanceof TaskError) throw new PlatformError(error.code,error.details);
            throw error;
          }
        };
        const value = r.platform?.client ? await execute(r.platform.client) : await inEpoch(pool,r.platform?.currentEpoch ?? 0,execute);
        return value === undefined ? reply.code(status).send() : reply.code(status).send(value);
      } });
  };
  const params = (r: FastifyRequest) => r.params as { taskKey: string; attemptId: string; id: string };
  route('reportAttemptResult',async (client,r) => {
    if (await reportResult(client,params(r).attemptId,r.platform?.principal ?? '',r.body as ResultReport) === 'closed') {
      if (r.platform) r.platform.commitOnError = true;
      throw new PlatformError('ATTEMPT_CLOSED');
    }
  },201);
  route('uploadEvidence',async (client,r) => {
    const created: string[] = []; uploads.set(r,created);
    return uploadEvidence(client,params(r).attemptId,r.platform?.principal ?? '',r.platform?.epoch ?? 0,root,r.body as Parameters<typeof uploadEvidence>[5],created);
  },201);
  const task = async (client: PoolClient, key: string) => {
    const row = (await client.query<{ id: string; task_key: string }>('select id,task_key from tasks where task_key=$1 and deleted_at is null',[key])).rows[0];
    if (!row) throw new PlatformError('TASK_NOT_FOUND');
    return row;
  };
  route('getTaskGate',async (client,r) => { const t = await task(client,params(r).taskKey); return taskGate(client,t.id,t.task_key); });
  route('listGates',async client => {
    const rows = (await client.query<{ id: string; task_key: string }>('select id,task_key from tasks where deleted_at is null order by task_key')).rows;
    const inputs = await gateInputs(client,rows.map(t => t.id));
    return { items:rows.map(t => { const conditions = completionGate(required(inputs.get(t.id))); return { taskKey:t.task_key,conditions,passed:conditions.every(c => c.result === 'PASS') }; }) };
  });
  route('completeTask',async (client,r) => {
    const repo = new RunnerRepository(client); await repo.lock();
    const t = await lockTask(client,params(r).taskKey);
    await assertVersion(client,t,(r.body as { updatedAt: string }).updatedAt);
    const q = (await client.query<{ base_sha: string }>('select base_sha from merge_queue where task=$1 order by queue_no desc limit 1',[t.id])).rows[0];
    const pipeline = q?.base_sha && options.resolveBasePipelineSha ? await options.resolveBasePipelineSha(client,q.base_sha,t.project_id) : null;
    await completeMergedTask(client,t.task_key,pipeline);
    return changed(client,t,[{ field:'lifecycleStatus',before:t.status,after:'done' }]);
  });
  route('listVerifications',(client,r) => verifications(client,r.query as PageFilter));
  route('getTaskVerifications',async (client,r) => { await task(client,params(r).taskKey); return verifications(client,{ ...r.query as PageFilter,taskKey:params(r).taskKey }); });
  route('getTaskAttempts',async (client,r) => { await task(client,params(r).taskKey); return attempts(client,params(r).taskKey,r.query as PageFilter); });
  route('listEvidence',(client,r) => evidenceList(client,r.query as PageFilter));
  route('addVerificationEvidence', (client, r) => addEvidenceReference(client, params(r).id, (r.body as { path: string }).path), 201);
  route('getEvidenceContent',async (client,r,reply) => {
    const row = (await client.query<{ storage_path: string; sha256: string; size: string }>('select storage_path,sha256,size from evidence where id::text=$1 and storage_path is not null',[params(r).id])).rows[0];
    if (!row) throw new PlatformError('NOT_FOUND');
    const bytes = await evidenceContent(root,row.storage_path);
    checkEvidence(bytes,row.sha256,Number(row.size));
    reply.header('Content-Disposition',`attachment; filename="${params(r).id}.bin"`).header('X-Content-Type-Options','nosniff').type('application/octet-stream');
    return bytes;
  });
  // 체크리스트·산출물 수정으로 마지막 Gate 조건을 채웠을 때도 별도 완료 승인을 요구하지 않는다.
  app.addHook('preSerialization',async (r,reply,payload) => {
    if (reply.statusCode < 400 && r.platform?.client && ['updateChecklistItem','updateTaskOutputs'].includes(r.platform.operation?.id ?? '')) {
      const t = await task(r.platform.client,params(r).taskKey);
      await enqueueIntegration(r.platform.client,t.id,r.platform.epoch);
    }
    return payload;
  });
}
