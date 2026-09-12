// ============================================================================
// Central configuration — all values come from environment variables.
// In production, values are injected by Docker Compose (from /opt/fleet-fuel/.env).
// For local development, this module transparently loads the repo-root .env.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv(file) {
  try {
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* env file is optional */
  }
}

// Local dev: repo-root .env (backend runs with cwd=backend/). Docker sets
// every variable explicitly, and existing process env always wins.
loadDotEnv(process.env.ENV_FILE || path.resolve(process.cwd(), '../.env'));
loadDotEnv(path.resolve(process.cwd(), '.env'));

const env = process.env;

export const config = {
  env: env.NODE_ENV || 'development',
  isProduction: (env.NODE_ENV || 'development') === 'production',

  port: Number(env.PORT || env.API_PORT || 4000),
  databaseUrl: env.DATABASE_URL || '',

  jwtSecret: env.JWT_SECRET || '',
  jwtExpiresIn: env.JWT_EXPIRES_IN || '12h',

  // Comma-separated allow-list; native/mobile clients send no Origin and
  // are always allowed (CORS does not apply to them).
  corsOrigins: (env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),

  version: env.APP_VERSION || '1.0.0',
  commit: env.GIT_COMMIT || 'unknown',
  branch: env.GIT_BRANCH || 'unknown',
  buildDate: env.BUILD_DATE || 'unknown',
  timezone: env.TZ || 'UTC',

  uploadsDir: env.UPLOADS_DIR || path.resolve(process.cwd(), 'uploads'),
  maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024),

  seedAdmin: {
    email: (env.SEED_ADMIN_EMAIL || 'admin@fleetfuel.local').toLowerCase(),
    name: env.SEED_ADMIN_NAME || 'Administrator',
    password: env.SEED_ADMIN_PASSWORD || '',
  },
};

// Fail fast on insecure production configuration.
if (config.isProduction) {
  const problems = [];
  if (!config.databaseUrl) problems.push('DATABASE_URL is not set');
  if (!config.jwtSecret || config.jwtSecret.toUpperCase().includes('CHANGE_THIS')) {
    problems.push('JWT_SECRET must be set to a long random secret (openssl rand -hex 32)');
  }
  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: refusing to start with insecure production configuration:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
}

if (!fs.existsSync(config.uploadsDir)) {
  try { fs.mkdirSync(config.uploadsDir, { recursive: true }); } catch { /* read-only fs in dev */ }
}
