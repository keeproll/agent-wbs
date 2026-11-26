import { expect, test } from 'vitest';
import { validateDesign } from '../src/tasks/design.ts';

const table = (name: string, change = '신규') => ({ f: { name, change }, b: { columns: [{ name: 'id', type: 'uuid', pk: true }] } });
test('설계는 다른 Task·같은 구역·자기 테이블의 외래키와 변경 구분을 구별한다', () => {
  const users = table('users');
  const child = { f: { name: 'posts', change: '신규' }, b: { columns: [
    { name: 'id', type: 'uuid', pk: true, fk: 'posts.id' }, { name: 'owner', type: 'uuid', fk: 'users.id' },
  ], indexes: [{ name: 'owners', cols: 'id, owner' }] } };
  expect(validateDesign('DB', { ents: [users, child] }, [])).toEqual([]);
  expect(validateDesign('DB', { ents: [child] }, [{ ents: [users] }])).toEqual([]);
  expect(validateDesign('DB', { ents: [table('users', '변경')] }, [{ ents: [users] }])).toEqual([]);
  expect(validateDesign('DB', { ents: [table('users', '삭제')] }, [{ ents: [users] }])).toEqual([]);
});

test('깨진 구조·필수 칸·지원하지 않는 요청 방식은 500 대신 항목 오류가 된다', () => {
  for (const content of [{ ents: [null] }, { ents: {} }, { ents: [{ f: [], b: 'bad' }] }]) {
    expect(validateDesign('DB', content, []).length).toBeGreaterThan(0);
  }
  expect(validateDesign('API', { ents: [{ f: { method: 'TRACE', path: 'relative' }, b: {} }] }, []).map(e => e.path))
    .toEqual(['content.ents.0.f.method', 'content.ents.0.f.path']);
  expect(validateDesign('FE', { b: { states: [{ state: 'Loading', display: '' }] } }, [])[0]?.path).toBe('content.b.states.0.display');
  for (const kind of ['DB', 'API', 'FE', 'DevOps']) expect(validateDesign(kind, {}, [])).toEqual([]);
});


test('엔티티의 필드·블록·줄 목록이 깨지면 저장을 거부한다', () => {
  const f = { method: 'GET', path: '/users' };
  for (const content of [
    { ents: [{ f }] }, { ents: [{ f: { ...f, desc: {} }, b: {} }] },
    { ents: [{ f, b: { request: [] } }] }, { b: { resp: [null] } },
    { ents: [{ f, b: { errors: [{ code: 'ERR', http: '400', cond: {} }] } }] },
  ]) expect(validateDesign('API', content, []).length).toBeGreaterThan(0);
});
