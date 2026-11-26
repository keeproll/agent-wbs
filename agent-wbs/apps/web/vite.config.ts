import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', 'AWBS_');
  const api = `http://127.0.0.1:${env.AWBS_PORT ?? 3100}`;
  return {
    plugins: [react()],
    // 워크스페이스 패키지(@awbs/shared)를 dist가 아닌 소스로 읽는다.
    resolve: { conditions: ['awbs-source', ...defaultClientConditions] },
    server: {
      host: '127.0.0.1',
      port: Number(env.AWBS_WEB_PORT ?? 5173),
      strictPort: true,
      proxy: { '/api': api },
    },
    // E2E(실제 API 연결 시험)는 preview 서버도 /api를 API로 넘긴다.
    preview: { host: '127.0.0.1', strictPort: true, proxy: { '/api': process.env.AWBS_E2E_API ?? api } },
  };
});
