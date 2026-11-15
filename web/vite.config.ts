import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const target = 'http://127.0.0.1:4400';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        // the server rejects POSTs whose Origin is not its own
        configure: (proxy) => proxy.on('proxyReq', (req) => req.setHeader('origin', target)),
      },
    },
  },
});
