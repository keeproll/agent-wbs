import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './files.ts';
import type { Entry } from './state.ts';

const DAY = 86400_000;
const UUID_FILE = /^[a-f0-9-]{36}\.json$/;
export interface RejectionLimits {
  maxRecords: number;
  maxBytes: number;
  maxAgeMs: number;
  maxRecordBytes: number;
  previewBytes: number;
  previousEpochAgeMs: number;
  pinnedWarning: number;
  maxSummaryKeys: number;
}
export const REJECTION_LIMITS: RejectionLimits = {
  maxRecords: 500, maxBytes: 20 * 1024 * 1024, maxAgeMs: 30 * DAY, maxRecordBytes: 64 * 1024,
  previewBytes: 4096, previousEpochAgeMs: 7 * DAY, pinnedWarning: 200, maxSummaryKeys: 1000,
};
export interface RejectionOptions { now?: () => number; rejectionLimits?: Partial<RejectionLimits> }
export interface RejectionMeta extends Entry {
  group: string;
  lastId: string;
  count: number;
  firstAt: number;
  lastAt: number;
  requestHash: string;
  bytes: number;
  retained: boolean;
  commandFailures?: number;
  truncated?: boolean;
}
interface Backoff { failures: number; nextAt: number; lastId: string }
interface Receipt { id: string; key: string; epoch: number }
interface Summary {
  version: 1;
  records: number;
  events: number;
  bytes: number;
  firstAt: number | null;
  lastAt: number | null;
  buckets: Record<string, number>;
  epochs: Record<string, number>;
  recent: Receipt[];
  pins: RejectionMeta[];
  corrupt: number;
  corruptRemoved: number;
  corruptBytes: number;
  truncated: number;
  batches: number;
  lastBatch: number;
}
export interface RejectionStatus {
  total: number;
  kept: number;
  bytes: number;
  summarized: number;
  summarizedRecords: number;
  pinned: number;
  corrupt: number;
  quarantined: number;
  level: 'ok' | 'warning' | 'danger';
  top: { operation: string; code: string; count: number }[];
}
export interface RejectionAlert { code: string; level: 'warning' | 'danger'; detail: string; revision: number }

export function requestHash(operation: string, request: Entry['request']): string {
  return hash(JSON.stringify({ operation, request }));
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function commandKey(epoch: number, id: string): string { return JSON.stringify([epoch, id]); }
function commandWait(failures: number): number { return Math.min(1800_000, 60_000 * 2 ** Math.min(Math.max(0, failures - 1), 5)); }
function blankSummary(): Summary {
  return { version: 1, records: 0, events: 0, bytes: 0, firstAt: null, lastAt: null, buckets: {}, epochs: {}, recent: [], pins: [], corrupt: 0, corruptRemoved: 0, corruptBytes: 0, truncated: 0, batches: 0, lastBatch: 0 };
}

/** 원문은 파일에만 두고, 전송 경로는 작은 색인과 지도로 조회한다. */
export class Rejections {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly current: () => { epoch: number; epochStartedAt: number };
  private readonly validate: (entry: Entry) => void;
  private readonly limits: RejectionLimits;
  private readonly rows = new Map<string, RejectionMeta>();
  private readonly keys = new Map<string, RejectionMeta>();
  private readonly groups = new Map<string, RejectionMeta>();
  private backoffs: Record<string, Backoff> = {};
  private summary = blankSummary();
  private tail: Promise<void> = Promise.resolve();
  private quarantineCount = 0;
  private quarantineBytes = 0;

  private constructor(directory: string, current: Rejections['current'], validate: Rejections['validate'], options: RejectionOptions) {
    this.directory = directory;
    this.current = current;
    this.validate = validate;
    this.now = options.now ?? Date.now;
    this.limits = { ...REJECTION_LIMITS, ...options.rejectionLimits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('거부 기록 보관 한도는 양의 정수여야 합니다.');
  }

  static async open(directory: string, current: Rejections['current'], validate: Rejections['validate'], options: RejectionOptions): Promise<Rejections> {
    const archive = new Rejections(directory, current, validate, options);
    const known = new Map<string, RejectionMeta>();
    const duplicates = new Map<string, string[]>();
    await mkdir(join(directory, 'corrupt'), { recursive: true, mode: 0o700 });
    await chmod(join(directory, 'corrupt'), 0o700);
    let changed = false;
    try {
      const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')) as Summary;
      if (summary.version !== 1 || !Array.isArray(summary.pins) || !Array.isArray(summary.recent) || !Number.isSafeInteger(summary.events) || summary.events < 0) throw new Error('요약 형식 오류');
      for (const value of [summary.records, summary.bytes, summary.corrupt, summary.corruptRemoved ?? 0, summary.corruptBytes ?? 0, summary.truncated, summary.batches, summary.lastBatch]) if (!Number.isSafeInteger(value) || value < 0) throw new Error('요약 합계 오류');
      for (const map of [summary.buckets, summary.epochs]) if (!map || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error('요약 종류 오류');
      for (const key of Object.keys(summary.buckets)) if (key !== 'other') {
        const parts: unknown = JSON.parse(key);
        if (!Array.isArray(parts) || parts.length !== 3 || typeof parts[0] !== 'string' || typeof parts[1] !== 'string' || typeof parts[2] !== 'number') throw new Error('요약 키 오류');
      }
      for (const receipt of summary.recent) if (!receipt || typeof receipt.id !== 'string' || typeof receipt.key !== 'string' || !Number.isSafeInteger(receipt.epoch)) throw new Error('요약 대조 기록 오류');
      for (const pin of summary.pins) archive.checkMeta(pin);
      archive.summary = { ...blankSummary(), ...summary };
      archive.summary.buckets = {};
      archive.summary.epochs = {};
      for (const [key, count] of Object.entries(summary.buckets)) archive.bump(archive.summary.buckets, key, count);
      for (const [key, count] of Object.entries(summary.epochs)) archive.bump(archive.summary.epochs, key, count);
      archive.summary.recent = summary.recent.slice(-10);
      if (Object.keys(summary.buckets).length !== Object.keys(archive.summary.buckets).length || Object.keys(summary.epochs).length !== Object.keys(archive.summary.epochs).length || summary.recent.length > 10) changed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await archive.quarantine('summary.json'); changed = true; }
    }
    try {
      const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')) as { version: number; rows: RejectionMeta[]; backoffs: Record<string, Backoff> };
      if (index.version !== 1 || !Array.isArray(index.rows) || !index.backoffs || typeof index.backoffs !== 'object') throw new Error('색인 형식 오류');
      for (const meta of index.rows) { archive.checkMeta(meta); known.set(meta.id, meta); }
      for (const b of Object.values(index.backoffs)) if (!Number.isSafeInteger(b.failures) || b.failures < 1 || !Number.isFinite(b.nextAt) || typeof b.lastId !== 'string') throw new Error('대기 형식 오류');
      archive.backoffs = index.backoffs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await archive.quarantine('index.json'); changed = true; }
    }
    archive.reindex();
    // 이전 버전의 큰 이력도 한 번에 하나씩 읽어 원문 전체를 메모리에 쌓지 않는다.
    for (const name of await readdir(directory)) {
      if (!UUID_FILE.test(name)) continue;
      try {
        const info = await stat(join(directory, name));
        if (info.size > archive.limits.maxBytes) throw new Error('읽기 한도 초과');
        const record = JSON.parse(await readFile(join(directory, name), 'utf8')) as Entry & Partial<RejectionMeta>;
        validate(record);
        if (`${record.id}.json` !== name || record.state !== 'rejected') throw new Error('거부 기록 형식 오류');
        const meta = archive.meta(record, info.mtimeMs);
        meta.bytes = info.size;
        archive.checkMeta(meta);
        if (meta.operation === 'reportCommandResult' && meta.request.params?.id && known.get(meta.id)?.lastId !== meta.lastId) {
          const key = commandKey(meta.request.epoch, meta.request.params.id);
          const failures = meta.commandFailures ?? meta.count;
          archive.backoffs[key] = { failures, nextAt: meta.lastAt + commandWait(failures), lastId: meta.lastId };
        }
        const group = archive.groups.get(meta.group);
        if (group?.retained && archive.rows.has(group.id)) {
          const latest = meta.lastAt >= group.lastAt ? meta : group;
          const discarded = latest.id === group.id ? meta.id : group.id;
          const copies = duplicates.get(meta.group) ?? [];
          copies.push(discarded);
          duplicates.set(meta.group, copies);
          if (latest.id !== group.id) {
            archive.rows.delete(group.id);
            archive.keys.delete(JSON.stringify([group.request.epoch, group.request.idempotencyKey]));
          }
          archive.put({ ...latest, count: group.count + meta.count, firstAt: Math.min(group.firstAt, meta.firstAt), lastAt: Math.max(group.lastAt, meta.lastAt) });
          changed = true;
        } else {
          const bounded = archive.bound({ ...meta, ...record });
          if (info.size > archive.limits.maxRecordBytes) {
            await archive.writeRecord(bounded);
            if (bounded.truncated) archive.summary.truncated++;
            changed = true;
          } else archive.put(meta);
        }
      } catch {
        const meta = known.get(name.slice(0, -5));
        if (meta) { archive.summarize(meta); if (archive.pinned(meta)) archive.pin(meta); }
        await archive.quarantine(name); changed = true;
      }
    }
    archive.reindex();
    if (changed) await archive.saveSummary();
    await archive.maintain();
    for (const [group, copies] of duplicates) {
      const meta = archive.groups.get(group);
      if (meta?.retained) {
        const raw = JSON.parse(await readFile(join(directory, `${meta.id}.json`), 'utf8')) as Entry;
        const merged = { ...raw, ...meta, request: raw.request, reason: raw.reason ?? meta.reason ?? '오류 코드를 확인하세요.', ...(raw.fix && { fix: raw.fix }) };
        if (meta.operation === 'reportCommandResult' && meta.request.params?.id) {
          const key = commandKey(meta.request.epoch, meta.request.params.id);
          const failures = Math.max(archive.backoffs[key]?.failures ?? 0, meta.commandFailures ?? meta.count);
          merged.commandFailures = failures;
          archive.backoffs[key] = { failures, nextAt: meta.lastAt + commandWait(failures), lastId: meta.lastId };
        }
        // 사본마다 쓰지 않고 묶음별 한 번만 동기화한 뒤 사본을 지운다.
        await archive.writeRecord(archive.bound(merged));
      }
      for (const id of copies) await rm(join(directory, `${id}.json`), { force: true });
    }
    await archive.saveIndex();
    return archive;
  }

  private checkMeta(meta: RejectionMeta): void {
    this.validate(meta);
    if (meta.state !== 'rejected' || !/^[a-f0-9]{64}$/.test(meta.group) || !/^[a-f0-9]{64}$/.test(meta.requestHash) ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(meta.lastId) || !Number.isSafeInteger(meta.count) || meta.count < 1 ||
      !Number.isFinite(meta.firstAt) || !Number.isFinite(meta.lastAt) || meta.lastAt < meta.firstAt ||
      !Number.isSafeInteger(meta.bytes) || meta.bytes < 0 || typeof meta.retained !== 'boolean' ||
      (meta.commandFailures !== undefined && (!Number.isSafeInteger(meta.commandFailures) || meta.commandFailures < 1))) throw new Error('거부 색인 형식 오류');
  }

  private meta(entry: Entry & Partial<RejectionMeta>, fallback = this.now()): RejectionMeta {
    const body = entry.request.body ?? {};
    const target = entry.request.params?.attemptId ?? entry.request.params?.id ?? entry.request.params?.messageId ?? entry.request.params?.taskKey ?? body.agent ?? body.runnerId ?? '';
    const meta: RejectionMeta = { ...entry, request: { ...entry.request },
      group: entry.group ?? hash(JSON.stringify([entry.request.epoch, entry.operation, entry.code, target])),
      lastId: entry.lastId ?? entry.id, count: entry.count ?? 1,
      firstAt: entry.firstAt ?? entry.rejectedAt ?? fallback, lastAt: entry.lastAt ?? entry.rejectedAt ?? fallback,
      requestHash: entry.requestHash ?? requestHash(entry.operation, entry.request), bytes: 0, retained: true,
    };
    const small = Object.fromEntries(Object.entries(body).filter(([key, value]) => ['fence', 'jobId', 'event', 'status', 'sha256', 'size', 'kind'].includes(key) &&
      (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' && Buffer.byteLength(value) <= 256)));
    if (Object.keys(small).length) meta.request.body = small; else delete meta.request.body;
    delete meta.file;
    if (meta.reason) meta.reason = meta.reason.slice(0, 256);
    if (meta.fix) meta.fix = meta.fix.slice(0, 256);
    meta.bytes = entry.bytes ?? Buffer.byteLength(JSON.stringify(entry));
    return meta;
  }

  private bound(record: RejectionMeta): RejectionMeta {
    const text = JSON.stringify(record);
    if (Buffer.byteLength(text) <= this.limits.maxRecordBytes) return record;
    const describe = (value: unknown) => {
      const source = typeof value === 'string' ? value : JSON.stringify(value);
      const bytes = Buffer.from(source);
      let preview = bytes.subarray(0, this.limits.previewBytes).toString('utf8');
      while (Buffer.byteLength(preview) > this.limits.previewBytes) preview = preview.slice(0, -1);
      return { preview, sha256: hash(source), length: bytes.length };
    };
    const bounded = structuredClone(record);
    bounded.truncated = true;
    for (const key of ['reason', 'fix'] as const) if (bounded[key] && Buffer.byteLength(bounded[key]) > this.limits.previewBytes) bounded[key] = JSON.stringify(describe(bounded[key]));
    if (bounded.request.body) for (const [key, value] of Object.entries(bounded.request.body)) {
      if (Buffer.byteLength(JSON.stringify(value)) > this.limits.previewBytes) bounded.request.body[key] = describe(value);
    }
    if (Buffer.byteLength(JSON.stringify(bounded)) > this.limits.maxRecordBytes) bounded.request.body = { truncated: describe(record.request.body ?? {}) };
    return bounded;
  }

  private reindex(): void {
    this.keys.clear(); this.groups.clear();
    for (const meta of [...this.summary.pins, ...this.rows.values()]) {
      this.keys.set(JSON.stringify([meta.request.epoch, meta.request.idempotencyKey]), meta);
      this.groups.set(meta.group, meta);
    }
  }
  private put(meta: RejectionMeta): void {
    const old = this.rows.get(meta.id);
    if (old) this.keys.delete(JSON.stringify([old.request.epoch, old.request.idempotencyKey]));
    this.rows.set(meta.id, meta);
    this.keys.set(JSON.stringify([meta.request.epoch, meta.request.idempotencyKey]), meta);
    this.groups.set(meta.group, meta);
  }
  private async writeRecord(record: RejectionMeta): Promise<void> {
    let text = JSON.stringify(record);
    while (record.bytes !== Buffer.byteLength(text)) { record.bytes = Buffer.byteLength(text); text = JSON.stringify(record); }
    await atomicWrite(this.directory, `${record.id}.json`, text);
    this.put(this.meta(record));
  }
  get entries(): RejectionMeta[] { return structuredClone([...this.groups.values()]); }
  find(epoch: number, key: string): RejectionMeta | undefined {
    const entry = this.keys.get(JSON.stringify([epoch, key]));
    return entry && structuredClone(entry);
  }
  hasSource(id: string): boolean {
    return [...this.groups.values()].some((e) => e.id === id || e.lastId === id) || this.summary.recent.some((r) => r.id === id);
  }
  blocked(epoch: number): Set<string> {
    return new Set([...this.groups.values()].filter((e) => e.request.epoch === epoch && e.stream.startsWith('attempt:')).map((e) => e.stream));
  }
  forAttempt(epoch: number, attemptId: string): RejectionMeta[] {
    return structuredClone([...this.groups.values()].filter((e) => e.request.epoch === epoch && e.request.params?.attemptId === attemptId));
  }
  commandDelay(epoch: number, id: string, at: number): { delay: number; revision: string } {
    const b = this.backoffs[commandKey(epoch, id)];
    return b ? { delay: Math.max(0, Math.min(1800_000, b.nextAt - at)), revision: b.lastId } : { delay: 0, revision: '' };
  }

  async read(id: string): Promise<RejectionMeta | undefined> {
    if (!this.rows.has(id)) return undefined;
    try {
      if ((await stat(join(this.directory, `${id}.json`))).size > this.limits.maxRecordBytes) throw new Error('거부 기록 크기 초과');
      const record = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')) as RejectionMeta;
      this.checkMeta(this.meta(record));
      return { ...this.rows.get(id), ...record };
    } catch {
      await this.serial(async () => {
        const meta = this.rows.get(id);
        if (meta) { this.summarize(meta); if (this.pinned(meta)) this.pin(meta); }
        this.rows.delete(id);
        await this.quarantine(`${id}.json`);
        this.reindex();
        await this.saveSummary(); await this.prune(); await this.saveIndex();
      });
      return undefined;
    }
  }

  reject(entry: Entry): Promise<void> {
    return this.serial(async () => {
      const at = entry.rejectedAt ?? this.now();
      const fresh = this.meta(entry, at);
      const old = this.groups.get(fresh.group);
      if (old?.lastId === entry.id) return;
      const record: RejectionMeta = { ...entry, ...fresh, request: structuredClone(entry.request), reason: entry.reason ?? '오류 코드를 확인하세요.', ...(entry.fix && { fix: entry.fix }),
        id: old?.id ?? entry.id, lastId: entry.id, count: (old?.retained ? old.count : 0) + 1,
        firstAt: old?.retained ? old.firstAt : at, lastAt: Math.max(old?.lastAt ?? at, at),
      };
      delete record.file;
      record.state = 'rejected';
      record.reason ??= '오류 코드를 확인하세요.';
      if (entry.operation === 'reportCommandResult' && entry.request.params?.id) {
        const key = commandKey(entry.request.epoch, entry.request.params.id);
        const failures = (this.backoffs[key]?.failures ?? 0) + 1;
        record.commandFailures = failures;
        this.backoffs[key] = { failures, nextAt: record.lastAt + commandWait(failures), lastId: entry.id };
      }
      const bounded = this.bound(record);
      if (bounded.truncated) this.summary.truncated++;
      await this.writeRecord(bounded);
      this.summary.pins = this.summary.pins.filter((e) => e.group !== record.group);
      this.reindex();
      await this.prune();
      await this.saveSummary(); await this.saveIndex();
    });
  }

  syncCommands(commands: { epoch: number; id: string }[]): Promise<void> {
    return this.serial(async () => {
      const active = new Set(commands.map((c) => commandKey(c.epoch, c.id)));
      const obsolete = Object.keys(this.backoffs).filter((key) => !active.has(key));
      if (!obsolete.length) return;
      for (const key of obsolete) Reflect.deleteProperty(this.backoffs, key);
      await this.saveIndex();
    });
  }
  maintain(): Promise<void> {
    return this.serial(async () => { if (await this.prune()) await this.saveIndex(); });
  }
  async close(): Promise<void> { await this.tail; }
  private serial(work: () => Promise<void>): Promise<void> {
    const operation = this.tail.then(work);
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  private pinned(entry: RejectionMeta): boolean { return entry.request.epoch === this.current().epoch && entry.stream.startsWith('attempt:'); }
  private pin(entry: RejectionMeta): void {
    const index = this.summary.pins.findIndex((e) => e.group === entry.group);
    const pin = { ...entry, retained: false, bytes: 0 };
    if (index < 0) this.summary.pins.push(pin);
    else this.summary.pins[index] = pin;
  }
  private bump(map: Record<string, number>, key: string, count: number): void {
    const target = Object.hasOwn(map, key) || Object.keys(map).length < this.limits.maxSummaryKeys - 1 ? key : 'other';
    map[target] = (map[target] ?? 0) + count;
  }
  private summarize(e: RejectionMeta): void {
    this.summary.records++;
    this.summary.events += e.count;
    this.summary.bytes += e.bytes;
    this.summary.firstAt = Math.min(this.summary.firstAt ?? e.firstAt, e.firstAt);
    this.summary.lastAt = Math.max(this.summary.lastAt ?? e.lastAt, e.lastAt);
    this.bump(this.summary.buckets, JSON.stringify([e.operation, e.code ?? '', e.status ?? 0]), e.count);
    this.bump(this.summary.epochs, String(e.request.epoch), e.count);
    this.summary.recent.push({ id: e.lastId, key: e.request.idempotencyKey, epoch: e.request.epoch });
    this.summary.recent = this.summary.recent.slice(-10);
  }
  private async prune(): Promise<boolean> {
    const now = this.now();
    const current = this.current();
    const rows = [...this.rows.values()];
    let bytes = rows.reduce((n, r) => n + r.bytes, 0);
    let count = rows.length;
    const selected = new Set<RejectionMeta>();
    const expired = (e: RejectionMeta) => now - e.lastAt > this.limits.maxAgeMs ||
      (e.request.epoch !== current.epoch && now - current.epochStartedAt >= this.limits.previousEpochAgeMs);
    for (const e of rows) if (expired(e)) { selected.add(e); count--; bytes -= e.bytes; }
    // 고정 보관·최근 24시간은 우선 남기되, 원문 총량의 강한 상한은 넘지 않는다.
    rows.sort((a, b) => Number(this.pinned(a)) - Number(this.pinned(b)) || Number(now - a.lastAt < DAY) - Number(now - b.lastAt < DAY) || a.lastAt - b.lastAt);
    for (const e of rows) {
      if (count <= this.limits.maxRecords && bytes <= this.limits.maxBytes) break;
      if (!selected.has(e)) { selected.add(e); count--; bytes -= e.bytes; }
    }
    const pinsBefore = this.summary.pins.length;
    this.summary.pins = this.summary.pins.filter((e) => e.request.epoch === current.epoch);
    const corruptChanged = await this.pruneCorrupt(count, bytes, now);
    if (!selected.size) {
      if (pinsBefore !== this.summary.pins.length) { this.reindex(); await this.saveSummary(); return true; }
      return corruptChanged;
    }
    let batch = 0;
    for (const e of selected) {
      if (this.pinned(e)) this.pin(e);
      this.summarize(e);
      batch += e.count;
    }
    this.summary.batches++;
    this.summary.lastBatch = batch;
    // 요약을 먼저 동기화한다. 삭제 중 끊기면 중복 집계는 허용해도 유실은 허용하지 않는다.
    await this.saveSummary();
    for (const e of selected) { await rm(join(this.directory, `${e.id}.json`), { force: true }); this.rows.delete(e.id); }
    this.reindex();
    return true;
  }

  private async pruneCorrupt(kept: number, bytes: number, now: number): Promise<boolean> {
    const folder = join(this.directory, 'corrupt');
    const files = [];
    for (const name of await readdir(folder)) {
      const info = await stat(join(folder, name));
      if (info.isFile()) files.push({ name, size: info.size, at: info.mtimeMs });
    }
    files.sort((a, b) => a.at - b.at);
    let count = files.length;
    let total = files.reduce((n, f) => n + f.size, 0);
    const selected = [];
    for (const file of files) {
      if (now - file.at <= this.limits.maxAgeMs && kept + count <= this.limits.maxRecords && bytes + total <= this.limits.maxBytes) continue;
      selected.push(file); count--; total -= file.size;
    }
    this.quarantineCount = count;
    this.quarantineBytes = total;
    if (!selected.length) return false;
    this.summary.corruptRemoved += selected.length;
    this.summary.corruptBytes += selected.reduce((n, f) => n + f.size, 0);
    this.summary.batches++;
    this.summary.lastBatch = selected.length;
    await this.saveSummary();
    for (const file of selected) await rm(join(folder, file.name), { force: true });
    return true;
  }

  get status(): RejectionStatus {
    const rows = [...this.rows.values()];
    const pinned = [...this.groups.values()].filter((e) => this.pinned(e)).length;
    const danger = pinned > this.limits.pinnedWarning || Object.values(this.backoffs).some((b) => b.failures >= 5);
    const total = this.summary.events + rows.reduce((n, e) => n + e.count, 0);
    const top = new Map<string, { operation: string; code: string; count: number }>();
    for (const [key, count] of Object.entries(this.summary.buckets)) {
      const [operation, code] = key === 'other' ? ['other', ''] : JSON.parse(key) as string[];
      top.set(`${operation ?? ''}:${code ?? ''}`, { operation: operation ?? '', code: code ?? '', count });
    }
    for (const e of rows) {
      const key = `${e.operation}:${e.code ?? ''}`;
      const old = top.get(key);
      top.set(key, { operation: e.operation, code: e.code ?? '', count: (old?.count ?? 0) + e.count });
    }
    return { total, kept: rows.length, bytes: this.quarantineBytes + rows.reduce((n, e) => n + e.bytes, 0), summarized: this.summary.events,
      summarizedRecords: this.summary.records, pinned, corrupt: this.summary.corrupt, level: danger ? 'danger' : total || this.summary.corrupt ? 'warning' : 'ok',
      quarantined: this.quarantineCount,
      top: [...top.values()].sort((a, b) => b.count - a.count).slice(0, 3) };
  }
  get alerts(): RejectionAlert[] {
    const alerts: RejectionAlert[] = [];
    if (this.summary.batches) alerts.push({ code: 'REJECTION_SUMMARIZED', level: 'warning', revision: this.summary.batches, detail: `거부 기록 ${String(this.summary.lastBatch)}건을 요약으로 옮겼습니다(총 ${String(this.summary.events)}건).` });
    if (this.summary.corrupt) alerts.push({ code: 'CORRUPT_REJECTION', level: 'warning', revision: this.summary.corrupt, detail: `읽지 못한 기록 ${String(this.summary.corrupt)}건을 격리했습니다(한도 초과로 요약한 원문 ${String(this.summary.corruptRemoved)}건).` });
    if (this.summary.truncated) alerts.push({ code: 'REJECTION_TRUNCATED', level: 'warning', revision: this.summary.truncated, detail: `큰 거부 원문 ${String(this.summary.truncated)}건을 미리보기와 해시로 남겼습니다.` });
    const repeated = Math.max(0, ...Object.values(this.backoffs).map((b) => b.failures));
    if (repeated >= 5) alerts.push({ code: 'REPEATED_COMMAND_REJECTION', level: 'danger', revision: repeated, detail: `같은 정리 명령이 연속 ${String(repeated)}회 거부되었습니다.` });
    const pinned = this.status.pinned;
    if (pinned > this.limits.pinnedWarning) alerts.push({ code: 'PINNED_REJECTION_OVERFLOW', level: 'danger', revision: pinned, detail: `고정 보관 시도가 ${String(pinned)}건입니다. 차단 근거를 확인하세요.` });
    return alerts;
  }
  private async quarantine(name: string): Promise<void> {
    const destination = join(this.directory, 'corrupt', name);
    let target = destination;
    try { await stat(destination); target += `.${randomUUID()}`; } catch { /* 첫 격리는 원래 파일 이름을 유지한다. */ }
    try { await rename(join(this.directory, name), target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.summary.corrupt++;
  }
  private saveSummary(): Promise<void> { return atomicWrite(this.directory, 'summary.json', JSON.stringify(this.summary)); }
  private saveIndex(): Promise<void> { return atomicWrite(this.directory, 'index.json', JSON.stringify({ version: 1, rows: [...this.rows.values()], backoffs: this.backoffs })); }
}
