import { describe, expect, it } from 'vitest';
import {
  blankEntity, knownTables, overviewErrors, relationRows, validateDraft, type EditorDraft,
} from '../src/features/task/editor-model.ts';

const col = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: 'uuid', nullable: false, pk: false, fk: '', unique: false, def: '', desc: '', ...extra });
const dbDraft = (f: Record<string, string>, columns: Record<string, unknown>[], indexes: Record<string, unknown>[] = []): EditorDraft => ({
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
