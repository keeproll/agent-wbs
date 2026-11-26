import type { Pool } from '@awbs/db';
import type { FastifyInstance } from 'fastify';
import { clientOf, read, routes } from '../changes/http.ts';
import {
  getExecPolicy, getModels, getSubagents, getWorkflow, putExecPolicy, putModels, putSubagents, putWorkflow,
  type ExecPolicyPut, type WorkflowPut,
} from './service.ts';

/** 설정 → Agent 탭(G§4.9): Agent 역할·기본 Workflow, 실행 정책, 허용 모델·순서, 하위 Agent. */
export function registerPolicyRoutes(app: FastifyInstance, pool: Pool): void {
  routes(app, '실행 정책 설정', (route) => {
    route('getWorkflowSettings', async (request) => read(pool, request, getWorkflow));
    route('putWorkflowSettings', async (request) => putWorkflow(clientOf(request), request.body as WorkflowPut));
    route('getExecPolicy', async (request) => read(pool, request, getExecPolicy));
    route('putExecPolicy', async (request) => putExecPolicy(clientOf(request), request.body as ExecPolicyPut));
    route('getModelSettings', async (request) => read(pool, request, getModels));
    route('putModelSettings', async (request) => putModels(clientOf(request), request.body as Parameters<typeof putModels>[1]));
    route('getSubagentSettings', async (request) => read(pool, request, getSubagents));
    route('putSubagentSettings', async (request) => putSubagents(clientOf(request), request.body as Parameters<typeof putSubagents>[1]));
  });
}
