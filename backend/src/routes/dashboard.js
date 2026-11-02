// ─────────────────────────────────────────────────────────────────────────────
// Dashboard aggregates — small, fast endpoints that power the dashboard
// widgets for EVERY signed-in role (no reports:view needed).
//
// GET /usage?days=90 → [{ date, station, external }] — daily litres issued at
// the station (completed, non-reversed fuel transactions) and external fuel
// purchases (§48: separate sources, one chart). Missing days are zero-filled
// so the series is continuous.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncH } from '../middleware/errors.js';

const router = Router();
router.use(requireAuth);

router.get('/usage', asyncH(async (req, res) => {
  let days = Number(req.query.days ?? 90);
  if (!Number.isFinite(days)) days = 90;
  days = Math.min(180, Math.max(7, Math.floor(days)));

  const { rows } = await pool.query(
    `WITH calendar AS (
        SELECT generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, interval '1 day')::date AS d
     ),
     station AS (
        SELECT created_at::date AS d, SUM(quantity)::float AS litres
          FROM fuel_transactions
         WHERE status = 'completed' AND reversal_of IS NULL
           AND created_at::date >= CURRENT_DATE - ($1::int - 1)
         GROUP BY 1
     ),
     external AS (
        SELECT transaction_date::date AS d, SUM(quantity)::float AS litres
          FROM external_fuel_entries
         WHERE transaction_date::date >= CURRENT_DATE - ($1::int - 1)
         GROUP BY 1
     )
     SELECT to_char(c.d, 'YYYY-MM-DD') AS date,
            COALESCE(s.litres, 0)::float AS station,
            COALESCE(e.litres, 0)::float AS external
       FROM calendar c
       LEFT JOIN station s ON s.d = c.d
       LEFT JOIN external e ON e.d = c.d
      ORDER BY c.d`, [days]);

  // Per-fuel-type split for the donut card (last 30 days, both sources).
  const { rows: byFuel } = await pool.query(
    `SELECT ft.name, COALESCE(SUM(x.litres), 0)::float AS litres
       FROM (SELECT fuel_type_id, quantity AS litres FROM fuel_transactions
              WHERE status = 'completed' AND reversal_of IS NULL
                AND created_at::date >= CURRENT_DATE - 29
             UNION ALL
             SELECT fuel_type_id, quantity FROM external_fuel_entries
              WHERE transaction_date::date >= CURRENT_DATE - 29) x
       JOIN fuel_types ft ON ft.id = x.fuel_type_id
      GROUP BY ft.name ORDER BY litres DESC`);

  res.json({ days, series: rows, by_fuel_type: byFuel });
}));

export default router;
