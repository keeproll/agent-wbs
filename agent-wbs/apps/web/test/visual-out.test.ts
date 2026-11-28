/**
 * 재발 방지(subagent-tag 리뷰 5): 시각 비교·측정 결과의 기본 출력이 봇 보관 폴더를 가리키면,
 * 경로를 빠뜨린 실행이 옛 마일스톤 증거를 덮어쓴다. 기본은 저장소 밖 임시 폴더여야 하고 보관 폴더는 환경 변수로만 쓴다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const E2E = join(import.meta.dirname, '../e2e');
const files = [...readdirSync(E2E).map((f) => join(E2E, f)), ...readdirSync(join(E2E, 'support')).map((f) => join(E2E, 'support', f))].filter((f) => f.endsWith('.ts'));

describe('시각 비교 기본 출력 경로', () => {
  it('어떤 e2e 코드도 기본값(??)으로 봇 보관 폴더를 쓰지 않는다', () => {
    const bad = files.filter((f) => /\?\?[^\n;]*\.orca\/bots/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });

  it('visualOut: 환경 변수가 없으면 실행 폴더 아래, 있으면 그 경로', async () => {
    process.env.AWBS_VISUAL_RUN_DIR = '/tmp/awbs-visual-test-run';
    delete process.env.AWBS_TEST_OUT_X;
    const { visualOut } = await import('../e2e/support/visual.ts');
    expect(visualOut('AWBS_TEST_OUT_X', 'M9-99')).toBe('/tmp/awbs-visual-test-run/M9-99');
    process.env.AWBS_TEST_OUT_X = '/somewhere/archive';
    expect(visualOut('AWBS_TEST_OUT_X', 'M9-99')).toBe('/somewhere/archive');
    delete process.env.AWBS_TEST_OUT_X;
  });
});
