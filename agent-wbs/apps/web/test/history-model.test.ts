import { describe, expect, it } from 'vitest';
import {
  countLabel, diffText, EMPTY_HISTORY_FILTER, filterHistory, historyOptions, isFiltered, rangeProblem, sortHistory, type HistoryItem,
} from '../src/features/history/model.ts';

const h = (id: string, at: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
  id, at, actor: '팀장', taskKey: 'TASK-0007', kind: '생성', text: 'Task 생성', before: null, after: null, ref: null, ...extra,
});

const rows = [
  h('a', '2026-11-01T01:00:00.000Z', { actor: 'Runner', kind: '실행', text: 'ATT-0007-1 개발 실행 시작', before: '실행 대기', after: '실행 중' }),
  h('b', '2026-11-03T10:00:00.000Z', { actor: '팀장', kind: '승인', taskKey: 'TASK-0005', text: '착수 승인', before: '승인 대기', after: '실행 대기' }),
  h('c', '2026-11-03T10:00:00.000Z', { actor: 'Codex', kind: '검증', text: 'V-0007-1 QA FAIL', before: null, after: '재작업 필요' }),
  h('d', '2026-10-27T01:00:00.000Z', { taskKey: null, kind: '재계획', text: '재조정 RP-001' }),
];

describe('이력 화면 계산(UI-10, P hVM L6448–6460)', () => {
  it('최신순 — 같은 시각은 id 내림차순', () => {
    expect(sortHistory(rows).map((r) => r.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('유형·주체는 정확히 같은 값, Task ID는 부분 일치(대소문자 무시), 검색은 내용·전후 값', () => {
    expect(filterHistory(rows, { ...EMPTY_HISTORY_FILTER, kind: '실행' }).map((r) => r.id)).toEqual(['a']);
    expect(filterHistory(rows, { ...EMPTY_HISTORY_FILTER, actor: '팀장' }).map((r) => r.id)).toEqual(['b', 'd']);
    expect(filterHistory(rows, { ...EMPTY_HISTORY_FILTER, task: 'task-0005' }).map((r) => r.id)).toEqual(['b']);
    expect(filterHistory(rows, { ...EMPTY_HISTORY_FILTER, task: '0007' }).map((r) => r.id)).toEqual(['c', 'a']);
    expect(filterHistory(rows, { ...EMPTY_HISTORY_FILTER, q: '재작업' }).map((r) => r.id)).toEqual(['c']);
    expect(filterHistory(rows, { ...EMPTY_HISTORY_FILTER, q: 'att-0007' }).map((r) => r.id)).toEqual(['a']);
  });

  it('필터 선택지는 받은 이력에 실제로 있는 유형·주체만(중복 없이), 오래된 기록에 처음 나온 순서(원본과 같은 순서)', () => {
    expect(historyOptions(rows)).toEqual({ kinds: ['재계획', '실행', '승인', '검증'], actors: ['팀장', 'Runner', 'Codex'] });
  });

  it('건수 문구 — 원본과 같은 모양', () => {
    expect(countLabel(24, 24)).toBe('이력 24건');
    expect(countLabel(3, 24)).toBe('이력 3건 (전체 24건 중)');
    expect(countLabel(301, 301)).toBe('이력 301건 · 최신 300건 표시');
  });

  it('이전 → 이후: 둘 다 없으면 빈칸, 한쪽만 없으면 —', () => {
    expect(diffText(rows[0] as HistoryItem)).toBe('실행 대기 → 실행 중');
    expect(diffText(rows[2] as HistoryItem)).toBe('— → 재작업 필요');
    expect(diffText(rows[3] as HistoryItem)).toBe('');
  });

  it('기간은 서버 필터라 「조건 있음」에 들어간다(MM-18)', () => {
    expect(isFiltered(EMPTY_HISTORY_FILTER)).toBe(false);
    expect(isFiltered({ ...EMPTY_HISTORY_FILTER, from: '2026-11-01' })).toBe(true);
    expect(isFiltered({ ...EMPTY_HISTORY_FILTER, q: '  ' })).toBe(false);
  });

  it('끝 날짜가 시작보다 빠르면 서버에 보내지 않고 안내한다', () => {
    expect(rangeProblem('2026-11-05', '2026-11-01')).toBe('끝 날짜가 시작 날짜보다 빠릅니다.');
    expect(rangeProblem('2026-11-01', '2026-11-01')).toBeNull();
    expect(rangeProblem('', '2026-11-01')).toBeNull();
  });
});
