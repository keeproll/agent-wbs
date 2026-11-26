// M2-08 변경 이벤트·이력의 순수 판정(DB 없이). DB를 쓰는 검증은 changes.db.test.ts에 있다.
import { describe, expect, test } from 'vitest';
import { CHANGE_TOPICS, changesPage, refText } from '../src/changes/events.ts';
import { decodeCursor, decodeTimeIdCursor, encodeCursor, seoulDayRange } from '../src/changes/history.ts';

const row = (seq: number, topic = 'task', ref: unknown = { taskKey: 'TASK-0001' }) => ({ seq, topic, ref, at: '2026-11-26T00:00:00.000000Z' });

describe('refText — DB jsonb 참조를 API 문자열로', () => {
  test('문자열은 그대로, null은 null', () => {
    expect(refText('TASK-0001')).toBe('TASK-0001');
    expect(refText(null)).toBeNull();
    expect(refText(undefined)).toBeNull();
  });
  test('객체는 taskKey → id → key 순서의 문자열 값', () => {
    expect(refText({ id: 'x', taskKey: 'TASK-0002' })).toBe('TASK-0002');
    expect(refText({ key: 'k', id: 'abc' })).toBe('abc');
    expect(refText({ key: 'exec-policy' })).toBe('exec-policy');
  });
  test('알려진 키가 없으면 키를 정렬한 JSON(같은 내용이면 같은 문자열)', () => {
    expect(refText({ b: 1, a: [2, { d: 1, c: 0 }] })).toBe('{"a":[2,{"c":0,"d":1}],"b":1}');
    expect(refText({ taskKey: 7 })).toBe('{"taskKey":7}');
  });
});

describe('changesPage — 커서와 reset 판정(contracts §7)', () => {
  test('처음(after=0)은 reset 없이 가장 오래된 것부터 limit만큼', () => {
    const page = changesPage({ after: 0, limit: 2, cursorFound: false, rows: [row(3), row(5), row(9)], latest: 9 });
    expect(page.reset).toBe(false);
    expect(page.events.map((e) => e.seq)).toEqual([3, 5]);
    expect(page.next).toBe(5);
    expect(page.events[0]).toEqual({ seq: 3, topic: 'task', ref: 'TASK-0001', at: '2026-11-26T00:00:00.000000Z' });
  });
  test('커서 행이 남아 있으면 그 뒤만 돌려준다. 새 것이 없으면 next는 after 그대로', () => {
    expect(changesPage({ after: 5, limit: 10, cursorFound: true, rows: [row(9)], latest: 9 })).toMatchObject({ next: 9, reset: false });
    expect(changesPage({ after: 9, limit: 10, cursorFound: true, rows: [], latest: 9 })).toEqual({ events: [], next: 9, reset: false });
  });
  test('커서 행이 지워졌으면(7일 보존 정리·초기화) reset:true, next는 남은 최신 seq', () => {
    expect(changesPage({ after: 4, limit: 10, cursorFound: false, rows: [row(9)], latest: 9 })).toEqual({ events: [], next: 9, reset: true });
  });
  test('초기화로 모두 지워졌으면 next=0으로 돌려 다음 조회가 다시 reset되지 않게 한다', () => {
    expect(changesPage({ after: 4, limit: 10, cursorFound: false, rows: [], latest: null })).toEqual({ events: [], next: 0, reset: true });
  });
  test('topic 목록은 계약 §7의 17종과 같다', () => {
    expect(CHANGE_TOPICS).toEqual(['task', 'dependency', 'attempt', 'verification', 'message', 'proposal', 'planning', 'schedule',
      'runner', 'ci', 'design', 'report', 'mail', 'notify', 'alert', 'project', 'settings']);
  });
});

describe('이력 조회 도우미', () => {
  test('날짜 필터는 Asia/Seoul 하루 경계(UTC로 9시간 앞)', () => {
    expect(seoulDayRange('2026-11-26', '2026-11-27')).toEqual({ from: '2026-11-25T15:00:00.000Z', to: '2026-11-27T15:00:00.000Z' });
    expect(seoulDayRange(undefined, '2026-11-26')).toEqual({ from: null, to: '2026-11-26T15:00:00.000Z' });
  });
  test('달력에 없는 날짜·거꾸로 된 기간은 거부', () => {
    expect(() => seoulDayRange('2026-02-30', undefined)).toThrow();
    expect(() => seoulDayRange('2026-11-27', '2026-11-26')).toThrow();
  });
  test('커서는 왕복되고 위조·손상된 값은 null', () => {
    const cursor = encodeCursor(['2026-11-26T00:00:00.000001Z', '0b7f3a2e-0000-4000-8000-000000000001']);
    expect(decodeCursor(cursor, 2)).toEqual(['2026-11-26T00:00:00.000001Z', '0b7f3a2e-0000-4000-8000-000000000001']);
    expect(decodeCursor('not-base64!', 2)).toBeNull();
    expect(decodeCursor(encodeCursor(['only-one']), 2)).toBeNull();
    expect(decodeCursor(Buffer.from('{"a":1}').toString('base64url'), 2)).toBeNull();
  });
  test('시각·id 커서는 안의 값까지 검사한다(형식만 맞는 위조 값은 null → 400, 리뷰 지적 6)', () => {
    const good = ['2026-11-26T00:00:00.000001Z', '0b7f3a2e-0000-4000-8000-000000000001'];
    expect(decodeTimeIdCursor(encodeCursor(good))).toEqual(good);
    expect(decodeTimeIdCursor(encodeCursor(['not-a-date', 'not-a-uuid']))).toBeNull();
    expect(decodeTimeIdCursor(encodeCursor(['2026-02-30T00:00:00Z', good[1] ?? '']))).toBeNull();
    expect(decodeTimeIdCursor(encodeCursor([good[0] ?? '', 'not-a-uuid']))).toBeNull();
  });
});
