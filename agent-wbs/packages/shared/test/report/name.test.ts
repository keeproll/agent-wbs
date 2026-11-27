import { expect, test } from 'vitest';
import { NO_PROJECT_NAME, reportProjectName, UNKNOWN_PROJECT_NAME } from '@awbs/shared';

test('보고서 제목의 프로젝트 이름은 스냅샷 값이다(생성 때 기록·0038(옛 0047)이 채움)', () => {
  expect(reportProjectName({ projectName: 'Agent WBS', projectNameStatus: 'snapshot' })).toBe('Agent WBS');
  expect(reportProjectName({ projectName: 'Agent WBS', projectNameStatus: 'filled' })).toBe('Agent WBS');
});

test('이름 미상(unknown, projectName null)은 「이름 미상(기존 보고서)」, 계약에 맞지 않게 이름이 없으면 「프로젝트 이름 없음」', () => {
  expect(reportProjectName({ projectName: null, projectNameStatus: 'unknown' })).toBe(UNKNOWN_PROJECT_NAME);
  expect(UNKNOWN_PROJECT_NAME).toBe('이름 미상(기존 보고서)');
  expect(reportProjectName({})).toBe(NO_PROJECT_NAME);
  expect(reportProjectName({ projectName: '  ', projectNameStatus: 'snapshot' })).toBe('프로젝트 이름 없음');
});
