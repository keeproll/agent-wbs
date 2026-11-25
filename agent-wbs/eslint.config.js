import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const noCrossApp = (group, message) => ({
  'no-restricted-imports': ['error', { patterns: [{ group, message }] }],
});

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/test-results/**', '**/playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  { languageOptions: { globals: globals.node } },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...noCrossApp(
        ['@awbs/api', '@awbs/api/*', '@awbs/db', '@awbs/db/*', '**/apps/api/**', '**/../api/src/**'],
        'web은 api·db를 직접 import하지 않는다. 공통 항목은 @awbs/shared에 둔다.',
      ),
    },
  },
  {
    files: ['apps/api/**/*.ts'],
    rules: noCrossApp(
      ['@awbs/web', '@awbs/web/*', '**/apps/web/**', '**/../web/src/**'],
      'api는 web을 import하지 않는다.',
    ),
  },
  {
    files: ['packages/**/*.ts'],
    rules: noCrossApp(
      ['@awbs/api', '@awbs/web', '**/apps/**'],
      'packages는 apps를 import하지 않는다.',
    ),
  },
);
