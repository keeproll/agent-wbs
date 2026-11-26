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

export async function exportProject(pool: Pool, epoch: number, root: string) {
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
    try {
      for (const path of paths) {
        if (files.some((file) => file.name === path.path)) continue;
        const data = await readStoredFile(root, epoch, path.path);
        const sha256 = createHash('sha256').update(data).digest('hex');
        if (sha256 !== path.sha256 || path.size !== null && data.length !== Number(path.size)) throw new Error('파일 무결성 불일치');
        files.push({ name: path.path, data }); manifest.push({ path: path.path, kind: path.kind, size: data.length, sha256 });
      }
      const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));
      const archive = zip([{ name: 'data.json', data: json(publicData({ epoch, tables })) },
        { name: 'manifest.json', data: json({ schemaVersion: 1, epoch, files: manifest }) }, ...files]);
      await db.query('commit');
      return archive;
    } catch { throw new PlatformError('UNAVAILABLE'); }
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
