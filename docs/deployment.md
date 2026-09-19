# Deployment Guide

Step-by-step instructions to take this repo from a fresh checkout to a live,
working deployment on Cloudflare Workers. Written for whoever is deploying
this for the first time — no prior Cloudflare Workers experience assumed.

## What this app needs from Cloudflare

- **A Worker** — runs `src/index.ts`, serves the API and the static frontend.
- **A D1 database** (SQLite at the edge) — all application data.
- **An R2 bucket** — stores uploaded attachments (COAs, receipt files).
- **One secret** (`ADMIN_PASSWORD`) — protects the owner-only `/admin` panel.
- **Three optional secrets** (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT`) — enable Web Push (step 6b). The app works fine without
  them; push sends are silently skipped and only the in-app bell + polling
  refresh are active.
- **A cron trigger** — already declared in `wrangler.toml` (`0 3 * * *`, daily
  expiry-alert check), no separate setup needed.

There's no separate database server, no Node backend process, and no
build step for the frontend (`public/` is served as-is).

---

## 1. Prerequisites

- A Cloudflare account (the free plan works — D1 and Workers are free-tier
  eligible; R2 requires adding a payment method to your account, see step 4,
  but has a generous free monthly allowance).
- Node.js 18+ and npm.
- This repo cloned locally.

Install dependencies:

```bash
npm install
```

## 2. Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser tab to authorize the CLI against your Cloudflare
account. Confirm you're pointed at the right account afterward:

```bash
npx wrangler whoami
```

## 3. Create the D1 database

`wrangler.toml` already has a `[[d1_databases]]` block with a
`database_id` — if you're continuing to deploy this project under the
**same Cloudflare account** that database was created in, skip to step 4.

If you're setting this up under a **different/new account**, create your
own database and point the config at it:

```bash
npx wrangler d1 create warehouse-quality-db
```

This prints a `database_id` — copy it into `wrangler.toml`, replacing the
existing value in the `[[d1_databases]]` block:

```toml
[[d1_databases]]
binding = "DB"
database_name = "warehouse-quality-db"
database_id = "<paste-the-new-id-here>"
```

## 4. Enable R2 and create the bucket

R2 is a separate product toggle on Cloudflare accounts and needs to be
turned on once in the dashboard before the CLI can create buckets:

1. Cloudflare dashboard → **R2** (left sidebar) → follow the prompt to
   enable R2 for your account (this requires a payment method on file,
   even though usage stays within the free tier for typical use).
2. Once enabled, create the bucket from the CLI:

   ```bash
   npx wrangler r2 bucket create warehouse-quality-attachments
   ```

If you changed the bucket name, update the `[[r2_buckets]]` block in
`wrangler.toml` to match.

## 5. Apply the database migrations

The files in `migrations/` are plain, numbered SQL files (`0001_init.sql`
through the latest) — apply each one, **in numeric order**, against the
remote database:

```bash
npm run db:migrate:remote
```

This runs `wrangler d1 migrations apply`, which records each applied file
in the database's `d1_migrations` table and only ever runs files it
hasn't recorded — safe to run again at any time. The deploy workflow
(`.github/workflows/deploy.yml`) runs it before every deploy, and a
failing migration stops the deploy before the new code goes live.

> **Databases set up before migration tracking.** Deploys used to run
> every file with `wrangler d1 execute` and ignore the errors, so a
> database created that way has 0001–0020 applied with no record of it.
> `scripts/d1-migrations-baseline.sql` records those (the deploy workflow
> runs it every time; it changes nothing once they're recorded). Never run
> it on a fresh database. For an existing *local* database, run it with
> `--local` and, if you had already applied later files by hand, record
> those too, e.g.
> `INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0021_supply_kind_code_pools.sql');`

To sanity-check the migrations landed:

```bash
npx wrangler d1 execute warehouse-quality-db --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

You should see `users`, `sessions`, `receipts`, `receipt_batches`,
`suppliers`, `materials`, `notification_events`, `app_settings`, and the
rest of the schema.

## 6. Set the admin secret

`ADMIN_PASSWORD` protects `/admin` (HTTP Basic Auth, any username, this
password) — it must never live in source control. Set it as a Worker
secret:

```bash
npx wrangler secret put ADMIN_PASSWORD
```

You'll be prompted to paste the value. Pick something strong — this
account can suspend the entire service and create/deactivate every login.

(For **local development only**, `.dev.vars` already has a placeholder
dev password and is git-ignored — never put a real production password
in that file.)

## 6b. Enable Web Push (optional)

Lets Warehouse/Quality get a real OS-level push notification (desktop or
Android browser tab, or an iOS device that has added the app to its home
screen — iOS never delivers push to a plain Safari tab) when a receipt is
registered or a decision is recorded, on top of the existing in-app bell.
Skip this section entirely if you don't need it yet; nothing else in the
app depends on it.

Generate a VAPID keypair (the identity the push service uses to verify
sends actually came from this app) — any machine with Node 18+ works, it
doesn't need to be run inside this repo:

```bash
node -e "
(async () => {
  const kp = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  console.log('VAPID_PUBLIC_KEY=' + Buffer.from(pub).toString('base64url'));
  console.log('VAPID_PRIVATE_KEY=' + jwk.d);
})();
"
```

Set the three secrets (the public key is technically not secret, but it's
simplest to manage it the same way as the private key since the app only
ever reads it from `env`):

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT   # e.g. mailto:you@yourcompany.com — required by the push spec
```

Apply the `push_subscriptions` migration if you haven't already run all of
step 5 (it's `migrations/0015_push_subscriptions.sql`, applied by
`npm run db:migrate:remote` along with the rest).

No redeploy is required after setting secrets — take effect immediately.
Once set, each user sees a bell-with-plus icon in the topbar to opt in
their device; nothing is sent to a device that hasn't explicitly enabled
it.

## 7. Deploy

```bash
npm run deploy
```

This runs `wrangler deploy`, which bundles `src/index.ts`, uploads
`public/` as static assets, and wires up the D1/R2 bindings and cron
trigger declared in `wrangler.toml`. On success it prints your Worker's
URL — something like:

```
https://qualitycheck.<your-subdomain>.workers.dev
```

## 7b. Automatic deploys via GitHub Actions

`.github/workflows/deploy.yml` runs `npm run typecheck` then
`wrangler deploy` on every push to this repo's deploy branch (also
runnable manually via the Actions tab's "Run workflow" button) — so from
here on you shouldn't need to run step 7 by hand for routine changes.

It needs one repository secret, which isn't set up automatically:

1. Cloudflare dashboard → profile icon → **My Profile** → **API Tokens**
   → **Create Token** → **Edit Cloudflare Workers** template (scope it to
   the account this Worker lives in).
2. GitHub repo → **Settings → Secrets and variables → Actions** → **New
   repository secret** → name it `CLOUDFLARE_API_TOKEN`, paste the token
   value.

Without that secret the workflow will run and fail at the deploy step
(typecheck still runs, so a broken build is still caught) — everything
up to step 6 above still needs doing by hand first, same as a manual
deploy.

## 7c. Nightly backup to GitHub (free, second copy of the data)

Cloudflare D1 already keeps a 30-day point-in-time recovery window for
this database automatically (Time Travel — no setup needed; see
`wrangler d1 time-travel --help`), but that lives entirely inside your
Cloudflare account. `.github/workflows/backup.yml` adds a second,
independent copy: every night it fetches a full JSON export of every
table and commits it to this repo's own `backups` branch — free, since
it's just this repo's GitHub Actions minutes, and it survives even an
account-level Cloudflare problem, not just an accidental bad write.

Setup (two secrets, once):

1. Generate a random token, e.g. `openssl rand -hex 32`.
2. Set it as a Worker secret: `wrangler secret put BACKUP_TOKEN` (paste
   the same value).
3. GitHub repo → **Settings → Secrets and variables → Actions** → add
   two repository secrets:
   - `BACKUP_TOKEN` — the same value as step 2.
   - `WORKER_URL` — your live Worker URL, e.g.
     `https://qualitycheck.<your-subdomain>.workers.dev`.

That's it — the workflow runs on its own from then on (also runnable
manually via the Actions tab). It keeps the most recent 90 days of
backup files and prunes older ones automatically.

**Restoring from it:** `git fetch origin backups && git show
backups:backups/backup-YYYY-MM-DD.json` gives you that day's full JSON
dump (every table, as a `{table_name: [rows...]}` object) — good enough
to inspect or hand-restore specific rows. For restoring the *whole*
database to a point in time, Cloudflare's own Time Travel (30-day
window) is the faster path; this GitHub copy is the fallback for
anything older than that, or if the Cloudflare account itself is the
problem.

`BACKUP_TOKEN` is deliberately separate from `ADMIN_PASSWORD` — it can
only ever read this one export endpoint, so a leaked CI secret can't
reach the admin panel.

## 8. Create the first accounts

There's no public sign-up — every Warehouse/Quality account is created
through the admin panel, which itself requires `ADMIN_PASSWORD` from step 6.

Easiest path: open `https://<your-worker-url>/admin` in a browser, enter
any username and the admin password when the browser's Basic Auth prompt
appears, and use the **Accounts** card to create your first Warehouse and
Quality logins.

Or from the command line:

```bash
curl -u admin:<your-ADMIN_PASSWORD> \
  -X POST https://<your-worker-url>/admin/api/users \
  -H "Content-Type: application/json" \
  -d '{"username":"whouse1","password":"<a-real-password>","role":"warehouse","display_name":"Warehouse User"}'

curl -u admin:<your-ADMIN_PASSWORD> \
  -X POST https://<your-worker-url>/admin/api/users \
  -H "Content-Type: application/json" \
  -d '{"username":"quality1","password":"<a-real-password>","role":"quality","display_name":"Quality User"}'
```

## 9. Verify the deployment

- Visit `https://<your-worker-url>/` — you should land on the Warehouse ·
  Quality role-picker landing page.
- Sign in through `/login/warehouse` and `/login/quality` with the
  accounts from step 8; confirm each role only sees its own nav tabs.
- Visit `/admin` again and confirm **Service Control** shows "active".
- Try receiving a material (Warehouse) and deciding a batch (Quality) to
  confirm D1 writes are working end-to-end.
- Upload an attachment (a COA file on a decided batch) to confirm the R2
  binding works.

## 9b. Bring over the Access history (one-time)

The Access inspection log, its specs, suppliers and materials are loaded
once, after the deploy that includes migrations 0021–0026. The data files
and the step-by-step run order live outside this repository (they contain
company data), in the `access-seed` folder next to it — see its README.
In short:

1. Import suppliers, materials and specifications through the app's own
   Excel import screens (preview first).
2. Run the numbering seed, then the history parts, with
   `wrangler d1 execute warehouse-quality-db --remote --file=...`. Every
   part is safe to run again.
3. Extract and upload the old TDS / MSDS / photo files with
   `scripts/extract-access-attachments.ps1` and
   `scripts/upload-access-attachments.mjs` (signs in as a Quality user;
   credentials come from environment variables).

## 10. Optional: a custom domain

By default the app is only reachable at the `workers.dev` subdomain from
step 7. To use your own domain:

1. Add the domain to your Cloudflare account (it must already use
   Cloudflare DNS).
2. Cloudflare dashboard → **Workers & Pages** → your Worker →
   **Settings → Domains & Routes** → **Add Custom Domain**.
3. Cloudflare provisions the certificate and routes traffic automatically
   — no `wrangler.toml` change needed for this part.

---

## 11. Staging / demo environment

A fully separate Worker (`qualitycheck-demo`), D1 database
(`warehouse-quality-db-staging`) and R2 bucket
(`warehouse-quality-attachments-staging`) — see `wrangler.toml`'s
`[env.staging]` block. Nothing done there (receiving, deciding, resetting
data) can touch production data or eat into production's D1 daily quota.
It deploys from its own `staging` branch via
`.github/workflows/deploy-staging.yml`, and re-seeds a fixed, realistic
demo dataset (a few suppliers/materials/specs and a receipt in every
status: pending, approved, rejected, partial, and a Quality-received
sample) on every deploy — `scripts/seed-demo-data.mjs` is idempotent, so
this never duplicates data, it just makes sure the canonical set exists.

**One-time setup:**

1. Add a `STAGING_ADMIN_PASSWORD` repo secret (Settings → Secrets and
   variables → Actions) — a password only for the demo environment's admin
   panel, separate from production's.
2. Create the `staging` branch from the deploy branch and push it:
   ```bash
   git checkout -b staging
   git push -u origin staging
   ```
   That first push triggers the workflow, which applies migrations,
   deploys, sets the admin password, and seeds the demo data.

**Before a demo:** push (or merge) whatever you want to show into
`staging`, or just re-run the workflow manually (Actions →
"Deploy staging (demo)" → Run workflow) to reseed a clean canonical
dataset without any code change.

**Demo accounts:** `quality` / `demo12345` and `warehouse` / `demo12345`
(seeded by `scripts/seed-demo-data.mjs`, not secrets — this is a demo
environment with fictional data only).

**URL:** `https://qualitycheck-demo.<your-subdomain>.workers.dev` (same
subdomain as production, different Worker name).

---

## Ongoing maintenance

**Deploying a code change:**

```bash
npm run deploy
```

**Adding a new migration:** create the next-numbered file in `migrations/`
(e.g. `0027_your_change.sql`) and try it locally first:

```bash
npm run db:migrate:local
```

Merging to the deploy branch applies it to production before the new
code goes live (the same as `npm run db:migrate:remote`). A migration
that fails stops the deploy; check what it left behind before retrying.
Never edit a
migration that has already been applied — add a new one.

**Rotating the admin password:**

```bash
npx wrangler secret put ADMIN_PASSWORD
```

(Overwrites the existing secret; takes effect immediately, no redeploy
needed.)

**Checking the cron job ran:** Cloudflare dashboard → your Worker →
**Logs**, or `npx wrangler tail` while waiting for the next 03:00 UTC run,
to confirm `runExpiryCheck` executes without errors.

---

## Known gaps to be aware of

- **Arabic translations** are a best-effort business/QC vocabulary, not a
  certified translation — worth a native Arabic speaker's review before
  this goes in front of real staff (see `docs/architecture.md`).
