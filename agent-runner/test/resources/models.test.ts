import { describe, expect, test } from 'vitest';
import { DEFAULT_MODEL_SETTINGS, claudeModels, collectModels, parseClaudeEfforts, parseCodexCatalog } from '../../src/resources/models.ts';
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
  test('목록에 보이는 모델만 보내고 rank는 싣지 않는다(계약 보완: 순서는 서버 설정값)', () => {
    expect(parseCodexCatalog(JSON.stringify(catalog))).toEqual([
      { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
    ]);
  });

  test('CLI 값은 받은 그대로 보낸다 — 공통 단계 매핑·ultra 제외는 서버 승인표가 한다', () => {
    const sol = parseCodexCatalog(JSON.stringify(catalog)).find((m) => m.id === 'gpt-6.2-sol');
    expect(sol?.efforts).toContain('ultra');
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

describe('계약 보완(2026-11-26 아이템 8) — Runner는 rank를 보내지 않고 Claude 목록은 서버 정책을 쓴다', () => {
  test('어떤 보고에도 rank 필드가 없다', async () => {
    const run: RunCommand = (cmd) => Promise.resolve({ code: 0, stdout: cmd === 'codex' ? JSON.stringify(catalog) : '--effort <l> (low)', stderr: '' });
    for (const agent of ['Codex', 'Claude'] as const) {
      const body = await collectModels(agent, { run, codex: 'codex', claude: 'claude' });
      expect(body?.models.every((m) => !('rank' in m))).toBe(true);
    }
  });

  test('Claude: 정책을 받기 전에는 Q-06 승인표의 모델을 대체값으로 쓴다', async () => {
    const run: RunCommand = () => Promise.resolve({ code: 0, stdout: '  --effort <level>  Effort (low, max)\n', stderr: '' });
    const body = await collectModels('Claude', { run, codex: 'codex', claude: 'claude' });
    expect(body?.models.map((m) => m.id)).toEqual(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(DEFAULT_MODEL_SETTINGS.claudeModelIds).toEqual(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  });

  test('Claude: 서버 정책의 claudeModels를 주면 그 목록만 보고한다', async () => {
    const run: RunCommand = () => Promise.resolve({ code: 0, stdout: '--effort <l> (low)', stderr: '' });
    const body = await collectModels('Claude', { run, codex: 'codex', claude: 'claude', claudeModelIds: ['claude-new-6'] });
    expect(body).toEqual({ agent: 'Claude', models: [{ id: 'claude-new-6', label: 'claude-new-6', efforts: ['low'] }] });
  });

  test('입력 배열을 바꾸지 않는다(freeze한 배열로 확인)', () => {
    const claude = Object.freeze(['b', 'a']);
    expect(claudeModels(claude, null).map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('Claude Effort 출처를 설정으로 바꿀 수 있다', () => {
  test("claudeEfforts: 'unknown'이면 도움말을 부르지 않고 efforts를 null(미확인)로 보낸다", async () => {
    const calls: string[] = [];
    const run: RunCommand = (cmd, args) => (calls.push([cmd, ...args].join(' ')), Promise.resolve({ code: 0, stdout: '--effort <l> (low)', stderr: '' }));
    const body = await collectModels('Claude', { run, codex: 'codex', claude: 'claude', claudeModelIds: ['m'], claudeEfforts: 'unknown' });
    expect(body).toEqual({ agent: 'Claude', models: [{ id: 'm', label: 'm', efforts: null }] });
    expect(calls).toEqual([]);
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
  test('받은 순서 그대로, Effort는 도움말 값', () => {
    expect(claudeModels(['claude-opus-5-5', 'claude-sonnet-5-5'], ['low', 'max'])).toEqual([
      { id: 'claude-opus-5-5', label: 'claude-opus-5-5', efforts: ['low', 'max'] },
      { id: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5', efforts: ['low', 'max'] },
    ]);
  });
  test('빈 ID·중복은 버린다', () => {
    expect(claudeModels([' ', 'a', 'a'], null)).toEqual([{ id: 'a', label: 'a', efforts: null }]);
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
    expect(body).toMatchObject({ agent: 'Codex', models: [{ id: 'gpt-6-luna' }, { id: 'gpt-6.2-sol' }, { id: 'gpt-5.5' }] });
  });

  test('Claude는 `claude --help`의 Effort를 설정 모델에 붙인다(Q-06: 단계는 CLI 도움말)', async () => {
    const r = run({ 'claude --help': { code: 0, stdout: '  --effort <level>  Effort (low, medium)\n' } });
    const body = await collectModels('Claude', { run: r.fn, codex: 'codex', claude: 'claude', claudeModelIds: ['claude-opus-5-5'] });
    expect(r.calls).toEqual(['claude --help']);
    expect(body).toEqual({ agent: 'Claude', models: [{ id: 'claude-opus-5-5', label: 'claude-opus-5-5', efforts: ['low', 'medium'] }] });
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
