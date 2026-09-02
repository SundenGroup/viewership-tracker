# Deploying

## Normal path: push to main

`.github/workflows/deploy.yml` runs on every push to `main`:

1. The runner checks out the pushed commit.
2. It pushes that commit into the server's repository over SSH as
   `refs/heads/deploy-inbox` (the server's own git remote is HTTPS without
   credentials, so the server cannot fetch from GitHub by itself).
3. It runs `deploy/update.sh` on the server, which takes a pre-deploy
   `pg_dump` (about 11 minutes, 6.5 GB, ten kept under `backups/`),
   fast-forwards `main` to `deploy-inbox`, runs `npm install`, `tsc`,
   `knex migrate:latest` and `pm2 restart clutch-viewership`.

Batch commits and push once per deploy. Do not also deploy by hand on top of
a push; the app would restart twice.

## Manual or scheduled deploy from a developer machine

```bash
git push root@165.232.126.195:/opt/clutch-viewership-tracker HEAD:refs/heads/deploy-inbox
ssh root@165.232.126.195 'bash /opt/clutch-viewership-tracker/deploy/update.sh'
```

For a deploy that must wait for the end of a broadcast day, the server keeps
`/root/evening-deploy.sh`: it refuses to run while any broadcast day is live,
merges `deploy-inbox`, builds, migrates and restarts, and logs to
`/var/log/clutch/evening-deploy.log`. Schedule it with a transient timer:

```bash
systemd-run --on-calendar='2026-09-03 21:00:00 UTC' --unit=clutch-evening-deploy bash /root/evening-deploy.sh
```

## Rules

- Never write a migration that needs an exclusive lock on a large table while
  a dump may be running; create a new table instead.
- No restarts during broadcast hours without approval.
- Dashboard deploys are separate: build in the redesign repo and rsync `dist/`
  to `/opt/clutch-viewership-tracker/src/dashboard/dist/`.
