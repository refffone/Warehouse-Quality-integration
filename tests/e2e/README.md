# E2E tests

Real click-through browser tests against a real `wrangler dev` + freshly
migrated local D1 — no mocked backend, no API shortcuts for the
transaction each test is actually about.

## Running

```bash
npm run test:e2e
```

That's it — `global-setup.ts` handles everything else:

1. Wipes local D1 (`.wrangler/state`) and re-applies every migration.
2. Boots `wrangler dev` on port 8787 as a background process.
3. Creates two fixed test accounts (`e2e_warehouse` / `e2e_quality`, see
   `constants.ts`) through the real admin API, using `ADMIN_PASSWORD`
   from `.dev.vars`.

`global-teardown.ts` kills the server again afterward. You don't need a
`wrangler dev` already running — if one is, this will kill it first (same
port).

Tests run serially (`workers: 1`, `playwright.config.ts`) against that
one shared backend rather than each getting an isolated database, so
every spec namespaces its own supplier/material codes (`WH1-`, `QA1-`,
...) to avoid colliding with other tests' data from the same run.

## What's covered

- **`warehouse-receiving.spec.ts`** — the Receive wizard, end to end:
  one material/one batch, one material/several batches, multiple
  materials each with multiple batches, a sample receipt (including who
  sent it), and the full receive → Quality approves → Warehouse
  finalizes-weight cycle.
- **`quality-decisions.spec.ts`** — approve, partially approve, and
  reject a batch; associate a code to an uncoded receipt line (both
  linking an existing material and creating a brand-new one inline);
  create a material code directly from the Codes tab; create a new spec
  version for a material.

Not covered (out of scope for this pass, not because they're low-risk —
worth adding if this suite grows): Excel import/export, the Suppliers
list/assessment tabs, PDF/Excel report downloads, push notifications,
Arabic/RTL rendering, and the admin panel. The manual verification notes
for those live in `docs/architecture.md`'s numbered sections.

## Helpers

`helpers.ts` has one function per real transaction (`receiveMaterial`,
`decideBatch`, `recordTestResults`, `finalizeWeight`, `associateCode`,
plus `login`/`goToNav`/`openReceiptCard` for navigation) so specs read as
a sequence of actions, not raw selectors. `seedSupplier`/`seedMaterial`/
`seedSpec` go through the real API rather than the UI — only for
prerequisites a scenario needs but isn't itself testing (e.g. a supplier
has to already exist before a receiving test can pick it); never for the
transaction a test is actually about.

Two subtleties worth knowing if you're adding a test:

- **Reload after seeding, before searching.** `app.js` caches suppliers/
  materials in module-level variables and only refetches when explicitly
  forced. Landing on To Do after login already populates that cache (it
  needs supplier names for existing receipt cards), so anything seeded
  via the API *after* login won't show up in a search combo without a
  reload to reset the cache first. `receiveMaterial()` already does this;
  if you add a new helper that searches for freshly-seeded data, it
  needs the same `page.reload({ waitUntil: "domcontentloaded" })`.
- **Filter search-result clicks by the intended text.** Several combos
  (Receive's supplier field, Associate-a-Code's existing-material field,
  the Specs tab's material field) start pre-filled with a default value,
  and the underlying `wireCodeSearch` component re-renders its results
  synchronously on focus using whatever value was already there. A blind
  `.first()` click on `.search-result-item` can grab a stale match for
  that default instead of your actual query, if it resolves before the
  real search's debounce fires. Always
  `.locator(".search-result-item").filter({ hasText: theCodeYouTyped }).first().click()`
  instead — Playwright's auto-waiting then retries until the *correct*
  suggestion exists.
