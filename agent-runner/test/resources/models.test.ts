import { describe, expect, test } from 'vitest';
import { claudeModels, collectModels, parseClaudeEfforts, parseCodexCatalog } from '../../src/resources/models.ts';
import type { RunCommand } from '../../src/readiness/command.ts';

const level = (effort: string) => ({ effort, description: `${effort} 설명` });
// `codex debug models --bundled` 출력 형식(0.172.0에서 확인한 필드만, 값은 축약)
const catalog = {
  models: [
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', priority: 7, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(level) },
    { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(level), shell_type: 'x' },
    { slug: 'gpt-daybreak-red-latest', display_name: 'Daybreak Red', visibility: 'hide', priority: 12, supported_reasoning_levels: [level('low')] },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 13, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map(level) },
  ],
};

describe('parseCodexCatalog — 모델별 CLI Effort 값(contracts §3.1, Q-06)', () => {
  test('목록에 보이는 모델만, 우선순위가 앞설수록 rank가 높다', () => {
    expect(parseCodexCatalog(JSON.stringify(catalog))).toEqual([
      { id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', rank: 3, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna', rank: 2, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'gpt-5.5', label: 'GPT-5.5', rank: 1, efforts: ['low', 'medium', 'high', 'xhigh'] },
    ]);
  });

  test('CLI 값은 받은 그대로 보낸다 — 공통 단계 매핑·ultra 제외는 서버 승인표가 한다', () => {
    const [top] = parseCodexCatalog(JSON.stringify(catalog));
    expect(top?.efforts).toContain('ultra');
  });

  test('Effort 목록이 없거나 비면 null(미확인)', () => {
    const json = JSON.stringify({
      models: [
        { slug: 'a', display_name: 'A', visibility: 'list', priority: 1 },
        { slug: 'b', display_name: 'B', visibility: 'list', priority: 2, supported_reasoning_levels: [] },
      ],
    });
    expect(parseCodexCatalog(json).map((m) => m.efforts)).toEqual([null, null]);
  });

  test('중복 Effort 값은 한 번만', () => {
    const json = JSON.stringify({ models: [{ slug: 'a', display_name: 'A', visibility: 'list', priority: 1, supported_reasoning_levels: [level('low'), level('low')] }] });
    expect(parseCodexCatalog(json)[0]?.efforts).toEqual(['low']);
  });

  test('이름이 없으면 slug를 이름으로 쓴다', () => {
    const json = JSON.stringify({ models: [{ slug: 'a', visibility: 'list', priority: 1 }] });
    expect(parseCodexCatalog(json)[0]?.label).toBe('a');
  });

  test.each(['{깨짐', '{}', '{"models":[{"display_name":"x"}]}'])('형식이 다르면 추정하지 않고 오류: %s', (text) => {
    expect(() => parseCodexCatalog(text)).toThrow();
  });
});

describe('parseClaudeEfforts — `claude --help`의 --effort 줄', () => {
  const help = [
    '  --disallowedTools <tools...>          Comma or space-separated list',
    '  --effort <level>                      Effort level for the current session',
    '                                        (low, medium, high, xhigh, max)',
    '  --environment <environment_id>        Create a new cloud session',
  ].join('\n');

  test('줄이 넘어가도 괄호 안 값을 낮은 순으로 읽는다', () => {
    expect(parseClaudeEfforts(help)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
  test('한 줄에 있어도 읽는다', () => {
    expect(parseClaudeEfforts('  --effort <level>  Effort level (low, high)\n  --x')).toEqual(['low', 'high']);
  });
  test('--effort가 없거나 값 목록이 없으면 null', () => {
    expect(parseClaudeEfforts('  --model <model>  Model\n')).toBeNull();
    expect(parseClaudeEfforts('  --effort <level>  Effort level\n  --model <m> (a, b)\n')).toBeNull();
  });
});

describe('claudeModels — CLI에 모델 목록 명령이 없어 설정의 모델 ID를 쓴다', () => {
  test('앞에 적은 모델일수록 rank가 높고 Effort는 도움말 값', () => {
    expect(claudeModels(['claude-opus-5-5', 'claude-sonnet-5-5'], ['low', 'max'])).toEqual([
      { id: 'claude-opus-5-5', label: 'claude-opus-5-5', rank: 2, efforts: ['low', 'max'] },
      { id: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5', rank: 1, efforts: ['low', 'max'] },
    ]);
  });
  test('빈 ID·중복은 버린다', () => {
    expect(claudeModels([' ', 'a', 'a'], null)).toEqual([{ id: 'a', label: 'a', rank: 1, efforts: null }]);
  });
});

describe('collectModels — 무료 로컬 명령만 부른다', () => {
  const run = (outputs: Record<string, { code: number; stdout: string }>) => {
    const calls: string[] = [];
    const fn: RunCommand = (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      const o = outputs[key];
      return Promise.resolve(o ? { ...o, stderr: '' } : { code: 127, stdout: '', stderr: 'not found' });
    };
    return { fn, calls };
  };

  test('Codex는 `codex debug models --bundled`(갱신 없이 동봉 목록)', async () => {
    const r = run({ 'codex debug models --bundled': { code: 0, stdout: JSON.stringify(catalog) } });
    const body = await collectModels('Codex', { run: r.fn, codex: 'codex', claude: 'claude', claudeModelIds: [] });
    expect(r.calls).toEqual(['codex debug models --bundled']);
    expect(body).toMatchObject({ agent: 'Codex', models: [{ id: 'gpt-6.2-sol' }, { id: 'gpt-6-luna' }, { id: 'gpt-5.5' }] });
  });

  test('Claude는 `claude --help`', async () => {
    const r = run({ 'claude --help': { code: 0, stdout: '  --effort <level>  Effort (low, medium)\n' } });
    const body = await collectModels('Claude', { run: r.fn, codex: 'codex', claude: 'claude', claudeModelIds: ['claude-opus-5-5'] });
    expect(r.calls).toEqual(['claude --help']);
    expect(body).toEqual({ agent: 'Claude', models: [{ id: 'claude-opus-5-5', label: 'claude-opus-5-5', rank: 1, efforts: ['low', 'medium'] }] });
  });

  test('명령이 실패하면 보고하지 않는다(null) — 빈 목록을 보내 기존 모델을 지우지 않는다', async () => {
    const r = run({});
    expect(await collectModels('Codex', { run: r.fn, codex: 'codex', claude: 'claude', claudeModelIds: [] })).toBeNull();
    expect(await collectModels('Claude', { run: r.fn, codex: 'codex', claude: 'claude', claudeModelIds: ['x'] })).toBeNull();
  });

  test('Claude 모델 ID 설정이 없으면 보고하지 않는다(모델 ID 하드코딩 금지, G §9.3-1)', async () => {
    const r = run({ 'claude --help': { code: 0, stdout: '--effort <l> (low)' } });
    expect(await collectModels('Claude', { run: r.fn, codex: 'codex', claude: 'claude', claudeModelIds: [] })).toBeNull();
    expect(r.calls).toEqual([]);
  });

  test('목록에 보이는 모델이 하나도 없으면 보고하지 않는다(계약 minItems 1)', async () => {
    const hidden = { models: [{ slug: 'h', visibility: 'hide', priority: 1 }] };
    const r = run({ 'codex debug models --bundled': { code: 0, stdout: JSON.stringify(hidden) } });
    expect(await collectModels('Codex', { run: r.fn, codex: 'codex', claude: 'claude', claudeModelIds: [] })).toBeNull();
  });
});
