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

This runs every file in `migrations/` through `wrangler d1 execute --file`,
in order — the same tested method used throughout this project's own
development (not wrangler's own `d1 migrations apply` tracking system,
which needs bookkeeping this project doesn't set up).

> **Only for the initial, from-scratch apply.** These scripts loop over
> *every* file each time, so re-running `db:migrate:remote` against a
> database that already has these tables will error on migration `0001`
> (the table already exists) before it gets anywhere near a new one. Once
> the initial set is applied, apply any *future* migration individually
> instead — see "Adding a new migration" further down.

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
step 5 (it's `migrations/0015_push_subscriptions.sql`, included in the
loop `npm run db:migrate:remote` already runs).

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

## Ongoing maintenance

**Deploying a code change:**

```bash
npm run deploy
```

**Adding a new migration:** create the next-numbered file in `migrations/`
(e.g. `0016_your_change.sql`), then apply it the same way as step 5, but
only the new file:

```bash
npx wrangler d1 execute warehouse-quality-db --remote --file=migrations/0016_your_change.sql
```

Always apply new migrations to `--remote` (production) *and* run them
against a local D1 (`--local`, or just delete `.wrangler/state` and let it
rebuild) before deploying code that depends on the new schema, so you can
catch mistakes against a throwaway copy first.

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
