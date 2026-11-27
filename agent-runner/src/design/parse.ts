import { parseDocument } from 'yaml';
import { DESIGN_LIMITS, dereference, pointer, record, schemaFields, shapeBudget, validShape, type ShapeBudget, type DesignItem, type DesignShape, type DesignSnapshot } from './shape.ts';
import { sqlItems } from './sql.ts';

export interface ContractFile { path: string; raw?: string; error?: string }
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch']);

function item(path: string, itemKey: string, kind: DesignItem['kind'], source: Record<string, unknown>, fields: (budget: ShapeBudget) => DesignShape['fields'], content: Record<string, unknown>, total: { bytes: number; deadline: number }): DesignItem {
  const result: DesignItem = { path, itemKey, kind, name: typeof source.summary === 'string' && source.summary.trim() && source.summary.length <= 512 ? source.summary : itemKey, content };
  const description = typeof source.description === 'string' ? source.description : source.summary;
  if (typeof description === 'string' && description.length <= 8192) result.description = description;
  if (source['x-task-key'] !== undefined) {
    if (typeof source['x-task-key'] !== 'string' || !/^TASK-\d{4,}$/.test(source['x-task-key'])) throw new Error('Task 키가 올바르지 않습니다.');
    result.taskKey = source['x-task-key'];
  }
  try {
    const budget = shapeBudget(); budget.deadline = Math.min(budget.deadline, total.deadline);
    const contract = { fields: fields(budget) };
    const bytes = Buffer.byteLength(JSON.stringify(contract));
    if (!validShape(contract) || total.bytes + bytes > DESIGN_LIMITS.reportBytes / 4) throw new Error('필드 목록 상한입니다.');
    total.bytes += bytes;
    result.contract = contract;
  }
  catch { /* 원문은 files.raw에 보존한다. 해석 불가는 contract 없이 보고한다. */ }
  return result;
}

function parameters(entry: Record<string, unknown>, op: Record<string, unknown>, root: unknown): Record<string, unknown>[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const list of [entry.parameters ?? [], op.parameters ?? []]) {
    if (!Array.isArray(list)) throw new Error('파라미터 목록이 아닙니다.');
    for (const source of list) {
      const p = dereference(source, root);
      if (typeof p.in !== 'string' || !['path', 'query', 'header', 'cookie'].includes(p.in) || typeof p.name !== 'string' || !p.name.trim()) throw new Error('파라미터 주소가 없습니다.');
      merged.set(`${p.in}/${p.name}`, p);
    }
  }
  return [...merged.values()];
}

function mediaFields(value: unknown, root: unknown, path: string, required: boolean, budget: ShapeBudget): DesignShape['fields'] {
  return Object.entries(record(value)).flatMap(([media, spec]) => {
    const schema = record(spec).schema;
    if (schema === undefined) throw new Error('본문 스키마가 없습니다.');
    return schemaFields(schema, root, `${path}/${pointer(media)}`, required, budget);
  });
}

function apiItems(root: Record<string, unknown>, path: string, total: { bytes: number; deadline: number }): DesignItem[] {
  if (typeof root.openapi !== 'string' || !/^3\.1\.\d+$/.test(root.openapi)) throw new Error('OpenAPI 3.1만 지원합니다.');
  const items: DesignItem[] = [];
  for (const [url, source] of Object.entries(record(root.paths ?? {}))) {
    if (!url.startsWith('/')) throw new Error('API 경로가 올바르지 않습니다.');
    const entry = dereference(source, root);
    for (const [method, value] of Object.entries(entry)) {
      if (!METHODS.has(method)) continue;
      const op = record(value);
      const responses = record(op.responses);
      items.push(item(path, `${method.toUpperCase()} ${url}`, 'REST', op, budget => {
        const fields: DesignShape['fields'] = [];
        for (const p of parameters(entry, op, root)) {
          const at = `/parameters/${pointer(String(p.in))}/${pointer(String(p.name))}`;
          for (const field of schemaFields(p.schema, root, at, p.in === 'path' || p.required === true, budget)) fields.push(field);
        }
        if (op.requestBody !== undefined) {
          const body = dereference(op.requestBody, root);
          for (const field of mediaFields(body.content, root, '/requestBody/content', body.required === true, budget)) fields.push(field);
        }
        for (const [code, source] of Object.entries(responses)) {
          const response = dereference(source, root);
          const at = `/responses/${pointer(code)}`;
          fields.push({ path: at, type: 'response', required: false });
          if (response.content !== undefined) for (const field of mediaFields(response.content, root, `${at}/content`, false, budget)) fields.push(field);
          if (response.headers !== undefined) for (const [name, source] of Object.entries(record(response.headers))) {
            const header = dereference(source, root);
            for (const field of schemaFields(header.schema, root, `${at}/headers/${pointer(name)}`, header.required === true, budget)) fields.push(field);
          }
        }
        return fields;
      }, {
        type: 'REST', auth: op.security === undefined && root.security === undefined ? '' : JSON.stringify(op.security ?? root.security),
        request: JSON.stringify({ parameters: parameters(entry, op, root), ...(op.requestBody !== undefined && { requestBody: op.requestBody }) }),
        response: JSON.stringify(responses), validation: [], tables: [],
        errors: Object.entries(responses).filter(([code]) => /^[45]/.test(code)).map(([code, source]) => ({ code, http: code, cond: typeof record(source).description === 'string' ? record(source).description : '' })),
      }, total));
    }
  }
  return items;
}

function eventItems(root: Record<string, unknown>, path: string, total: { bytes: number; deadline: number }): DesignItem[] {
  if (typeof root.asyncapi !== 'string' || !/^3\.0\.\d+$/.test(root.asyncapi)) throw new Error('AsyncAPI 3.0만 지원합니다.');
  return Object.entries(record(root.channels)).flatMap(([key, source]) => {
    const channel = dereference(source, root);
    const address = channel.address === undefined || channel.address === null ? key : channel.address;
    if (typeof address !== 'string' || !address.trim()) throw new Error('채널 주소가 없습니다.');
    const servers = channel.servers === undefined ? Object.values(record(root.servers ?? {})) : channel.servers;
    if (!Array.isArray(servers)) throw new Error('서버 목록이 아닙니다.');
    const protocols = servers.map(s => dereference(s, root).protocol);
    const bindings = record(channel.bindings ?? {});
    const kind = 'kafka' in bindings || protocols.some(p => p === 'kafka' || p === 'kafka-secure') ? 'Kafka'
      : 'ws' in bindings || protocols.some(p => p === 'ws' || p === 'wss') ? 'WebSocket' : 'AsyncAPI';
    if (kind === 'AsyncAPI') return [];
    let content: Record<string, unknown> = {};
    {
      try {
        const actions = Object.values(record(root.operations ?? {})).map(op => dereference(op, root)).filter(op => dereference(op.channel, root) === channel).map(op => op.action);
        content = { type: 'message', auth: '', rules: [], topic: null,
          messages: Object.entries(record(channel.messages ?? {})).map(([name, source]) => ({ name, direction: actions.join(', '), schema: JSON.stringify(dereference(source, root).payload ?? {}) })),
        };
      } catch { /* 해석하지 못한 참조는 원문만 보존한다. */ }
    }
    return [item(path, address, kind, channel, budget => {
      return Object.entries(record(channel.messages ?? {})).flatMap(([name, source]) => {
        const message = dereference(source, root);
        let payload: unknown = typeof message.payload === 'boolean' ? message.payload : dereference(message.payload, root);
        let payloadRoot: unknown = root;
        if (payload !== undefined && typeof payload === 'object' && payload !== null && 'schemaFormat' in payload) {
          const multi = record(payload);
          if (typeof multi.schemaFormat !== 'string' || !/^(application\/schema\+(json|yaml)|application\/vnd\.aai\.asyncapi\+(json|yaml))(;|$)/.test(multi.schemaFormat)) throw new Error('JSON Schema가 아닌 메시지는 대조 안 함입니다.');
          payload = multi.schema;
          payloadRoot = multi.schema;
        }
        const at = `/messages/${pointer(name)}`;
        const fields: DesignShape['fields'] = [{ path: at, type: 'message', required: false }];
        for (const field of schemaFields(payload, payloadRoot, `${at}/payload`, false, budget)) fields.push(field);
        if (message.headers !== undefined) for (const field of schemaFields(message.headers, root, `${at}/headers`, false, budget)) fields.push(field);
        return fields;
      });
    }, content, total)];
  });
}

/** 입력은 호출자가 commit에 고정해 읽은 contracts/ 파일이다. 저장소 코드를 실행하지 않는다. */
export function parseContracts(sources: readonly ContractFile[], ref = 'main'): Pick<DesignSnapshot, 'files' | 'items'> & { problems: Record<string, string> } {
  const files: DesignSnapshot['files'] = [];
  const items: DesignItem[] = [];
  const paths = new Set<string>();
  const sql: ContractFile[] = [];
  const total = { bytes: 0, deadline: performance.now() + DESIGN_LIMITS.parseMs };
  const problems = Object.create(null) as Record<string, string>;
  let inputBytes = 0;
  for (const source of sources) {
    const { path, raw } = source;
    if (!path.startsWith('contracts/') || path.includes('\\') || [...path].some(c => c.charCodeAt(0) < 32) || path.split('/').some(p => !p || p === '.' || p === '..') || paths.has(path)) throw new Error('계약 파일 경로가 잘못되었거나 중복입니다.');
    paths.add(path);
    const bytes = raw === undefined ? 0 : Buffer.byteLength(raw);
    inputBytes += raw === undefined ? 0 : Buffer.byteLength(JSON.stringify(raw));
    const file = { path, kind: 'raw', format: /\.([^./]+)$/.exec(path)?.[1] ?? 'raw', status: ref === 'main' ? 'ok' : 'draft', ...(raw !== undefined && bytes <= DESIGN_LIMITS.fileBytes && inputBytes <= DESIGN_LIMITS.reportBytes / 2 && { raw }) } as DesignSnapshot['files'][number];
    files.push(file);
    if (bytes > DESIGN_LIMITS.fileBytes || inputBytes > DESIGN_LIMITS.reportBytes / 2) {
      file.status = 'error'; file.error = '계약 파일의 크기 상한을 넘었습니다.';
      if (/^contracts\/db\/(postgres|postgresql)\/.*\.sql$/i.test(path)) { file.kind = 'PostgreSQL'; file.format = 'SQL'; sql.push({ path, error: file.error }); }
      continue;
    }
    if (/^contracts\/db\/(postgres|postgresql)\/.*\.sql$/i.test(path)) {
      file.kind = 'PostgreSQL'; file.format = 'SQL'; sql.push(source);
      continue;
    }
    try {
      if (source.error !== undefined || raw === undefined) throw new Error('계약 파일을 읽지 못했습니다.');
      if (/\.(json|ya?ml)$/i.test(path)) {
        const doc = parseDocument(raw, { prettyErrors: false, stringKeys: true, uniqueKeys: true });
        if (doc.errors.length || doc.warnings.length) throw new Error('YAML 또는 JSON 문법을 확인하세요.');
        const root = record(doc.toJS({ maxAliasCount: 0 }));
        if ('openapi' in root) {
          file.kind = 'REST'; file.format = 'OpenAPI 3.1'; items.push(...apiItems(root, path, total));
        } else if ('asyncapi' in root) {
          file.kind = 'AsyncAPI'; file.format = 'AsyncAPI 3.0'; items.push(...eventItems(root, path, total));
        }
      }
    } catch (error) {
      file.status = 'error'; file.error = error instanceof Error ? error.message.slice(0, 400) : '계약 파일을 읽지 못했습니다.';
    }
  }
  if (sql.length) {
    try { items.push(...sqlItems(sql)); }
    catch (error) {
      for (const file of files.filter(f => f.format === 'SQL')) {
        file.status = 'error'; file.error = error instanceof Error ? error.message.slice(0, 400) : 'SQL 해석에 실패했습니다.';
      }
    }
  }
  const keys = new Map<string, DesignItem>();
  let shapeBytes = 0;
  for (const item of items) {
    if (item.contract) {
      const bytes = Buffer.byteLength(JSON.stringify(item.contract));
      if (!validShape(item.contract) || shapeBytes + bytes > DESIGN_LIMITS.reportBytes / 4) {
        delete item.contract; item.content = {};
        problems[item.itemKey] = '대조 안 함: 필드 목록의 크기 상한을 넘었습니다.';
      } else shapeBytes += bytes;
    }
    const existing = keys.get(item.itemKey);
    if (existing) {
      delete existing.contract; existing.content = {};
      problems[item.itemKey] = '대조 안 함: 여러 계약 파일의 설계 항목 키가 중복입니다.';
    } else keys.set(item.itemKey, item);
  }
  return { files, items: [...keys.values()], problems };
}
