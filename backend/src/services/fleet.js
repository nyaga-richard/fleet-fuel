// ============================================================================
// Fleet services (§8/§43): the authoritative odometer trail. Every mileage
// event (fuel issue, external fuel, trip completion, manual) lands here once
// (dedupe_key), and the vehicle's current_odometer only ever moves forward.
// ============================================================================
import { ApiError } from '../middleware/errors.js';

export async function recordOdometer(client, { vehicleId, odometer, source, refTable, refId, enteredBy, at }) {
  if (!vehicleId || odometer == null || !Number.isFinite(Number(odometer))) return null;
  const odo = Number(odometer);
  const dedupe = `odo:${source}:${refId}`;
  const { rows } = await client.query(
    `INSERT INTO vehicle_odometer_history
       (vehicle_id, odometer, source, ref_table, ref_id, dedupe_key, entered_by, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now()))
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [vehicleId, odo, source, refTable ?? null, refId ?? null, dedupe, enteredBy ?? null, at ?? null]);
  // Current odometer is a high-water mark: rollbacks are history, not state (§41).
  await client.query(
    `UPDATE vehicles SET current_odometer = GREATEST(current_odometer, $2), updated_at = now() WHERE id = $1`,
    [vehicleId, odo]);
  return rows[0]?.id ?? null;
}

export async function checkOdometerProgression(client, vehicleId, odometer, at) {
  if (odometer == null) return;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(odometer), 0)::float AS max_odo FROM vehicle_odometer_history
      WHERE vehicle_id = $1 AND recorded_at <= COALESCE($2::timestamptz, now())`, [vehicleId, at ?? null]);
  if (rows.length && Number(odometer) < Number(rows[0].max_odo) - 0.5) {
    throw new ApiError(400, `Odometer regression: a later record shows ${rows[0].max_odo} km. Correct the reading or record a correction instead.`);
  }
}

// Wheel positions per axle configuration (§12).
export const POSITIONS = {
  '4x2': ['FL', 'FR', 'RL', 'RR'],
  '4x4': ['FL', 'FR', 'RL', 'RR'],
  '6x2': ['FL', 'FR', 'RLO', 'RLI', 'RRO', 'RRI'],
  '6x4': ['FL', 'FR', 'RLO', 'RLI', 'RRO', 'RRI'],
  '8x4': ['FL', 'FR', 'MLO', 'MLI', 'MRO', 'MRI', 'RLO', 'RLI', 'RRO', 'RRI'],
};
export const POSITION_LABELS = {
  FL: 'Front Left', FR: 'Front Right',
  RL: 'Rear Left', RR: 'Rear Right',
  RLO: 'Rear Left Outer', RLI: 'Rear Left Inner',
  RRO: 'Rear Right Outer', RRI: 'Rear Right Inner',
  MLO: 'Mid Left Outer', MLI: 'Mid Left Inner',
  MRO: 'Mid Right Outer', MRI: 'Mid Right Inner',
};
