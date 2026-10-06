import { defineConfig } from 'vite';

// base './' keeps asset URLs relative, so the build works under /<repo>/ on GitHub Pages.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', chunkSizeWarningLimit: 700 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
