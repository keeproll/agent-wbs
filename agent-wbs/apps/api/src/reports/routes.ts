import type { Pool } from '@awbs/db';
import type { ReportKind } from '@awbs/shared';
import type { FastifyInstance } from 'fastify';
import { clientOf, params, read, routes } from '../changes/http.ts';
import { createCustomReport, getReport, listReports } from './service.ts';

const UUID = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const PROJECT = params({ projectId: UUID });
const REPORT = params({ reportId: UUID });

/**
 * 보고서 API(G§8.5, contracts §2.3). 팀장 세션.
 * PDF(`GET /api/reports/:reportId/pdf`)는 M6-02가 붙인다. 메일(미리보기·발송)은 M6-03이다.
 * 수정·삭제 경로는 만들지 않는다(G§9.6-1).
 */
export function registerReportRoutes(app: FastifyInstance, pool: Pool): void {
  routes(app, '보고서 처리', (route) => {
    route('listReports', async (request) => {
      const { projectId } = request.params as { projectId: string };
      const query = request.query as { kind?: ReportKind; limit?: number; cursor?: string };
      return read(pool, request, (client) => listReports(client, projectId, query));
    }, PROJECT);
    route('createReport', async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const anchor = request.platform?.reportAnchor;
      if (!anchor) throw new Error('보고서 기준점이 없습니다(공통 관문 설정 확인).');
      return reply.code(201).send(await createCustomReport(clientOf(request), projectId, request.body as { from: string; to: string; view: 'int' | 'ext' }, anchor));
    }, PROJECT);
    route('getReport', async (request) => {
      const { reportId } = request.params as { reportId: string };
      return read(pool, request, (client) => getReport(client, reportId));
    }, REPORT);
  });
}
