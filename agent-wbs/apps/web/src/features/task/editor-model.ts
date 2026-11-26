/**
 * 구조화 편집기(UI-03F)의 데이터 모양과 검사 — 화면과 떨어진 순수 함수라 단위 시험으로 확인한다.
 * 원본 validateEd(P L5549–5591)·blankEnt(P L5506)·designView 관계 테이블(P L5477–5486)을 옮겼다.
 *
 * 기술 설계 content(계약은 자유 JSON)는 원본 모양을 그대로 쓴다.
 *   { ents?: [{ f: {name|method,path,…}, b: {columns: [...], …} }], b?: { migration: [...], … } }
 * 왜 원본 모양인가: 서버는 내용을 검사하지 않고 그대로 저장하므로(보고함) 화면이 모양을 정한다.
 * 빈 객체 `{}`는 「섹션 없음」으로 본다(설계 섹션 삭제 API가 없어 제거를 `{}` 저장으로 한다).
 */
import { COLSETS, DESIGN, SPEC_TBL, toLines, type Block, type DesignKind } from './labels.ts';

export type Row = Record<string, string | boolean>;
export type BlockValue = Row[] | string[] | string;
export interface DesignEnt { f: Record<string, string>; b: Record<string, BlockValue> }
export interface DesignContent { ents?: DesignEnt[]; b?: Record<string, BlockValue> }

/** 편집 중인 초안. 줄 목록·코드 블록은 textarea 글자 그대로(string), 표는 행 배열 */
export interface EditorDraft {
  kind: 'ent' | 'blk' | 'spec';
  /** 설계 종류(ent·blk). spec이면 '' */
  sec: DesignKind | '';
  /** 수정하는 엔티티 번호. 새로 추가는 -1 */
  idx: number;
  /** blk·spec의 블록 키 */
  key: string;
  f: Record<string, string>;
  b: Record<string, Row[] | string>;
}

export interface KnownTable { cols: string[]; task: string; change: string }
export type Known = Record<string, KnownTable>;

export const isDesignPresent = (content: unknown): content is DesignContent =>
  typeof content === 'object' && content !== null && Object.keys(content).length > 0;

/** 모든 Task의 DB 설계에 정의된 테이블(삭제 제외). skip은 지금 편집 중인 엔티티(P L5454). */
export function knownTables(tasks: { taskKey: string; designs: { kind: string; content: unknown }[] }[], skip: { task: string; idx: number } | null): Known {
  const m: Known = {};
  for (const t of tasks) {
    for (const sec of t.designs) {
      if (sec.kind !== 'DB' || !isDesignPresent(sec.content)) continue;
      (sec.content.ents ?? []).forEach((en, i) => {
        if (skip && skip.task === t.taskKey && skip.idx === i) return;
        const name = en.f.name;
        if (name && en.f.change !== '삭제') m[name] = { cols: ((en.b.columns ?? []) as Row[]).map((c) => String(c.name)), task: t.taskKey, change: en.f.change ?? '' };
      });
    }
  }
  return m;
}

/** 편집기 블록 목록(P L5500 edBlocks) */
export function draftBlocks(d: Pick<EditorDraft, 'kind' | 'sec' | 'key'>): Block[] {
  if (d.kind === 'ent' && d.sec) return DESIGN[d.sec].ent?.blocks ?? [];
  if (d.kind === 'blk' && d.sec) return DESIGN[d.sec].blocks.filter((b) => b.k === d.key);
  return [SPEC_TBL[d.key as 'ac' | 'outputs']];
}

/** 저장된 값 → 초안(P L5488 toDraftBlocks) */
export function toDraft(blocks: Block[], b: Record<string, BlockValue> | undefined): Record<string, Row[] | string> {
  const o: Record<string, Row[] | string> = {};
  for (const bk of blocks) {
    const v = b?.[bk.k];
    if (bk.t === 'lines') o[bk.k] = Array.isArray(v) ? (v as string[]).join('\n') : '';
    else if (bk.t === 'code') o[bk.k] = typeof v === 'string' ? v : '';
    else o[bk.k] = Array.isArray(v) ? (v as Row[]).map((r) => ({ ...r })) : [];
  }
  return o;
}

/** 초안 → 저장할 값(P L5493 fromDraftBlocks): 줄은 나누고, 코드는 끝 공백 제거, 표 칸은 앞뒤 공백 제거 */
export function fromDraft(blocks: Block[], b: Record<string, Row[] | string>): Record<string, BlockValue> {
  const o: Record<string, BlockValue> = {};
  for (const bk of blocks) {
    const v = b[bk.k];
    if (bk.t === 'lines') o[bk.k] = toLines(typeof v === 'string' ? v : '');
    else if (bk.t === 'code') o[bk.k] = String(typeof v === 'string' ? v : '').replace(/\s+$/, '');
    else o[bk.k] = (Array.isArray(v) ? v : []).map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, typeof x === 'string' ? x.trim() : x])));
  }
  return o;
}

const C = (name: string, type: string, nullable: boolean, pk: boolean, fk: string, unique: boolean, def: string, desc: string): Row => ({ name, type, nullable, pk, fk, unique, def, desc });
/** 새 엔티티 기본값(P L5506–5509) */
export function blankEntity(kind: DesignKind): DesignEnt {
  if (kind === 'DB') {
    return {
      f: { name: '', change: '신규', desc: '' },
      b: { columns: [C('id', 'uuid', false, true, '', false, 'gen_random_uuid()', '내부 식별자'), C('created_at', 'timestamptz', false, false, '', false, 'now()', ''), C('updated_at', 'timestamptz', false, false, '', false, 'now()', '')], indexes: [] },
    };
  }
  return { f: { method: 'GET', path: '/api/', desc: '', auth: '팀장 세션' }, b: { request: '', response: '', validation: [], errors: [], tables: [] } };
}

/** 표에 새 행(P L5546 edAddRow) */
export function blankRow(cols: string): Row {
  const r: Row = {};
  for (const c of COLSETS[cols] ?? []) r[c.k] = c.dv !== undefined ? c.dv : c.t === 'check' ? false : '';
  return r;
}

export interface DraftCheck {
  errs: string[];
  rowErr: Record<string, Record<number, Record<string, boolean>>>;
  fieldErr: Record<string, boolean>;
}

const SNAKE = /^[a-z][a-z0-9_]*$/;

/**
 * 저장 전 검사(P L5549–5591). 오류가 하나라도 있으면 저장하지 않는다.
 * - known: 다른 Task까지 포함한 DB 테이블(편집 중인 엔티티 제외)
 * - ownApi: 이 Task의 다른 Endpoint(편집 중인 것 제외)
 */
export function validateDraft(d: EditorDraft, ctx: { known: Known; ownApi: { method: string; path: string }[] }): DraftCheck {
  const errs: string[] = [];
  const rowErr: DraftCheck['rowErr'] = {};
  const fieldErr: Record<string, boolean> = {};
  const mark = (k: string, ri: number, ck: string, msg: string) => {
    ((rowErr[k] ??= {})[ri] ??= {})[ck] = true;
    if (!errs.includes(msg)) errs.push(msg);
  };
  const rows = (k: string): Row[] => (Array.isArray(d.b[k]) ? (d.b[k] as Row[]) : []);
  const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v as boolean)).trim();

  if (d.kind === 'ent' && d.sec) {
    for (const fd of DESIGN[d.sec].ent?.fields ?? []) {
      if (fd.req && !str(d.f[fd.k])) { fieldErr[fd.k] = true; errs.push(`${fd.l}을(를) 입력하세요.`); }
    }
  }
  for (const bk of draftBlocks(d)) {
    if (bk.t !== 'table' || !bk.cols) continue;
    rows(bk.k).forEach((r, ri) => {
      for (const c of COLSETS[bk.cols ?? ''] ?? []) {
        if (c.req && c.t !== 'check' && !str(r[c.k])) mark(bk.k, ri, c.k, `${bk.l} ${String(ri + 1)}행: ${c.l} 필수`);
      }
    });
  }

  if (d.kind === 'ent' && d.sec === 'DB') {
    const cols = rows('columns');
    const name = str(d.f.name);
    if (name && !SNAKE.test(name)) { fieldErr.name = true; errs.push('테이블명은 snake_case(소문자 · 숫자 · _)로 입력하세요.'); }
    const dup = ctx.known[name];
    if (name && d.f.change === '신규' && dup) { fieldErr.name = true; errs.push(`테이블 ${name}은(는) 이미 ${dup.task}에서 정의되어 있습니다. 기존 테이블이면 구분을 「변경」으로 지정하세요.`); }
    if (d.f.change !== '삭제') {
      if (!cols.length) errs.push('컬럼을 1개 이상 정의하세요.');
      else if (!cols.some((c) => c.pk)) errs.push('PK 컬럼이 없습니다 — 최소 1개 컬럼에 PK를 지정하세요.');
    }
    const seen = new Set<string>();
    cols.forEach((c, ri) => {
      const cn = str(c.name);
      if (cn && !SNAKE.test(cn)) mark('columns', ri, 'name', `컬럼 정의 ${String(ri + 1)}행: 컬럼명은 snake_case`);
      if (cn && seen.has(cn)) mark('columns', ri, 'name', `컬럼명 ${cn}이(가) 중복됩니다`);
      if (cn) seen.add(cn);
      if (c.pk && c.nullable) mark('columns', ri, 'nullable', `컬럼 정의 ${String(ri + 1)}행: PK 컬럼은 Null을 허용할 수 없습니다`);
      const fk = str(c.fk);
      if (!fk) return;
      const m = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(fk);
      if (!m) { mark('columns', ri, 'fk', `컬럼 정의 ${String(ri + 1)}행: FK 참조는 table.column 형식`); return; }
      const [, table = '', column = ''] = m;
      const targetCols = table === name ? cols.map((x) => str(x.name)) : ctx.known[table]?.cols ?? null;
      if (!targetCols) mark('columns', ri, 'fk', `FK 대상 테이블 ${table}이(가) 어떤 Task에도 정의되어 있지 않습니다`);
      else if (!targetCols.includes(column)) mark('columns', ri, 'fk', `FK 대상 컬럼 ${fk}이(가) 없습니다`);
    });
    rows('indexes').forEach((x, ri) => {
      str(x.cols).split(',').map((z) => z.trim()).filter(Boolean).forEach((z) => {
        if (!seen.has(z)) mark('indexes', ri, 'cols', `Index ${str(x.name) || `${String(ri + 1)}행`}: 컬럼 ${z}이(가) 테이블에 없습니다`);
      });
    });
  }

  if (d.kind === 'ent' && d.sec === 'API') {
    const p = str(d.f.path);
    if (p && !p.startsWith('/')) { fieldErr.path = true; errs.push('Path는 /로 시작해야 합니다.'); }
    if (p && ctx.ownApi.some((e) => e.method === d.f.method && e.path === p)) { fieldErr.path = true; errs.push(`${d.f.method ?? ''} ${p} Endpoint가 이미 있습니다.`); }
    rows('errors').forEach((r, ri) => {
      if (str(r.http) && !/^\d{3}$/.test(str(r.http))) mark('errors', ri, 'http', `Error Response ${String(ri + 1)}행: HTTP 상태는 3자리 숫자`);
    });
  }

  if (d.kind === 'blk' && d.key === 'env') {
    rows('env').forEach((r, ri) => {
      if (str(r.name) && !/^[A-Z][A-Z0-9_]*$/.test(str(r.name))) mark('env', ri, 'name', `환경 변수 ${String(ri + 1)}행: 변수명은 대문자 · 숫자 · _ 만 사용`);
    });
  }
  return { errs, rowErr, fieldErr };
}

/** DB 섹션의 관계 테이블 — 컬럼 정의의 FK에서 자동 계산(P L5477–5486) */
export function relationRows(taskKey: string, content: DesignContent, known: Known) {
  const rows: { from: string; to: string; card: string; ok: string }[] = [];
  for (const en of content.ents ?? []) {
    for (const c of (en.b.columns ?? []) as Row[]) {
      const fk = typeof c.fk === 'string' ? c.fk : '';
      if (!fk) continue;
      const table = fk.split('.')[0] ?? '';
      const at = known[table];
      rows.push({
        from: `${en.f.name ?? ''}.${String(c.name)}`, to: fk, card: c.nullable ? 'N : 0..1' : 'N : 1',
        ok: at ? (at.task === taskKey ? '이 Task에서 정의' : `${at.task}에서 정의`) : '정의되지 않은 테이블',
      });
    }
  }
  return rows;
}

/** 개요 편집 검사(P L1114–1124). same은 경고일 뿐 저장을 막지 않는다(UAT-TASK-02 「경고」). */
export function overviewErrors(o: { title: string; purpose: string; doneCond: string; assignee: string; verifier: string }) {
  return { title: !o.title.trim(), purpose: !o.purpose.trim(), doneCond: !o.doneCond.trim(), same: !!o.assignee && o.assignee === o.verifier };
}
