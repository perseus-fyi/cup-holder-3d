import { defineConfig } from 'vite';

// manifold-3d грузит свой .wasm; исключаем из пре-бандла, чтобы Vite не ломал
// относительный locateFile (мы передаём URL через ?url в manifold-setup.ts).
export default defineConfig({
  base: './',
  optimizeDeps: {
    exclude: ['manifold-3d'],
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    target: 'es2021',
    chunkSizeWarningLimit: 2000,
  },
});
