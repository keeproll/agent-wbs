import { describe, expect, it } from 'vitest';
import {
  type Row, blankEntity, knownTables, overviewErrors, relationRows, validateDraft, type EditorDraft,
} from '../src/features/task/editor-model.ts';

const col = (name: string, extra: Row = {}): Row => ({ name, type: 'uuid', nullable: false, pk: false, fk: '', unique: false, def: '', desc: '', ...extra });
const dbDraft = (f: Record<string, string>, columns: Row[], indexes: Row[] = []): EditorDraft => ({
  kind: 'ent', sec: 'DB', idx: -1, key: '', f, b: { columns, indexes },
});
const tasks = [
  { taskKey: 'TASK-0003', designs: [{ kind: 'DB', content: { ents: [{ f: { name: 'tasks', change: '신규' }, b: { columns: [col('id', { pk: true }), col('title')] } }] } }] },
  { taskKey: 'TASK-0004', designs: [] },
];

describe('기술 설계 편집기 검사(P L5549–5591, UAT-TASK-08)', () => {
  it('다른 Task가 정의한 테이블을 「신규」로 다시 만들면 막는다(중복 테이블)', () => {
    const known = knownTables(tasks, null);
    const r = validateDraft(dbDraft({ name: 'tasks', change: '신규', desc: '' }, [col('id', { pk: true })]), { known, ownApi: [] });
    expect(r.errs).toContain('테이블 tasks은(는) 이미 TASK-0003에서 정의되어 있습니다. 기존 테이블이면 구분을 「변경」으로 지정하세요.');
    expect(r.fieldErr.name).toBe(true);
  });
  it('없는 FK 대상 테이블·컬럼을 행 오류로 막는다', () => {
    const known = knownTables(tasks, null);
    const r = validateDraft(dbDraft({ name: 'checklist', change: '신규', desc: '' }, [
      col('id', { pk: true }), col('task_id', { fk: 'nothing.id' }), col('t2', { fk: 'tasks.missing' }), col('t3', { fk: 'tasks.id' }),
    ]), { known, ownApi: [] });
    expect(r.errs).toContain('FK 대상 테이블 nothing이(가) 어떤 Task에도 정의되어 있지 않습니다');
    expect(r.errs).toContain('FK 대상 컬럼 tasks.missing이(가) 없습니다');
    expect(r.rowErr.columns?.[1]?.fk).toBe(true);
    expect(r.rowErr.columns?.[2]?.fk).toBe(true);
    expect(r.rowErr.columns?.[3]).toBeUndefined();
  });
  it('Null을 허용한 PK·PK 없음·없는 인덱스 컬럼을 막는다', () => {
    const r1 = validateDraft(dbDraft({ name: 'a_b', change: '신규', desc: '' }, [col('id', { pk: true, nullable: true })], [{ name: 'ix', cols: 'id, nope', kind: 'BTREE' }]), { known: {}, ownApi: [] });
    expect(r1.errs).toContain('컬럼 정의 1행: PK 컬럼은 Null을 허용할 수 없습니다');
    expect(r1.errs).toContain('Index ix: 컬럼 nope이(가) 테이블에 없습니다');
    const r2 = validateDraft(dbDraft({ name: 'a_b', change: '신규', desc: '' }, [col('id')]), { known: {}, ownApi: [] });
    expect(r2.errs).toContain('PK 컬럼이 없습니다 — 최소 1개 컬럼에 PK를 지정하세요.');
  });
  it('중복 Endpoint·잘못된 HTTP 상태·/ 없는 Path를 막는다', () => {
    const draft: EditorDraft = { kind: 'ent', sec: 'API', idx: -1, key: '', f: { method: 'GET', path: '/api/tasks', desc: '', auth: '팀장 세션' }, b: { request: '', response: '', validation: '', errors: [{ code: 'X', http: '40', cond: '' }], tables: '' } };
    const r = validateDraft(draft, { known: {}, ownApi: [{ method: 'GET', path: '/api/tasks' }] });
    expect(r.errs).toContain('GET /api/tasks Endpoint가 이미 있습니다.');
    expect(r.errs).toContain('Error Response 1행: HTTP 상태는 3자리 숫자');
    const bad = validateDraft({ ...draft, f: { ...draft.f, path: 'api/x' }, b: { ...draft.b, errors: [] } }, { known: {}, ownApi: [] });
    expect(bad.errs).toContain('Path는 /로 시작해야 합니다.');
  });
  it('환경 변수 이름은 대문자·숫자·_만 허용한다', () => {
    const draft: EditorDraft = { kind: 'blk', sec: 'DevOps', idx: -1, key: 'env', f: {}, b: { env: [{ name: 'db_url', example: 'x', secret: true, desc: '' }] } };
    expect(validateDraft(draft, { known: {}, ownApi: [] }).errs).toContain('환경 변수 1행: 변수명은 대문자 · 숫자 · _ 만 사용');
  });
  it('AC·산출물 표의 필수 칸이 비면 막는다', () => {
    const draft: EditorDraft = { kind: 'spec', sec: '', idx: -1, key: 'ac', f: {}, b: { ac: [{ given: 'g', when: '', then: 't', method: '' }] } };
    expect(validateDraft(draft, { known: {}, ownApi: [] }).errs).toEqual(['Acceptance Criteria 1행: When (행동) 필수']);
  });
  it('새 테이블 초안은 id PK와 시각 컬럼을 갖는다(P L5507)', () => {
    const ent = blankEntity('DB');
    expect((ent.b.columns as { name: string; pk: boolean }[]).map((c) => c.name)).toEqual(['id', 'created_at', 'updated_at']);
  });
  it('FK에서 관계 테이블을 계산한다', () => {
    const known = knownTables(tasks, null);
    const rows = relationRows('TASK-0004', { ents: [{ f: { name: 'checklist', change: '신규' }, b: { columns: [col('task_id', { fk: 'tasks.id' }), col('p', { fk: 'checklist.id', nullable: true })] } }] }, known);
    expect(rows).toEqual([
      { from: 'checklist.task_id', to: 'tasks.id', card: 'N : 1', ok: 'TASK-0003에서 정의' },
      { from: 'checklist.p', to: 'checklist.id', card: 'N : 0..1', ok: '정의되지 않은 테이블' },
    ]);
  });
});

describe('개요 편집 검사(P L1111–1127, UAT-TASK-02)', () => {
  const base = { title: '제목', purpose: '목적', doneCond: '완료', assignee: 'Claude', verifier: 'Codex' };
  it('필수 칸이 비면 항목별 오류', () => {
    expect(overviewErrors({ ...base, title: ' ', purpose: '', doneCond: '' })).toEqual({ title: true, purpose: true, doneCond: true, same: false });
  });
  it('담당과 검증 Agent가 같으면 경고(저장은 막지 않음)', () => {
    expect(overviewErrors({ ...base, verifier: 'Claude' })).toEqual({ title: false, purpose: false, doneCond: false, same: true });
  });
});

describe('잘못된 설계 데이터 방어(리뷰 R4)', () => {
  it('빈 엔티티·문자열 엔티티·배열 아닌 블록을 버리고 버린 수를 센다', async () => {
    const { normalizeDesign } = await import('../src/features/task/editor-model.ts');
    const r = normalizeDesign('DB', { ents: [{}, { f: { name: 'ok', change: '신규', bad: 3 }, b: { columns: 'x', indexes: [null, { name: 'ix', cols: 'id' }] } }, 'bad'], b: { migration: 'not-array', seed: ['a', 1] } });
    expect(r.content.ents).toEqual([{ f: { name: 'ok', change: '신규' }, b: { columns: [], indexes: [{ name: 'ix', cols: 'id' }] } }]);
    expect(r.content.b).toEqual({ migration: [], seed: ['a'] });
    expect(r.dropped).toBe(7);
  });
  it('객체가 아닌 content·배열 아닌 ents도 죽지 않는다', async () => {
    const { normalizeDesign, knownTables } = await import('../src/features/task/editor-model.ts');
    expect(normalizeDesign('API', { ents: 'nope', b: null }).content).toEqual({ ents: [], b: {} });
    expect(normalizeDesign('FE', null).dropped).toBe(1);
    expect(knownTables([{ taskKey: 'T', designs: [{ kind: 'DB', content: { ents: [{}, 'x'] } }] }], null)).toEqual({});
  });
  it('정상 데이터는 그대로다', async () => {
    const { normalizeDesign } = await import('../src/features/task/editor-model.ts');
    const ok = { ents: [{ f: { name: 'tasks', change: '신규', desc: '' }, b: { columns: [{ name: 'id', pk: true, nullable: false }], indexes: [] } }], b: { migration: ['m'] } };
    expect(normalizeDesign('DB', ok)).toEqual({ content: ok, dropped: 0 });
  });
});

describe('작업량 편집 검사(UAT-TASK-02, 서버 계약 확장 대기 — 리뷰 R8)', () => {
  it('0<시간≤400, 낙관≤예상≤비관, 토큰 정수, 날짜 형식', async () => {
    const { estimateErrors } = await import('../src/features/task/editor-model.ts');
    expect(estimateErrors({ lo: '3', est: '4', hi: '6', tok: '560', fixStart: '' })).toEqual([]);
    expect(estimateErrors({ lo: '0', est: '4', hi: '401', tok: '1.5', fixStart: '2026-13-01' })).toEqual([
      'lo: 0보다 크고 400 이하인 숫자로 입력하세요.', 'hi: 0보다 크고 400 이하인 숫자로 입력하세요.',
      'tok: 예상 토큰은 0 이상의 정수(K)로 입력하세요.', 'fixStart: YYYY-MM-DD 형식으로 입력하세요.',
    ]);
    expect(estimateErrors({ lo: '5', est: '4', hi: '6', tok: '1', fixStart: '2026-11-30' })).toEqual(['range: 0보다 큰 숫자로, 낙관 ≤ 예상 ≤ 비관 순서가 되어야 합니다.']);
  });
});

describe('설계 저장은 바꾼 블록·엔티티만 최신 위에 얹는다(재리뷰 P1)', () => {
  const latest = { ents: [{ f: { name: 'a', change: '신규', desc: '상대가 고친 설명' }, b: { columns: [] } }, { f: { name: 'b', change: '신규' }, b: {} }], b: { migration: ['옛'], seed: ['상대 seed'] } };
  it('블록 편집은 그 블록만 바꾸고 다른 엔티티·블록은 최신 값 유지', async () => {
    const { applyDesignOp } = await import('../src/features/task/editor-model.ts');
    expect(applyDesignOp('DB', latest, { type: 'blocks', b: { migration: ['내 것'] } })).toEqual({ ...latest, b: { migration: ['내 것'], seed: ['상대 seed'] } });
  });
  it('엔티티 편집은 편집 전 이름으로 찾아 그것만 바꾸고, 새 엔티티는 뒤에 붙인다', async () => {
    const { applyDesignOp } = await import('../src/features/task/editor-model.ts');
    const mine = { f: { name: 'b2', change: '변경' }, b: {} };
    expect(applyDesignOp('DB', latest, { type: 'entUpsert', key: 'b', ent: mine }).ents?.map((e) => e.f.name)).toEqual(['a', 'b2']);
    expect(applyDesignOp('DB', latest, { type: 'entUpsert', key: null, ent: mine }).ents?.map((e) => e.f.name)).toEqual(['a', 'b', 'b2']);
    expect(applyDesignOp('DB', latest, { type: 'entUpsert', key: 'a', ent: mine }).ents?.[1]?.f.name).toBe('b');
  });
  it('엔티티 삭제는 이름으로, 섹션 추가는 있으면 그대로, 제거는 전체 교체', async () => {
    const { applyDesignOp } = await import('../src/features/task/editor-model.ts');
    expect(applyDesignOp('DB', latest, { type: 'entDelete', key: 'a' }).ents?.map((e) => e.f.name)).toEqual(['b']);
    expect(applyDesignOp('DB', latest, { type: 'blocks', b: {} })).toEqual(latest);
    expect(applyDesignOp('DB', undefined, { type: 'blocks', b: {} })).toEqual({ ents: [], b: {} });
    expect(applyDesignOp('DB', latest, { type: 'replace', content: {} })).toEqual({});
  });
});
