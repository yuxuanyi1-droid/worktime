import path from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  root: repoRoot,
  define: {
    __BASE_PATH__: JSON.stringify(''),
    __BASE_URL__: JSON.stringify('/'),
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^react$/, replacement: path.join(repoRoot, 'client/node_modules/react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: path.join(repoRoot, 'client/node_modules/react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: path.join(repoRoot, 'client/node_modules/react/jsx-dev-runtime.js') },
      { find: /^react-dom$/, replacement: path.join(repoRoot, 'client/node_modules/react-dom/index.js') },
      { find: /^react-dom\/test-utils$/, replacement: path.join(repoRoot, 'client/node_modules/react-dom/test-utils.js') },
      { find: /^echarts\/core$/, replacement: path.join(repoRoot, 'client/node_modules/echarts/core.js') },
      { find: /^echarts\/charts$/, replacement: path.join(repoRoot, 'client/node_modules/echarts/charts.js') },
      { find: /^echarts\/components$/, replacement: path.join(repoRoot, 'client/node_modules/echarts/components.js') },
      { find: /^echarts\/renderers$/, replacement: path.join(repoRoot, 'client/node_modules/echarts/renderers.js') },
      { find: /^@testing-library\/react$/, replacement: path.join(repoRoot, 'client/node_modules/@testing-library/react/dist/index.js') },
      { find: /^@testing-library\/jest-dom\/vitest$/, replacement: path.join(repoRoot, 'client/node_modules/@testing-library/jest-dom/dist/vitest.mjs') },
      { find: /^@testing-library\/user-event$/, replacement: path.join(repoRoot, 'client/node_modules/@testing-library/user-event/dist/esm/index.js') },
      { find: /^react-router-dom$/, replacement: path.join(repoRoot, 'client/node_modules/react-router-dom/dist/index.js') },
      { find: '@client', replacement: path.join(repoRoot, 'client/src') },
      { find: '@', replacement: path.join(repoRoot, 'client/src') },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['tests/client/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/client/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'tests/coverage/client',
      reporter: ['text', 'html', 'json-summary'],
      include: ['client/src/**/*.{ts,tsx}'],
      exclude: [
        'client/src/**/*.d.ts',
        'client/src/main.tsx',
      ],
    },
  },
});
