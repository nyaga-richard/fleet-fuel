-- Demo data — 90-day operating series for the sandbox (deterministic).
-- Run after `npm run migrate` + SEED_DEMO_DATA seed, BEFORE demo-ledger-backfill.sql.
-- Creates, for the seeded vehicle/tank/fuel type:
--   • 90 daily DIRECT_ENTRY fuel transactions (TXN-DEMO-###) with a steadily
--     progressing odometer, ending today
--   • 90 matching external fuel entries (vehicle history only — never touches
--     station stock or the Station Fuel Ledger, §2–§7)
-- Idempotent: skipped entirely if demo transactions already exist.

DO $$
DECLARE
  v_vehicle uuid;  v_tank uuid;  v_ftype uuid;  v_user uuid;  v_pump uuid;
  d int;  ts timestamptz;  qty numeric;  odo numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM fuel_transactions WHERE txn_no LIKE 'TXN-DEMO-%') THEN
    RAISE NOTICE 'demo series already present — skipping';
    RETURN;
  END IF;

  SELECT id INTO v_vehicle FROM vehicles ORDER BY created_at LIMIT 1;
  SELECT id INTO v_ftype  FROM fuel_types WHERE code = 'DIESEL' LIMIT 1;
  SELECT id INTO v_tank   FROM tanks WHERE fuel_type_id = v_ftype ORDER BY created_at LIMIT 1;
  SELECT id INTO v_user   FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1;
  SELECT id INTO v_pump   FROM pumps ORDER BY created_at LIMIT 1;

  FOR d IN 1..90 LOOP
    ts  := (CURRENT_DATE - (91 - d))::timestamptz + interval '08:30' + (d % 7) * interval '17 min';
    qty := 120 + ((d * 37) % 276);              -- deterministic 120–395 L
    odo := 118000 + d * 180 + (d % 5) * 7;      -- steady daily progression

    INSERT INTO fuel_transactions
      (txn_no, request_id, authorization_id, vehicle_id, fuel_type_id, tank_id, pump_id,
       quantity, unit_price, unit_cost, operator_id, odometer, status, client_uuid, lpo_no,
       source, created_at)
    VALUES
      ('TXN-DEMO-' || lpad(d::text, 3, '0'), NULL, NULL, v_vehicle, v_ftype, v_tank, v_pump,
       qty, 165.50, 165.50, v_user, odo, 'completed',
       md5('demo-txn-' || d)::uuid, NULL,
       'DIRECT_ENTRY', ts);

    INSERT INTO external_fuel_entries
      (vehicle_id, fuel_type_id, supplier, quantity, unit_price, odometer,
       transaction_date, entered_by, client_uuid, created_at)
    VALUES
      (v_vehicle, v_ftype, 'External Dealer', 30 + ((d * 13) % 71), 168.00, odo + 90,
       ts + interval '6 hours', v_user, md5('demo-ext-' || d)::uuid, ts + interval '6 hours');
  END LOOP;

  RAISE NOTICE 'demo series inserted: 90 direct entries + 90 external entries';
END $$;
