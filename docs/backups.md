# Backups

Two scripts handle backups, both in `deploy/`.

## Daily backups (recurring, automated)

[`deploy/daily-backup.sh`](../deploy/daily-backup.sh) runs from cron at **03:00 UTC** every day. Produces a `pg_dump` only — no code, no config, since those live in git.

Output:
- `/opt/clutch-viewership-tracker/backups/daily/daily-YYYYMMDD-HHMMSS.sql.gz` — last 7 retained
- `/opt/clutch-viewership-tracker/backups/weekly/weekly-YYYYMMDD-HHMMSS.sql.gz` — last 4 Sunday snapshots retained

Log: `/opt/clutch-viewership-tracker/backups/daily-backup.log`

Cron entry on the production server:
```
0 3 * * * /opt/clutch-viewership-tracker/deploy/daily-backup.sh
```

### Pulling a daily backup to your laptop

```bash
# List available daily backups
ssh root@165.232.126.195 "ls -lh /opt/clutch-viewership-tracker/backups/daily/"

# Download the latest
scp root@165.232.126.195:/opt/clutch-viewership-tracker/backups/daily/daily-LATEST.sql.gz ./

# Or download all daily + weekly
rsync -av root@165.232.126.195:/opt/clutch-viewership-tracker/backups/daily/ ./backups-daily/
rsync -av root@165.232.126.195:/opt/clutch-viewership-tracker/backups/weekly/ ./backups-weekly/
```

## One-off Phase 0 backups (full snapshot)

[`deploy/phase0-backup.sh`](../deploy/phase0-backup.sh) bundles **everything**: pg_dump + code tarball + dashboard build + nginx config + `.env` + system info. Run before any major architectural change.

Output: `/tmp/clutch-phase0-YYYYMMDD-HHMMSS.tar.gz` (~50 MB). Includes a `MANIFEST.txt` describing the contents.

```bash
# Generate
ssh root@165.232.126.195 "/opt/clutch-viewership-tracker/deploy/phase0-backup.sh"

# Pull down
scp root@165.232.126.195:/tmp/clutch-phase0-LATEST.tar.gz ./
```

The `.env` file inside the bundle is **sensitive** — it has DB credentials, JWT secret, API keys. Treat the bundle as confidential.

## Restoring

### Database only (most common)

```bash
# On a fresh Postgres instance:
gunzip -c daily-YYYYMMDD-HHMMSS.sql.gz | psql -U <user> -d <empty_db>
```

The dump uses `pg_dump`'s plain SQL format, so it's portable across PG versions ≥ 13.

### Full restore (after a catastrophic loss)

1. Provision a new droplet with PostgreSQL, Node 22, nginx, pm2.
2. Extract the Phase 0 bundle: `tar -xzf clutch-phase0-*.tar.gz`
3. Restore the DB: `gunzip -c database.sql.gz | psql -U postgres -d clutch_viewership`
4. Place `dotenv.txt` as `.env` in the app dir.
5. Extract `code.tar.gz` to `/opt/clutch-viewership-tracker/`.
6. Extract `dashboard-dist.tar.gz` into `src/dashboard/`.
7. `npm install --production=false`, `npx tsc`.
8. Copy `nginx-clutch-viewership.conf` to `/etc/nginx/sites-available/`, symlink to `sites-enabled`, reload nginx.
9. `pm2 start ecosystem.config.js && pm2 save`.

## Verification

After any restore, confirm:

```sql
SELECT COUNT(*) FROM viewership_snapshots;       -- should match expected order of magnitude
SELECT MAX(timestamp) FROM viewership_snapshots; -- should match the backup timestamp ± 1 day
SELECT COUNT(*) FROM channels WHERE is_active = true;
SELECT name, status FROM tournament_series ORDER BY name;
```
