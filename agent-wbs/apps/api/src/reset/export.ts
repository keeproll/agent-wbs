import { createHash } from 'node:crypto';
import type { Pool } from '@awbs/db';
import { PlatformError } from '../platform/errors.ts';
import { redactText } from '../platform/redact.ts';
import { ProjectError } from '../project/errors.ts';
import { readStoredFile } from './files.ts';
import { zip } from './zip.ts';

const PRIVATE_TABLES = new Set(['mail_outbox', 'mail_log', 'notify_outbox', 'notify_log', 'notify_events', 'runner_jobs', 'runner_job_events', 'repo_checks']);
const privateField = /password|passwd|token|secret|cookie|authorization|credential|recipient|email|smtp|chat.?id|ciphertext|nonce|private.?key|api.?key/i;
function publicData(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return redactText(value).replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED]');
  if (Array.isArray(value)) return value.map(publicData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !privateField.test(key)).map(([key, item]) => [key, publicData(item)]));
  return value;
}

/**
 * 내보내기 전체 크기 상한(기본 1GiB, M2-04 리뷰 P3-2).
 * 왜: 지금 ZIP은 메모리에서 만들어 데이터의 약 2배를 쓰고, 그동안 DB 트랜잭션·세대 잠금을 잡는다.
 * 크기는 data.json·manifest.json과 파일을 모두 더한다. 상한을 넘으면 파일을 읽기 전에 이유(details.reason='export_too_large')와 크기를 알려 준다. 큰 자료가 생기면 스트리밍 ZIP64로 바꾼다.
 */
export const EXPORT_MAX_BYTES = 1024 ** 3;
const FAILURE_SAMPLE = 20;

export async function exportProject(pool: Pool, epoch: number, root: string, limit = EXPORT_MAX_BYTES) {
  // 파일을 읽는 동안에도 잠금을 유지한다. 초기화·파일 삭제와 섞인 반쪽짜리 내보내기를 막는다.
  const db = await pool.connect();
  try {
    await db.query('begin isolation level repeatable read');
    await db.query('select public.lock_epoch($1)', [epoch]);
    const project = (await db.query<{ id: string }>('select id from projects')).rows[0];
    if (!project) throw new ProjectError('PROJECT_NOT_FOUND');
    const tables: Record<string, unknown[]> = {};
    const names = (await db.query<{ table_name: string }>("select table_name from information_schema.columns where table_schema='public' and column_name='project_id' order by table_name")).rows;
    tables.projects = (await db.query('select * from projects')).rows;
    for (const { table_name: name } of names) if (!PRIVATE_TABLES.has(name)) tables[name] = (await db.query(`select * from ${db.escapeIdentifier(name)} where project_id=$1`, [project.id])).rows;
    const paths = (await db.query<{ path: string; kind: string; sha256: string; size: string | null }>(`select storage_path path,'evidence' kind,sha256,size::text from evidence where project_id=$1
      union all select path,'pdf',sha256,null from report_pdfs where project_id=$1 order by path`, [project.id])).rows;
    const files: { name: string; data: Buffer }[] = [], manifest: { path: string; kind: string; size: number; sha256: string }[] = [];
    // 크기를 아는 파일(Evidence)로 먼저 상한을 검사한다. 읽은 뒤 실제 크기로 한 번 더 본다(PDF는 크기 기록이 없음).
    // 표 데이터(data.json)도 상한에 넣는다(교차 리뷰 F4). 파일보다 먼저 만들어 크기를 안다.
    const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));
    const dataJson = json(publicData({ epoch, tables }));
    const known = dataJson.length + paths.reduce((sum, path) => sum + (path.size === null ? 0 : Number(path.size)), 0);
    if (known > limit) throw new PlatformError('UNAVAILABLE', { reason: 'export_too_large', totalBytes: known, limitBytes: limit });
    // 읽지 못한 파일은 모두 모아 어떤 파일이 왜 실패했는지 알려 준다(경로는 서버가 만든 `<epoch>/…/<uuid>` 형식).
    const failures: { path: string; reason: 'missing' | 'integrity' | 'unreadable' }[] = [];
    let total = dataJson.length;
    for (const path of paths) {
      if (files.some((file) => file.name === path.path)) continue;
      let data: Buffer;
      try { data = await readStoredFile(root, epoch, path.path); } catch (error) {
        failures.push({ path: path.path, reason: (error as { code?: string }).code === 'ENOENT' ? 'missing' : 'unreadable' });
        continue;
      }
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (sha256 !== path.sha256 || path.size !== null && data.length !== Number(path.size)) { failures.push({ path: path.path, reason: 'integrity' }); continue; }
      total += data.length;
      if (total > limit) throw new PlatformError('UNAVAILABLE', { reason: 'export_too_large', totalBytes: total, limitBytes: limit });
      files.push({ name: path.path, data }); manifest.push({ path: path.path, kind: path.kind, size: data.length, sha256 });
    }
    if (failures.length) throw new PlatformError('UNAVAILABLE', { reason: 'files_unreadable', failedCount: failures.length, failures: failures.slice(0, FAILURE_SAMPLE) });
    const manifestJson = json({ schemaVersion: 1, epoch, files: manifest });
    total += manifestJson.length;
    if (total > limit) throw new PlatformError('UNAVAILABLE', { reason: 'export_too_large', totalBytes: total, limitBytes: limit });
    try {
      const archive = zip([{ name: 'data.json', data: dataJson }, { name: 'manifest.json', data: manifestJson }, ...files]);
      await db.query('commit');
      return archive;
    } catch { throw new PlatformError('UNAVAILABLE', { reason: 'zip_limit' }); }
  } catch (error) {
    await db.query('rollback');
    // 반복 읽기 스냅샷이 초기화 직전 잡혔으면 PostgreSQL은 세대 검사 대신 직렬화 충돌을 낸다.
    if ((error as { code?: string }).code === '40001') {
      const currentEpoch = (await db.query<{ epoch: number }>('select epoch from system_state')).rows[0]?.epoch;
      throw new PlatformError(currentEpoch !== epoch ? 'EPOCH_MISMATCH' : 'UNAVAILABLE', { currentEpoch });
    }
    throw error;
  } finally { db.release(); }
}
