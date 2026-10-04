import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const API = 'http://127.0.0.1:4317';

export default defineConfig({
  root: path.resolve(__dirname, 'web'),
  plugins: [react()],
  resolve: {
    alias: { '@shared': path.resolve(__dirname, 'shared') },
  },
  server: {
    port: 5317,
    strictPort: true,
    fs: { allow: [path.resolve(__dirname)] },
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/media': { target: API, changeOrigin: true },
      '/ws': { target: API, ws: true },
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
  },
});
