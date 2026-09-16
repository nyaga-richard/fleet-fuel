// ============================================================================
// Wheel configuration master data (§1–§8). Configurations live in the
// database — the frontend NEVER hardcodes wheel positions. Position codes
// (§5) are stable identifiers (A2-L-O); display names are cosmetic and can
// change without breaking historical data. Legacy seeded codes (FL, RLO…)
// remain valid codes for the system configurations.
// ============================================================================
import { bad } from '../middleware/errors.js';
import { pool as defaultPool } from '../db/pool.js';

const AXLE_TYPES = ['STEERING', 'DRIVE', 'TRAILING', 'TAG'];
const SIDES = ['LEFT', 'RIGHT'];
const WHEEL_POSITIONS = ['INNER', 'OUTER', 'SINGLE'];
const AXLE_WORDS = ['Front', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
const SIDE_WORDS = { LEFT: 'Left', RIGHT: 'Right' };
export const POSITIONS_BY_CONFIG_SQL = `
  SELECT p.position_code, p.display_name, p.axle_number, p.axle_type, p.side,
         p.wheel_position, p.sort_order
    FROM wheel_configuration_positions p`;

/** Default display name from structure (§3/§4): "Rear Left Outer". */
function defaultDisplay(axleNumber, axleCount, side, wheelPosition) {
  let axleWord;
  if (axleNumber === 1) axleWord = 'Front';
  else if (axleNumber === axleCount) axleWord = axleCount === 2 ? 'Rear' : 'Rear';
  else axleWord = AXLE_WORDS[axleNumber - 1] || `Axle ${axleNumber}`;
  const pos = wheelPosition === 'SINGLE' ? '' : ` ${wheelPosition.charAt(0)}${wheelPosition.slice(1).toLowerCase()}`;
  return `${axleWord} ${SIDE_WORDS[side]}${pos}`.replace(/\s+/g, ' ').trim();
}

/** Stable position code (§5): A{axle}-{L|R}[-{I|O}] — never a display name. */
export function positionCode(axleNumber, side, wheelPosition) {
  const base = `A${axleNumber}-${side === 'LEFT' ? 'L' : 'R'}`;
  if (wheelPosition === 'INNER') return `${base}-I`;
  if (wheelPosition === 'OUTER') return `${base}-O`;
  return base;
}

/**
 * Validate a configuration payload (§8) and return a normalized structure.
 * Rejects: duplicate position codes, duplicate axle numbers/gaps, missing
 * sides, odd/insufficient wheel counts, duplicate tire positions, invalid
 * axle types. Positions may omit display_name and position_code (generated).
 */
export function normalizeConfiguration(payload) {
  const code = String(payload.code || '').trim().toUpperCase();
  if (!code || code.length > 12) throw bad('Configuration code is required (max 12 chars, e.g. 6x4)');
  const name = String(payload.name || '').trim() || `${code} — Wheel Configuration`;
  const axlesIn = Array.isArray(payload.axles) ? payload.axles : null;
  if (!axlesIn || !axlesIn.length) throw bad('At least one axle is required');
  if (axlesIn.length > 8) throw bad('A configuration can have at most 8 axles');

  const seenAxleNumbers = new Set();
  const seenCodes = new Set();
  const seenSlots = new Set();
  const axles = [];
  let sort = 0;

  for (const a of axlesIn) {
    const axleNumber = Number(a.axle_number ?? a.axleNumber);
    if (!Number.isInteger(axleNumber) || axleNumber < 1 || axleNumber > 8) throw bad('Axle numbers must be integers 1–8');
    if (seenAxleNumbers.has(axleNumber)) throw bad(`Duplicate axle number ${axleNumber} (§8)`);
    seenAxleNumbers.add(axleNumber);
    const axleType = String(a.axle_type ?? a.type ?? '').toUpperCase();
    if (!AXLE_TYPES.includes(axleType)) throw bad(`Axle ${axleNumber}: type must be one of ${AXLE_TYPES.join(', ')}`);

    const positionsIn = Array.isArray(a.positions) ? a.positions : [];
    if (!positionsIn.length) throw bad(`Axle ${axleNumber} has no wheel positions`);
    const sides = new Set(positionsIn.map((p) => String(p.side ?? '').toUpperCase()));
    for (const s of sides) if (!SIDES.includes(s)) throw bad(`Axle ${axleNumber}: side must be LEFT or RIGHT`);
    if (!SIDES.every((s) => sides.has(s))) throw bad(`Axle ${axleNumber} is missing a side — every axle needs LEFT and RIGHT (§8)`);

    const positions = [];
    for (const p of positionsIn) {
      const side = String(p.side ?? '').toUpperCase();
      const wheelPosition = String(p.wheel_position ?? p.position ?? 'SINGLE').toUpperCase();
      if (!WHEEL_POSITIONS.includes(wheelPosition)) throw bad(`Axle ${axleNumber}: wheel position must be INNER, OUTER or SINGLE`);
      const slot = `${axleNumber}|${side}|${wheelPosition}`;
      if (seenSlots.has(slot)) throw bad(`Duplicate tire position: axle ${axleNumber} ${side} ${wheelPosition} (§8)`);
      seenSlots.add(slot);
      let pc = String(p.position_code ?? p.code ?? '').trim().toUpperCase();
      if (!pc) pc = positionCode(axleNumber, side, wheelPosition);
      if (!/^[A-Z0-9-]{2,8}$/.test(pc)) throw bad(`Position code "${pc}" is invalid (2–8 chars, letters/digits/dashes)`);
      if (seenCodes.has(pc)) throw bad(`Duplicate position code "${pc}" (§8)`);
      seenCodes.add(pc);
      const display = String(p.display_name ?? p.display ?? '').trim() || defaultDisplay(axleNumber, axlesIn.length, side, wheelPosition);
      positions.push({ axle_number: axleNumber, axle_type: axleType, side, wheel_position: wheelPosition, position_code: pc, display_name: display, is_required: p.is_required !== false, sort_order: sort++ });
    }
    axles.push({ axle_number: axleNumber, axle_type: axleType, positions });
  }

  // Axle numbers must be 1..N with no gaps (deterministic front→rear order).
  const ordered = [...axles].sort((x, y) => x.axle_number - y.axle_number);
  ordered.forEach((a, i) => { if (a.axle_number !== i + 1) throw bad('Axle numbers must be sequential starting at 1 (§8)'); });

  const wheelCount = axles.reduce((a, x) => a + x.positions.length, 0);
  if (wheelCount < 2) throw bad('A configuration needs at least 2 wheels');
  if (wheelCount % 2 !== 0) throw bad(`Invalid wheel count: ${wheelCount} — wheel counts must be even (§8)`);

  return { code, name, axles: ordered, wheel_count: wheelCount, axle_count: axles.length };
}

export async function insertConfiguration(client, normalized, { isSystem = false, notes = null } = {}) {
  const { rows: cfg } = await client.query(
    `INSERT INTO wheel_configurations (code, name, axles, wheel_count, is_active, is_system, notes)
     VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING *`,
    [normalized.code, normalized.name, normalized.axle_count, normalized.wheel_count, isSystem, notes]);
  const id = cfg[0].id;
  for (const a of normalized.axles) {
    await client.query(
      `INSERT INTO wheel_configuration_axles (configuration_id, axle_number, axle_type) VALUES ($1,$2,$3)`,
      [id, a.axle_number, a.axle_type]);
    for (const p of a.positions) {
      await client.query(
        `INSERT INTO wheel_configuration_positions
           (configuration_id, axle_number, axle_type, side, wheel_position, position_code, display_name, is_required, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, p.axle_number, p.axle_type, p.side, p.wheel_position, p.position_code, p.display_name, p.is_required, p.sort_order]);
    }
  }
  return cfg[0];
}

/** Full configuration (header + axles + positions), or null. */
export async function loadConfiguration(client, id) {
  const db = client || defaultPool;
  const { rows } = await db.query('SELECT * FROM wheel_configurations WHERE id = $1', [id]);
  if (!rows.length) return null;
  const configuration = rows[0];
  const { rows: axleRows } = await db.query(
    'SELECT * FROM wheel_configuration_axles WHERE configuration_id = $1 ORDER BY axle_number', [id]);
  const { rows: posRows } = await db.query(
    `${POSITIONS_BY_CONFIG_SQL} WHERE p.configuration_id = $1 ORDER BY p.sort_order`, [id]);
  return {
    configuration,
    axles: axleRows.map((a) => ({ ...a, positions: posRows.filter((p) => p.axle_number === a.axle_number) })),
    positions: posRows,
  };
}

/** The effective position structure for a vehicle row (config-driven; the
 *  legacy in-code map is only a last-resort fallback for unlinked rows). */
export async function positionsForVehicle(client, vehicle) {
  const db = client || defaultPool;
  if (vehicle.wheel_configuration_id) {
    const cfg = await loadConfiguration(db, vehicle.wheel_configuration_id);
    if (cfg) return cfg.positions;
  }
  // Fallback mirrors the pre-master-data behaviour for rows created before
  // migration 010 that could not be backfilled.
  const legacy = {
    '4x2': ['FL', 'FR', 'RL', 'RR'], '4x4': ['FL', 'FR', 'RL', 'RR'],
    '6x2': ['FL', 'FR', 'RLO', 'RLI', 'RRO', 'RRI'], '6x4': ['FL', 'FR', 'RLO', 'RLI', 'RRO', 'RRI'],
    '8x4': ['FL', 'FR', 'MLO', 'MLI', 'MRO', 'MRI', 'RLO', 'RLI', 'RRO', 'RRI'],
  };
  const { rows } = await db.query(
    `SELECT p.position_code, p.display_name, p.axle_number, p.axle_type, p.side,
            p.wheel_position, p.sort_order
       FROM wheel_configurations w
       JOIN wheel_configuration_positions p ON p.configuration_id = w.id
      WHERE w.code = $1 ORDER BY p.sort_order`, [vehicle.axle_config || '4x2']);
  if (rows.length) return rows;
  return (legacy[vehicle.axle_config] || legacy['4x2']).map((code, i) => ({ position_code: code, display_name: code, sort_order: i }));
}
