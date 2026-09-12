# ⚡ Fleet Fuel — Command Cheat Sheet

Every command, organized by what you're trying to do. Copy-paste ready.

| Context | Path / values |
|---|---|
| **Production app** | `/opt/fleet-fuel/app` |
| **Production env** | `/opt/fleet-fuel/.env` |
| **Backups** | `/opt/fleet-fuel/backups` |
| **Dev machine repo** | `~/fleet-fuel` (anywhere) |
| **Compose (prod)** | `sudo docker compose -p fleet-fuel --env-file /opt/fleet-fuel/.env -f docker-compose.yml -f docker-compose.prod.yml` |

> Abbreviated below as `$COMP` =
> `sudo docker compose -p fleet-fuel --env-file /opt/fleet-fuel/.env -f docker-compose.yml -f docker-compose.prod.yml`
> (run from `/opt/fleet-fuel/app`)

---

## 🥇 The only 3 commands you memorize

```bash
cd /opt/fleet-fuel/app
sudo ./scripts/deploy.sh        # install once, then this ships EVERY update
./scripts/status.sh             # is everything OK?
sudo ./scripts/backup.sh        # take a backup right now
```

---

## 1️⃣ First-time installation (one server, once)

```bash
# ── On your machine: push code to GitHub ─────────────────────────
git remote add origin git@github.com:YOUR-ORG/fleet-fuel.git
git push -u origin master && git push --tags

# ── On the server: one-time install ──────────────────────────────
git clone https://github.com/YOUR-ORG/fleet-fuel.git /tmp/fleet-fuel

sudo /tmp/fleet-fuel/scripts/install.sh \
  --repo https://github.com/YOUR-ORG/fleet-fuel.git \
  --domain fuel.example.com \
  --api-domain api.fuel.example.com \
  --token YOUR_CLOUDFLARE_TUNNEL_TOKEN
# → prints a generated admin password ONCE — save it

# Non-default ports (other services on this server):
sudo /tmp/fleet-fuel/scripts/install.sh ... \
  --web-port 8080 --api-port 8443 --postgres-port 15432
```

---

## 2️⃣ Deploy / update (after every code change)

```bash
cd /opt/fleet-fuel/app
sudo ./scripts/deploy.sh                # backup → pull → build → migrate → start → verify

# Variations
SKIP_GIT_PULL=1 sudo ./scripts/deploy.sh   # deploy working tree as-is (no git pull)
FORCE=1 sudo ./scripts/deploy.sh           # allow placeholder secrets (TEST ONLY)

# On a dev machine (no backup/migrations gates):
docker compose up -d --build            # postgres + backend(auto-migrates) + web
```

Deploy does, in order: checks (+port conflicts) → record release → `git pull` →
**pre-deploy backup** → build → postgres (wait healthy) → migrations → backend
(wait ready) → web → tunnel → final health check. **Never touches data volumes.**

---

## 3️⃣ Status & health

```bash
./scripts/status.sh                     # human-readable dashboard
./scripts/healthcheck.sh                # exit 0 = all good (CI-friendly)

# Individual endpoints
curl -s http://127.0.0.1:4000/api/health | jq        # API + DB (adjust API_PORT)
curl -s http://127.0.0.1:4000/api/health/live        # liveness
curl -s http://127.0.0.1:4000/api/health/ready       # readiness
curl -s http://127.0.0.1:3000/api/health | jq        # web

# Quick container glance
$COMP ps
docker ps --filter name=fleetfuel
```

---

## 4️⃣ Backups & restore

```bash
sudo ./scripts/backup.sh                    # backup now → prints path (last line)
sudo ./scripts/backup.sh --verify           # verify ALL archives are intact
sudo ./scripts/backup.sh --retention        # apply retention only (30d/12w/12m)

ls -1t /opt/fleet-fuel/backups/*.sql.gz     # list backups, newest first
cat /opt/fleet-fuel/backups/latest.sql.gz.sha256

# Restore — interactive (pick from list, type RESTORE to confirm)
sudo ./scripts/restore.sh
sudo ./scripts/restore.sh --latest                          # newest backup
sudo ./scripts/restore.sh /opt/fleet-fuel/backups/fleetfuel_2026-09-12_020000.sql.gz
sudo ./scripts/restore.sh <file> --yes                      # skip prompt (automation)
```

Restore automatically: verifies archive → safety-backups current DB → stops
backend/web → restores → verifies → restarts → health-checks.

---

## 5️⃣ Rollback a bad release

```bash
sudo ./scripts/rollback.sh                  # → previous recorded release
sudo ./scripts/rollback.sh a83f91c          # → specific commit/tag

# Data problem instead of code problem? Restore the pre-deploy backup:
cat /opt/fleet-fuel/app/.deploy/last-predeploy-backup   # path of last pre-deploy backup
sudo ./scripts/restore.sh "$(cat /opt/fleet-fuel/app/.deploy/last-predeploy-backup)"
# DB is NEVER auto-downgraded — migrations are forward-only by design.
```

---

## 6️⃣ Logs

```bash
$COMP logs -f backend                    # follow API logs
$COMP logs -f web                        # frontend
$COMP logs -f postgres                   # database
$COMP logs -f cloudflared                # tunnel
$COMP logs --tail=100 backend            # last 100 lines
$COMP logs --tail=50 postgres backend web cloudflared   # everything at once
docker logs fleetfuel-cloudflared 2>&1 | grep -i "registered\|error"
```

---

## 7️⃣ Ports (conflicts with other services)

```bash
# What's using a port?
sudo ss -ltnp | grep :3000               # or :4000 / :5432
sudo lsof -i :4000

# Change our ports — edit env, redeploy. Nothing else changes.
sudo nano /opt/fleet-fuel/.env
#     WEB_PORT=8080
#     API_PORT=8443
#     POSTGRES_PORT=15432
cd /opt/fleet-fuel/app && sudo ./scripts/deploy.sh   # preflight re-verifies first
```

Unaffected by host-port changes: tunnel URLs (`http://web:3000`,
`http://backend:4000` — container names), `DATABASE_URL` (container network),
mobile app (public URL), all scripts (read `.env`).

---

## 8️⃣ Database operations

```bash
# Migrations
$COMP run --rm --no-deps backend npm run migrate            # apply pending
$COMP run --rm --no-deps backend node src/db/migrate.js --down   # revert last (rare!)

# Seed (idempotent — safe to repeat, never overwrites data)
$COMP run --rm --no-deps backend npm run seed

# psql shell
$COMP exec postgres psql -U fleetfuel -d fleetfuel
# handy SQL:
#   SELECT * FROM inventory_transactions ORDER BY created_at DESC LIMIT 20;  -- ledger
#   SELECT count(*) FROM fuel_transactions;
#   SELECT max(name) FROM pgmigrations;                                      -- schema version

# Table sizes / DB size
$COMP exec postgres psql -U fleetfuel -d fleetfuel -c "
  SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
  FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;"
```

---

## 9️⃣ Docker lifecycle (data-safe)

```bash
$COMP restart                            # restart all (Test 1 — data survives)
$COMP up -d --build --force-recreate     # full recreate (Test 2 — data survives)
$COMP up -d --no-deps backend            # start one service
$COMP up -d --build backend              # rebuild + start one service
$COMP stop backend web                   # stop app (leave DB up) — used by restore
$COMP down                               # stop everything (KEEP containers' volumes!)

# ⛔ NEVER in production:            ⛔ NEVER:
$COMP down -v                              docker volume prune
$COMP volume rm fleetfuel_postgres_data    docker system prune --volumes

# Volumes exist? sizes?
docker volume ls | grep fleetfuel
docker system df -v | grep -A2 fleetfuel
```

---

## 🔟 Configuration changes

```bash
sudo nano /opt/fleet-fuel/.env

# ── After changing… ──────────────────────────────────────────────
# ports, domains, CORS, JWT, DB creds  →  sudo ./scripts/deploy.sh
# NEXT_PUBLIC_API_URL                  →  deploy (rebuild bakes it in)
# CLOUDFLARE_TUNNEL_TOKEN              →  deploy (starts cloudflared)
# backup retention (BACKUP_RETENTION_*)→  nothing (read each run)

# Verify what's live:
curl -s http://127.0.0.1:4000/api/system/version | jq
curl -s http://127.0.0.1:4000/api/health | jq '.version, .commit'
```

---

## 1️⃣1️⃣ Cloudflare Tunnel

```bash
# Status
$COMP ps cloudflared
docker logs --tail 30 fleetfuel-cloudflared          # want: "Registered tunnel connection"

# After changing routes/token in .env or the CF dashboard:
cd /opt/fleet-fuel/app && sudo ./scripts/deploy.sh
$COMP restart cloudflared                            # or just bounce it

# Tunnel dashboard: Zero Trust → Networks → Tunnels → fleet-fuel
#   fuel.example.com  →  http://web:3000
#   api.fuel.example.com  →  http://backend:4000
# (or via host ports: http://host.docker.internal:8080 / :8443)
```

---

## 1️⃣2️⃣ Local development (dev machine)

```bash
# Stack
cp .env.example .env                    # then edit secrets
docker compose up -d --build
docker compose -p fleet-fuel exec backend npm run seed     # demo data
docker compose logs -f backend

# Backend directly (faster iteration)
cd backend && npm install
ENV_FILE=../.env.dev-test npm run dev            # watch mode
ENV_FILE=../.env.dev-test npm test               # e2e suite (12 tests)
ENV_FILE=../.env.dev-test npm run migrate

# Web directly
cd web && npm install
npm run dev                                      # next dev, hot reload

# URLs: http://localhost:3000 (web) · http://localhost:4000/api/health (api)
```

---

## 1️⃣3️⃣ Mobile app

```bash
cd mobile
cp .env.example .env
# dev: EXPO_PUBLIC_API_URL=http://<YOUR-LAN-IP>:4000
# prod: EXPO_PUBLIC_API_URL=https://api.fuel.example.com
npm install
npx expo start                        # scan QR with Expo Go
npx expo run:android                  # dev build on device
```

Offline test: airplane mode → create request + issue → reconnect →
Sync tab → both appear **once** server-side (idempotent).

---

## 1️⃣4️⃣ GitHub & releases

```bash
git pull && sudo ./scripts/deploy.sh         # the standard update
git tag -a v1.4.2 -m "release" && git push --tags
git log --oneline -5
cd /opt/fleet-fuel/app && cat .deploy/last-deploy.json      # what's deployed
git status && git stash list                 # rollback may stash changes
```

---

## 🚨 Emergency runbook

| Symptom | Do this |
|---|---|
| **Site down** | `./scripts/status.sh` → `$COMP ps` → fix the red service |
| **Deploy failed at migrations** | Nothing lost — old release still running. `$COMP logs backend`, fix migration, re-run `deploy.sh` |
| **Bad release deployed** | `sudo ./scripts/rollback.sh` |
| **Data corrupted/deleted** | `sudo ./scripts/restore.sh` → pick newest good backup |
| **Port conflict at deploy** | Script tells you the variable → edit `.env` → re-run deploy |
| **Disk full** | `df -h` → `docker system df` → prune **unused** images: `docker image prune -a` (NEVER `--volumes`!) → check `/opt/fleet-fuel/backups` growth |
| **DB won't start** | `$COMP logs postgres` → `docker volume inspect fleetfuel_postgres_data` → `df -h` |
| **Tunnel connected, 502 errors** | Public hostname service URL wrong → must be `http://web:3000` / `http://backend:4000` |
| **Forgot admin password** | Another admin resets it via the Users page. No other admin? One-liner reset (see next row) |
| **Reset admin password via DB** | `docker exec -it fleetfuel-backend node -e "const b=require('bcryptjs');const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query('UPDATE users SET password_hash=\$1 WHERE email=\$2',[b.hashSync('NewTempPass123',12),'admin@fleetfuel.local']).then(()=>{console.log('reset OK');p.end()})"` → sign in with `NewTempPass123` → change it immediately (verified pattern) |
| **Server rebooted** | Do nothing — everything auto-starts. Verify: `./scripts/status.sh` |
| **API 503 "database disconnected"** | `$COMP logs postgres` · `pg_isready` inside container · restart postgres: `$COMP restart postgres` |

---

## ✅ Periodic checks (monthly)

```bash
sudo ./scripts/backup.sh --verify                     # backups intact?
ls -1t /opt/fleet-fuel/backups | head -5              # recent backups exist?
./scripts/healthcheck.sh                              # all green?
df -h /                                               # disk headroom?
docker system df                                      # docker bloat?
$COMP exec postgres psql -U fleetfuel -d fleetfuel -c "SELECT max(name) FROM pgmigrations;"
cd /opt/fleet-fuel/app && git fetch && git log HEAD..origin/master --oneline   # updates pending?
```

---

*Golden rule: `deploy.sh` replaces code, never data. If a script ever asks
you to type `RESTORE` or `y` — that's the only destructive gate there is.*
