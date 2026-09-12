# Fleet Fuel Management System

Production-ready, **self-hosted** fleet fuel management: fuel requests, authorizations,
issues, bulk receipts, pump/tank readings, adjustments and a **permanent, reconstructible
fuel ledger** — with an offline-capable mobile app for pump attendants and managers.

| Layer      | Technology                                                        |
|------------|-------------------------------------------------------------------|
| Backend    | Node.js 20 + Express, PostgreSQL 16 (central authority)           |
| Web        | Next.js 14 (App Router)                                           |
| Mobile     | React Native (Expo) + SQLite (offline queue + cache)              |
| Deployment | Docker Compose, GitHub, Cloudflare Tunnel, Ubuntu Server          |

**→ New here? Follow the complete walkthrough: [DEPLOY.md — Step-by-Step Deployment Guide](DEPLOY.md)**
**→ Daily driving? [CHEATSHEET.md — Command Cheat Sheet](CHEATSHEET.md)**
**→ Mobile app rollout? [MOBILE.md — Mobile Deployment Guide](MOBILE.md)**

---

## The one rule that drives this architecture

> **A deployment may replace containers, images, and application code — it must
> never replace, reset, or delete the production PostgreSQL database, uploaded
> files, fuel ledger, inventory history, audit history, or any other persistent
> business data.**

How this is enforced:

- PostgreSQL data lives in the **named volume `fleetfuel_postgres_data`** — never in
  a container filesystem, never in the Git working tree.
- Uploaded documents live in the **named volume `fleetfuel_uploads`**.
- Backups are written **outside all containers** (default `/opt/fleet-fuel/backups`)
  and a verified pre-deployment backup is taken **before every update**.
- Schema changes are **forward-only migrations** (node-pg-migrate) tracked in the
  database; running migrations twice is a safe no-op.
- `docker compose down -v`, `volume prune`, `DROP DATABASE`, `TRUNCATE`, and any
  seed-overwrite are **never** part of the deployment path. Seeds are idempotent and
  refuse to touch existing data.
- All operational history (fuel transactions, ledger entries, audit logs, users) is
  **append-only**: corrections happen through documented reversals/adjustments, never
  through deletion.

---

## Architecture

```text
                    ┌───────────────────────┐
                    │        GitHub         │  application source
                    └───────────┬───────────┘
                                │  git pull (scripts/deploy.sh)
                                ▼
                    ┌───────────────────────┐
                    │    Ubuntu Server      │
                    │      Docker           │
                    │ ┌───────────────────┐ │
                    │ │ cloudflared       │ │  outbound-only tunnel
                    │ └────────┬──────────┘ │
                    │ ┌────────▼──────────┐ │
                    │ │ Next.js Web :3000 │ │  localhost-only
                    │ └────────┬──────────┘ │
                    │ ┌────────▼──────────┐ │
                    │ │ Express API :4000 │ │  localhost-only
                    │ └────────┬──────────┘ │
                    │ ┌────────▼──────────┐ │
                    │ │ PostgreSQL :5432  │ │  localhost-only
                    │ │ PERSISTENT VOLUME │ │
                    │ └───────────────────┘ │
                    │ volumes: db, uploads  │
                    │ /opt/fleet-fuel/backups│
                    └───────────────────────┘
                          ▲            ▲
              https://fuel.example.com |
                          |            ▼
                 Manager Web   https://api.fuel.example.com
                                       │
                     ┌─────────────────┴──────────────┐
                     │   Manager Mobile   Attendant Mobile │
                     │        (Expo, SQLite offline queue) │
                     └─────────────────────────────────────┘
```

- **No inbound ports are opened on the router.** `cloudflared` connects *outbound*
  to Cloudflare; visitors reach the app through the tunnel.
- Web, API and PostgreSQL bind to `127.0.0.1` only in production. The database is
  never exposed publicly.
- Mobile apps talk to the same public API domain and keep working offline via a
  local SQLite queue that replays **idempotently** (`POST /api/sync/batch`).

---

## Repository structure

```text
fleet-fuel/
├── backend/                 Express API
│   ├── src/
│   │   ├── routes/          health, auth, users, vehicles, fuel-types, tanks,
│   │   │                    pumps, requests, transactions, inventory, ledger,
│   │   │                    sync, system
│   │   ├── services/        ledger engine, shared ops (REST+sync), audit, numbering
│   │   ├── middleware/      auth (JWT+roles), validation, errors
│   │   └── db/              pool, advisory-locked migration runner
│   ├── migrations/          node-pg-migrate, forward-only, transactional
│   ├── seeds/               idempotent dev/first-install seed
│   ├── tests/               end-to-end API test suite
│   ├── docker/entrypoint.sh wait-for-db → migrate → start
│   └── Dockerfile           multi-stage, non-root, healthcheck
├── web/                     Next.js 14 frontend (standalone Docker build)
├── mobile/                  Expo app (expo-router, expo-sqlite offline engine)
├── docker/postgres/         first-boot init scripts (run once, ever)
├── scripts/                 install | deploy | backup | restore | rollback | status | healthcheck
├── .github/workflows/       ci.yml (+ optional manual deploy.yml)
├── docker-compose.yml       base (dev-friendly)
├── docker-compose.prod.yml  production override (tunnel, localhost-only, backups)
├── .env.example             every configuration variable, documented
└── README.md
```

---

## Quick start (developer machine)

Prereqs: Docker + Docker Compose, Node 20 (for API tests).

```bash
git clone https://github.com/ORGANIZATION/fleet-fuel.git
cd fleet-fuel
cp .env.example .env                 # then edit: passwords, JWT secret
docker compose up -d --build         # postgres + backend (auto-migrates) + web
docker compose -p fleet-fuel exec backend npm run seed   # optional demo data
```

- Web:  http://localhost:3000
- API:  http://localhost:4000/api/health

Run the API test suite (needs the API running):

```bash
cd backend && npm test
```

> The **production** command is *not* `docker compose up` — it is
> `./scripts/deploy.sh`, which adds pre-deploy backup, migrations, health gates
> and tunnel startup (see below).

---

## Production installation (one time)

On a fresh Ubuntu 22.04/24.04 server:

```bash
git clone https://github.com/ORGANIZATION/fleet-fuel.git /tmp/fleet-fuel
sudo /tmp/fleet-fuel/scripts/install.sh \
  --repo https://github.com/ORGANIZATION/fleet-fuel.git \
  --domain fuel.example.com \
  --api-domain api.fuel.example.com \
  --token <CLOUDFLARE_TUNNEL_TOKEN>
```

`install.sh` verifies Ubuntu → installs Docker/Compose/git → creates
`/opt/fleet-fuel/{app,backups,uploads,logs}` → clones the repo → **generates
`/opt/fleet-fuel/.env` with strong random secrets** → installs a 02:00 nightly
backup cron → runs the first deployment → seeds an admin **only if the database
is empty**. At the end it prints the generated admin password (once — store it).

### Cloudflare Tunnel setup (5 minutes, no port forwarding)

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel**
   → name it `fleet-fuel` → copy the token.
2. Put the token in `/opt/fleet-fuel/.env` as `CLOUDFLARE_TUNNEL_TOKEN=…`
   (or pass `--token` to `install.sh`).
3. In the tunnel's **Public Hostname** tab add two routes:

   | Public hostname        | Service             |
   |------------------------|---------------------|
   | `fuel.example.com`     | `http://web:3000`   |
   | `api.fuel.example.com` | `http://backend:4000` |

4. `./scripts/deploy.sh` (or wait for the restart policy) brings up cloudflared
   with the token. Verify with `./scripts/status.sh`.

> Single-domain alternative: route only `fuel.example.com` → `http://web:3000`
> and serve the API under a path rewrite (`/api/* → http://backend:4000/api/*`)
> in the same tunnel config; then set `NEXT_PUBLIC_API_URL=https://fuel.example.com`.

---

## Daily operations

| Task                    | Command                          |
|-------------------------|----------------------------------|
| Deploy/update (ONE cmd) | `./scripts/deploy.sh`            |
| Status                  | `./scripts/status.sh`            |
| Health check            | `./scripts/healthcheck.sh`       |
| Backup now              | `./scripts/backup.sh`            |
| Verify backups          | `./scripts/backup.sh --verify`   |
| Restore (interactive)   | `./scripts/restore.sh`           |
| Rollback app release    | `./scripts/rollback.sh`          |
| Logs                    | `docker compose logs -f backend` |
| Run pending migrations  | `docker compose run --rm backend npm run migrate` |

`deploy.sh` performs, in order: prerequisite checks → record previous release →
`git pull --ff-only` → **pre-deployment backup** → build images → start postgres
(wait healthy) → **run pending migrations** → start backend (wait ready) → start
frontend → start cloudflared → health check → summary + URLs.
Any failure aborts with the old containers still serving and the backup path on screen.

### Rollback policy

`./scripts/rollback.sh` returns **application code** to the previous commit and
restarts. The **database is intentionally never downgraded** — migrations are
forward-only and reversing them risks data loss. For data recovery use the
pre-deploy backup: `./scripts/restore.sh .deploy/last-predeploy-backup`.
Write migrations to stay compatible with the release currently in production
(add columns/tables first, remove them in a later release).

### Backup retention (configurable in `.env`)

- `BACKUP_RETENTION_DAILY=30` — every backup from the last 30 days
- `BACKUP_RETENTION_WEEKLY=12` — the newest backup of each ISO week, 12 weeks
- `BACKUP_RETENTION_MONTHLY=12` — the newest backup of each month, 12 months
- Cleanup never deletes the newest backup and never leaves zero backups.

---

## Environment variables

Copy `.env.example` → `.env` (development) or let `install.sh` generate
`/opt/fleet-fuel/.env` (production). `.env` is git-ignored — **never commit it**.

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `production` refuses placeholder secrets at startup |
| `POSTGRES_*`, `DATABASE_URL` | database credentials (compose + backend) |
| `POSTGRES_BIND` / `API_BIND` / `WEB_BIND` | **must be `127.0.0.1` in production** |
| `JWT_SECRET` | long random string (`openssl rand -hex 32`) |
| `CORS_ORIGIN` | browser origin allow-list (never `*` in production) |
| `NEXT_PUBLIC_API_URL` | public API URL, baked into the web bundle at build |
| `WEB_DOMAIN` / `API_DOMAIN` | public hostnames (docs, status output) |
| `CLOUDFLARE_TUNNEL_TOKEN` | tunnel token; deploy refuses to start cloudflared without it |
| `BACKUP_DIR`, `BACKUP_RETENTION_*` | backup location and retention policy |
| `EXPO_PUBLIC_API_URL` | mobile app API URL (mobile/.env) — never localhost in production |

Changing `NEXT_PUBLIC_API_URL` requires a rebuild (`deploy.sh` always passes the
current value as a build argument).

---

## Roles

| Role | Capabilities |
|------|--------------|
| `admin` | everything: users, configuration, all operations |
| `manager` | approve/reject requests, issue, receipts, adjustments, reversals, reports |
| `attendant` | create requests, issue fuel against approved requests, record readings |

## Domain model (permanent data)

- **Fuel ledger** = append-only `inventory_transactions`
  (`opening | receipt | issue | adjustment | reversal`) with a running
  `balance_after` stamp. Reconstructible from PostgreSQL at any time; opening +
  receipts + adjustments + reversals − issues = closing balance, always.
- **Fuel transactions** are immutable; reversal creates a compensating pair
  (original marked `reversed` + a reversal transaction + a positive ledger entry).
- **Requests → authorizations** workflow is fully audited (`audit_logs`).
- Master data (vehicles, tanks, pumps, fuel types, users) is **never deleted** —
  only deactivated. `DELETE` endpoints intentionally return an error.

---

## Mobile app (offline-first)

```bash
cd mobile
cp .env.example .env          # set EXPO_PUBLIC_API_URL (dev: your LAN IP)
npm install
npx expo start
```

- **SQLite is the local operational store only.** PostgreSQL is the central
  authority for authorizations, users, roles, inventory, the ledger and final
  transactions.
- All reads render from the local cache (instant, offline).
- All writes are appended to an on-device outbox in SQLite, then replayed via
  `POST /api/sync/batch`. Every op carries an `op_id`/`client_uuid`; the server
  applies it **exactly once** — replays return `duplicate` and are dropped.
  Permanent validation failures are parked per-op (never retried forever).
- Auto-sync triggers: after login, when connectivity returns (NetInfo), every
  5 minutes, and manually from the Sync tab.
- Queued ops survive app restart and device restart.

Production build: set `EXPO_PUBLIC_API_URL=https://api.fuel.example.com`, then
`npx expo run:android` / `run:ios`, or use EAS Build.

---

## Data-safety acceptance tests

Run these after first deployment — they are the contract this repo must keep:

```bash
# 1. Container restart — data survives
docker compose restart && ./scripts/status.sh

# 2. Container recreation — data survives
docker compose -p fleet-fuel --env-file /opt/fleet-fuel/.env \
  -f docker-compose.yml -f docker-compose.prod.yml up -d --build --force-recreate

# 3. GitHub update — data survives
git pull && ./scripts/deploy.sh

# 4. Server reboot — everything auto-starts (restart: unless-stopped)
sudo reboot

# 5. Backup restores
./scripts/backup.sh && ./scripts/restore.sh --latest

# 6. Offline mobile — airplane mode → record request + issue → reconnect
#    → both appear once in the web console (no duplicates)
```

After test 3, verify in the web UI: vehicles, fuel types, requests,
authorizations, transactions, inventory, ledger balance and audit history are
all unchanged; `./scripts/status.sh` reports every service healthy.

## API surface (summary)

```
GET  /api/health            full health (db status, version, commit)
GET  /api/health/live|ready liveness / readiness (Docker gates)
POST /api/auth/login        → JWT
GET  /api/auth/me
CRUD /api/users             (admin; deactivate-only)
CRUD /api/vehicles /api/fuel-types /api/tanks /api/pumps
GET/POST /api/requests      + POST /:id/approve|reject|cancel
GET  /api/transactions      + POST /issue  + POST /:id/reverse
GET  /api/inventory/stock   + POST /receipts /adjustments /readings /uploads
GET  /api/ledger            + /api/ledger/summary (opening→closing)
POST /api/sync/batch        mobile offline replay (idempotent)
GET  /api/sync/pull         authoritative snapshot/delta for devices
GET  /api/system/version    version, commit, migrations, uptime
```

## Security notes

- Containers run non-root, minimal alpine images, with healthchecks and
  `restart: unless-stopped`.
- JWT (HS256, 12 h), bcrypt password hashing (cost 12), login rate limiting.
- CORS is an explicit allow-list; no `*` in production. Native apps unaffected.
- Production refuses to boot with placeholder secrets (`CHANGE_THIS`).
- The tunnel is outbound-only; no database, API or web port is publicly reachable.
- Backups are `chmod 700` directory, checksummed, and verified after every dump.

## Troubleshooting

| Symptom | Check |
|---|---|
| `deploy.sh` fails at migrations | old release still running; read the error, fix the migration, re-run `./scripts/deploy.sh` |
| Tunnel "no registration" | `docker logs fleetfuel-cloudflared` — token valid? routes saved in Zero Trust? |
| Backend 503 on `/api/health` | `docker compose logs postgres` — volume full? `df -h` |
| Web shows API errors | `NEXT_PUBLIC_API_URL` baked at build — redeploy after changing it |
| Mobile can't connect | `EXPO_PUBLIC_API_URL` set? reachable from the device (not localhost)? |
| Restore refused | archive corrupt? `./scripts/backup.sh --verify` lists bad archives |

---

## License

MIT — see [LICENSE](LICENSE).
