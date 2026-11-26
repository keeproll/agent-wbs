import type { InputError } from '@awbs/shared/api';

type Row = Record<string, unknown>;
const object = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const list = (v: unknown): Row[] => Array.isArray(v) ? v.filter(object) : [];

/** P5549–5591: 편집기의 필수 칸·참조 검사를 서버에서도 적용한다. 빈 구역은 허용한다. */
export function validateDesign(kind: string, content: Row, otherDb: readonly Row[]): InputError[] {
  const errors: InputError[] = [];
  const mark = (path: string, rule: string, message: string) => errors.push({ path: `content.${path}`, rule, message });
  const rows = (value: unknown, path: string): Row[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) { mark(path, 'type', '행 목록이어야 합니다.'); return []; }
    value.forEach((r, i) => { if (!object(r)) mark(`${path}.${String(i)}`, 'type', '각 행은 객체여야 합니다.'); });
    return value.map(r => object(r) ? r : {});
  };
  const block = (value: unknown, path: string): Row => {
    if (value === undefined) return {};
    if (!object(value)) { mark(path, 'type', '항목 묶음은 객체여야 합니다.'); return {}; }
    return value;
  };
  const required = (r: Row, keys: readonly string[], path: string) => keys.forEach(k => {
    if (!text(r[k])) mark(`${path}.${k}`, 'required', '필수 내용을 입력하세요.');
  });
  const table = (b: Row, key: string, keys: readonly string[], path: string) => {
    const result = rows(b[key], `${path}.${key}`);
    result.forEach((r, i) => {
      const rowPath = `${path}.${key}.${String(i)}`;
      required(r, keys, rowPath);
      for (const [field, value] of Object.entries(r)) if (typeof value !== 'string' && typeof value !== 'boolean') mark(`${rowPath}.${field}`, 'type', '표의 값은 글자 또는 참·거짓이어야 합니다.');
    });
    return result;
  };
  const blockTypes = (b: Row, lines: readonly string[], code: readonly string[], path: string) => {
    for (const key of lines) if (b[key] !== undefined && (!Array.isArray(b[key]) || !(b[key] as unknown[]).every(v => typeof v === 'string'))) mark(`${path}.${key}`, 'type', '글자 목록이어야 합니다.');
    for (const key of code) if (b[key] !== undefined && typeof b[key] !== 'string') mark(`${path}.${key}`, 'type', '코드는 문자열이어야 합니다.');
  };
  const ents = rows(content.ents, 'ents');
  const known = new Map<string, string[]>();
  for (const c of otherDb) for (const e of list(c.ents)) {
    const f = object(e.f) ? e.f : {}, b = object(e.b) ? e.b : {};
    if (f.change !== '삭제') known.set(text(f.name), list(b.columns).map(c => text(c.name)));
  }
  const current = new Map<string, string[]>();
  if (kind === 'DB') for (const e of ents) {
    const f = object(e.f) ? e.f : {}, b = object(e.b) ? e.b : {};
    if (f.change !== '삭제') current.set(text(f.name), list(b.columns).map(c => text(c.name)));
  }
  const seen = new Set<string>();
  ents.forEach((e, i) => {
    const path = `ents.${String(i)}`, f = block(e.f, `${path}.f`), b = block(e.b, `${path}.b`);
    for (const key of ['f', 'b']) if (e[key] === undefined) mark(`${path}.${key}`, 'required', '필드와 블록 묶음이 필요합니다.');
    for (const [field, value] of Object.entries(f)) if (typeof value !== 'string') mark(`${path}.f.${field}`, 'type', '필드 값은 문자열이어야 합니다.');
    if (kind === 'DB') {
      required(f, ['name', 'change'], `${path}.f`);
      const name = text(f.name);
      if (name && !/^[a-z][a-z0-9_]*$/.test(name)) mark(`${path}.f.name`, 'pattern', '테이블명은 소문자·숫자·_로 입력하세요.');
      if (name && (seen.has(name) || (f.change === '신규' && known.has(name)))) mark(`${path}.f.name`, 'unique', '이미 정의된 테이블입니다. 기존 테이블이면 변경으로 지정하세요.');
      if (name) seen.add(name);
      if (f.change !== undefined && !['신규', '변경', '삭제'].includes(String(f.change))) mark(`${path}.f.change`, 'enum', '신규·변경·삭제 중 하나를 고르세요.');
      const cols = table(b, 'columns', ['name', 'type'], `${path}.b`);
      if (f.change !== '삭제' && !cols.some(c => c.pk === true)) mark(`${path}.b.columns`, 'primaryKey', 'PK(행을 구별하는 기본키) 컬럼을 하나 이상 지정하세요.');
      const names = new Set<string>();
      cols.forEach((c, j) => {
        const cp = `${path}.b.columns.${String(j)}`, nameOfCol = text(c.name);
        if (nameOfCol && !/^[a-z][a-z0-9_]*$/.test(nameOfCol)) mark(`${cp}.name`, 'pattern', '컬럼명은 소문자·숫자·_로 입력하세요.');
        if (names.has(nameOfCol)) mark(`${cp}.name`, 'unique', '컬럼명이 겹칩니다.');
        names.add(nameOfCol);
        for (const k of ['pk', 'nullable', 'unique']) if (c[k] !== undefined && typeof c[k] !== 'boolean') mark(`${cp}.${k}`, 'type', '참 또는 거짓이어야 합니다.');
        if (c.pk && c.nullable) mark(`${cp}.nullable`, 'primaryKey', '기본키는 값 없음을 허용할 수 없습니다.');
        if (c.fk !== undefined && typeof c.fk !== 'string') mark(`${cp}.fk`, 'type', '외래키는 문자열이어야 합니다.');
        const fk = text(c.fk);
        if (!fk) return;
        const match = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(fk);
        if (!match) { mark(`${cp}.fk`, 'pattern', 'FK(다른 컬럼을 가리키는 외래키)는 table.column 형식이어야 합니다.'); return; }
        const target = current.get(match[1] ?? '') ?? known.get(match[1] ?? '');
        if (!target?.includes(match[2] ?? '')) mark(`${cp}.fk`, 'exists', '외래키 대상 테이블 또는 컬럼이 없습니다.');
      });
      table(b, 'indexes', ['name', 'cols'], `${path}.b`).forEach((r, j) => {
        if (text(r.cols).split(',').some(c => !names.has(c.trim()))) mark(`${path}.b.indexes.${String(j)}.cols`, 'exists', '인덱스 대상 컬럼이 테이블에 없습니다.');
      });
    }
    if (kind === 'API') {
      blockTypes(b, ['validation', 'tables'], ['request', 'response'], `${path}.b`);
      required(f, ['method', 'path'], `${path}.f`);
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(text(f.method))) mark(`${path}.f.method`, 'enum', '지원하는 HTTP Method(요청 방식)를 고르세요.');
      if (text(f.path) && !text(f.path).startsWith('/')) mark(`${path}.f.path`, 'pattern', '주소는 /로 시작해야 합니다.');
      const endpoint = `${text(f.method)} ${text(f.path)}`;
      if (seen.has(endpoint)) mark(`${path}.f.path`, 'unique', '같은 요청 방식과 주소가 이미 있습니다.');
      seen.add(endpoint);
      table(b, 'errors', ['code', 'http'], `${path}.b`).forEach((r, j) => {
        if (!/^\d{3}$/.test(String(r.http ?? '').trim())) mark(`${path}.b.errors.${String(j)}.http`, 'pattern', 'HTTP 상태는 3자리 숫자여야 합니다.');
      });
    }
  });
  const b = block(content.b, 'b');
  const lineKeys: Record<string, string[]> = { DB: ['migration', 'seed', 'integrity'], API: ['resp'], FE: ['interactions', 'apis', 'navigation'], DevOps: ['targets', 'health', 'deploy'] };
  blockTypes(b, lineKeys[kind] ?? [], kind === 'DevOps' ? ['commands'] : [], 'b');
  if (kind === 'DevOps') {
    table(b, 'files', ['path'], 'b');
    table(b, 'services', ['name'], 'b');
    table(b, 'env', ['name'], 'b').forEach((r, i) => {
      if (text(r.name) && !/^[A-Z][A-Z0-9_]*$/.test(text(r.name))) mark(`b.env.${String(i)}.name`, 'pattern', '환경 변수명은 대문자·숫자·_로 입력하세요.');
    });
  }
  if (kind === 'FE') for (const [key, fields] of [
    ['screens', ['name']], ['components', ['name']], ['inputs', ['field']], ['states', ['state', 'display']],
  ] as const) table(b, key, fields, 'b');
  return errors;
}
