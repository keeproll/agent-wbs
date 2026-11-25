import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // 두 시스템은 소스를 공유하지 않는다(architecture §1-4).
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/agent-wbs/**', '@awbs/*'], message: 'WBS 소스를 import하지 않는다.' }] },
      ],
    },
  },
);
