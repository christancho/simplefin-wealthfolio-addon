import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    // Pinned so date handling is actually exercised against a UTC-negative
    // zone. Left to the machine, the suite would pass in UTC CI while the
    // one-day display shift this addon has already hit went undetected.
    env: { TZ: 'America/Toronto' },
  },
});
