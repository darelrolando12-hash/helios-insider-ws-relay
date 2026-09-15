import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const baseCdnUrl = env.BASE_CDN_URL?.trim();
  const normalizedBaseCdnUrl = baseCdnUrl && !baseCdnUrl.endsWith('/') ? `${baseCdnUrl}/` : baseCdnUrl;

  return {
    // Absolute, NOT './'. The router serves nested paths (/chart/:ticker,
    // /zerod/:ticker); a relative base makes the browser resolve
    // ./assets/index.js against /chart/ and 404 the whole bundle.
    base: normalizedBaseCdnUrl ?? '/',
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'framer-motion',
        '@react-three/fiber',
        '@react-three/drei',
        'three',
        'react-router-dom',
        '@supabase/supabase-js',
      ],
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
      allowedHosts: true, // 允许所有主机访问（E2B 动态域名）
    },
  };
});
