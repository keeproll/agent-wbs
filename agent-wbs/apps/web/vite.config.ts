import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', 'AWBS_');
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: Number(env.AWBS_WEB_PORT ?? 5173),
      strictPort: true,
      proxy: { '/api': `http://127.0.0.1:${env.AWBS_PORT ?? 3100}` },
    },
    preview: { host: '127.0.0.1', strictPort: true },
  };
});
