import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, readdir, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWrite } from './files.ts';
import { Rejections, type RejectionOptions } from './rejections.ts';
import type { ApiRequest, ApiResponse, OperationId } from '../api/client.ts';
import { OPERATIONS } from '../api/generated/client.ts';

export const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;

export type ReportId = { [K in OperationId]: ApiRequest<K> extends { idempotencyKey: string } ? K : never }[OperationId];
export type Message = ApiResponse<'pollMessages'>['body']['messages'][number];
export interface Entry {
  id: string;
  operation: ReportId;
  request: { epoch: number; idempotencyKey: string; params?: Record<string, string>; body?: Record<string, unknown> };
  file?: { name: string; type: string };
  stream: string;
  state: 'pending' | 'rejected';
  attempts: number;
  nextAt: number;
  status?: number;
  code?: string;
  reason?: string;
  fix?: string;
  rejectedAt?: number;
}
export interface Document {
  version: 1;
  runnerId: string;
  epoch: number;
  pendingEpoch: number | null;
  cursor: string | null;
  inbox: Message[];
  /** 실패·중단된 시도에 전달한 Task 지시를 성공 보고까지 보존한다. */
  /** responded: 이 지시에 업무 응답을 이미 보냈다. 다음 시도에 다시 전달해도 응답은 한 번만 보낸다(M5-05 P3-3). */
  instructions?: { message: Message; attemptId: string; responded?: true }[];
  outbox: Entry[];
  epochStartedAt?: number;
}

export function validEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validate(value: Document): void {
  if (value?.version !== 1 || typeof value.runnerId !== 'string' || !value.runnerId || !validEpoch(value.epoch) ||
    (value.pendingEpoch !== null && !validEpoch(value.pendingEpoch)) || (value.cursor !== null && typeof value.cursor !== 'string') ||
    !Array.isArray(value.inbox) || !Array.isArray(value.outbox) || (value.epochStartedAt !== undefined && !Number.isFinite(value.epochStartedAt))) throw new Error('Runner 상태 파일 형식이 올바르지 않습니다.');
  const ids = new Set<string>();
  for (const e of value.outbox) {
    if (!e || typeof e.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(e.id) || ids.has(e.id) || !Object.hasOwn(OPERATIONS, e.operation) ||
      (OPERATIONS as Record<string, { method: string }>)[e.operation]?.method === 'GET' || e.operation === ('heartbeat' as OperationId) ||
      !validEpoch(e.request?.epoch) || typeof e.request.idempotencyKey !== 'string' || !e.request.idempotencyKey || typeof e.stream !== 'string' ||
      !['pending', 'rejected'].includes(e.state) || !Number.isSafeInteger(e.attempts) || e.attempts < 0 ||
      !Number.isFinite(e.nextAt) || (e.file && (e.file.name !== e.id || typeof e.file.type !== 'string'))) {
      throw new Error('보고 대기함 형식이 올바르지 않습니다. 원본 파일을 보존하세요.');
    }
    ids.add(e.id);
  }
  if (value.inbox.some((m) => !m || typeof m.id !== 'string')) throw new Error('수신함 형식이 올바르지 않습니다.');
  if (value.instructions !== undefined && (!Array.isArray(value.instructions) || value.instructions.some(i => !i || typeof i.attemptId !== 'string' || !i.attemptId ||
    (i.responded !== undefined && i.responded !== true) || !i.message || typeof i.message.id !== 'string' || typeof i.message.taskKey !== 'string' || !['Codex', 'Claude'].includes(i.message.toAgent) || typeof i.message.body !== 'string'))) throw new Error('보관한 Task 지시 형식이 올바르지 않습니다.');
}

export class StateLockError extends Error { override name = 'StateLockError'; }
export class StateStorageError extends Error { override name = 'StateStorageError'; }

export async function acquireLock(directory: string): Promise<FileHandle> {
  const lock = await open(join(directory, 'lock'), 'a+', 0o600);
  try {
    // 자식의 fd 3과 부모의 fd는 같은 열린 파일을 가리켜, 자식 종료 뒤에도 부모가 잠금을 보유한다.
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], { stdio: ['ignore', 'ignore', 'ignore', lock.fd] });
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code === 73) throw new StateLockError('다른 Runner가 이 데이터 폴더를 사용하고 있습니다.');
    if (code !== 0) throw new StateLockError('데이터 폴더 잠금을 얻지 못했습니다. flock 설치를 확인하세요.');
    await lock.chmod(0o600);
    return lock;
  } catch (error) { await lock.close(); throw error; }
}

export class State {
  private data: Document;
  private tail: Promise<void> = Promise.resolve();
  private readonly directory: string;
  private readonly lock: FileHandle;
  private closed = false;
  private failed = false;
  private archives!: Rejections;
  private readonly now: () => number;

  private constructor(home: string, data: Document, lock: FileHandle, now: () => number) {
    this.directory = join(home, 'state');
    this.data = data;
    this.lock = lock;
    this.now = now;
  }

  static async open(home: string, options: RejectionOptions = {}): Promise<State> {
    const now = options.now ?? Date.now;
    const directory = join(home, 'state');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = await acquireLock(directory);
    try {
      for (const folder of [directory, join(directory, 'evidence'), join(directory, 'rejected')]) {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await chmod(folder, 0o700);
        for (const name of await readdir(folder)) if (name.endsWith('.tmp')) await rm(join(folder, name), { force: true });
      }
      let data: Document = { version: 1, runnerId: randomUUID(), epoch: 0, pendingEpoch: null, cursor: null, inbox: [], outbox: [] };
      let existed = false;
      try { data = JSON.parse(await readFile(join(directory, 'runner.json'), 'utf8')) as Document; existed = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // 이전 형식도 파일을 만들기 전에 경로·식별자부터 검증한다.
      validate({ ...data, outbox: data.outbox.map((entry) => {
        const checked = { ...entry };
        if (typeof (checked.file as unknown as { base64?: unknown } | undefined)?.base64 === 'string') delete checked.file;
        return checked;
      }) });
      const before = structuredClone(data);
      data.epochStartedAt ??= now();
      const state = new State(home, data, lock, now);
      state.archives = await Rejections.open(join(directory, 'rejected'), () => ({ epoch: state.data.epoch, epochStartedAt: state.data.epochStartedAt ?? now() }),
        (entry) => { validate({ ...state.data, outbox: [entry] }); }, options);
      // 이전 버전의 인라인 증거와 거부 기록도 잃지 않고 새 저장 방식으로 옮긴다.
      for (const entry of data.outbox) {
        const legacy = entry.file as unknown as { base64?: string; type: string } | undefined;
        if (legacy?.base64 !== undefined) {
          if (Buffer.byteLength(legacy.base64, 'base64') > MAX_EVIDENCE_BYTES) {
            entry.state = 'rejected';
            entry.code = 'EVIDENCE_TOO_LARGE';
            entry.reason = '이전 증거가 50 MiB 상한을 초과했습니다. 나눈 파일로 다시 보고하세요.';
            delete entry.file;
            continue;
          }
          await atomicWrite(join(directory, 'evidence'), entry.id, Buffer.from(legacy.base64, 'base64'));
          entry.file = { name: entry.id, type: legacy.type };
        }
      }
      for (const entry of [...data.outbox]) if (entry.state === 'rejected' && !state.archives.hasSource(entry.id)) await state.reject(entry);
      data = state.data;
      data.outbox = data.outbox.filter((e) => !state.archives.hasSource(e.id));
      validate(data);
      if (!existed || !isDeepStrictEqual(before, data)) await atomicWrite(directory, 'runner.json', JSON.stringify(data));
      if (existed) await chmod(join(directory, 'runner.json'), 0o600);
      state.data = data;
      const referenced = new Set(data.outbox.flatMap((e) => e.file ? [e.file.name] : []));
      for (const name of await readdir(join(directory, 'evidence'))) if (!referenced.has(name)) await rm(join(directory, 'evidence', name), { force: true });
      return state;
    } catch (error) { await lock.close(); throw error; }
  }

  get snapshot(): Document { return structuredClone(this.data); }
  get rejected() { return this.archives.entries; }
  get rejectionStatus() { return this.archives.status; }
  get rejectionAlerts() { return this.archives.alerts; }
  findRejection(epoch: number, key: string) { return this.archives.find(epoch, key); }
  rejectedFor(attemptId: string) { return this.archives.forAttempt(this.data.epoch, attemptId); }
  blockedAttempts() { return this.archives.blocked(this.data.epoch); }
  readRejection(id: string) { return this.archives.read(id); }
  maintainRejections() { return this.archives.maintain(); }
  syncCommands(commands: { epoch: number; id: string }[]) { return this.archives.syncCommands(commands); }
  commandDelay(epoch: number, id: string, at: number) { return this.archives.commandDelay(epoch, id, at); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    await this.archives.close();
    await this.lock.close();
  }

  async saveEvidence(id: string, file: Blob): Promise<void> {
    if (this.closed || this.failed) throw new StateStorageError('상태 저장소가 닫혔습니다.');
    await atomicWrite(join(this.directory, 'evidence'), id, new Uint8Array(await file.arrayBuffer()));
  }
  async evidence(entry: Entry): Promise<Buffer> {
    if (!entry.file) throw new StateStorageError('증거 파일 참조가 없습니다.');
    return readFile(join(this.directory, 'evidence', entry.file.name));
  }
  async removeEvidence(entry: Entry): Promise<void> {
    if (entry.file) await rm(join(this.directory, 'evidence', entry.file.name), { force: true });
  }
  async reject(entry: Entry): Promise<void> {
    await this.archives.reject(entry);
    await this.update((draft) => { draft.outbox = draft.outbox.filter((e) => e.id !== entry.id); });
    await this.removeEvidence(entry);
  }

  update(change: (draft: Document) => void): Promise<void> {
    if (this.closed || this.failed) return Promise.reject(new StateStorageError('상태 저장소가 닫혔거나 저장에 실패했습니다. 다시 시작하세요.'));
    const operation = this.tail.then(async () => {
      const draft = structuredClone(this.data);
      change(draft);
      const epochChanged = draft.epoch !== this.data.epoch;
      if (epochChanged) draft.epochStartedAt = this.now();
      validate(draft);
      if (isDeepStrictEqual(draft, this.data)) return;
      try {
        await atomicWrite(this.directory, 'runner.json', JSON.stringify(draft));
        this.data = draft;
      } catch { this.failed = true; throw new StateStorageError('상태 파일 저장에 실패했습니다. 원본을 보존하고 다시 시작하세요.'); }
      if (epochChanged) await this.archives.maintain();
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async observeEpoch(epoch: number): Promise<void> {
    if (!validEpoch(epoch)) throw new Error('서버의 초기화 번호가 올바르지 않습니다.');
    let discarded: Entry[] = [];
    await this.update((draft) => {
      if (epoch === draft.epoch && draft.pendingEpoch === null) return;
      if (epoch < draft.epoch || (draft.pendingEpoch !== null && epoch < draft.pendingEpoch)) throw new Error('서버 초기화 번호가 뒤로 갔습니다.');
      if (draft.pendingEpoch === epoch) return;
      draft.pendingEpoch = epoch;
      discarded = draft.outbox;
      draft.outbox = [];
      draft.inbox = [];
      draft.instructions = [];
      draft.cursor = null;
    });
    for (const entry of discarded) await this.removeEvidence(entry);
  }

  async resetAfterMismatch(epoch: unknown): Promise<void> {
    let discarded: Entry[] = [];
    await this.update((draft) => {
      draft.pendingEpoch = Math.max(draft.epoch, draft.pendingEpoch ?? draft.epoch, validEpoch(epoch) ? epoch : draft.epoch);
      discarded = draft.outbox;
      draft.outbox = [];
      draft.inbox = [];
      draft.instructions = [];
      draft.cursor = null;
    });
    for (const entry of discarded) await this.removeEvidence(entry);
  }
}
