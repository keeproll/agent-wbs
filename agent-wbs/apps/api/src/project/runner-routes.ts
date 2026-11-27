import type { Pool } from '@awbs/db';
import type { FastifyInstance } from 'fastify';
import type { DraftInput } from './draft.ts';
import { installProjectErrors } from './errors.ts';
import { actionOf, routeOf, type Ctx } from './routes.ts';
import { reportInputChanges, reportProgress, reportRepoCheck, submitDraft, submitTechProposals } from './service.ts';
import type { StepStatus } from './steps.ts';
import { inputErrors, OPERATIONS } from '@awbs/shared/api';
import { ProjectError } from './errors.ts';
import { resolveMovedBaselines } from '../ci/decisions.ts';
import { RunnerRepository } from '../runner/repository.ts';
import { enqueueIntegration } from '../execution/gate.ts';
import { reportGithubStatus, type GithubReport } from './github.ts';

const body = <T>(ctx: Ctx) => ctx.request.body as T;
const param = (ctx: Ctx, name: string) => (ctx.request.params as Record<string, string>)[name] ?? '';

/**
 * 프로젝트 흐름의 Runner·Planning 보고(G§8.4, contracts §3.1·§3.3).
 * M2-05(installRunner)와 같은 방식으로 buildApp 밖에서 설치한다. buildApp에 넣으면 보안 테스트가
 * 모든 Runner 경로에 붙이는 시험용 처리기와 경로가 겹치기 때문이다.
 */
export function installProjectRunner(app: FastifyInstance, pool: Pool): void {
  void app.register(async (scope) => {
    installProjectErrors(scope, actionOf);
    routeOf(scope, pool, 'reportGithubStatus', async (ctx) => {
      const op = OPERATIONS.find((item) => item.id === 'reportGithubStatus');
      const errors = op ? inputErrors(op, ctx.request.body) : [];
      if (errors.length) throw new ProjectError('VALIDATION_FAILED', { errors });
      await reportGithubStatus(ctx.client, body<GithubReport>(ctx), ctx.principal);
    }, 204);
    routeOf(scope, pool, 'reportRepoCheck', (ctx) => reportRepoCheck(ctx.client, param(ctx, 'id'), body(ctx), ctx.principal), 204);
    routeOf(scope, pool, 'reportInputChanges', async (ctx) => {
      const repo = new RunnerRepository(ctx.client); await repo.lock();
      const result = await reportInputChanges(ctx.client,body(ctx));
      if (!result.historyRewritten) {
        const project = (await ctx.client.query<{ id: string }>('select id from projects')).rows[0];
        if (project) {
          for (const task of (await ctx.client.query<{ id: string }>("select id from tasks where project_id=$1 and status='gate' and deleted_at is null order by id",[project.id])).rows) {
            await enqueueIntegration(ctx.client,task.id,ctx.epoch,{ baseSha:result.head,baselineOnly:true });
          }
          await resolveMovedBaselines(ctx.client,project.id);
        }
      }
      return result;
    });
    routeOf(scope, pool, 'reportBootstrapProgress', (ctx) =>
      reportProgress(ctx.client, param(ctx, 'jobId'), body<{ fence: number; stepKey: string; status: StepStatus; note?: string }>(ctx), ctx.principal), 204);
    routeOf(scope, pool, 'submitDraft', (ctx) => submitDraft(ctx.client, param(ctx, 'jobId'), body<DraftInput & { fence: number }>(ctx), ctx.principal), 201);
    routeOf(scope, pool, 'submitTechProposals', (ctx) => submitTechProposals(ctx.client, param(ctx, 'jobId'), body(ctx), ctx.principal), 201);
  });
}
