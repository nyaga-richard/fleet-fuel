// ============================================================================
// 007 — §37: per-user notification preferences (category → enabled/disabled).
// ============================================================================
export const up = (pgm) => {
  pgm.sql("ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{}'");
};
export const down = (pgm) => {
  pgm.sql('ALTER TABLE users DROP COLUMN IF EXISTS notification_prefs');
};
