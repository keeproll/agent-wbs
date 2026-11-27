import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { ApiError, ApiTransportError, type ApiClient, type ApiRequest, type ApiResponse, type OperationId } from './client.ts';
import { MAX_EVIDENCE_BYTES, State, type Entry, type ReportId } from '../state/state.ts';
import { requestHash } from '../state/rejections.ts';
import { assertDesignSnapshot } from '../design/validate.ts';
import { designItemHash } from '../design/hash.ts';

export interface OutboxOptions {
  now?: () => number;
  random?: () => number;
  monotonic?: () => number;
  onRejected?: (entry: Entry) => void | Promise<void>;
}

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
  return Math.min(60_000, Math.max(base * (1 + random * 0.2), Number.isFinite(after) ? after : 0));
}

export class Outbox {
  private readonly state: State;
  private readonly api: ApiClient;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly monotonic: () => number;
  private readonly onRejected: OutboxOptions['onRejected'];
  private readonly deadlines = new Map<string, number>();
  private flushing: Promise<void> | undefined;

  constructor(state: State, api: ApiClient, { now = Date.now, random = Math.random, monotonic = () => performance.now(), onRejected }: OutboxOptions = {}) {
    this.state = state;
    this.api = api;
    this.now = now;
    this.random = random;
    this.monotonic = monotonic;
    this.onRejected = onRejected;
  }

  /** M4-02의 readiness 보고자가 기존 점검 항목과 함께 표시한다. */
  get readinessWarnings(): string[] {
    const status = this.state.rejectionStatus;
    const blocked = this.state.snapshot.outbox.filter(e => e.code === 'EXTERNAL_WRITE_BLOCKED').map(e => `설계 보고 보류: 외부 쓰기 권한 대조를 기다립니다 (${String(e.request.body?.jobId)}).`);
    return [...blocked, ...(status.total || status.corrupt ? [`보고 거부 ${String(status.total)}건: 원문 ${String(status.kept)}건, 요약 ${String(status.summarized)}건, 고정 ${String(status.pinned)}건.`,
      ...this.state.rejectionAlerts.map((a) => `${a.level}: ${a.detail}`)] : [])];
  }

  get rejected() { return this.state.rejected; }
  rejectedFor(attemptId: string) { return this.state.rejectedFor(attemptId); }

  async enqueue<K extends ReportId>(operation: K, request: Omit<ApiRequest<K>, 'idempotencyKey'> & { idempotencyKey?: string }): Promise<Entry> {
    const input: Omit<Entry['request'], 'idempotencyKey'> = request;
    if (operation === 'reportDesignSnapshot') assertDesignSnapshot(input.body);
    const at = typeof input.body?.at === 'string' ? input.body.at : new Date(this.now()).toISOString();
    const attemptId = input.params?.attemptId;
    const id = randomUUID();
    const event = operation === 'uploadEvidence' ? `${operation}-${encodeURIComponent(String(input.body?.kind))}-${String(input.body?.sha256)}`
      : `${operation}${typeof input.body?.status === 'string' ? `-${input.body.status}` : ''}`;
    const key = request.idempotencyKey ?? (attemptId ? `att:${attemptId}:${event}:${at}` : `${operation}:${this.state.snapshot.runnerId}:${id}`);
    const parts = key.split(':');
    const generalKey = parts.length === 3 && Boolean(parts[0]) && parts[1] === this.state.snapshot.runnerId && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(parts[2] ?? '');
    if (attemptId ? !key.startsWith(`att:${attemptId}:`) || !/^[^:]+:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(key.slice(`att:${attemptId}:`.length))
      : !/^night:\d{4}-\d\d-\d\d$/.test(key) && !generalKey) {
      throw new TypeError('멱등 키가 계약 형식과 다릅니다.');
    }
    const serialized = JSON.parse(JSON.stringify({ ...request, idempotencyKey: key })) as Entry['request'];
    const entry: Entry = { id, operation, request: serialized, stream: attemptId ? `attempt:${attemptId}` : operation,
      state: 'pending', attempts: 0, nextAt: 0 };
    if (operation === 'uploadEvidence') {
      const { file, size } = (request as ApiRequest<'uploadEvidence'>).body;
      if (!(file instanceof Blob) || file.size > MAX_EVIDENCE_BYTES) throw new RangeError('증거 파일은 50 MiB 이하여야 합니다.');
      if (size !== file.size) throw new RangeError('증거 파일의 실제 크기와 보고 크기가 다릅니다.');
      await this.state.saveEvidence(id, file);
      entry.file = { name: id, type: file.type };
      if (serialized.body) delete serialized.body.file;
    }
    let saved = entry;
    await this.state.update((draft) => {
      if (operation !== 'reportCommandResult' && (draft.pendingEpoch !== null || input.epoch !== draft.epoch)) throw new Error('초기화 정리가 끝나기 전에는 보고를 추가할 수 없습니다.');
      const pending = draft.outbox.find((e) => e.request.epoch === input.epoch && e.request.idempotencyKey === key);
      const archived = pending ? undefined : this.state.findRejection(input.epoch, key);
      const existing = pending ?? archived;
      if (existing) {
        if (existing.operation !== operation || (archived ? archived.requestHash !== requestHash(operation, serialized) : !isDeepStrictEqual(existing.request, serialized))) throw new Error('같은 멱등 키에 다른 요청을 쌓을 수 없습니다.');
        saved = existing;
        return;
      }
      if (operation === 'ackMessage') {
        const messageId = input.params?.messageId;
        if (!draft.inbox.some((m) => m.id === messageId)) throw new Error('수신함에 없는 메시지입니다.');
        draft.inbox = draft.inbox.filter((m) => m.id !== messageId);
      }
      draft.outbox.push(entry);
    });
    if (saved.id !== id) await this.state.removeEvidence(entry);
    return structuredClone(saved);
  }

  flush(commandsOnly = false): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.send(commandsOnly).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async send(commandsOnly: boolean): Promise<void> {
    const active = new Set(this.state.snapshot.outbox.map((e) => e.id));
    for (const id of this.deadlines.keys()) if (!active.has(id)) this.deadlines.delete(id);
    const blocked = this.state.blockedAttempts();
    for (const entry of this.state.snapshot.outbox) {
      if (commandsOnly && entry.operation !== 'reportCommandResult') continue;
      const latest = this.state.snapshot;
      if (!latest.outbox.some((e) => e.id === entry.id)) continue;
      if (latest.pendingEpoch !== null && entry.operation !== 'reportCommandResult') return;
      if (blocked.has(entry.stream)) continue;
      blocked.add(entry.stream);
      if (entry.nextAt > 0 && !this.deadlines.has(entry.id)) {
        const delay = Math.max(0, Math.min(60_000, entry.nextAt - this.now()));
        this.deadlines.set(entry.id, this.monotonic() + delay);
        if (entry.nextAt > this.now() + 60_000) await this.state.update((draft) => {
          const stored = draft.outbox.find((e) => e.id === entry.id);
          if (stored) stored.nextAt = this.now() + 60_000;
        });
      }
      if ((this.deadlines.get(entry.id) ?? 0) > this.monotonic()) continue;
      try {
        const request = structuredClone(entry.request);
        if (entry.operation === 'reportDesignSnapshot') assertDesignSnapshot(request.body);
        if (entry.file && request.body) request.body.file = new Blob([new Uint8Array(await this.state.evidence(entry))], { type: entry.file.type });
        const call = this.api as (id: OperationId, request: unknown) => Promise<ApiResponse<OperationId>>;
        await call(entry.operation, request);
      } catch (error) {
        const designCode = entry.operation === 'reportDesignSnapshot' && error instanceof ApiError && error.status === 409 ? error.error?.code : undefined;
        if (designCode === 'VERSION_CONFLICT' && error instanceof ApiError) {
          const details = error.error?.details;
          const conflicts = details?.conflicts;
          const body = entry.request.body;
          const items = Array.isArray(body?.items) ? body.items as { itemKey: string }[] : [];
          if (Array.isArray(conflicts) && conflicts.length && conflicts.every((raw: unknown) => {
            if (!raw || typeof raw !== 'object') return false;
            const c = raw as Record<string, unknown>, item = items.find(i => i.itemKey === c.itemKey);
            return item && ['checked', 'unchecked'].includes(String(c.serverState)) && c.commit === body?.commit && c.ref === body?.ref && c.serverContentHash === designItemHash(item);
          })) {
            await this.state.update(draft => { draft.outbox = draft.outbox.filter(e => e.id !== entry.id); });
            this.deadlines.delete(entry.id); blocked.delete(entry.stream); continue;
          }
        }
        if (error instanceof ApiError && error.error?.code === 'EPOCH_MISMATCH') {
          await this.state.resetAfterMismatch(error.error.details?.currentEpoch);
          this.deadlines.clear();
          return;
        }
        const retry = retryable(error) || designCode === 'EXTERNAL_WRITE_BLOCKED';
        if (retry && !this.state.snapshot.outbox.some((e) => e.id === entry.id)) continue;
        if (retry) {
          const delay = retryDelay(entry.attempts, error, this.now(), this.random());
          this.deadlines.set(entry.id, this.monotonic() + delay);
          await this.state.update((draft) => {
            const stored = draft.outbox.find((e) => e.id === entry.id);
            if (stored) {
              stored.attempts++; stored.nextAt = this.now() + delay;
              if (designCode === 'EXTERNAL_WRITE_BLOCKED') { stored.code = designCode; stored.reason = '외부 쓰기 권한 대조를 기다리며 설계 보고를 보류합니다.'; }
            }
          });
        } else {
          const record = { ...entry, attempts: entry.attempts + 1, rejectedAt: this.now(),
            code: error instanceof ApiError ? error.error?.code ?? 'INVALID_RESPONSE' : 'INVALID_REQUEST',
            reason: designCode === 'VERSION_CONFLICT' ? '서버와 불일치: 최신 항목 hash를 확인하고 중지했습니다.' : error instanceof ApiError ? error.error?.message ?? `서버가 보고를 거부했습니다: HTTP ${String(error.status)}` : '로컬 요청 또는 증거 파일을 확인하세요.',
            ...(error instanceof ApiError && error.error?.fix && { fix: error.error.fix }),
            ...(error instanceof ApiError && { status: error.status }) };
          await this.state.reject(record);
          if (!entry.stream.startsWith('attempt:')) blocked.delete(entry.stream);
          this.deadlines.delete(entry.id);
          if (authenticationFailed(error)) {
            try { await this.onRejected?.(structuredClone(record)); } catch { /* 인증 실패는 알림 오류와 관계없이 중지한다. */ }
            throw error;
          }
          await this.onRejected?.(structuredClone(record));
        }
        if (authenticationFailed(error)) throw error;
        continue;
      }
      await this.state.update((draft) => { draft.outbox = draft.outbox.filter((e) => e.id !== entry.id); });
      await this.state.removeEvidence(entry);
      this.deadlines.delete(entry.id);
      blocked.delete(entry.stream);
    }
  }
}
