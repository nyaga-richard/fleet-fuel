// ============================================================================
// Push delivery (§40) — Expo push API, best effort by design.
//
// Notifications are the durable record (§29); push is just the doorbell:
//   • a failed/blocked Expo call NEVER fails the business transaction
//   • pushes queued inside an open transaction are held until the tx
//     commits (flushPushes() on response finish) — a rollback can never
//     ring the bell for something that didn't happen (§46)
//   • no extra infrastructure: plain HTTPS to exp.host, no Redis/queue
// ============================================================================
import { pool } from '../db/pool.js';

const EXPO_PUSH_URL = process.env.EXPO_PUSH_URL || 'https://exp.host/--/api/v2/push/send';
const CHUNK = 99; // Expo accepts up to 100 notifications per request

const pending = [];

export function queuePush(n) {
  if (!n || !n.userId) return;
  pending.push(n);
}

async function sendChunk(messages) {
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(messages),
  });
  if (!res.ok) throw new Error(`expo push ${res.status}`);
  const out = await res.json().catch(() => null);
  const errs = (out?.data || []).filter((r) => r?.status === 'error').map((r) => r.errors?.[0]?.message || 'error');
  if (errs.length) console.warn(`[push] ${errs.length} receipt error(s):`, errs.slice(0, 3).join('; '));
}

/** Fire queued pushes for every user that has an active registered device. */
export async function flushPushes() {
  if (!pending.length) return;
  const batch = pending.splice(0, pending.length);
  try {
    const userIds = [...new Set(batch.map((n) => n.userId))];
    const { rows } = await pool.query(
      'SELECT user_id, push_token FROM push_devices WHERE active = true AND push_token IS NOT NULL AND user_id = ANY($1::uuid[])',
      [userIds],
    );
    const byUser = new Map(rows.map((r) => [r.user_id, r.push_token]));
    const messages = [];
    for (const n of batch) {
      const to = byUser.get(n.userId);
      if (!to) continue;
      messages.push({
        to,
        title: n.title || 'Fleet Fuel',
        body: n.body || n.message || '',
        data: n.data || {},
        sound: 'default',
        channelId: 'default',
      });
    }
    for (let i = 0; i < messages.length; i += CHUNK) {
      await sendChunk(messages.slice(i, i + CHUNK));
    }
  } catch (e) {
    console.warn('[push] delivery skipped (non-fatal):', e.message);
  }
}
