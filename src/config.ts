/**
 * Public endpoint configuration.
 *
 * These are NOT secrets — they are visible in every browser network tab
 * regardless of where they're defined. Real secrets (the Massive API key)
 * remain in .env, untouched by this file.
 *
 * Editing this file directly (instead of .env) lets the custom relay
 * domain be changed without needing a rebuild pipeline that re-reads
 * environment variables.
 */
export const RELAY_WS_URL   = 'wss://relay.helios-insiders.com';
export const RELAY_REST_URL = 'https://relay.helios-insiders.com';
