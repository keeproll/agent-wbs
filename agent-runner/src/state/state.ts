import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiRequest, ApiResponse, OperationId } from '../api/client.ts';
import { OPERATIONS } from '../api/generated/client.ts';

export type ReportId = { [K in OperationId]: ApiRequest<K> extends { idempotencyKey: string } ? K : never }[OperationId];
export type Message = ApiResponse<'pollMessages'>['body']['messages'][number];
export interface Entry {
  id: string;
  operation: ReportId;
  request: { epoch: number; idempotencyKey: string; params?: Record<string, string>; body?: Record<string, unknown> };
  file?: { base64: string; type: string };
  stream: string;
  state: 'pending' | 'rejected';
  attempts: number;
  nextAt: number;
  status?: number;
  code?: string;
}
export interface Document {
  version: 1;
  runnerId: string;
  epoch: number;
  pendingEpoch: number | null;
  cursor: string | null;
  inbox: Message[];
  outbox: Entry[];
}

export function validEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validate(value: Document): void {
  if (value?.version !== 1 || typeof value.runnerId !== 'string' || !value.runnerId || !validEpoch(value.epoch) ||
    (value.pendingEpoch !== null && !validEpoch(value.pendingEpoch)) || (value.cursor !== null && typeof value.cursor !== 'string') ||
    !Array.isArray(value.inbox) || !Array.isArray(value.outbox)) throw new Error('Runner 상태 파일 형식이 올바르지 않습니다.');
  const ids = new Set<string>();
  for (const e of value.outbox) {
    if (!e || typeof e.id !== 'string' || ids.has(e.id) || !Object.hasOwn(OPERATIONS, e.operation) ||
      (OPERATIONS as Record<string, { method: string }>)[e.operation]?.method === 'GET' || e.operation === ('heartbeat' as OperationId) ||
      !validEpoch(e.request?.epoch) || typeof e.request.idempotencyKey !== 'string' || !e.request.idempotencyKey || typeof e.stream !== 'string' ||
      !['pending', 'rejected'].includes(e.state) || !Number.isSafeInteger(e.attempts) || e.attempts < 0 ||
      !Number.isFinite(e.nextAt) || (e.file && (typeof e.file.base64 !== 'string' || typeof e.file.type !== 'string'))) {
      throw new Error('보고 대기함 형식이 올바르지 않습니다. 원본 파일을 보존하세요.');
    }
    ids.add(e.id);
  }
  if (value.inbox.some((m) => !m || typeof m.id !== 'string')) throw new Error('수신함 형식이 올바르지 않습니다.');
}

/** shortcut: 한 데이터 폴더는 Runner 프로세스 하나만 쓴다. 다중 프로세스를 지원할 때 OS 잠금을 추가한다. */
export class State {
  private data: Document;
  private tail: Promise<void> = Promise.resolve();
  private readonly directory: string;

  private constructor(home: string, data: Document) {
    this.directory = join(home, 'state');
    this.data = data;
  }

  static async open(home: string): Promise<State> {
    const path = join(home, 'state/runner.json');
    let data: Document;
    try { data = JSON.parse(await readFile(path, 'utf8')) as Document; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const state = new State(home, { version: 1, runnerId: randomUUID(), epoch: 0, pendingEpoch: null, cursor: null, inbox: [], outbox: [] });
      await state.update(() => undefined);
      return state;
    }
    validate(data);
    return new State(home, data);
  }

  get snapshot(): Document { return structuredClone(this.data); }

  update(change: (draft: Document) => void): Promise<void> {
    const operation = this.tail.then(async () => {
      const draft = structuredClone(this.data);
      change(draft);
      validate(draft);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temp = join(this.directory, `${randomUUID()}.tmp`);
      try {
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(draft)); await file.sync(); }
        finally { await file.close(); }
        await rename(temp, join(this.directory, 'runner.json'));
        this.data = draft;
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await rm(temp, { force: true }); }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async observeEpoch(epoch: number): Promise<void> {
    if (!validEpoch(epoch)) throw new Error('서버의 초기화 번호가 올바르지 않습니다.');
    await this.update((draft) => {
      if (epoch === draft.epoch && draft.pendingEpoch === null) return;
      if (epoch < draft.epoch || (draft.pendingEpoch !== null && epoch < draft.pendingEpoch)) throw new Error('서버 초기화 번호가 뒤로 갔습니다.');
      if (draft.pendingEpoch === epoch) return;
      draft.pendingEpoch = epoch;
      draft.outbox = [];
      draft.inbox = [];
      draft.cursor = null;
    });
  }
}
