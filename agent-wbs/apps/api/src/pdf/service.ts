/**
 * 보고서 PDF 만들기·캐시(G§8.5 L944 「서버 렌더링, 생성 후 캐시」, data-model `report_pdfs`, architecture §6.1 데이터 파일).
 *
 * 순서:
 * 1. 읽기 트랜잭션에서 보고서 기록(스냅샷 포함)과 캐시 행을 읽는다. 지금의 프로젝트 이름 같은 현재 값은 읽지 않는다.
 *    왜: 보고서는 생성 시점 기록이다. PDF의 모든 값은 스냅샷에서 온다(프로젝트 이름도 스냅샷의 projectName).
 * 2. 스냅샷으로 HTML을 만들고 그 hash(앞 16자)를 캐시 키로 쓴다. 파일 이름에 키가 들어간다.
 *    캐시 행이 같은 키의 파일을 가리키고, 파일 지문(sha256)이 행과 같으면 그 파일을 준다.
 *    키가 다르거나(서식이 바뀜), 지문이 다르거나, 파일이 없으면 다시 만든다. 왜: 다른 문서나 바뀐 파일을 내보내지 않는다.
 * 3. 다시 만들 때 Chromium으로 변환한다. **이때는 DB 잠금을 잡지 않는다.**
 *    왜: 변환은 몇 초 걸린다. 그동안 세대 잠금을 잡고 있으면 프로젝트 초기화가 그만큼 기다린다.
 * 4. 세대 잠금(inEpoch) 안에서 파일을 쓰고 `report_pdfs` 행을 남긴다.
 *    - 변환하는 사이에 초기화됐으면 세대가 달라 잠금이 실패한다(AW001). 그러면 아무것도 저장하지 않고 404를 준다.
 *      초기화로 보고서가 지워졌기 때문이다. 옛 세대의 PDF가 새 프로젝트 폴더에 섞이지 않는다.
 *    - 파일은 `<세대>/pdf/<보고서 id>-<보기>-<문서 hash 16자>.pdf`에 쓴다. 세대별 폴더는 초기화 뒤 파일 삭제 작업이 폴더째 지운다(reset/files.ts).
 *    - 키가 바뀌어 새로 만들었으면, 행이 가리키던 옛 파일은 지운다.
 *
 * 같은 보고서·보기를 동시에 여러 번 요청해도 변환은 한 번만 한다(같은 프로세스 안에서 진행 중인 변환을 함께 기다린다).
 * 스냅샷은 바뀌지 않으므로(G L373) 서식이 바뀌지 않는 한 한 번 만든 PDF를 계속 쓴다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from '@awbs/db';
import type { ReportKind, ReportSnapshotData } from '@awbs/shared';
import { ApiError, invalid } from '../changes/http.ts';
import { inEpoch } from '../platform/transaction.ts';
import { readStoredFile } from '../reset/files.ts';
import { externalPdfLeaks, reportHtml } from './html.ts';
import { pdfName, type ReportView } from './model.ts';
import type { PdfRenderer } from './render.ts';

export interface ReportPdf { file: Buffer; name: string; reportKey: string }

/** G L49: PDF 생성 실패 → 「다시 시도 / 기간을 나눠 생성」 */
const FAILED_FIX = '잠시 후 다시 시도하세요. 계속 실패하면 기간을 나눠 보고서를 생성하세요.';
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const notFound = (reportId: string) => new ApiError('NOT_FOUND', { reportId }, [], '보고서를 찾을 수 없습니다.');

interface Row {
  reportKey: string; kind: ReportKind; from: string; to: string; generatedAt: string; dueAt: string | null; reason: string | null;
  snapshot: ReportSnapshotData; projectId: string; path: string | null; sha256: string | null;
}
const iso = (column: string) => `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function load(pool: Pool, reportId: string, view: ReportView): Promise<Row | undefined> {
  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const row = (await client.query<Row>(
      `select r.report_key "reportKey",r.kind,to_char(r."from",'YYYY-MM-DD') "from",to_char(r."to",'YYYY-MM-DD') "to",${iso('r.generated_at')} "generatedAt",
         ${iso('r.due_at')} "dueAt",r.reason,r.snapshot,r.project_id "projectId",c.path,c.sha256
       from reports r left join report_pdfs c on c.report=r.id and c.view=$2 where r.id=$1`, [reportId, view])).rows[0];
    await client.query('commit');
    return row;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** 캐시 파일 경로. 문서 hash가 이름에 들어 있어, 문서가 달라지면 경로도 달라진다. */
const pathOf = (epoch: number, reportId: string, view: ReportView, key: string) => `${String(epoch)}/pdf/${reportId}-${view}-${key}.pdf`;

async function cached(root: string, epoch: number, row: Row, path: string): Promise<Buffer | null> {
  // 행이 다른 문서(예: 서식이 바뀌기 전)의 파일을 가리키면 쓰지 않는다.
  if (row.path !== path || !row.sha256) return null;
  try {
    const file = await readStoredFile(root, epoch, row.path);
    return sha256(file) === row.sha256 ? file : null;
  } catch { return null; }
}

/** 임시 파일에 다 쓴 뒤 이름을 바꾼다. 왜: 쓰다 멈춘 반쪽 파일이 캐시 이름으로 남지 않게 한다. */
async function writeAtomic(path: string, data: Buffer) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, path); } catch (error) { await rm(temp, { force: true }); throw error; }
}

/**
 * 세대 잠금 안에서 부른다. 보고서는 수정·삭제가 없고(G§9.6-1) 초기화로만 없어진다.
 * 초기화는 세대를 바꾸므로, 잠금이 성공했다면 보고서는 아직 있다. 그래서 따로 존재 확인을 하지 않는다.
 */
async function save(client: PoolClient, root: string, epoch: number, reportId: string, row: Row, view: ReportView, relative: string, file: Buffer) {
  await mkdir(join(root, String(epoch), 'pdf'), { recursive: true, mode: 0o700 });
  await writeAtomic(join(root, relative), file);
  await client.query(`insert into report_pdfs(project_id,report,view,path,sha256) values($1,$2,$3,$4,$5)
    on conflict (report,view) do update set path=excluded.path,sha256=excluded.sha256,updated_at=now()`, [row.projectId, reportId, view, relative, sha256(file)]);
  // 같은 세대 폴더 안의, 이 파일이 만든 이름 모양인 옛 키 파일만 지운다. DB 값도 믿지 않는다(`..` 같은 경로를 따라가지 않음).
  // 다른 세대 파일은 초기화 정리가 맡는다.
  const old = row.path;
  if (old && old !== relative && new RegExp(`^${String(epoch)}/pdf/${reportId}-(int|ext)-[0-9a-f]{16}\\.pdf$`).test(old)) await rm(join(root, old), { force: true });
}

const running = new Map<string, Promise<ReportPdf>>();

/**
 * 보고서 PDF를 돌려준다(없으면 만들어 캐시한다). 팀장 다운로드(GET /api/reports/:id/pdf)와 메일 첨부(M6-03)가 함께 쓴다.
 * - epoch: 요청을 받은 시점의 세대 번호. 파일 폴더와 저장 잠금이 이 번호를 쓴다.
 * - 일간 보고서는 팀장용만 있다(P canToggle L6416). 일간 보고용은 400.
 */
export async function reportPdf(pool: Pool, root: string, renderer: PdfRenderer, epoch: number, reportId: string, view: ReportView,
  onFailure?: (error: unknown) => void, options: { external?: boolean } = {}): Promise<ReportPdf> {
  if (options.external) return externalPdf(pool, renderer, reportId, onFailure);
  const key = `${String(epoch)}:${reportId}:${view}`;
  const current = running.get(key);
  if (current) return current;
  const job = (async () => {
    const row = await load(pool, reportId, view);
    if (!row) throw notFound(reportId);
    if (row.kind === 'daily' && view === 'ext') throw invalid([{ path: 'view', rule: 'enum', message: '일간 보고서는 팀장용만 있습니다.' }], '일간 보고서는 팀장용만 있습니다.');
    const result = (file: Buffer): ReportPdf => ({ file, name: pdfName(row.reportKey, view), reportKey: row.reportKey });
    // PDF에 들어가는 값은 보고서 기록과 스냅샷뿐이다(프로젝트 이름도 스냅샷 값). 그 문서의 hash가 캐시 키다.
    // 팀장 다운로드 · 내부 수신자용. 외부 변환을 하지 않는다(Q-13 fix4). 외부 수신자용은 externalPdf.
    const html = reportHtml({ ...row, view });
    const path = pathOf(epoch, reportId, view, sha256(Buffer.from(html)).slice(0, 16));
    const hit = await cached(root, epoch, row, path);
    if (hit) return result(hit);
    let file: Buffer;
    try {
      file = await renderer.render(html);
    } catch (error) {
      // 원인(브라우저 오류 문구)은 응답에 싣지 않고 서버 기록에만 남긴다. 왜: 내부 경로 같은 정보가 화면에 나가지 않게 한다.
      onFailure?.(error);
      throw new ApiError('PDF_FAILED', { reportId }, [], 'PDF를 만들지 못했습니다. 화면의 보고서는 계속 볼 수 있습니다.', FAILED_FIX);
    }
    try {
      await inEpoch(pool, epoch, (client) => save(client, root, epoch, reportId, row, view, path, file));
    } catch (error) {
      if ((error as { code?: string }).code === 'AW001') throw notFound(reportId);
      throw error;
    }
    return result(file);
  })();
  running.set(key, job);
  try { return await job; } finally { running.delete(key); }
}

/**
 * 외부 수신자에게 붙일 보고용 PDF(Q-13 fix4). 보고용 글이 외부 변환(externalText)을 지나고, 만들기 직전에 보이는 글 전체를 검사한다.
 * - 캐시에 저장하지 않는다. 왜: 팀장 다운로드 · 내부 수신자용 보고용 PDF와 내용이 다르다. 같은 캐시 줄(report, view)을 덮어쓰지 않게 한다.
 * - 검사에 걸리면 만들지 않는다. 변환 함수가 이미 걸렀어야 하므로 코드 결함이다(메일은 보내기 전 실패 → 15분 재시도).
 */
async function externalPdf(pool: Pool, renderer: PdfRenderer, reportId: string, onFailure?: (error: unknown) => void): Promise<ReportPdf> {
  const row = await load(pool, reportId, 'ext');
  if (!row) throw notFound(reportId);
  if (row.kind === 'daily') throw invalid([{ path: 'view', rule: 'enum', message: '일간 보고서는 팀장용만 있습니다.' }], '일간 보고서는 팀장용만 있습니다.');
  const html = reportHtml({ ...row, view: 'ext', external: true });
  const leaks = externalPdfLeaks(html);
  if (leaks.length) {
    onFailure?.(new Error(`외부 보고용 PDF 검사 실패: ${String(leaks.length)}건`));
    throw new ApiError('PDF_FAILED', { reportId }, [], '보고용 PDF에 주소 · 내부 용어가 남아 만들지 않았습니다.', FAILED_FIX);
  }
  try {
    return { file: await renderer.render(html), name: pdfName(row.reportKey, 'ext'), reportKey: row.reportKey };
  } catch (error) {
    onFailure?.(error);
    throw new ApiError('PDF_FAILED', { reportId }, [], 'PDF를 만들지 못했습니다. 화면의 보고서는 계속 볼 수 있습니다.', FAILED_FIX);
  }
}
