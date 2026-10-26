import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  cacheDir: '.vite-cache',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
    assetsInlineLimit: 0,
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.ISLAND_DEV_PORT) || 5230,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: Number(process.env.ISLAND_PREVIEW_PORT) || 5231,
    strictPort: true,
  },
});
