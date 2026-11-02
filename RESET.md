# Full Database Reset — Clean Start (admin user only)

> ⚠️ **This permanently deletes everything** in the database: every user
> account, vehicle, tank, pump, request, fuel transaction, **ledger entry and
> audit history**. The only way back is the backup the script writes **before**
> touching anything. The tool is manual-only — deploys, restarts and startup
> jobs can never trigger it. If you only want to undo a bad deploy, use
> `scripts/rollback.sh` instead — do NOT reset.

What you end up with: **exactly one admin login**, an empty, fully-migrated
schema, and untouched uploaded files (the `uploads` volume is *not* cleared —
delete those manually if you also want them gone).

---

## Step 0 — Prep (5 minutes, do not skip)

1. **Deploy the latest build first** so the reset tool and the current fixes
   are on the server:
   ```bash
   cd /opt/fleet-fuel/app && sudo git pull && sudo ./scripts/deploy.sh
   ```
2. **Check every phone's outbox is empty.** Open the app → **Sync tab**:
   - `Pending` must be **0** and there must be **no failed items**.
   - Anything pending exists *only* on that phone. Resetting the server (or
     clearing the app) before it syncs = **that fueling record is gone.**
   - If items are pending: Sync now. If they show errors, fix the cause
     (the exact server reason is printed under each item) or use
     **RESET & RETRY FAILED** — do not continue until the queue drains.
3. **Confirm a real admin password is configured** (the seed refuses to
   create a production admin with a default/blank password):
   ```bash
   grep SEED_ADMIN_PASSWORD /opt/fleet-fuel/.env   # must show a strong value
   ```
   To change it: edit `/opt/fleet-fuel/.env`, then it applies at reset time.

## Step 1 — Reset the server database

```bash
cd /opt/fleet-fuel/app
sudo bash scripts/reset-db.sh            # interactive — you type RESET
# or, scripted / non-interactive:
sudo bash scripts/reset-db.sh --yes --bare
```

- `--bare` leaves **only the admin user** (also removes the seeded
  Diesel/Petrol reference fuel types). Omit it if you want Diesel/Petrol kept.
- The script auto-detects the docker install, takes a gzip backup to
  `/opt/fleet-fuel/backups/pre-reset-<timestamp>.sql.gz` (same mechanism as
  the nightly backup), drops and recreates the schema, re-applies all
  migrations **forward**, seeds the one admin, and prints row counts.

Expected result:

```
 users         : 1
 fuel_types    : 0      (--bare; 2 without it)
 vehicles      : 0
 tanks         : 0
 pumps         : 0
 requests      : 0
 transactions  : 0
 ledger        : 0
 readings      : 0
 audit         : 0
 sync_log      : 0
```

No restart is needed — the API keeps serving against the fresh schema.

## Step 2 — Log in and change the password

1. Open the web console, log in with `SEED_ADMIN_EMAIL` /
   `SEED_ADMIN_PASSWORD` from `/opt/fleet-fuel/.env`.
2. **Change the admin password immediately** (Profile → change password).

## Step 3 — Rebuild master data (web console)

In this order (each step needs the previous one):

1. **Fuel types** (Configuration → Fuel types)
2. **Tanks** — assign fuel type + capacity (Inventory → Tanks)
3. **Pumps** — assign each to its tank (Inventory → Pumps)
4. **Vehicles** (Fleet)
5. **Staff users** — least privilege: attendants get **Pump Attendant**,
   managers **Fleet Manager**; admin only for administrators.

## Step 4 — Reset every phone

The phones still hold their old local cache and outbox, which now reference
deleted rows — they **must** be cleared, and they must run a build that
includes the fresh-install startup fix (commit `9cd7815` or later).

**Android:** Settings → Apps → Fleet Fuel → Storage → **Clear storage**
(or uninstall, then install the latest APK).
**iOS:** delete the app, reinstall.

Then on each phone: log in (start with admin to create that device's user if
needed) → pull down on Home to sync → verify the Home screen shows the tanks
and stock you created in Step 3.

---

## Local development (native postgres, no docker)

```bash
cd ~/path/to/fleet-fuel
FLEET_ENV_FILE=$PWD/.env.dev-test bash scripts/reset-db.sh --bare --yes
```

## Getting the old data back

Every reset leaves a timestamped backup first:
`/opt/fleet-fuel/backups/pre-reset-*.sql.gz`. Restoring is itself destructive,
so it is **never automatic** — use your restore flow with explicit operator
confirmation (see DEPLOY.md), or manually:

```bash
gunzip -c /opt/fleet-fuel/backups/pre-reset-XXXX.sql.gz \
  | sudo docker compose -p fleet-fuel --env-file /opt/fleet-fuel/.env \
      exec -T postgres psql -U fleetfuel -d fleetfuel
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Seed refuses: "Refusing to seed production without SEED_ADMIN_PASSWORD" | Set a strong `SEED_ADMIN_PASSWORD` in `/opt/fleet-fuel/.env`, re-run the reset. |
| `Docker daemon is not running` | `sudo systemctl start docker`, re-run. |
| Phone keeps failing to sync after reset | It was not cleared (Step 4) — its outbox references deleted rows. Clear storage and log in again. |
| Backup file missing | The script aborts before touching the DB if the backup comes out empty — check disk space in `$BACKUP_DIR`. |
