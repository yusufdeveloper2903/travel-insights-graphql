import { defineConfig } from 'vitest/config';

// graphql@17 ships a "development" export condition. Vite enables it by default, but
// externalized deps (graphql-yoga, @graphql-tools) are loaded by Node without it, which would
// put two graphql realms in one process. Resolve exactly like Node does in production.
const conditions = ['module-sync', 'node', 'import', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/index.ts'],
    },
  },
});
