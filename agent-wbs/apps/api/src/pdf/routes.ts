import type { Pool } from '@awbs/db';
import type { FastifyInstance } from 'fastify';
import { params, routes } from '../changes/http.ts';
import { chromiumRenderer, type PdfRenderer } from './render.ts';
import { reportPdf } from './service.ts';
import type { ReportView } from './model.ts';

export interface PdfOptions {
  /** HTML → PDF 변환기. 기본은 Playwright Chromium. 시험은 이것을 감싸 호출 횟수를 세거나 실패시킨다. */
  renderer?: PdfRenderer;
}

const REPORT = params({ reportId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } });

/**
 * GET /api/reports/:reportId/pdf?view=int|ext(G§8.5 L944, contracts §2.3). 팀장 세션.
 * 파일 이름은 G L410 예시(`RPT-W-261027_보고용.pdf`)다. 한글 이름은 `filename*`(RFC 5987: 글자 인코딩을 적는 방식)로 보내고,
 * 한글을 못 읽는 프로그램을 위해 `filename`에는 보고서 번호만 적는다.
 */
export function registerReportPdfRoutes(app: FastifyInstance, pool: Pool, root: string, options: PdfOptions = {}): void {
  const renderer = options.renderer ?? chromiumRenderer();
  app.addHook('onClose', async () => { await renderer.close(); });
  routes(app, '보고서 PDF 다운로드', (route) => {
    route('getReportPdf', async (request, reply) => {
      const { reportId } = request.params as { reportId: string };
      const { view } = request.query as { view: ReportView };
      const pdf = await reportPdf(pool, root, renderer, request.platform?.epoch ?? 0, reportId, view, (error) => {
        request.log.error({ err: error, reportId, view }, '보고서 PDF 변환 실패');
      });
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="${pdf.reportKey}.pdf"; filename*=UTF-8''${encodeURIComponent(pdf.name)}`)
        .header('cache-control', 'private, no-store')
        .send(pdf.file);
    }, REPORT);
  });
}
