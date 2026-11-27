import { expect, test } from 'vitest';
import { NO_PROJECT_NAME, reportProjectName } from '@awbs/shared';

test('보고서 제목의 프로젝트 이름은 스냅샷 값이고, 없으면 「프로젝트 이름 없음」이다(옛 보고서)', () => {
  expect(reportProjectName({ projectName: 'Agent WBS' })).toBe('Agent WBS');
  expect(reportProjectName({})).toBe(NO_PROJECT_NAME);
  expect(reportProjectName({ projectName: null })).toBe('프로젝트 이름 없음');
  expect(reportProjectName({ projectName: '  ' })).toBe('프로젝트 이름 없음');
});
