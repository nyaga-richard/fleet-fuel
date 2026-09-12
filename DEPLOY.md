# Step-by-Step Deployment Guide

Complete walkthrough: from a fresh **Ubuntu Server** to a live Fleet Fuel
Management System reachable at your own domains through **Cloudflare Tunnel** —
including what to do when **other services already occupy the default ports**.

> **Ports in one sentence:** every host port (`POSTGRES_PORT`, `API_PORT`,
> `WEB_PORT`) is configurable in the `.env`; the deploy script **checks ports
> before touching anything**; container-internal ports, the Cloudflare Tunnel
> service URLs, and the mobile app URL never need to change.

---

## Table of contents

- [Part 0 — What you need](#part-0--what-you-need)
- [Part 1 — Push the code to GitHub](#part-1--push-the-code-to-github)
- [Part 2 — Prepare the Ubuntu server](#part-2--prepare-the-ubuntu-server)
- [Part 3 — Create the Cloudflare Tunnel](#part-3--create-the-cloudflare-tunnel)
- [Part 4 — Run the installer](#part-4--run-the-installer)
- [Part 5 — If a port is already in use](#part-5--if-a-port-is-already-in-use)
- [Part 6 — Wire the public hostnames in Cloudflare](#part-6--wire-the-public-hostnames-in-cloudflare)
- [Part 7 — First login and smoke test](#part-7--first-login-and-smoke-test)
- [Part 8 — Verify data safety (acceptance tests)](#part-8--verify-data-safety-acceptance-tests)
- [Part 9 — Day-2 operations cheat sheet](#part-9--day-2-operations-cheat-sheet)
- [Part 10 — Troubleshooting](#part-10--troubleshooting)

> **Companion doc:** every command in one page — [CHEATSHEET.md](CHEATSHEET.md).

---

## Part 0 — What you need

| # | Thing | Notes |
|---|-------|-------|
| 1 | Ubuntu 22.04 / 24.04 server | 2 vCPU / 4 GB RAM is plenty to start. No public IP or open ports required. |
| 2 | A domain managed by **Cloudflare** | e.g. `example.com` — you will create `fuel.example.com` and `api.fuel.example.com` |
| 3 | SSH access to the server | a user with `sudo` |
| 4 | A GitHub account/org | free private repo is fine |
| 5 | 15–30 minutes | the installer does the heavy lifting |

---

## Part 1 — Push the code to GitHub

**On your development machine** (or anywhere with the repo):

```bash
cd fleet-fuel

# 1. Create an EMPTY private repo named fleet-fuel on github.com first
#    (GitHub → New repository → Private → do NOT add README/gitignore).

# 2. Add your remote and push
git remote add origin git@github.com:YOUR-ORG/fleet-fuel.git
git push -u origin master        # or: git push -u origin main
git push --tags                  # pushes v1.0.0
```

> **Secrets are never pushed.** `.env`, `.env.*` are git-ignored; production
> secrets are generated on the server (Part 4). Double-check with
> `git status` — no `.env` should ever appear.

---

## Part 2 — Prepare the Ubuntu server

SSH in and do the basics:

```bash
ssh your-user@SERVER_IP

sudo apt update && sudo apt -y upgrade
sudo timedatectl set-timezone Africa/Nairobi    # match TZ in .env
```

**Firewall:** nothing needs to be opened to the internet. The Cloudflare
Tunnel makes **outbound** connections only. If UFW is enabled, the defaults
are fine — optionally allow SSH from your office IP:

```bash
sudo ufw status                  # if inactive, you can leave it that way,
sudo ufw allow from YOUR_OFFICE_IP to any port 22   # or lock SSH down like this
```

> The app's web/API/database ports bind to `127.0.0.1` only — they are not
> reachable from the network even without a firewall.

---

## Part 3 — Create the Cloudflare Tunnel

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com).
2. Pick your domain → **Zero Trust** (left sidebar) → **Networks → Tunnels**.
3. **Create a tunnel** → choose **Cloudflared** → name it `fleet-fuel` → Save.
4. Under "Install and run a connector", **copy the token** shown in the
   command line (the long string after `--token`).
   - Keep this tab open — you'll add the public hostnames in Part 6.
5. Store the token safely for now; you'll pass it to the installer:

```
CLOUDFLARE_TUNNEL_TOKEN = eyJhIjoi...   (example shape — use YOUR token)
```

---

## Part 4 — Run the installer

Still on the server:

```bash
# Grab the repo (installer copies it to /opt/fleet-fuel/app itself)
git clone https://github.com/YOUR-ORG/fleet-fuel.git /tmp/fleet-fuel

sudo /tmp/fleet-fuel/scripts/install.sh \
  --repo https://github.com/YOUR-ORG/fleet-fuel.git \
  --domain fuel.example.com \
  --api-domain api.fuel.example.com \
  --token PASTE_CLOUDFLARE_TUNNEL_TOKEN_HERE
```

The installer will:

1. Verify Ubuntu → install **Docker + Compose + git** if missing
2. Create `/opt/fleet-fuel/{app,backups,uploads,logs}`
3. Clone your repo into `/opt/fleet-fuel/app`
4. Generate `/opt/fleet-fuel/.env` with **random strong secrets**
5. Check the host ports are free (see Part 5 if not — pass port flags)
6. Install a nightly **02:00 backup** cron job
7. Build containers, run migrations, start everything, health-check it
8. Seed an **admin user only because the database is empty** and print the
   generated admin password — **save it** (shown once)

If you prefer to choose ports because you already know they clash:

```bash
sudo /tmp/fleet-fuel/scripts/install.sh \
  --repo https://github.com/YOUR-ORG/fleet-fuel.git \
  --domain fuel.example.com --api-domain api.fuel.example.com \
  --token PASTE_TOKEN \
  --web-port 8080 --api-port 8443 --postgres-port 15432
```

After it finishes, `./scripts/status.sh` should show every service healthy.

---

## Part 5 — If a port is already in use

Default host ports: **5432** (PostgreSQL), **4000** (API), **3000** (web).
Other services on the server may already use them. Two scenarios:

### A) The installer/deployer tells you

The deploy preflight **detects conflicts before stopping or changing
anything** and fails with a message like:

```text
[✗] Host port 3000 (Web frontend) is already used by ANOTHER service on this server.
    → Edit the env file:  set WEB_PORT=<a free port>
    → Then re-run this script. Nothing was modified yet.
    Note: only the HOST port changes. Cloudflare Tunnel service URLs
    (http://web:3000, http://backend:4000) and the mobile app URL are
    unaffected. Find the occupying process:  sudo ss -ltnp | grep :3000
```

**Fix — pick free ports and update the env file:**

```bash
# 1. Find something free (example: check a candidate)
sudo ss -ltnp | grep -E ':(8080|8443|15432)\b'    # no output = free

# 2. Edit the env file
sudo nano /opt/fleet-fuel/.env
#     WEB_PORT=8080
#     API_PORT=8443
#     POSTGRES_PORT=15432        # only the ones that clash

# 3. Re-deploy — preflight re-checks, then applies
cd /opt/fleet-fuel/app && sudo ./scripts/deploy.sh
```

That's the whole change. **Nothing else references the host ports:**

| What | Affected by host-port change? |
|---|---|
| Cloudflare Tunnel service URLs (`http://web:3000`, `http://backend:4000`) | **No** — those are container-network names/ports |
| Mobile app (`EXPO_PUBLIC_API_URL`) | **No** — it uses the public URL |
| Web app in browsers (`NEXT_PUBLIC_API_URL`) | **No** — public URL |
| `DATABASE_URL` (`postgres:5432`) | **No** — container-network port |
| Backup/restore/status scripts | **No** — they read the `.env` |
| `*_BIND` values | Keep `127.0.0.1` — never expose publicly |

### B) You know in advance (fresh install)

Pass the port flags to `install.sh` as shown in Part 4.

> **Re-running the installer?** Explicit flags always win: if
> `/opt/fleet-fuel/.env` already exists, `install.sh` keeps your generated
> secrets but **applies any `--web-port/--api-port/--postgres-port`,
> `--domain/--api-domain`, and `--token` values you pass** to the existing
> file (passwords/JWT are never touched). So the fix for a port conflict on
> a re-run is simply: run the same install command with new port flags.

> **Why changing host ports is always safe here:** Docker publishes
> `127.0.0.1:<HOST_PORT> -> <fixed container port>`. Containers each have
> their own network namespace, so inside the Docker network the services
> still talk on their original ports. Only the "door" on the host moves —
> and the only things using those doors are you (localhost admin access)
> and optionally a host-installed cloudflared (see Part 6, Option C).

---

## Part 6 — Wire the public hostnames in Cloudflare

Back in the Cloudflare Zero Trust tab from Part 3 → your tunnel
`fleet-fuel` → **Public Hostname** tab → add **two** entries:

| Subdomain | Domain | Service type | URL |
|-----------|--------|--------------|-----|
| `fuel` | `example.com` | HTTP | `web:3000` |
| `api` | `example.com` | HTTP | `backend:4000` |

(The dashboard writes this as `http://web:3000` — the container names on the
`fleet-fuel` Docker network. **These do not change when you change host
ports.**)

Alternatives:

- **Option B — route via host ports:** service URL
  `http://host.docker.internal:8080` (and `:8443` for the API), matching
  whatever `WEB_PORT`/`API_PORT` you set. Works because the cloudflared
  container has `host.docker.internal` mapped to the host gateway.
- **Option C — host-installed cloudflared instead of the container:** if you
  already run cloudflared as a systemd service on the host, use service URLs
  `http://localhost:8080` / `http://localhost:8443` and disable the bundled
  container by removing `CLOUDFLARE_TUNNEL_TOKEN` from `.env` (deploy skips
  it automatically).
- **Single domain:** route only `fuel.example.com → http://web:3000`, then in
  the same tunnel add a path rule `/api/* → http://backend:4000/api/*` and set
  `NEXT_PUBLIC_API_URL=https://fuel.example.com` in `.env`. Redeploy once
  (it's a build-time variable).

Save, then bounce the tunnel so it picks everything up:

```bash
cd /opt/fleet-fuel/app && sudo ./scripts/deploy.sh
docker logs --tail 20 fleetfuel-cloudflared     # expect "Registered tunnel connection"
```

---

## Part 7 — First login and smoke test

1. Browse to `https://fuel.example.com` → sign in with the admin password
   from Part 4.
2. **Change the admin password** (Users → your user → Reset password).
3. Create the operational baseline (Configuration + Vehicles):
   - Fuel types: Diesel, Petrol (already seeded)
   - Tanks: e.g. *Main Diesel Tank*, 10 000 L — set **opening stock**
   - Pumps: e.g. *Pump 1* → tank
   - Vehicles: plates + drivers
4. Run the full workflow once:
   - Fuel Requests → **New request** (40 L Diesel, a vehicle)
   - **Approve** it (manager/admin)
   - Issue Fuel → pick the request + pump → **Issue fuel**
   - Inventory → Bulk receipts → record a delivery (adds stock via the ledger)
   - Fuel Ledger → verify: receipt `+`, issue `−`, running balance correct
5. Sanity from the server:

```bash
cd /opt/fleet-fuel/app
./scripts/status.sh          # PostgreSQL/Backend/Frontend HEALTHY, Tunnel CONNECTED
./scripts/healthcheck.sh     # ALL CHECKS PASSED
```

---

## Part 8 — Verify data safety (acceptance tests)

These are the contract — run them once after first deployment, and any time
you want reassurance. Create some real data first (vehicles, a request,
authorization, transaction, a bulk receipt — Part 7 covers it).

```bash
cd /opt/fleet-fuel/app

# Test 1 — container restart keeps data
sudo docker compose -p fleet-fuel --env-file /opt/fleet-fuel/.env \
  -f docker-compose.yml -f docker-compose.prod.yml restart
./scripts/status.sh && verify data in the web UI

# Test 2 — full rebuild/recreate keeps data
sudo docker compose -p fleet-fuel --env-file /opt/fleet-fuel/.env \
  -f docker-compose.yml -f docker-compose.prod.yml up -d --build --force-recreate

# Test 3 — a GitHub update keeps data
git pull && sudo ./scripts/deploy.sh

# Test 4 — server reboot auto-recovers
sudo reboot          # everything returns automatically (restart: unless-stopped)

# Test 5 — backup + restore works
sudo ./scripts/backup.sh
sudo ./scripts/restore.sh --latest

# Test 6 — offline mobile: airplane mode → create request + issue →
#          reconnect → both appear once (never duplicated)
```

After Test 2/3, confirm in the web UI: vehicles, requests, authorizations,
transactions, inventory and the **ledger balance are unchanged**; audit
history intact; users intact.

---

## Part 9 — Day-2 operations cheat sheet

| Task | Command |
|---|---|
| **Deploy/update (the one command)** | `cd /opt/fleet-fuel/app && sudo ./scripts/deploy.sh` |
| Status | `./scripts/status.sh` |
| Health check | `./scripts/healthcheck.sh` |
| Backup now | `sudo ./scripts/backup.sh` |
| Verify backups | `sudo ./scripts/backup.sh --verify` |
| Restore (interactive) | `sudo ./scripts/restore.sh` |
| Roll back app release | `sudo ./scripts/rollback.sh` |
| Logs | `docker compose -p fleet-fuel logs -f backend` |
| Change ports | edit `/opt/fleet-fuel/.env` → `sudo ./scripts/deploy.sh` |
| Change domains/CORS | edit `.env` (`CORS_ORIGIN`, `NEXT_PUBLIC_API_URL`) → redeploy |

Update flow every time (`deploy.sh` does this automatically):
**checks → pre-deploy backup → git pull → build → start PostgreSQL →
run pending migrations → start API (health-gated) → start web → tunnel →
final health check.** A failed migration leaves the old release running and
prints the backup path.

---

## Part 10 — Troubleshooting

| Symptom | Diagnosis | Fix |
|---|---|---|
| Deploy: "password authentication failed for user" | Volume was first initialized with a different password (`POSTGRES_PASSWORD` only applies on first boot) | `ENV_PASS="$(grep -E '^POSTGRES_PASSWORD=' /opt/fleet-fuel/.env \| cut -d= -f2-)"` then `sudo docker exec fleetfuel-postgres psql -U fleetfuel -d fleetfuel -c "ALTER USER fleetfuel WITH PASSWORD '$ENV_PASS';"` → re-deploy. Data is untouched |
| Deploy: "Host port X already used" | Another service owns the port | Set `WEB_PORT`/`API_PORT`/`POSTGRES_PORT` in `.env`, re-run deploy (see Part 5) |
| Find what occupies a port | `sudo ss -ltnp \| grep :3000` or `sudo lsof -i :3000` | stop it, or move our stack to another port |
| Tunnel "NOT RUNNING" in status | Token missing/placeholder | put `CLOUDFLARE_TUNNEL_TOKEN=…` in `.env`, re-run deploy |
| Tunnel runs, site 502/530 | Public hostname service URL wrong | must be `http://web:3000` / `http://backend:4000` (container names) or host.docker.internal/localhost variants (Part 6) |
| Web loads but API errors | `NEXT_PUBLIC_API_URL` wrong (it's baked at build) | fix in `.env`, re-run `deploy.sh` |
| Backend unhealthy | `docker compose -p fleet-fuel logs --tail 50 backend` | usually DB connectivity/`DATABASE_URL` |
| "Database not healthy" | `docker compose logs postgres`, `df -h` | disk full is the usual suspect |
| Restore refuses | corrupt archive | `./scripts/backup.sh --verify` lists bad files; use an older backup |
| Mobile can't connect | `EXPO_PUBLIC_API_URL` wrong/unreachable | must be `https://api.fuel.example.com` (never localhost/IP) |

**Getting help from the logs, all in one place:**

```bash
docker compose -p fleet-fuel logs --tail=100 postgres backend web cloudflared
```

---

*That's the whole journey. Once installed, remember the mantra:*
**`./scripts/deploy.sh` is the only command you need to ship an update —
and it will never touch your production data.**
