import { defineConfig } from 'vite';

// 纯前端应用：Worker 使用 Vite 原生 `new Worker(new URL(...), { type: 'module' })` 打包
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  worker: {
    format: 'es',
  },
  server: {
    host: '127.0.0.1',
    port: 5188,
  },
});
