import { expect, test } from 'vitest';
import { NO_PROJECT_NAME, reportProjectName, UNKNOWN_PROJECT_NAME } from '@awbs/shared';

test('보고서 제목의 프로젝트 이름은 스냅샷 값이다', () => {
  expect(reportProjectName({ projectName: 'Agent WBS' })).toBe('Agent WBS');
  expect(reportProjectName({ projectName: 'Agent WBS', projectNameFilled: { source: 'current' } })).toBe('Agent WBS');
});

test('이름을 알 수 없는 옛 보고서(0047 unknown)는 「이름 미상(기존 보고서)」, 표시 없이 이름이 없으면 「프로젝트 이름 없음」', () => {
  expect(reportProjectName({ projectNameFilled: { source: 'unknown' } })).toBe(UNKNOWN_PROJECT_NAME);
  expect(UNKNOWN_PROJECT_NAME).toBe('이름 미상(기존 보고서)');
  expect(reportProjectName({})).toBe(NO_PROJECT_NAME);
  expect(reportProjectName({ projectName: null })).toBe('프로젝트 이름 없음');
  expect(reportProjectName({ projectName: '  ' })).toBe('프로젝트 이름 없음');
});
