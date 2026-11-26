import { randomUUID } from 'node:crypto';
import { ApiError, ApiTransportError, type ApiClient, type ApiRequest, type ApiResponse, type OperationId } from './client.ts';
import { State, type Entry, type ReportId } from '../state/state.ts';

interface Clock { now?: () => number; random?: () => number }

export function authenticationFailed(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export function retryable(error: unknown): boolean {
  return error instanceof ApiTransportError || (error instanceof ApiError && (error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599)));
}

export function retryDelay(attempts: number, error: unknown, now: number, random: number): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
  const header = error instanceof ApiError ? error.retryAfter : null;
  const after = header === null ? 0 : /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return Math.max(Math.min(60_000, base * (1 + random * 0.2)), Number.isFinite(after) ? after : 0);
}

export class Outbox {
  private readonly state: State;
  private readonly api: ApiClient;
  private readonly now: () => number;
  private readonly random: () => number;
  private flushing: Promise<void> | undefined;

  constructor(state: State, api: ApiClient, { now = Date.now, random = Math.random }: Clock = {}) {
    this.state = state;
    this.api = api;
    this.now = now;
    this.random = random;
  }

  /** M4-02의 readiness 보고자가 기존 점검 항목과 함께 표시한다. */
  get readinessWarnings(): string[] {
    return this.state.snapshot.outbox.filter((e) => e.state === 'rejected').map((e) => `${e.operation}: ${String(e.status ?? '')} ${e.code ?? '보고 거부'}`);
  }

  async enqueue<K extends ReportId>(operation: K, request: Omit<ApiRequest<K>, 'idempotencyKey'>): Promise<Entry> {
    const input: Omit<Entry['request'], 'idempotencyKey'> = request;
    const at = typeof input.body?.at === 'string' ? input.body.at : new Date(this.now()).toISOString();
    const attemptId = input.params?.attemptId;
    const id = randomUUID();
    // 같은 밀리초에 여러 증거 파일이 생겨도 서로 다른 이벤트다.
    const key = attemptId ? `att:${attemptId}:${operation}-${id}:${at}` : `${operation}:${this.state.snapshot.runnerId}:${id}`;
    const serialized = JSON.parse(JSON.stringify({ ...request, idempotencyKey: key })) as Entry['request'];
    const entry: Entry = { id, operation, request: serialized, stream: attemptId ? `attempt:${attemptId}` : operation,
      state: 'pending', attempts: 0, nextAt: 0 };
    if (operation === 'uploadEvidence') {
      const file = (request as ApiRequest<'uploadEvidence'>).body.file;
      entry.file = { base64: Buffer.from(await file.arrayBuffer()).toString('base64'), type: file.type };
      if (serialized.body) delete serialized.body.file;
    }
    await this.state.update((draft) => {
      if (operation !== 'reportCommandResult' && (draft.pendingEpoch !== null || input.epoch !== draft.epoch)) throw new Error('초기화 정리가 끝나기 전에는 보고를 추가할 수 없습니다.');
      if (operation === 'ackMessage') {
        const messageId = input.params?.messageId;
        if (!draft.inbox.some((m) => m.id === messageId)) throw new Error('수신함에 없는 메시지입니다.');
        draft.inbox = draft.inbox.filter((m) => m.id !== messageId);
      }
      draft.outbox.push(entry);
    });
    return structuredClone(entry);
  }

  flush(commandsOnly = false): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.send(commandsOnly).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async send(commandsOnly: boolean): Promise<void> {
    const blocked = new Set<string>();
    for (const entry of this.state.snapshot.outbox) {
      if (commandsOnly && entry.operation !== 'reportCommandResult') continue;
      const latest = this.state.snapshot;
      if (!latest.outbox.some((e) => e.id === entry.id)) continue;
      if (latest.pendingEpoch !== null && entry.operation !== 'reportCommandResult') return;
      if (blocked.has(entry.stream)) continue;
      blocked.add(entry.stream);
      if (entry.state === 'rejected' || entry.nextAt > this.now()) continue;
      try {
        const request = structuredClone(entry.request);
        if (entry.file && request.body) request.body.file = new Blob([Buffer.from(entry.file.base64, 'base64')], { type: entry.file.type });
        const call = this.api as (id: OperationId, request: unknown) => Promise<ApiResponse<OperationId>>;
        await call(entry.operation, request);
      } catch (error) {
        if (error instanceof ApiError && error.error?.code === 'EPOCH_MISMATCH') {
          await this.state.observeEpoch(error.error.details?.currentEpoch as number);
          return;
        }
        await this.state.update((draft) => {
          const stored = draft.outbox.find((e) => e.id === entry.id);
          if (!stored) return;
          stored.attempts++;
          if (retryable(error)) stored.nextAt = this.now() + retryDelay(entry.attempts, error, this.now(), this.random());
          else {
            stored.state = 'rejected';
            if (error instanceof ApiError) { stored.status = error.status; stored.code = error.error?.code ?? 'INVALID_RESPONSE'; }
            else stored.code = 'INVALID_REQUEST';
          }
        });
        if (authenticationFailed(error)) throw error;
        continue;
      }
      await this.state.update((draft) => { draft.outbox = draft.outbox.filter((e) => e.id !== entry.id); });
      blocked.delete(entry.stream);
    }
  }
}
