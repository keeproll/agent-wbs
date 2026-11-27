import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { designSnapshotProblems } from '../../src/design/validate.ts';
import { designItemHash } from '../../src/design/hash.ts';

const body = () => ({ jobId: 'job', fence: 1, commit: 'a'.repeat(40), ref: 'main', files: [{ path: 'contracts/api/openapi.json', kind: 'REST', format: 'OpenAPI 3.1', status: 'ok' }], items: [{ itemKey: 'GET /users', kind: 'REST', path: 'contracts/api/openapi.json', content: {}, extracted: null }], drifts: [] });

test('M6-05의 kind·stableKey·content 스키마 위반을 전송 전에 거부한다', () => {
  for (const bad of [{ kind: 'file' }, { itemKey: 'TRACE /users' }, { itemKey: 'GET relative' }, { content: { type: 'postgres' } }, { content: { type: 'REST', request: 123 } }]) {
    const value = body(); value.items = value.items.map(i => ({ ...i, ...bad }));
    expect(designSnapshotProblems(value).length, '계약 대기: M6-05 fix1 OpenAPI 병합·client 재생성이 필요합니다.').toBeGreaterThan(0);
  }
});

test('M6-05 공용 fixture 전체와 고정 hash 벡터가 서버와 일치한다', () => {
  interface Fixture { id: string; body: { items: unknown[] }; expectedStatus: number; expectedRule?: string; serverContentHash?: string; prior?: string; expectedConflicts?: { itemKey: string; serverContentHash: string }[] }
  const path = new URL('../../../agent-wbs/contracts/fixtures/design-snapshot.json', import.meta.url);
  expect(existsSync(path), '계약 대기: M6-05 fix1의 design-snapshot.json이 아직 없습니다.').toBe(true);
  const fixtures = JSON.parse(readFileSync(path, 'utf8')) as Fixture[];
  expect(fixtures.length).toBeGreaterThan(20);
  for (const fixture of fixtures) {
    const errors = designSnapshotProblems(fixture.body);
    expect(errors.length === 0, fixture.id).toBe(fixture.expectedStatus !== 400);
    if (fixture.expectedRule) expect(errors.some(e => e.rule === fixture.expectedRule), fixture.id).toBe(true);
    if (fixture.serverContentHash) expect(designItemHash(fixture.body.items[0]), fixture.id).toBe(fixture.serverContentHash);
    if (fixture.expectedConflicts) {
      const prior = fixtures.find(f => f.id === fixture.prior);
      expect(designItemHash(prior?.body.items[0]), fixture.id).toBe(fixture.expectedConflicts[0]?.serverContentHash);
      expect(designItemHash(fixture.body.items[0]), fixture.id).not.toBe(fixture.expectedConflicts[0]?.serverContentHash);
    }
  }
});
