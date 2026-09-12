# docker/postgres

Optional PostgreSQL configuration that lives outside the database volume.

`init/*.sql` (and `*.sh`) scripts are executed by the official `postgres`
image **only when the data directory is empty** — i.e. the very first time
the `fleetfuel_postgres_data` volume is created. They never run again on
existing databases, so they are safe across application updates.

Do not place any production data here. Production data lives exclusively in
the named Docker volumes:

- `fleetfuel_postgres_data` — database files
- `fleetfuel_uploads`       — uploaded documents/files
- host `${BACKUP_DIR}` (default `/opt/fleet-fuel/backups`) — database dumps
