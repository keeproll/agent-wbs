import type { Pool } from '@awbs/db';
import type { FastifyInstance } from 'fastify';
import { clientOf, routes, read, ApiError, params, isUuid } from '../changes/http.ts';
import { deferChange } from '../changes/events.ts';
import { enqueueJob, systemState } from '../project/db.ts';
import { githubSettings } from '../project/github.ts';
import { agentUsage, splitViolations } from './read.ts';
import { getSplit, putSplit, getSchedule, putSchedule, getBlackouts, putBlackouts, getConcurrency, putConcurrency, getBudget, putBudget, putGithub } from './service.ts';

export function registerSettingsRoutes(app: FastifyInstance, pool: Pool) {
  routes(app, '설정', route => {
    route('getSplitSettings', r => read(pool, r, getSplit));
    route('putSplitSettings', r => putSplit(clientOf(r), r.body as Parameters<typeof putSplit>[1]));
    route('getScheduleSettings', r => read(pool, r, getSchedule));
    route('putScheduleSettings', r => putSchedule(clientOf(r), r.body as Parameters<typeof putSchedule>[1]));
    route('getBlackouts', r => read(pool, r, getBlackouts));
    route('putBlackouts', r => putBlackouts(clientOf(r), r.body as Parameters<typeof putBlackouts>[1]));
    route('getConcurrency', r => read(pool, r, getConcurrency));
    route('putConcurrency', r => putConcurrency(clientOf(r), r.body as Parameters<typeof putConcurrency>[1]));
    route('getObsBudget', r => read(pool, r, getBudget));
    route('putObsBudget', r => putBudget(clientOf(r), r.body as Parameters<typeof putBudget>[1]));
    route('putGithubSettings', r => putGithub(clientOf(r), r.body as Parameters<typeof putGithub>[1]));
    route('checkGithub', async (r, reply) => {
      const client = clientOf(r);
      const { epoch } = await systemState(client);
      const { mode } = await githubSettings(client);
      const jobId = await enqueueJob(client, { projectId: null, kind: 'github_check', payload: { mode }, epoch, dedupKey: `github-check:${r.id}:${crypto.randomUUID()}` });
      return reply.code(202).send({ jobId });
    });
    route('getSplitViolations', r => read(pool, r, splitViolations));
    route('getAgentUsage', r => read(pool, r, agentUsage));
    route('ackAlert', async (r, reply) => {
      const client = clientOf(r);
      const { id } = r.params as { id: string };
      if (!isUuid(id)) throw new ApiError('NOT_FOUND');
      const alert = (await client.query<{ project_id: string | null; acknowledged_at: Date | null }>('select project_id,acknowledged_at from alerts where id=$1 for update', [id])).rows[0];
      if (!alert) throw new ApiError('NOT_FOUND');
      if (!alert.acknowledged_at) {
        await client.query('update alerts set acknowledged_at=clock_timestamp() where id=$1', [id]);
        deferChange(client, alert.project_id, 'alert', { id });
      }
      return reply.code(204).send();
    }, params({ id: { type: 'string', minLength: 1 } }));
    route('checkReadiness', async (r, reply) => {
      const client = clientOf(r);
      const row = (await client.query<{ readinessCheckRequest: number }>('update app_settings set readiness_check_request=readiness_check_request+1 where singleton returning readiness_check_request "readinessCheckRequest"')).rows[0];
      deferChange(client, null, 'runner', { key: 'readiness' });
      return reply.code(202).send(row);
    });
  });
}
