import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { PoolClient } from '@awbs/db';
import { PlatformError } from '../platform/errors.ts';
import { RunnerRepository } from '../runner/repository.ts';
import { checkedJob } from '../runner/service.ts';
import { record } from '../tasks/history.ts';
import { deferChange } from '../changes/events.ts';

export async function multipartBody(contentType: string, buffer: Buffer): Promise<Record<string, unknown>> {
  try {
    const form = await new Response(new Uint8Array(buffer),{ headers:{ 'content-type':contentType } }).formData();
    const body: Record<string, unknown> = {};
    for (const [key,value] of form) {
      if (Object.hasOwn(body,key)) throw new Error('중복 항목');
      body[key] = typeof value === 'string' ? value : Buffer.from(await value.arrayBuffer());
    }
    if (!Buffer.isBuffer(body.file)) throw new Error('파일 누락');
    for (const key of ['size','fence']) {
      const value = body[key];
      if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('숫자 형식');
      body[key] = Number(value);
    }
    return body;
  } catch { throw new PlatformError('VALIDATION_FAILED'); }
}

export function checkEvidence(file: unknown, sha256: string, size: number): asserts file is Buffer {
  if (!Buffer.isBuffer(file) || file.length !== size || createHash('sha256').update(file).digest('hex') !== sha256) throw new PlatformError('VALIDATION_FAILED', { reasons:['파일 크기와 SHA-256 지문이 일치해야 합니다.'] });
}

export async function uploadEvidence(client: PoolClient, attemptId: string, principal: string, epoch: number, root: string,
  body: { file: unknown; kind: string; sha256: string; size: number; fence: number }, created: string[]) {
  checkEvidence(body.file,body.sha256,body.size);
  const repo = new RunnerRepository(client);
  await repo.lock();
  const a = await repo.attempt(attemptId);
  if (!a) throw new PlatformError('ATTEMPT_NOT_FOUND');
  await checkedJob(repo,a.job,body.fence,principal);
  if (a.status !== 'running') throw new PlatformError('ATTEMPT_CLOSED');
  const id = randomUUID(), relative = `${epoch}/evidence/${id}`;
  const folder = join(root,String(epoch),'evidence');
  await mkdir(folder,{ recursive:true,mode:0o700 });
  const path = join(root,relative);
  // shortcut: 강제 종료 직전 DB가 롤백되면 파일 하나가 남을 수 있다. epoch 초기화가 폴더째 정리하며 대용량 운영 때 정리 worker를 추가한다.
  const handle = await open(path,'wx',0o600);
  created.push(path);
  try { await handle.writeFile(body.file); await handle.sync(); } finally { await handle.close(); }
  await client.query('insert into evidence(id,project_id,task,attempt,kind,storage_path,sha256,size) values($1,$2,$3,$4,$5,$6,$7,$8)', [id,a.project_id,a.task,a.id,body.kind,relative,body.sha256,body.size]);
  return { id };
}

export async function evidenceContent(root: string, relative: string) {
  if (!/^\d+\/evidence\/[0-9a-f-]{36}$/.test(relative)) throw new PlatformError('NOT_FOUND');
  try {
    const base = await realpath(root), path = await realpath(join(root,relative));
    if (!path.startsWith(resolve(base)+sep)) throw new PlatformError('NOT_FOUND');
    const handle = await open(join(root,relative),constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return await handle.readFile(); } finally { await handle.close(); }
  } catch (error) {
    if (['ENOENT','ELOOP','ENOTDIR'].includes((error as { code?: string }).code ?? '')) throw new PlatformError('NOT_FOUND');
    throw error;
  }
}

export async function removeUploads(paths: readonly string[]) { await Promise.all(paths.map(path => rm(path,{ force:true }))); }

/** P6246–6252: 기존 검증에 참조만 덧붙인다. 사용자가 준 경로로 서버 파일을 열거나 외부 주소에 접속하지 않는다. */
export async function addEvidenceReference(client: PoolClient, verificationId: string, value: string) {
  const path = value.trim();
  const url = URL.parse(path);
  const invalid = !path || [...path].some((char) => char.charCodeAt(0) < 32 || char === '\\') || (url
    ? !/^https?:\/\//.test(path) || !url.hostname || !!url.username || !!url.password
    : path.startsWith('/') || path.includes('//') || path.split('/').some((part) => part === '.' || part === '..'));
  if (invalid) throw new PlatformError('VALIDATION_FAILED', { reasons: ['저장소 상대 경로나 HTTP(S) 링크를 입력하세요.'] });
  const row = (await client.query<{ project_id: string; task: string; task_key: string; attempt: string }>(`select v.project_id,a.task,t.task_key,v.attempt from verifications v
    join task_attempts a on a.id=v.attempt join tasks t on t.id=a.task where v.id::text=$1 and t.deleted_at is null for update of t`, [verificationId])).rows[0];
  if (!row) throw new PlatformError('NOT_FOUND');
  const id = (await client.query<{ id: string }>(`insert into evidence(project_id,task,attempt,verification,kind,reference_path)
    values($1,$2,$3,$4,'reference',$5) on conflict(verification,reference_path) do nothing returning id`, [row.project_id, row.task, row.attempt, verificationId, path])).rows[0]?.id;
  if (!id) throw new PlatformError('VALIDATION_FAILED', { reasons: ['이미 연결된 Evidence 경로입니다.'] });
  await record(client, { projectId: row.project_id, taskId: row.task, kind: 'Evidence', text: '검증에 Evidence 경로를 추가했습니다.',
    after: path, ref: { verificationId, evidenceId: id } });
  await client.query('update tasks set updated_at=clock_timestamp() where id=$1', [row.task]);
  deferChange(client, row.project_id, 'verification', { id: verificationId });
  deferChange(client, row.project_id, 'task', { taskKey: row.task_key });
  return { id, taskKey: row.task_key, attemptId: row.attempt, verificationId, checklistItemKey: null, kind: 'reference', path, sha256: null, size: null };
}
