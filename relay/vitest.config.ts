import { defineConfig } from 'vitest/config';

export default defineConfig({
  /**
   * Stops Vite walking up to the repo root and loading the FRONTEND's
   * postcss.config.js (which requires tailwindcss, not a dependency here).
   * The engine is server-side and processes no CSS at all.
   */
  css: { postcss: {} },

  test: {
    environment: 'node',
    include: ['engine/**/*.test.ts'],

    /**
     * Dummy credentials so importing the engine tree does not trip
     * config.assertConfig(), which throws when SUPABASE_URL / SUPABASE_ANON_KEY
     * are absent.
     *
     * That fail-fast is deliberate and must stay: an empty credential produces
     * a Supabase client that looks healthy and silently returns nothing. These
     * values exist only to let the module graph load — no test performs a real
     * query, and ENGINE_MODE stays unset (therefore 'shadow'), so every write
     * path is intercepted rather than executed even if one were reached.
     */
    env: {
      SUPABASE_URL:      'http://localhost/shadow-test',
      SUPABASE_ANON_KEY: 'test-anon-key',
      MASSIVE_API_KEY:   'test-massive-key',
    },
  },
});
