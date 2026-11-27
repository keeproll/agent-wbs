/**
 * 메일 화면 E2E(M6-03)의 보조 프로세스: 가짜 SMTP + 조작용 HTTP + 보고서 생성 + 메일 worker 반복.
 * `apps/web/scripts/e2e-api-mail.ts`가 띄우고 끝나면 끈다. 실제 메일 서버에는 연결하지 않는다.
 *
 * 환경 변수: DATABASE_URL(앱 역할로 접속), SMTP_PORT_FILE(가짜 SMTP 포트·조작 포트를 적을 파일)
 * - 시작하면 정기 보고서를 원본 기간(2026-11-04 07:00 서울 기준)으로 만든다(보고서 화면·테스트 발송에 쓸 최신 보고서).
 * - 0.5초마다 메일 worker를 두 번 돌린다. 한 번은 지금 시각, 한 번은 「지금 + 16분」으로 판정한다.
 *   왜: 15분 뒤 자동 재시도를 화면 시험에서 기다리지 않고 바로 확인하기 위해서다(재시도 규칙 자체는 mail 시나리오가 시각을 정해 검증한다).
 * - 조작: `POST /mode/<accept|auth_fail|…>` → 가짜 SMTP 응답 방식을 바꾼다. `GET /messages` → 받은 메일 수 · 받는 사람 · 링크 수 · PDF 첨부 여부.
 * - PDF 첨부는 가짜 PDF다(Q-13 외부 수신자 시험용). 실제 PDF 변환은 mail 시나리오가 확인한다.
 */
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createPool } from '../../packages/db/src/index.ts';
import { generateDueReports } from '../../apps/api/src/reports/service.ts';
import { deliverMail } from '../../apps/api/src/mail/deliver.ts';
import { FakeSmtp, mimePart, type SmtpMode } from './smtp.ts';

const url = process.env.DATABASE_URL;
const portFile = process.env.SMTP_PORT_FILE;
if (!url || !portFile) throw new Error('DATABASE_URL, SMTP_PORT_FILE가 필요합니다.');
const appUrl = new URL(url);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { onError: () => undefined });
const smtp = new FakeSmtp();
const smtpPort = await smtp.start();
const control = createServer((req, res) => {
  const mode = /^\/mode\/([a-z_]+)$/.exec(req.url ?? '')?.[1];
  if (req.method === 'POST' && mode) { smtp.mode = mode as SmtpMode; res.end('ok'); return; }
  if (req.url === '/messages') {
    res.setHeader('content-type', 'application/json');
    // links: HTML · 글자 본문의 링크 · 앱 주소 수(외부 수신자는 0이어야 한다). pdf: PDF 첨부가 있는지.
    const links = (raw: string) => [mimePart(raw, 'text/html') ?? '', mimePart(raw, 'text/plain') ?? ''].join('\n').match(/href=|https?:\/\//g)?.length ?? 0;
    res.end(JSON.stringify({ count: smtp.messages.length, to: smtp.messages.map((m) => m.to),
      items: smtp.messages.map((m) => ({ to: m.to, links: links(m.raw), pdf: /content-type:\s*application\/pdf/i.test(m.raw) })) }));
    return;
  }
  res.statusCode = 404; res.end();
});
await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
const address = control.address();
const controlPort = typeof address === 'object' && address ? address.port : 0;

await generateDueReports(pool, 1, { now: new Date('2026-11-04T07:00:00+09:00').toISOString(), startup: true });
writeFileSync(portFile, JSON.stringify({ smtpPort, controlPort, user: smtp.user, password: smtp.password }));

const FAKE_PDF = () => Promise.resolve(Buffer.from('%PDF-1.4 e2e fake'));
let stopping = false;
const loop = async () => {
  while (!stopping) {
    const epoch = (await pool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch ?? 1;
    await deliverMail(pool, epoch, { now: new Date().toISOString(), timeoutMs: 1500, pdf: FAKE_PDF }).catch(() => undefined);
    await deliverMail(pool, epoch, { now: new Date(Date.now() + 16 * 60_000).toISOString(), timeoutMs: 1500, pdf: FAKE_PDF }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
  }
};
const running = loop();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  stopping = true;
  void running.finally(async () => { control.close(); await smtp.stop(); await pool.end(); });
});
