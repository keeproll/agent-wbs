import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: [
  'test/{secrets,redact,log,config,app-isolation,app-github-retry,runner-public-key}.test.ts',
  'test/api/*.test.ts',
  'test/github/*.test.ts',
  'test/cli/{env,isolation,isolation-scripts,dedicated-user}.test.ts',
  'test/git/{agent-boundary,agent-permissions,agent-git-hang,agent-access-inventory,inputs}.test.ts',
  'test/ci/{ci-task,ci-night,ci-night-review,ci-deploy-review}.test.ts',
] } });
