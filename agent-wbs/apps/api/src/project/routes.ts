import assert from 'node:assert/strict';
import type { Pool, PoolClient } from '@awbs/db';
import { OPERATIONS } from '@awbs/shared/api';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { installProjectErrors } from './errors.ts';
import { projectState } from './read.ts';
import { checkInputs, updateProject, type ProjectEdit } from './edit.ts';
import { githubSettings } from './github.ts';
import { dashboard } from './dashboard.ts';
import {
  analyzeInputs, approveBootstrap, confirmTech, createProject, createRepoCheck, getRepoCheck, rerunBootstrap, retryBootstrap, retryInputs, recheckInputs, skipInputs,
  type Registration,
} from './service.ts';

/** 오류 본문의 `action`(무엇을 하려다 실패했나, G§0.3) */
export const ACTIONS: Record<string, string> = {
  createRepoCheck: '저장소 접근 확인', getRepoCheck: '저장소 확인 결과 조회', createProject: '프로젝트 등록', getProject: '프로젝트 조회',
  updateProject: '프로젝트 정보 편집', checkInputs: '지금 입력 확인',
  approveBootstrap: '초기 WBS 승인', rerunBootstrap: '재분석 요청', retryBootstrap: '초기 분석 다시 시도', confirmTech: '기술 결정 확정',
  analyzeInputs: '이 버전으로 분석', skipInputs: '분석 안 함', retryInputs: '차이 분석 다시 시도', recheckInputs: '입력 이력 복구 확인',
  reportRepoCheck: '저장소 확인 결과 보고', reportInputChanges: '입력 변경 보고', reportBootstrapProgress: '분석 진행 보고',
  submitDraft: '초기 WBS 초안 등록', submitTechProposals: '기술 결정 제안',
};
export const actionOf = (method: string, url: string) =>
  ACTIONS[OPERATIONS.find((op) => op.method === method && op.path === url)?.id ?? ''] ?? '프로젝트 처리';

export interface Ctx { client: PoolClient; epoch: number; principal: string; request: FastifyRequest }
type Handler = (ctx: Ctx) => Promise<unknown>;

/**
 * 계약(OPERATIONS)의 본문 스키마로 라우트를 등록한다. 변경 요청은 공통 관문(platform)이 연 트랜잭션을 그대로 쓴다.
 * 별도 트랜잭션을 열면 멱등 응답 저장과 업무 변경이 갈라지기 때문이다.
 */
export function routeOf(scope: FastifyInstance, pool: Pool, id: string, handler: Handler, status = 200) {
  const op = OPERATIONS.find((item) => item.id === id);
  assert(op, id);
  scope.route({
    method: op.method, url: op.path, schema: { ...(op.body && { body: op.body }) },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const context = request.platform;
      assert(context);
      const run = (client: PoolClient) => handler({ client, epoch: context.currentEpoch, principal: context.principal, request });
      let result: unknown;
      if (context.client) result = await run(context.client);
      else {
        // 조회는 공통 관문이 트랜잭션을 열지 않는다. 한 시점의 값을 읽도록 읽기 전용 트랜잭션으로 묶는다.
        const client = await pool.connect();
        try {
          await client.query('begin isolation level repeatable read read only');
          result = await run(client);
          await client.query('commit');
        } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
      }
      return result === undefined ? reply.code(status).send() : reply.code(status).send(result);
    },
  });
}

const body = <T>(ctx: Ctx) => ctx.request.body as T;
const param = (ctx: Ctx, name: string) => (ctx.request.params as Record<string, string>)[name] ?? '';

/** 팀장 프로젝트 API(contracts §2.2). 초기화·내보내기는 M2-04 범위라 여기서 등록하지 않는다. */
export function registerProjectRoutes(app: FastifyInstance, pool: Pool): void {
  void app.register(async (scope) => {
    installProjectErrors(scope, actionOf);
    routeOf(scope, pool, 'createRepoCheck', (ctx) => createRepoCheck(ctx.client, body<{ url: string }>(ctx).url, ctx.epoch), 202);
    routeOf(scope, pool, 'getRepoCheck', (ctx) => getRepoCheck(ctx.client, param(ctx, 'id')));
    routeOf(scope, pool, 'createProject', (ctx) => createProject(ctx.client, body<Registration>(ctx), ctx.epoch), 201);
    routeOf(scope, pool, 'getProject', (ctx) => projectState(ctx.client));
    routeOf(scope, pool, 'getGithubSettings', (ctx) => githubSettings(ctx.client));
    routeOf(scope, pool, 'getDashboard', (ctx) => dashboard(ctx.client));
    routeOf(scope, pool, 'updateProject', (ctx) => updateProject(ctx.client, body<ProjectEdit>(ctx)));
    routeOf(scope, pool, 'checkInputs', (ctx) => checkInputs(ctx.client, body<{ updatedAt: string }>(ctx)), 202);
    routeOf(scope, pool, 'approveBootstrap', (ctx) => approveBootstrap(ctx.client, body<{ revision: number }>(ctx).revision));
    routeOf(scope, pool, 'rerunBootstrap', (ctx) => rerunBootstrap(ctx.client, body<{ revision: number; instruction: string }>(ctx), ctx.epoch), 202);
    routeOf(scope, pool, 'retryBootstrap', (ctx) => retryBootstrap(ctx.client, body<{ revision: number } | { revision: null; runNo: number }>(ctx), ctx.epoch), 202);
    routeOf(scope, pool, 'confirmTech', async (ctx) => {
      await confirmTech(ctx.client, param(ctx, 'projectId'), body<{ decisions: { id: string; choice: 'approve' | 'reject'; updatedAt: string }[] }>(ctx), ctx.epoch);
      const state = await projectState(ctx.client);
      return { decisions: 'bootstrap' in state ? state.bootstrap.decisions : [] };
    });
    routeOf(scope, pool, 'analyzeInputs', (ctx) => analyzeInputs(ctx.client, body<{ updatedAt: string; commit: string; commits: string[]; instr?: string }>(ctx), ctx.epoch), 202);
    routeOf(scope, pool, 'skipInputs', (ctx) => skipInputs(ctx.client, body<{ updatedAt: string; commits: string[] }>(ctx)), 204);
    routeOf(scope, pool, 'retryInputs', (ctx) => retryInputs(ctx.client, body<{ updatedAt: string; version: number }>(ctx), ctx.epoch), 202);
    routeOf(scope, pool, 'recheckInputs', (ctx) => recheckInputs(ctx.client, body<{ updatedAt: string }>(ctx)), 202);
  });
}
