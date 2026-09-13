# Warehouse–Quality Integration: Gap Analysis & Technical Architecture

## Context

Materials received by the warehouse (imports and supplier samples) are currently
logged manually into Quality's standalone Microsoft Access database. This causes
two concrete problems:

1. Quality is often notified late because, today, notification is tied to
   financial posting — a price must be entered before the receipt shows up in
   the system at all.
2. Actual received quantities aren't captured until *after* Quality approval
   (the warehouse only weighs material once it's Quality-approved), so
   warehouse and Quality end up looking at inconsistent numbers for a while.

On top of that, supplier samples aren't tracked in any system today and
sometimes get physically lost, because there's no registration step at all for
them.

The goal is a **lightweight, dedicated warehouse ↔ quality tracking and
notification web app** — not a full WMS or ERP — hosted on Cloudflare, that:

- Lets warehouse register a receipt (import or sample) the moment material
  physically arrives, independent of financial/price data.
- Auto-notifies Quality the moment a receipt is registered.
- Lets Quality test against spec, approve/reject at the batch or
  partial-quantity level, assign an internal batch number via a configurable
  scheme, and set an expiry date.
- Notifies warehouse back so they can finalize the actual weighed quantity.
- Proactively alerts warehouse when an approved material is approaching its
  expiry date (a gap identified during this analysis, not in the original
  brief).

**Explicitly out of scope** (confirmed by the business owner): integration
with any ERP/financial system, formal regulatory/audit compliance (no
e-signatures, no GMP/21 CFR Part 11-style controls — informal traceability is
enough), and any downstream handling of rejected material (return to
supplier, disposal, quarantine). A "rejected" status is tracked; nothing acts
on it.

The repository is currently empty — this document is the green-field design
for what gets built next.

---

## 1. Gap Analysis

Each gap below is stated as: what's missing today → why it matters → how the
proposed design closes it.

### 1.1 Notification is coupled to finance
**Today:** a receipt only becomes visible to Quality once it's been priced in
the financial system.
**Why it matters:** this is the direct cause of Quality's biggest delay.
**Fix:** receipt registration is a standalone event with its own timestamp,
owned entirely by this app. It has no dependency on price, costing, or any
financial system — those remain a separate, later process outside this app's
scope.

### 1.2 Flat records can't express real receipts
**Today:** the Access system records appear to be one row per event, but real
receipts are more nested than that.
**Why it matters:** a single receipt can contain multiple material codes,
each with multiple supplier batch numbers, and Quality needs to act at any of
those three levels (whole code, one batch, or part of one batch's quantity).
**Fix:** a three-level data model — **Receipt → Receipt Line (per material
code) → Batch (per supplier batch #)** — described in full in §3.

### 1.3 Materials without a code yet
**Today:** unclear how a receipt is handled when no material code exists yet
(new material, not yet set up in master data).
**Why it matters:** blocking receipt registration on a code existing would
recreate the same delay problem this project is meant to fix.
**Fix:** `material_code` is nullable on a Receipt Line; the line carries a
free-text material name as a fallback and can be reconciled to a code later
via an **"Associate a Code"** action available to Quality on any uncoded
line: Quality either links it to an existing material (its existing spec
then applies) or creates a brand-new material code together with its spec
in the same step. Implemented as `POST
/api/receipt-lines/:id/associate-code`.

### 1.4 Not all materials expire
**Today:** expiry date is implicitly expected on every approved record.
**Why it matters:** some materials genuinely have no expiry; forcing a date
would produce meaningless data.
**Fix:** expiry date is optional at approval time; a `requires_expiry` flag
on the Material master (where a code exists) can pre-fill Quality's UI, but
Quality can always leave it blank.

### 1.5 Spec lookup only works when a code exists — and specs need to be a
### first-class, easy-to-author object, not free text
**Today:** none — this is a new capability being requested.
**Why it matters:** Quality's day-to-day work was clarified as three
capabilities — **Create Codes**, **Create Specifications**, **Test
Incomings** — and specs specifically need to be *easy to create*, following
the pattern already proven in the user's `chemerp-costing` repo: structured
parameter rows (not a paragraph of free text), a default checklist per
material Subtype so a new spec never starts blank, and versioning instead
of destructive edits.
**Fix:**
- **Material classification**: materials carry a Type/Subtype pair
  (e.g. `RM`/`Solvents`, `PKG`/`Pail`), managed by Quality themselves as
  data (`material_types` / `material_subtypes` tables) rather than a
  hardcoded enum — consistent with how batch-number schemes are already
  Quality-configurable.
- **Structured specs**: a `specs` row (versioned, one active version per
  material) owns a list of `spec_parameters` rows, each a
  `parameter_name` + `param_type` (`numeric_range | pass_fail |
  time_range | text_value`) + `method`/`min_value`/`max_value`/`unit` —
  the same shape ChemERP uses for its RM/PKG spec parameters.
- **Default templates**: Quality defines a reusable default parameter
  checklist per Subtype (`subtype_spec_templates`); creating a spec for a
  material without an explicit parameter list pre-fills from its
  subtype's template.
- **Simple versioning, no approval chain**: unlike ChemERP's two-person
  R&D+QM sign-off, a new spec version here is active immediately on
  creation and automatically supersedes the prior one — full history
  retained, but no multi-step approval (consistent with "informal
  traceability is enough").
- When a Receipt Line has a material code, `getReceipt` now resolves and
  attaches that material's active spec (with parameters) directly onto
  the line for Quality's review screen. When there's no code (see 1.3),
  Quality's "Associate a Code" action now accepts a structured
  `parameters[]` array when creating a brand-new material, instead of a
  single free-text field.

### 1.6 No support for partial/selective approval
**Today:** nothing — the Access system is a manual, flat log.
**Why it matters:** explicitly required — Quality can approve a whole
material code (every batch), or accept/reject specific supplier batches, or
accept only part of one batch's quantity.
**Fix:** approval decisions live on the Batch entity, and each Batch carries
separate `qty_accepted` / `qty_rejected` fields so a partial decision is a
first-class case, not a workaround.

### 1.7 Two "truths" for quantity aren't reconciled
**Today:** "as-received" quantity (declared by warehouse at intake) and
"actual weighed" quantity (measured after approval) exist at different times
and aren't shown together.
**Why it matters:** explicitly required — both figures should be visible to
*both* warehouse and Quality on the same record once available.
**Fix:** both fields live on the same Batch row (`qty_as_received`,
`qty_actual_weighed`), so the moment the second is filled in, both roles see
both numbers and any variance on the same screen.

### 1.8 Internal batch numbering has no system support
**Today:** Quality manually writes numbers like `BSF09260004` by hand into
Access.
**Why it matters:** manual sequencing is error-prone (duplicates, gaps) and
the pattern itself needs to be changeable by Quality without a code change.
**Fix:** a configurable `BatchNumberScheme` (pattern template + a running
counter per supplier+month) generates the number, with Quality able to
override the generated value on any given batch. The counter increment must
be atomic — see §5 for how Cloudflare handles this safely under concurrent
receipts.

### 1.9 Samples are invisible and behave differently from imports
**Today:** samples aren't registered anywhere, so they get lost; and even
once registered, samples shouldn't follow the same lifecycle as imports.
**Why it matters:** explicitly required — a sample never needs a warehouse
"actual weight finalization" step, and Quality's in-progress testing status
on a sample should **not** be visible to warehouse (warehouse only needs to
know a sample was logged and stored, not where it stands in testing).
**Fix:** `Receipt.type` is `import | sample`. This is not just a workflow
branch — it's also a field-visibility rule enforced by role: warehouse's view
of a sample record omits Quality's live test status entirely. On the
Quality side, samples get their own **tab**, not a shared list with
imports: `GET /api/receipts` accepts a `type` filter, and each of
Quality's two tabs is just that endpoint called with a fixed `type` —
warehouse's type choice at intake is what routes the record to the
correct tab, with no separate routing step needed.

Samples also carry a field imports don't: **who sent the sample**
(`Receipt.sample_sent_by`). It's optional at intake, but has an
asymmetric edit rule rather than being simply "editable anytime": if
warehouse captures it in the receiving step, either role can edit it
afterward; if warehouse skips it, warehouse permanently loses the ability
to add it — only Quality can fill the gap from then on
(`PATCH /api/receipts/:id/sample-sender`). This mirrors Quality's real
concern — the field must not silently stay blank forever — without
letting warehouse backfill it after the fact from memory.

### 1.10 No notification mechanism exists at all
**Today:** nothing pushes an alert to either side; Quality finds out about
receipts only when someone tells them.
**Fix:** an in-app notification feed for both roles, backed by email as a
secondary channel (see §5) — fired on receipt registration (→ Quality) and
on approval/rejection decisions (→ Warehouse).

### 1.11 No expiry monitoring (gap surfaced during this analysis)
**Today:** nothing tracks approaching expiry dates; the original brief didn't
mention this but it's a natural extension of storing expiry data at all.
**Fix:** a scheduled daily job scans approved batches with a set expiry date
against configurable lead times (e.g. 90/30 days out) and raises a warehouse
notification per threshold crossed.

### 1.12 No place for supporting documents
**Today:** nothing captures the actual COA PDF, spec sheet, or a photo of a
supplier label — everything is described in fields only.
**Fix:** file attachments (COA output, and inbound docs) stored per Batch or
Receipt Line (see §5, Cloudflare R2).

### 1.13 Historical Access data has no migration path
**Today:** years of existing records live only in the Access project.
**Fix:** flagged as an open item — needs a schema-preserving export from
Access before cutover; not designed in this document because no export/schema
sample exists yet.

### 1.14 No role separation
**Today:** a single Access database, presumably used only by Quality
directly, with warehouse relaying data informally.
**Fix:** two roles (Warehouse, Quality) with distinct permissions — most
notably the sample-status visibility rule in 1.9 — rather than one shared
view of everything.

### 1.15 Combination novelty is tracked with a second, hand-typed code
**Today:** in the Access system, Quality manually enters not one but two
codes per record — a general material code, and a second "import code"
Quality derives themselves by checking whether this exact (material code,
material name, supplier) combination has been received before. That
lookup-and-type step is exactly the kind of manual, error-prone work this
project exists to remove — and it also revealed that a material code can
legitimately map to more than one material name ("depending on several
technical factors"), which the original one-name-per-code model didn't
account for.
**Why it matters:** the import code's real value is flagging, at a glance,
which of three situations applies to an incoming receipt: the material
code has never been received before; the material code is known but this
supplier is new; or the material code and supplier are both known but this
delivery arrived under a material name not seen from that supplier before.
**Fix:** `decideBatch` now auto-generates an **import code** per Receipt
Line (not per batch — it's defined by *material + name + supplier*, the
shape of a line) the first time Quality reviews it, regardless of the
decision outcome (a brand-new material can still be rejected). It's
computed from three sequential existence checks against already-reviewed
lines, classifying the line as `new_material` / `new_supplier` /
`new_name_variant` / `repeat` — this scenario is stored on the line for
display, but the *code itself* draws from one of two simple, system-wide
ledger pools, matching how Quality's current system already labels
records: **RMF** for any of the three novel scenarios, **RMS** for a
regular repeat. Each pool is just a prefix plus a plain running number
(`GET /api/import-code-schemes`, `PUT /api/import-code-schemes/:kind` —
default `RMF{seq:04d}` / `RMS{seq:04d}`), not scoped to any one material or
supplier — a material's first-ever receipt and a different material's
first-ever new-supplier event both draw the next number from the same RMF
pool. Quality can freely override the generated value, same as the
internal batch number. This is a separate, coexisting code from the
internal batch number (§1.8) — import code flags novelty at review time
for any decision; internal batch number identifies a specific *accepted*
lot, assigned only on approve/partial.

### 1.16 No production date captured
**Today:** only an expiry date is captured at decision time; the
material's production/manufacture date isn't recorded anywhere.
**Fix:** `decideBatch` accepts an optional `production_date`, stored
alongside `expiry_date` on the batch and visible to both roles once set —
same treatment as expiry date.

---

## 2. Non-Goals

To keep scope honest as this gets built:

- **No ERP/financial integration.** This is a tracking/notification tool
  only; pricing and financial posting remain wherever they are today.
- **No formal regulatory compliance.** No e-signatures, no GMP/21 CFR Part
  11-style controls, no legally-defensible audit trail. Ordinary
  created/updated timestamps and a simple event log are enough.
- **No rejection workflow.** "Rejected" is a terminal status for tracking
  purposes only; return-to-supplier, disposal, and quarantine handling are
  not modeled.

---

## 3. Proposed Data Model

```
Material
  code                 nullable, unique when present
  name
  unit
  requires_expiry      boolean
  type_code            -> MaterialType, nullable
  subtype_code         -> MaterialSubtype, nullable

MaterialType
  code                 e.g. "RM", "PKG" — Quality-managed, not an enum
  name

MaterialSubtype
  code                 e.g. "SOLVENT", "PAIL"
  type_code            -> MaterialType
  name

SubtypeSpecTemplate    -- default parameter checklist per subtype
  subtype_code         -> MaterialSubtype
  parameter_name, param_type, method, min_value, max_value, unit, sort_order

Spec                   -- versioned; one active version per material
  material_code        -> Material
  version
  status                active | superseded
  title, notes, created_by

SpecParameter
  spec_id               -> Spec
  parameter_name
  param_type             numeric_range | pass_fail | time_range | text_value
  method, min_value, max_value, unit, sort_order

Supplier
  code
  name

BatchNumberScheme
  supplier_id           nullable (null = global default)
  pattern_template      e.g. "{supplier_code}{MMYY}{seq:04d}"
  current_sequence      per supplier+month counter

Receipt
  id
  type                  import | sample
  received_at
  supplier_id
  created_by            (warehouse user)
  status                derived from its lines/batches
  sample_sent_by         nullable, sample-only — see §1.9 for the edit rule

ReceiptLine
  id
  receipt_id
  material_code         nullable
  material_name_text    fallback when no code
  unit
  import_code            nullable until Quality's first review of the line
  import_scenario         new_material | new_supplier | new_name_variant | repeat

ImportCodeCounter       -- one row per pool: RMF, RMS
  kind                    RMF | RMS
  current_sequence        system-wide, not scoped to material/supplier

ImportCodeScheme        -- one Quality-editable pattern per pool
  kind                    RMF | RMS
  pattern_template        e.g. "RMF{seq:04d}", "RMS{seq:04d}"

ReceiptBatch
  id
  receipt_line_id
  supplier_batch_no
  qty_as_received
  qty_accepted          nullable until decided
  qty_rejected          nullable until decided
  qty_actual_weighed    nullable until warehouse finalizes (imports only)
  status                pending | approved | rejected | partial
  internal_batch_no     nullable until approved
  expiry_date           nullable
  production_date       nullable
  coa_remarks
  coa_file_ref           -> R2 object key, nullable

NotificationEvent
  id
  target_role           warehouse | quality
  receipt_id / batch_id
  kind                  new_receipt | decision | expiry_alert
  created_at
  read_at

ExpiryAlertRule
  lead_time_days         e.g. 90, 30
```

This structure is deliberately close to what's described in the brief; it
adds nullability and status fields specifically to cover the gaps in §1
rather than introducing unrelated complexity.

---

## 4. Workflow Summary

1. **Warehouse registers a Receipt** with one or more Receipt Lines, each
   with one or more Batches. Type is marked `import` or `sample`. No price,
   no actual-weight finalization required at this step.
2. **System notifies Quality** of the new receipt.
3. **Quality reviews** each line/batch: spec is looked up automatically when
   a code exists; Quality records the test outcome and, per batch or per
   partial quantity, either approves (sets expiry if applicable, generates or
   overrides the internal batch #, adds remarks) or rejects (status only).
4. **System notifies Warehouse** of the decision(s): internal batch #,
   expiry date, remarks, and the approved quantity.
5. **Warehouse finalizes actual weight** (imports only — samples skip this).
   From this point, `qty_as_received` and `qty_actual_weighed` are both
   visible to both roles on the same record.
6. **Ongoing:** a daily scheduled job checks approved batches with an expiry
   date against the configured lead times and notifies Warehouse of upcoming
   expiries.

Throughout, Warehouse's view of a `sample` receipt never exposes Quality's
in-progress test status (§1.9).

---

## 5. Cloudflare Architecture & Limitations

Given the actual scale here (~10,000 records/year), every service below is
well within free/low-tier limits — the choices are about fit, not capacity.

| Concern | Choice | Notes / limitations |
|---|---|---|
| API / backend | **Workers** | Handles HTTP API and the scheduled expiry job. Request volume here is negligible against Workers' limits. |
| Relational data | **D1** (SQLite-based) | Comfortably fits this volume and schema. Key limitation: D1 has no cross-database joins and a single-writer-per-database model — irrelevant for normal CRUD here, but matters for the batch-number sequence counter (§1.8), which needs a small transaction to increment safely instead of a naive read-then-write. |
| File storage | **R2** | COA documents, spec sheets, label photos. S3-compatible API, no egress fees — appropriate for occasional PDF/image attachments. |
| Batch-number concurrency (optional) | **Durable Objects** | Only worth adding if two receipts from the same supplier in the same month could realistically race in practice; a D1 transaction is very likely sufficient at this volume, so treat this as a fallback, not a default. |
| Notifications | In-app feed (`NotificationEvent` table, polled or via a Durable Object/WebSocket) + email via a third-party API (e.g. Resend/SendGrid) called from a Worker | Cloudflare has no built-in push or email-sending service — this has to be assembled from D1 storage plus an external email API for the secondary channel. |
| Scheduled expiry check | **Cron Triggers** | Native Workers feature; a daily trigger scanning D1 is all this needs. |
| Auth | **Cloudflare Access** if the company already has an SSO/IdP, otherwise simple app-level auth (email/password or magic link) stored in D1 | Only two roles exist, so custom auth is cheap to build if no SSO is available — worth confirming before build. |
| Warehouse-floor connectivity | Flag only, not decided here | Workers require an internet connection; if warehouse-floor connectivity is unreliable, a PWA shell with local draft caching (service worker, sync-on-reconnect) would be needed. This should be confirmed before committing to a plain web-app assumption. |

---

## 6. Open Items to Resolve Before/During Build

- **Access data migration**: need an actual export or schema dump from the
  existing Access project before a migration path can be designed.
- **Auth**: confirm whether an existing company SSO/IdP should back
  Cloudflare Access, or whether simple custom auth is preferred.
- **Units**: the standard unit list from the current Quality system was
  mentioned as available but not yet provided — needed to seed `Material.unit`
  and Batch quantity fields.
- **Expiry alert configuration**: confirm desired lead time(s) (e.g. 90/30
  days) and whether email is wanted alongside in-app notification.
- **Warehouse connectivity**: confirm reliability of internet access on the
  warehouse floor, which decides whether offline-capable (PWA) drafting is
  needed.

---

## 7. Frontend

A working UI now exists at `public/`, served as Cloudflare Workers static
assets (`[assets]` binding in `wrangler.toml`, with the Worker's `fetch`
handler falling back to `env.ASSETS.fetch(request)` for any non-`/api/`
path — one deployment, no separate Pages project). It's vanilla
HTML/CSS/JS (no framework, no build step), matching the "lightweight
dedicated tool" scope from §Context: `index.html` shell,
`styles.css` (design tokens), `api.js` (fetch wrapper injecting the
`X-Role` header), `app.js` (hash router + views).

Visual direction — "Aurora Lab": paper-white cards with a soft
violet–teal–peach aurora glow behind them, Fraunces italic for headings,
IBM Plex Sans/Mono for body and codes. Chosen from three researched
directions (aurora/mesh-gradient trend, Attio's card style, calm-clinical
lab UI restraint) presented as a moodboard and picked by the user.

Screens: Warehouse (Receive, To Do, History) and Quality (To Do, History,
Codes, Specifications), each To Do/History screen with an Imports/Samples
toggle and a live search box, plus a shared notification bell. Codes
itself splits into three subtabs (Types & Subtypes, Materials, Numbering
Schemes) — it was one long stacked page of three cards at first, which
read as cluttered even though each card was independently fine, so each
now gets the screen to itself, remembering the last one visited across
navigation. Covers the full loop end-to-end: register → notify → decide/associate-code →
finalize weight → both roles see the result, including the sample-sender
asymmetric-edit rule (§1.9) and the sample-status redaction it depends on.

**To Do vs. History**: a receipt files under History only once nothing
remains for the *current role* to act on — not just once Quality has
decided. Quality's split is a straight read of `receipt.status`
(`decided` → History). Warehouse's is role-aware: a receipt Quality has
fully decided still counts as Warehouse's to-do if any approved/partial
batch hasn't been weighed yet (`receiptNeedsWeighIn` in `app.js`) — caught
during testing, when a receipt that should still need weighing
disappeared into History the moment Quality finished with it.

**Search**: filters the already-fetched receipts (each To Do/History
screen fetches full detail for every receipt in view anyway, to compute
the bucket split and render cards) across receipt #, material code,
supplier batch #, internal batch #, and status (receipt- or batch-level)
— no server round-trip per keystroke, debounced 150ms client-side.

Verified in a real browser (Playwright + the sandbox's Chromium) at both
desktop and phone width, seeded with realistic data through every screen
and modal, across two review passes. Caught and fixed four real bugs this
way:
- A stray quote turning a boolean data-attribute into a bad attribute
  name, twice (broke "remove row" buttons in two different forms).
- `.field`/`.form-grid` setting `display: flex` at the same specificity
  as the browser's default `[hidden] { display: none }` rule, silently
  defeating every `hidden`-attribute toggle in the app — fixed with an
  explicit `[hidden] { display: none !important; }` rule.
- The mobile "stack every field to full width" rule losing the same kind
  of specificity fight against `.field-row .field`'s `flex: 1` shorthand
  (which sets `flex-basis: 0%` as part of the shorthand) — needed
  `!important` for the same reason.
- The To Do/History bug described above.

Google Fonts failed to load only inside this sandbox's restricted network
egress (confirmed via failed-request capture) — not a real deployment
issue, since Cloudflare Workers serves to the open internet with no such
restriction; the font stack's fallback still rendered a clean, legible
page in the meantime.

**Not yet built**: auth beyond the `X-Role` stand-in, the expiry-alert
notification isn't surfaced anywhere beyond the shared bell (no dedicated
"expiring soon" view), and dark mode is defined in `styles.css` tokens but
not yet checked against a real dark-mode screenshot.

### 7.1 Receive as a two-step form

Split from one long single-page form into two: **Receipt details** (type,
supplier, date, who) then **Materials & batches**, each getting its own
screen with a compact step indicator — discussed with the user first
(question, not a given) given the trade-off of extra navigation for the
common single-line receipt against a long unbroken scroll for the messier
multi-code, multi-batch ones the original spec called out. State
(`receiveWizard`) is a module-level object so stepping back to edit
details doesn't lose what's already been entered on step 2 (verified by
navigating back and forward and confirming values persisted); it resets
only after a successful submit.

### 7.2 Structured test results (the content of a COA) and PDF/Excel export

Closes the gap flagged earlier: Quality had nowhere to enter actual test
results, only a free-text remarks field. `decideBatch` now accepts an
optional `test_results[]` (measured value + pass/fail per spec parameter,
stored in the new `batch_test_results` table, validated against the
material's active spec parameters), and the Decide modal renders one row
per active spec parameter — name, method, the spec's own range or
pass/fail hint, a measured-value input, and a Pass/Fail select — so
Quality is filling in a checklist, not guessing at a blank field. A
decided batch shows a compact pass/fail-count badge (opens the full
read-only table on click) plus **COA PDF** / **COA Excel** buttons.

No file upload, per the user (COA is generated from recorded data, not an
uploaded document) — `GET /api/batches/:id/coa?format=pdf|xlsx` builds
the certificate server-side from the batch, its material/supplier/spec
context, and its test results, using `pdf-lib` (PDF) and `xlsx`/SheetJS
(Excel) — both pure-JS, Workers-compatible, no Node filesystem dependency.
xlsx carries known high-severity advisories, but they're in its *parsing*
path; this app only ever writes files from its own trusted data, so
they don't apply here. The frontend downloads via `fetch` (so the `X-Role`
header goes along) into a `Blob` and triggers a normal save through a
throwaway `<a download>` — a plain `<a href>` link can't carry a custom
header, which a same-origin API behind a role check needs.

Verified past "the file signature looks right": inspected the Excel
output's actual cell contents, and rendered the generated PDF in a real
PDF viewer (Chromium's built-in one, via Playwright) to confirm the
certificate reads correctly end to end, not just that `file` calls it a
valid PDF.

### 7.3 Testing split from deciding; COA for rejected batches

Requested follow-up: recording test results and making the approve/
reject/partial call were one action, forcing Quality to have already
decided before they could even record what they measured. They're now
two independent steps against the same batch:

- `POST /api/batches/:id/test-results` (new, quality-only) validates and
  persists `results[]` against the material's active spec — the same
  validation `decideBatch` used to do inline — and stamps `tested_by`/
  `tested_at` (new columns on `receipt_batches`, migration `0008`).
  Callable any time the batch is still `pending`, independent of whether
  a decision has been made yet, and re-callable to correct a recorded
  result before deciding (replaces prior rows for that batch).
- `POST /api/batches/:id/decision` no longer accepts `test_results` —
  `BatchDecisionInput` had the field removed — and only sets `decided_by`/
  `decided_at`/status/quantities. It works whether or not results were
  recorded first (an empty results table is a valid, if incomplete, COA).

On the frontend, "Record test results" is now its own button/modal next
to "Decide" on a pending batch, with the same per-parameter checklist UI
that used to live inside the Decide modal. The Decide modal instead shows
a read-only recap table of whatever's been recorded so far, so Quality
can see it while deciding without being able to edit it there.

COA export (`GET /api/batches/:id/coa`) already only blocked `pending`
batches, not rejected ones — the "allow COA of rejected imports" half of
the ask needed no code change to the guard, just content worth exporting,
which the split now provides (results can be recorded on a batch that
Quality then rejects). Both PDF and Excel output gained a "Tested by"
line alongside "Decided by".

Verified end to end against the local D1 (`wrangler d1 migrations apply
--local`, then `wrangler dev`): recorded a failing result on a pending
batch via `POST .../test-results`, confirmed via `GET /api/receipts/:id`
that the batch was still `pending` with `tested_by` set and the result
attached, rejected the batch, then downloaded both COA formats and
inspected their actual content (PDF via Chromium's viewer, xlsx cell
contents directly) — both show `status: rejected`, "Tested by", "Decided
by", and the FAIL row together. Repeated the flow through the real UI via
Playwright (role switch, "Record test results" modal, Decide modal's
read-only recap, reject, then COA buttons present on the rejected batch
in History) — no console errors beyond the sandbox's known Google Fonts
`ERR_CONNECTION_RESET`, not a real issue.

## 8. Production D1 provisioned

Created the real D1 database (`warehouse-quality-db`) on the live
Cloudflare account and applied all migrations against it directly via the
D1 HTTP query API (the Cloudflare MCP connector available in this
environment can manage D1 but has no "deploy a Worker" action, and
`wrangler` itself isn't authenticated here). `wrangler.toml`'s placeholder
`database_id` now points at the real database. Deploying the Worker code
itself still needs `wrangler login && wrangler deploy` run by someone with
Cloudflare account access — everything else is ready.

## 9. Master Data dossier (Quality-only) + attachments

Requested follow-up: Quality wanted a single per-material-code dossier —
every name the material's been received under, its full spec history,
every RMF/RMS import event with COA links, supporting files (photo/TDS/
MSDS) per import, and pass-rate metrics overall and per supplier.

Most of this was already implicit in the existing data model and just
needed a new aggregating endpoint: `GET /api/materials/:code/dossier`
(`getMaterialDossier` in `src/routes/masterdata.ts`, quality-only) returns
names (`GROUP BY material_name_text`), the material's full spec history
(factored `listSpecsForMaterial` out of the existing `listSpecs` route so
both can share it), RMF and RMS import entries (receipt lines whose
`import_code` starts with each prefix, each with its batches and COA
readiness and its attachments), and metrics computed two ways — overall
and `GROUP BY supplier_id` — as approved/rejected/partial/pending counts
plus a pass rate (`approved ÷ (approved + rejected)`; partial is shown as
its own count rather than folded into the ratio, per explicit direction).

Attachments were new: no file storage existed (R2 was removed earlier
when nothing needed it). Re-added the `ATTACHMENTS` R2 binding, a new
`attachments` table (migration `0009`, one row per file: kind, filename,
content type, size, R2 key, uploader) keyed to a `receipt_line_id` — i.e.
scoped to one specific import code, matching "attachments per RMF."
Upload requires the line to already have an import code (its first batch
must have been decided), since an attachment is meaningless without the
import event it documents. `src/routes/attachments.ts` handles upload
(multipart `POST`, validates `kind` ∈ photo/tds/msds), list, streamed
download, and delete (removes both the R2 object and the D1 row);
everything gated to Quality, matching "Master Data — Quality View only."
D1 stores only metadata — the file bytes live in R2, which is built for
arbitrary-size blobs and has no egress fees, unlike stuffing binary data
into D1 rows.

R2 itself needs a one-time opt-in on the Cloudflare dashboard before a
bucket can be created — the Cloudflare MCP connector's
`r2_bucket_create` call failed with "Please enable R2 through the
Cloudflare Dashboard" the first time this was attempted. The application
code (migration, types, routes, frontend) is complete and typechecked
regardless; only the actual bucket creation and the eventual `wrangler
deploy` are blocked on that dashboard step plus Cloudflare account access.

Frontend: a new "Master Data" tab (quality-only route) with a material
picker, then stat tiles (total imports, approved/rejected/partial/pending,
pass rate) and a per-supplier breakdown table, a names-received table, a
spec-version dropdown reusing the same parameter-list rendering as the
Specifications tab, and two import-history sections — RMF entries shown
by default, RMS entries behind a "Show all RMSs (N)" toggle (kept
expanded across in-place reloads after an upload/delete, rather than
collapsing back each time). Each import entry shows its batch(es) with
COA buttons (reusing the existing `downloadCoa` helper) and its
attachments, with an inline upload form (kind + file picker) per entry.

Verified against the local D1 (migration applied, `wrangler dev`):
built a scripted scenario across two suppliers (one new-material RMF, one
new-supplier RMF, one repeat RMS; one rejected, two approved) and
confirmed via direct API calls that names/specs/RMF/RMS/metrics all came
back correct, including the per-supplier pass-rate split (100% for the
supplier with two approvals, 0% for the one rejection). Uploaded and
downloaded an attachment via curl to confirm the R2 round-trip, then
repeated the same upload through the actual UI with Playwright — screenshot-
verified the dossier layout, confirmed the file landed on the correct
import entry (not just "some" line) by checking its `receipt_line_id` via
the API afterward, and confirmed the "Show all RMSs" section survives a
post-upload reload instead of collapsing (a bug caught and fixed during
this same verification pass, before it shipped).

## 10. Searchable code lookups + Suppliers subtab (supplier assessment)

Two follow-up requests: material/supplier pickers should be searchable by
code rather than scrolled through in a plain dropdown, and Master Data
needed a second view — evaluating a *supplier's* track record rather than
a material's.

**Searchable combobox**: replaced the material `<select>` with a text
input backed by a native `<datalist>` (`codeComboboxHtml`/
`wireCodeCombobox` in `app.js`) — typing filters by code or name using
the browser's own matching, no custom filter logic to maintain. Selection
only fires once the typed value exactly matches a known code, so a
partial search never triggers a lookup on a non-existent one. Reused for
both the Material Dossier and the new Suppliers picker.

**Master Data restructured into subtabs** (mirroring the Codes tab's
existing Types/Materials/Schemes pattern): "Material Dossier" (the
existing view) and "Suppliers" (new), with the active subtab remembered
across navigation the same way `codesSubtab` already works.

**Supplier assessment** (`GET /api/suppliers/:code/assessment`,
`getSupplierAssessment` in `src/routes/masterdata.ts`, quality-only):
overall performance (imports, approved/rejected/partial/pending, pass
rate, distinct codes supplied), a star rating, and a per-material-code
breakdown so "which code does this supplier deliver best" is a lookup,
not a mental exercise. Rating is deliberately simple and transparent
rather than a hidden weighted formula: stars = pass rate rounded onto a
0–5 scale, labeled Unrated/Very Poor/Poor/Fair/Good/Excellent, flagged
`low_volume` under 5 decided batches so a single early result doesn't
read as proven performance. "Best code provided" is the code with the
highest pass rate among codes with at least one decided batch (ties
broken by import volume) — surfaced as its own callout and highlighted
in the ranked codes table, rather than requiring the user to eyeball a
sorted column.

Verified against local D1 with a scripted scenario (one supplier
delivering two material codes at different pass rates, another supplier
with a single rejection): confirmed via direct API calls that the star
rating, low-volume flag, and best-code selection all matched hand
computation, then re-verified through the real UI with Playwright —
screenshot-confirmed both subtabs, the combobox correctly resolving a
typed partial code to the right dossier/assessment, and mobile-width
rendering of the new stat tiles and ranked table. One real bug caught and
fixed during this pass: switching subtabs (or materials) while a dossier/
assessment fetch was still in flight could have it resolve against DOM
that had since been replaced (`document.getElementById(...)` returning
`null`), throwing on `querySelectorAll`. Fixed with a same-request guard
(`body.isConnected` plus a "did a newer request start" check) in both
`loadDossier` and `loadAssessment` before touching the DOM.

## 11. Live search replaces the datalist combobox

Feedback on §10's combobox: the native `<datalist>` still renders as a
browser dropdown list, which is exactly what was asked to go away, and
its exact-match-required selection didn't read as "autofetch."

Replaced `codeComboboxHtml`/`wireCodeCombobox` with `codeSearchHtml`/
`wireCodeSearch`: a plain `search-input` (same class and 150ms debounce
convention already used by the receipt search box in `viewReceiptBucket`)
paired with a custom-rendered, absolutely-positioned results panel —
filtered client-side against the already-cached materials/suppliers list,
capped at 8 matches, closed on blur (150ms delay so a click on a result
registers first) rather than a global document click listener, which
would otherwise leak across this app's repeated full-section
`innerHTML` re-renders. Clicking a result (or pressing Enter to jump to
the top match) sets the input and immediately calls the existing
`loadDossier`/`loadAssessment`, unchanged — only the picker UI changed,
not what happens after a selection.

Scoped to Master Data's two pickers only, matching where the request
came from; the Specifications tab, Codes tab, and Receive wizard still
use plain `<select>` dropdowns. Same pattern is trivially reusable there
if wanted later.

Verified through the real UI with Playwright: typing a partial code/name
shows the custom panel (confirmed it's not a native dropdown), narrows
live, clicking a result loads the right dossier immediately; Enter
selects the top match; blur/click-outside closes the panel; screenshot-
checked at both desktop and mobile width to confirm the panel doesn't
overflow its card. No console errors beyond the sandbox's known Google
Fonts limitation.

## 12. Live search on the remaining pickers + Arabic/RTL support

Two more requests: extend §11's live-search picker to the Specifications
tab and two pickers in the receiving workflow, and add a language toggle
that switches the entire app to Arabic with proper right-to-left layout.

**Remaining pickers** — mechanical reuse of the existing `codeSearchHtml`/
`wireCodeSearch` component, no changes to the component itself:
Specifications' material picker (`viewSpecs`), the Receive wizard's
Supplier field (`renderReceiveStep1` — needed a `name` attribute added to
`codeSearchHtml` so the search input still participates in the form's
`FormData` the same way the old `<select>` did), and the "Associate a
Code" modal's existing-material picker (`openAssociateModal`). Found and
fixed two real argument-order bugs while doing this pass: the Master Data
dossier's and Suppliers subtab's own pickers (`renderMaterialDossierSection`,
`renderSupplierAssessmentSection`) were calling `codeSearchHtml(id, items, placeholder)`
— the *old* `codeComboboxHtml` signature — instead of the current
`codeSearchHtml(id, placeholder, name)`, passing the materials/suppliers
array where a placeholder string was expected. Caught by a systematic
grep of every `codeSearchHtml(` call site while wiring the new ones, not
by symptom (the malformed `name` attribute didn't visibly break anything
in earlier screenshots), and fixed alongside the new work.

**Arabic translation + RTL** — the app had zero i18n scaffolding
(`app.js` is ~1,950 lines of inline English template strings), so "the
whole project" meant a systematic pass, not a small addition. Confirmed
scope with the user first: full coverage (every label/button/table
header/toast), best-effort standard business/QC Arabic — not a certified
translation, flagged here for a native-speaker review before this goes
in front of real staff — and full RTL layout mirroring.

New `public/i18n.js`: a flat `translations.en`/`translations.ar`
dictionary (274 keys, namespaced by area — `receive.*`, `masterdata.*`,
`status.*`, etc.), `t(key, vars)` with `{placeholder}` substitution and
an English fallback if a key is ever missing (never renders a raw key),
`getLang()`/`setLang()` persisted to `localStorage` under `wq_lang`
(mirrors the existing `wq_role`/`wq_name` convention in `api.js`), and
`applyDocumentDirection()` setting `<html lang dir>`. A small inline
script in `index.html`'s `<head>` applies the stored language's
`dir`/`lang` synchronously before first paint, avoiding an LTR-then-RTL
flash on load.

Every view-rendering function in `app.js` — topbar, Receive wizard, the
receipt list/detail/modals, Codes and its three subtabs, Specifications,
Master Data and its two subtabs, toasts — had its hardcoded strings
replaced with `t("...")` calls; status enum values from the API
(`pending`/`approved`/..., `pass`/`fail`, `new_material`/`repeat`/...,
`active`/`superseded`) route through `status.<value>` keys rather than
rendering raw. Scope boundary: only the app's own UI chrome is
translated — user-entered data (material/supplier names, remarks, typed
names) and the API itself are untouched, translation is purely a
client-side display layer. Verified every `t()` call site resolves to a
real key with a small Node script (301 call sites, one false positive
from string-concatenation `t()` calls the regex couldn't parse) and that
the two dictionaries have exact key parity (274/274) — catches exactly
the failure mode where a key gets missed in one language and silently
falls back to the wrong-language string instead of erroring.

**Language toggle**: a button in the topbar next to the role switch,
labeled with the language it switches *to*. Chose "flip the stored
preference, then full page reload" over making every view function
reactive to a live language change — this is a vanilla app where every
view already fully re-renders its own DOM on navigation, so a reload is
the pragmatic choice for a rare action, not a live-update one.

**RTL CSS**: the layout is almost entirely flexbox/grid, which is
direction-aware by default, so most of it needed zero changes. Converted
the handful of physical-property spots found by inspection
(`margin-left`/`-right`, `text-align: left`, one inline style) to logical
properties (`margin-inline-start/end`, `text-align: start`) so they
auto-flip with direction; added `IBM Plex Sans Arabic` (official Arabic
companion to the existing IBM Plex family, keeps the visual identity
close) as the body/heading face under `[dir="rtl"]`, since Arabic has no
equivalent to the Fraunces-italic-display convention.

Verified through the real UI with Playwright, both languages, desktop
and mobile: full round-trip (English → toggle → Arabic, confirmed
`dir="rtl"`/`lang="ar"` and every screen's Arabic text — topbar, Receive
wizard, Specifications, Master Data's both subtabs with their search
pickers — → toggle back → confirmed `dir="ltr"`/`lang="en"` and English
intact); confirmed the language choice survives a manual reload. Two
real bugs caught and fixed during this pass, both pre-existing (not
introduced by this change, just newly exposed by testing with a fresh,
minimal dataset): (1) the Specifications page crashed entirely
("Not found") if zero subtypes existed yet, because its template loader
called the API unconditionally with an empty subtype value — fixed with
a guard; (2) a 6-column data table (Master Data's per-supplier breakdown)
squeezed and wrapped mid-value on narrow mobile widths instead of
scrolling horizontally (e.g. "100%" rendering as "00%" with the leading
digit clipped) — `.data-table` had no `white-space: nowrap`, so cells
wrapped instead of forcing the table wider and letting the existing
`.table-scroll` container handle the overflow, which is what it was
built for. Confirmed via direct DOM `textContent` inspection (not just a
screenshot) that the underlying data was always correct — this was a
pure rendering bug, not a data bug.

## 13. Arabic typeface upgrade

Feedback on §12: "arabic fonts are bad." The initial pass used a single
face — IBM Plex Sans Arabic — for both display and body roles, chosen
mainly because it's the official Arabic companion to the Latin IBM Plex
family already in use, not for its own merits as an Arabic UI face. It's
a comparatively weak release next to purpose-built options on Google
Fonts (narrower weight range, less refined letterforms at UI sizes).

Replaced it with a real two-role pairing that mirrors what the Latin
side already does (Fraunces for character, IBM Plex Sans for neutrality)
rather than flattening both roles into one face: **Markazi Text** (a
literary Arabic serif with genuine warmth) for `--font-display` — h1/h2/h3
and the brand name, same scope Fraunces has — and **Cairo** (one of the
most widely used, polished Arabic UI faces on Google Fonts, weights
200–900) for `--font-body`, everything else. `--font-mono` is untouched
in both directions — material/batch/RMF codes are always Latin/numeric.
Both loaded from the same Google Fonts `<link>` already in `index.html`.

Verified visually with Playwright (desktop, Arabic mode): re-screenshotted
the same three screens from §12's verification pass (To Do, Master
Data's Suppliers subtab, Specifications) and confirmed via
`getComputedStyle` that `--font-display`/`--font-body` resolve to the
new families. Headings now read with distinct character instead of just
a bolder weight of the body face; body text, labels, and tables are
noticeably cleaner. No layout regressions at the new font's metrics —
checked the denser cards (stat grids, the per-supplier table) for
overflow or wrapping, found none.

## 14. Material Function + a sortable/filterable codes List

Two additions to the Codes tab: a "Function" field on materials
(what the material is *used for* — Solvent, Binder, Packaging — an
independent axis from Type/Subtype, not hierarchical), and a new "List"
subtab giving a single flat, sortable, filterable view across every
material code. Confirmed with the user that Function should be a
controlled list they manage (like Types/Subtypes), not free text.

**Backend** (migration `0010`): `material_functions` (code, name — same
flat shape as `material_types`) plus a nullable `function_code` column
on `materials`. `upsertMaterial` (`src/routes/masterdata.ts`) validates
an unknown `function_code` the same way it already validates type/subtype
(404 rather than silently accepting a typo), and the new
`listMaterialFunctions`/`upsertMaterialFunction` mirror the existing
Type CRUD exactly — no new pattern introduced. Applied directly to the
production D1 database via the Cloudflare MCP connector's query tool, as
established for prior migrations in this session (no `wrangler` CLI
auth here, only the D1-management MCP tools).

**Frontend**: the "Types & Subtypes" subtab gained a third card
("Material functions") with its own table + add form, reusing the exact
markup pattern the Type/Subtype blocks already use. The Materials
subtab's table and create/edit form both gained a Function column/select.
The new "List" subtab (`renderCodesListSection`) is a from-scratch view:
three filter `<select>`s (Type/Subtype/Function) plus a debounced search
box (matching the app's established 150ms convention) filter the
already-loaded materials client-side, and clicking any of the Code/
Function/Type/Subtype column headers sorts by that field (▲/▼ indicator,
click again to reverse) — all in one small piece of state
(`codesListState`) rather than a server round-trip, consistent with how
every other list/search view in this app works.

Verified via curl (valid function saves and round-trips; an unknown
`function_code` 404s with `"Unknown function code: ..."`, matching the
existing type/subtype error shape) and then through the real UI with
Playwright in both languages: created two functions and two materials
spanning them, confirmed sort-by-Function actually reorders rows,
confirmed the Function filter narrows to just the matching material,
and confirmed full Arabic/RTL rendering of the new subtab and card (new
`i18n.js` keys added with the same en/ar parity check used throughout
this project — 283/283 keys in both dictionaries, zero missing either
direction).

## 15. Real accounts, landing page, and role-locked logins

Replaces the `X-Role` header stand-in (a client-set header, spoofable
from devtools, previously the entire access-control mechanism) with
real server-enforced accounts, and replaces the topbar's Warehouse/
Quality `<select>` with a landing page and two separate, role-locked
login pages — the last piece of the "deploy for presentation first,
build real auth after" plan from earlier in this project.

**Backend** (migration `0013`: `users`, `sessions`). `src/auth.ts` —
PBKDF2-SHA256 password hashing (Web Crypto, no external package;
100k iterations, per-user salt) and session management: an opaque
32-byte token delivered only via an `httpOnly; Secure; SameSite=Lax`
cookie, 12-hour lifetime, looked up against `sessions` joined to
`users` on every request (`getSession`) — the actual replacement for
the old `getRole(request)` header read. `src/routes/auth.ts` — login
(username + password + the requesting page's role, all three must
match; one generic "Invalid username or password" for every failure
case — wrong password, unknown user, deactivated account, or right
password on the wrong portal — so a guesser learns nothing), logout,
and `/api/auth/me` for the frontend to bootstrap its session. Every
route in `src/index.ts` that used to branch on the header-derived
`role` now branches on `session?.role` instead — the authorization
logic itself (who can do what) is unchanged, only the source of truth
for identity.

**Account management**: there's no public sign-up, so `src/routes/admin.ts`
gained a small CRUD surface (create account, reset password, deactivate/
reactivate — deactivating also kills that user's live sessions
immediately, not just future logins) behind the existing owner-only
`ADMIN_PASSWORD` HTTP Basic Auth, with a matching "Accounts" card added
to the Admin page's server-rendered HTML.

**Entry pages** (`src/routes/pages.ts`, server-rendered like the Admin
page — no dependency on `app.js`/`i18n.js`/`api.js`, since they must
work before any session exists): `GET /` is a landing page with two
cards (Warehouse / Quality); `GET /login/warehouse` and
`GET /login/quality` are separate login forms, each hardcoding its own
role in the login request so a warehouse account can't accidentally
(or deliberately) sign in through the quality portal. The SPA itself
moved to `GET /app`, session-gated server-side (`requireAppSession` —
302 to `/` without a valid cookie) before the asset is served.

**A real deployment-config bug found during this build**: Cloudflare's
static-asset handling defaults to `html_handling = "auto-trailing-slash"`,
which redirects a request for the literal path `/index.html` to `/` —
harmless normally, but `GET /app`'s guard specifically fetches that
exact asset path, so every successful login bounced straight back to
the landing page. Fixed with `html_handling = "none"` in
`wrangler.toml`. Caught by testing the actual login flow end-to-end
with Playwright rather than trusting the code read cleanly — the
session cookie, the query, and the redirect logic were all individually
correct, so this would have been very hard to catch from code review
alone.

**Frontend**: `public/api.js` dropped the `x-role` header entirely
(the cookie rides along automatically on same-origin requests);
`public/app.js` replaced the `wq_role` localStorage read with an
in-memory `session` object populated once at boot from `/api/auth/me`
(never localStorage — the role is now a server-enforced fact, not a
client-picked stand-in), and the topbar's role `<select>` became a
"Signed in as `<name>` (`<role>`)" readout plus a Log out button.

Verified with Playwright: unauthenticated `/app` redirects to `/`;
wrong password, unknown username, and a valid warehouse account
submitted through the quality login all fail identically; a correct
login lands on `/app` with exactly that role's tabs; a warehouse
session hitting a quality-only endpoint directly (bypassing the UI)
gets a 403 from the server, not just a hidden button — confirming
enforcement moved to the backend rather than just cosmetic; deactivating
an account via the Admin panel immediately invalidates its live
session. Also fixed a latent bug caught during this pass: session
`expires_at` (an ISO-8601 string) was being compared directly against
SQLite's `datetime('now')` (a different string format) — the same class
of bug as the date-range issue fixed in the reports feature — normalized
with `datetime(s.expires_at)` so expiry actually reflects wall-clock time
rather than sometimes tolerating a same-day session hours past its
real expiry.

Migration `0013` applied to both local and the production D1 database
directly via the Cloudflare MCP connector, as established for every
prior migration in this project.

## 16. "Mission Control" visual identity + a component-by-component polish pass

A full restyle, done in two phases: first a one-shot identity change,
then a series of small, individually-verified refinements to specific
component families, each proposed as a standalone before/after
comparison (built in the scratchpad, screenshotted, sent for review)
before being rolled into the real app files — never speculatively
applied app-wide first.

**The identity itself** (`public/styles.css`, `src/routes/pages.ts`,
`src/routes/admin.ts`): dark-by-default rather than gated behind
`prefers-color-scheme` — this is the app's actual visual identity, not
a dark-mode option, with a lighter "daylight" variant still shipping
under the media query for anyone who needs it. A deep-navy base
(`--bg-base: #0a0d1a`) with a nebula radial-gradient glow, a tiled
starfield texture and a whisper of film-grain, both as inline SVG
data-URIs (`--stars`, `--grain`); glass panels (`backdrop-filter: blur`)
over the nebula rather than flat cards; Space Grotesk for display type
paired with IBM Plex Sans/Mono for body/code; status pills styled like
panel indicator lights (a glowing dot). All three server-rendered
entry surfaces (the SPA shell, the landing/login pages, the Admin
panel) share the same token set so the identity is consistent before
and after a session exists. The sidebar (`.app-frame` > `.sidebar` +
`.main-col`) replaced a horizontal tab row that wrapped to two lines
once the app grew past ~4 tabs; on mobile it collapses back to an
icon-only horizontal strip. A todo-count badge (`.tab-badge`) was
added to the To Do nav item, backed by `getTodoCount()` in
`src/routes/receipts.ts` — a role-aware `SELECT COUNT(*)` mirroring
the exact client-side pending logic (Quality: not-decided;
Warehouse: not-decided OR needs-weigh-in) — polled every 20s.

**Reference-driven component refinements**, each shipped after a
comparison round: **cards** (`.card`) gained a 16px radius, a refined
shadow, and a diagonal sheen pseudo-element, rolled out to the app,
the landing page's role cards, and the login card — deliberately never
given `overflow: hidden`, since several cards host an absolutely-
positioned `.search-results` dropdown that has to escape the card's
bounds. **Buttons** (`.btn.primary`) moved from a flat fill to a
diagonal `--accent` → `--accent-deep` gradient with a hover lift +
glow and a press-down on `:active`; two new semantic variants,
`.warning`/`.success`, filled a real gap (an "Approve" action
previously had no button color of its own). **Tables** (`.data-table`)
gained zebra striping (`--accent-soft-row`), a firmer 2px header rule,
and a single accent bar on the leading cell of a hovered row (not
every cell — an early version of this bug briefly rendered three
separate bars per row). **Form field labels** switched to uppercase +
letter-spacing to match the table-header/stat-tile convention that
already existed everywhere else. **Modals** (`.modal`) gained a
header/body divider and a ~200ms scale+fade entrance instead of
appearing instantly; **toasts** (`.toast`) gained a status icon
(check/alert, from `public/icons.js`) plus a colored left accent bar
for success/error instead of a flat red fill for errors and a plain
box otherwise, and a slide-up entrance. **Empty states and loading**
were previously visually identical — `.empty-state` rendered the same
plain centered text whether a list was still loading or had genuinely
come back empty. Split into `loadingState()` (a spinning ring),
`emptyState(icon, title, sub)` (a 44px icon-circle + title, contextual
icon per view — bell, inbox, search, database), and `errorState()`
(the same shape, red-tinted) — three helpers in `public/app.js`
replacing all ten prior call sites. **Form inputs** were a bigger find
than expected: several mini-forms (Codes' New type/subtype/function/
material, the numbering-scheme patterns) used bare `<input>`/`<select>`
without the `.field` wrapper the input styling was scoped to, so they
were silently falling through to unstyled native controls. The input
rule was broadened to apply app-wide (excluding checkbox/radio/range/
file, and `.search-input`, which owns its own background-image for
the search icon), and gained an inset shadow, a hover border tint,
and a soft focus glow — and the "Add"/"Save" buttons on those same
mini-forms were promoted from `.btn.ghost` to `.btn.primary`, since
each is the sole submit action of its row, not a secondary option.

**The landing page's role cards and the sidebar nav icons** were
redesigned around a "each destination owns a distinct accent color"
principle taken from a reference repo's (chemerp-costing) module
launcher (`src/pages/home/index.jsx`): a per-role tinted diagonal
gradient, a large icon watermark bleeding off the bottom-right corner
(masked with a radial gradient so it fades rather than cutting off
hard — confirmed by actually standing up that reference repo's real
backend+frontend locally, logging in, and screenshotting its live
Home launcher rather than working from source alone), and a hover
lift + glow in that role's own color. Icon geometry and hues were
taken directly from that repo's definitions rather than invented:
`#C084FC` + an isometric-cube icon for Warehouse (their `wh_rm`
module), `#34D399` + a magnifying-lens icon for Quality (their
`quality` module). The sidebar received the same underlying principle
adapted to its own shape — a literal giant watermark icon doesn't fit
a 36px nav row, so each tab instead gets its own accent hue (via an
inline `--tab-color` custom property) for its icon and active/hover
tint, instead of one blanket violet for every tab; `receive` and
`masterdata` reuse the landing-card hues for continuity, the rest are
distinct hues from the same reference palette. **Login and landing**
were also revisited against general B2B auth-UX research (split-
screen "reason to sign in" layouts, password-visibility toggles,
loading feedback on submit, autofocus) rather than a generic restyle —
proposed as a comparison but not yet rolled into the real login pages
as of this writing.

Every change in this pass followed the same loop: read the current
component's actual CSS/markup (not an assumption of it), build a
standalone before/after comparison in the scratchpad, screenshot both
normal and interactive (hover/focus) states in both themes, get
explicit go-ahead, then edit the real files and re-verify live with
Playwright (including a full `wrangler dev` + seeded-account pass, not
just the isolated comparison) before committing.

## 17. Web Push notifications + auto-refreshing To Do/History

Two related requests: get notified on phone/desktop instead of only via
the in-app bell, and have the To Do/History views update themselves when
a receipt is registered elsewhere, instead of needing a manual reload.

**Web Push** (`src/push.ts`, using `@block65/webcrypto-web-push` — a
WebCrypto-native implementation of RFC 8291/8292 that runs directly in
the Workers runtime, unlike the Node-only `web-push` package):
`notify()` (`src/db.ts`), the single choke point every notification
already flowed through, now also calls `sendPushToRole()` right after
inserting the `notification_events` row — one integration point covers
`new_receipt`, `decision`, and `expiry_alert` without touching any of
their call sites. A new `push_subscriptions` table
(`migrations/0015_push_subscriptions.sql`) stores one row per opted-in
device (`role`, `endpoint`, and the `p256dh`/`auth` keys `PushManager.
subscribe()` returns) — keyed by role rather than user id, since a
subscription belongs to whichever portal a browser was signed into, not
a specific account. Three new endpoints (`/api/push/vapid-public-key`,
`/api/push/subscribe`, `/api/push/unsubscribe`) and three optional Worker
secrets (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`, documented
in `docs/deployment.md` step 6b) — unset in local dev and push is silently
skipped, so nothing else depends on them. A 404/410 from the push service
(a dead subscription) deletes that row; any other failure is swallowed —
one unreachable device must never break the request that triggered the
notification.

**Client side** (`public/app.js`, `public/sw.js`): a topbar bell-with-plus
button (hidden once subscribed, or once permission is denied) drives
`Notification.requestPermission()` → `pushManager.subscribe()` → POST
the subscription to the backend. `public/sw.js` handles the `push` event
(shows the OS notification) and `notificationclick` (focuses/opens the
app), and also forwards the payload via `postMessage` to any open tab —
`app.js` listens for that message and, if the current tab is on To Do or
History, refetches immediately instead of waiting on the polling
fallback below. A `public/manifest.webmanifest` (plus `icon-192.png`/
`icon-512.png`, hand-rasterized with a small Node/zlib script since no
image tooling was available — a violet square with the sidebar's white
diamond mark) and an `apple-touch-icon` link make the app installable to
an iOS home screen, the *only* way iOS delivers push at all — Safari
never delivers push to a plain browser tab.

**Auto-refresh** deliberately doesn't depend on push being granted:
`boot()` (`public/app.js`) gained a third 20s interval alongside the
existing notification/todo-count polls, that refetches-and-rerenders the
current view only when it's To Do or History (the two views that
actually list receipts — Receive, Codes, Specs, and Master Data are
untouched, per explicit scope). This is the backstop for devices that
never subscribed to push; a subscribed device gets the same refresh
near-instantly via the service-worker message path instead of waiting
out the interval.

Verified against a real `wrangler dev` + seeded accounts: registering a
receipt via the API while a second Playwright session sat on the To Do
view showed it appear with no manual reload, within one poll interval;
service worker registration/activation and all new static assets (manifest,
icons, `sw.js`) returned 200; the subscribe flow's actual `pushManager.
subscribe()` call can't be exercised in this sandbox (Chromium disables
the Push API in the ephemeral/incognito-style context Playwright launches
here — a Chromium limitation, not an app bug) but the failure path was
confirmed to fail gracefully (toast, no crash) rather than exercising the
happy path, which needs a real browser profile.

## 18. Suppliers list (both roles) + Warehouse's own weight-accuracy assessment

Two additions, both about suppliers but answering different questions for
different audiences.

**Suppliers list** (`public/app.js` `viewSuppliers()`, new "Suppliers" nav
tab for both roles) is a plain browsable directory — code, name, total
receipts — plus an inline add-supplier form, backed by the existing
`GET/POST /api/suppliers` (already open to both roles) rather than a new
endpoint. `listSuppliers` (`src/routes/masterdata.ts`) now also returns
`total_receipts` (a `LEFT JOIN` + `COUNT`), an additive field the existing
consumers of that same endpoint (the Receive wizard's supplier picker,
Master Data's own supplier search) simply ignore. The supplier list's own
PDF/Excel export reuses the already-existing `/api/reports/suppliers`
endpoint, whose permission was loosened from quality-only to any signed-in
role to match.

**Supplier Assessment** (new "Supplier Assessment" nav tab, Warehouse
role only) is a different question from Quality's own pass/fail
assessment already living in Master Data › Suppliers: not "did the
material meet spec" but "did the supplier actually ship what their
paperwork claimed" — comparing `qty_as_received` (what the receipt says)
against `qty_actual_weighed` (what Warehouse physically found, from the
existing finalize-weight step — the same field, just aggregated for the
first time). `getSupplierWeightAssessment` (`src/routes/masterdata.ts`,
new warehouse-only route `GET /api/suppliers/:code/weight-assessment`)
scopes to batches that have actually been through finalize-weight, and
reports per material code (a supplier can ship several codes in
different units — KG, L, PCS — so per-code sums are the only place raw
quantities are safe to add). The "overall" figure is deliberately *not* a
cross-material sum of those quantities (that would silently add
kilograms to pallet counts); it's a batch-weighted average of each
material's own unit-agnostic variance percentage instead.

Both new views reuse this app's established conventions rather than
inventing new ones: `codeSearchHtml`/`wireCodeSearch` for the supplier
picker, `exportBarHtml`/`wireExportBar` for exports, `.stat-grid` for the
headline numbers, `.table-scroll` + `.data-table` for the breakdown — and
both needed their own container added to the `#…-body`-style flex-gap
fix from the mobile layout pass above, since they're built on the same
"stack a few `.card`s below the page header" shape that bug came from.

## 19. Excel export/import for Suppliers, Materials, and Specs

The existing PDF/Excel export (`buildReportXlsx`, `reportBuilders.ts`) is a
branded, human-read-only report — timestamped title rows unsuitable for
round-tripping. Import needed a plainer sheet, so `src/xlsxImport.ts` adds
a second, undecorated builder (`buildTemplateXlsx`: just a header row plus
data, no title/blank rows to confuse a naive re-import) alongside a reader
(`parseXlsxRows`, via `XLSX.read`/`sheet_to_json`) and a lenient boolean
parser (`parseImportBoolean` — accepts "true"/"1"/"yes"/"y", so a client's
own spelling of a checkbox column doesn't matter).

Both entities follow the same preview-then-commit shape
(`suppliersImportTemplate`/`importSuppliers`,
`materialsImportTemplate`/`importMaterials` in `src/routes/masterdata.ts`):
a `GET .../import-template` downloads the current table as a starting
point; `POST .../import?commit=false` (the default the UI calls first)
validates every row and reports, per row, `insert`/`update`/`error` without
writing anything; `commit=true` is refused outright (400) while any row
still errors, and otherwise writes every row in one `env.DB.batch()` via
the existing `ON CONFLICT(code) DO UPDATE` upsert pattern already used by
the JSON create/edit endpoints. Refusing a partial commit — rather than
applying the good rows and skipping the bad ones — keeps "did my import
work?" a clean yes/no instead of "partially, check which."

Materials import carries one extra layer Suppliers doesn't need: Type,
Subtype and Function are foreign keys into Quality's own classification
tables, not free text, so an unrecognized or mismatched code in those
columns is a validation error rather than a silently-created dangling
reference (all three lookup tables are small and loaded once up front,
not per row). Permissions mirror each entity's existing tier — Suppliers
import is open to any signed-in role, Materials import is quality-only —
reusing `isUploadedFile`'s structural `File` check from
`attachments.ts` (exported for this reuse) since the pinned
`@cloudflare/workers-types` version doesn't type `FormData.get()` as
possibly returning a `File`.

On the frontend, `importSectionHtml`/`wireImportSection` (`public/app.js`)
are a shared pair added once and wired into both `viewSuppliers()` and
the Codes → Materials subtab: a template-download link, a file picker, a
"Preview" button that posts with `commit=false` and renders one row per
result (`status-pill` reused as insert→green, update→purple, error→red),
and a "Confirm import" button that only appears once a preview comes back
with zero errors and re-posts the same file with `commit=true`. A
successful commit reloads the calling view so the refreshed list and a
reset import section show immediately. No new CSS was needed — the
section reuses `.card`, `.hstack`, `.btn`, `.status-pill` and
`.table-scroll`/`.data-table` as they already exist.

**Specs** (`specsImportTemplate`/`importSpecs`, `src/routes/specs.ts`) don't
fit the upsert-by-code shape the other two use: a spec is versioned,
append-only history (creating one always supersedes the material's
current active version, never edits one in place), and one spec has many
parameters. So the sheet is one row *per parameter* — Material Code,
Title, Notes, Created By, Parameter Name, Param Type, Method, Min/Max
Value, Unit — and `importSpecs` groups all rows sharing a Material Code
into one new spec version, importing via the exact same `createSpecVersion`
the manual "new spec version" form already calls (not a hand-rolled copy),
so the behavior — supersede the old active version, validate parameter
bounds per `param_type` — is identical either way. A bad row invalidates
its *whole group*, not just itself (one bad parameter shouldn't half-create
a spec with the rest silently applied), so every row sharing that Material
Code shows as an error even if only one of them was actually wrong. The
template downloads one row per parameter of each material's current active
spec — a material with no active spec yet has no rows, and gets a spec via
rows a user adds by hand. `validateParameter` (refactored out of the
existing bounds-check loop) is exported so the import path and the regular
create-spec-version path enforce the exact same rule.

The same `importSectionHtml("masterdata-specs-import", ...)`/
`wireImportSection` pair is also wired into Master Data's Material Dossier
section (`renderMaterialDossierSection`, next to its own `dossier-export`
export bar), since that's the other screen a quality user already has a
material pulled up on. Its `onImported` callback re-loads just that
material's dossier (not a full view re-render like Suppliers/Materials/
Specifications use), so the import result panel stays visible instead of
being wiped by the refresh — showing the confirmation alongside the
now-updated Specifications card underneath.

Same pair again in Codes → Materials (`renderMaterialsSection`), stacked
right under that tab's own Materials import section with a one-line label
between them ("Import specifications for these materials") so the two
template-download/preview rows aren't mistaken for one — since creating a
batch of new materials there and then giving them specs is the same
workflow split across two imports otherwise.

Suppliers list needed one more consideration the other two placements
didn't: unlike Codes and Master Data (already quality-only screens),
Suppliers list is shared with Warehouse. Specs import stays quality-only
on the backend regardless, so the frontend only renders the specs import
block (and only wires it) when `getRole() === "quality"` — Warehouse's
own Suppliers list keeps just its Suppliers import, matching what
Warehouse could actually use `/api/specs/import` for (nothing).

## 20. Two Arabic mobile card-wrapping bugs, and why bdi() alone wasn't enough

Reported as "weird stacking" — a receipt card's title (an Arabic label
concatenated with a Latin supplier name, e.g. "إيصال رقم 1 · Greif
Packaging Solutions (SUP-007)") wrapped onto a second line with its
supplier code visibly split in half: "(SUP-" on one line, "007)" on the
next. Two distinct bugs turned out to be layered on top of each other:

1. **Bidi word-order jumbling.** Concatenating a translated Arabic phrase
   with an embedded Latin name in one paragraph, under `dir="rtl"`, lets
   the Unicode Bidi Algorithm reorder pieces relative to each other once
   the line wraps — this codebase already had the right instinct for it
   (`<bdi>` around batch numbers and quantity values, from the earlier
   Arabic/RTL work), just not applied to supplier/material names and
   people's names. Added a shared `bdi(str)` helper (escapes, then wraps
   in `<bdi>`) and a `bdiHtml(html)` variant for a caller that already
   built its own markup (`supplierName()`), and applied both wherever a
   name or free-text value sits inline with translated UI text: receipt
   titles, the "logged by"/"sent by" lines, the Receive wizard's recent-
   receipts list, Master Data's RMF/RMS entry lines, and the two `t(...,
   {name/code: ...})` substitution call sites (attachment "uploaded by",
   supplier assessment's "best code") — those needed their outer `esc()`
   removed and pushed onto each substituted value individually, since
   escaping the *whole* templated result after substitution would have
   turned the inserted `<bdi>` tags into literal escaped text.

2. **Codes splitting mid-hyphen — the actual cause of the split "(SUP-
   007)".** This one turned out to have nothing to do with bidi or
   Arabic at all: `<bdi>` isolates word *order*, it doesn't stop normal
   line-wrapping, and standard line-breaking treats a hyphen as a valid
   wrap point — so any code containing one (`SUP-007`, `GRF-9020`,
   `DRM-200L`, ...) can break internally wherever it happens to fall
   across a line, in English too, just far less noticeable at desktop
   widths and with English's narrower font metrics than Cairo's. Fixed
   at the two class definitions every code in the app already renders
   through (`.mono`, `.batch-id`) — one `white-space: nowrap` on each —
   rather than hunting down every call site individually.
   `supplierName()` (used in the receipt title) didn't wrap its `(code)`
   suffix in either class before this, so it also picked up a `<span
   class="mono small muted">` around just that part.

Verified by reproducing the exact reported layout locally (a supplier
named "Greif Packaging Solutions" with code "SUP-007", at 412px width,
Arabic), confirming the split before the fix and its absence after, then
spot-checking English at both mobile and desktop width to confirm
`<bdi>`/`nowrap` are no-ops there.

## 21. Receive wizard's material code became a real search-and-select, not free text

Reported as a 500 on submitting a receipt: `receipt_lines.material_code`
is a foreign key into `materials`, but the Receive wizard's "Material
code (if known)" field was a plain text box — a typo'd or not-yet-coded
code hit an unhandled SQLite constraint violation on insert (the
top-level `catch` in `src/index.ts` turns that into a raw 500).

Two layers of fix:

- **Backend** (`createReceipt`, `src/routes/receipts.ts`): every line's
  material code is checked against `materials` up front, before any row
  is written, returning a clean `404 Unknown material code: ...` instead
  of letting the constraint violation surface as a 500 partway through
  writing the receipt.
- **Frontend** (`renderReceiveStep2`, `public/app.js`): the material code
  field is now `codeSearchHtml`/`wireCodeSearch` — the same live-search
  component Master Data/Specs/Suppliers already use — so a Warehouse user
  picks from real codes instead of typing one freehand; selecting a
  result also prefills the material name below (only if it's still
  blank, so it stays an override, never clobbering something the user
  already typed). The material name field itself gained a `<datalist>`
  of existing material names for autocomplete-as-you-type, while staying
  a free-text input — Warehouse's whole reason to write the name
  separately from the code is recording an uncoded material exactly as
  its paperwork spells it, so suggestions had to stay optional, never a
  hard constraint. The submit handler also gets a matching client-side
  check (unknown code → toast, no request sent) so the common case never
  even reaches the backend's own check.

This needed one permission change: `GET /api/materials` was quality-only
(a Warehouse screen had never needed the materials list before). Loosened
to any signed-in role, matching `GET /api/suppliers`'s existing precedent
— reading materials for this search is a legitimate Warehouse need now;
writing them (`PUT /api/materials`) stays Quality-only, unchanged.

One implementation pitfall worth flagging for future repeatable/dynamic
form sections: `wireCodeSearch` looks its input up via
`document.getElementById`, which only resolves once that element is
actually in the live DOM — building a `.line-item`'s full innerHTML
(including the search markup) and wiring it *before* appending it to the
document silently fails (`getElementById` returns `null`). Fixed by
moving the `appendChild` earlier, right after building the item's static
markup and before calling `wireCodeSearch` on it.

## 22. Next Step

The app is deployed and in use (see `docs/deployment.md`); logins are now
real accounts with case-insensitive usernames (migration 0014). Two things
still worth following up: the Arabic translations are a best-effort
business/QC vocabulary, not a certified translation, worth a native
speaker's review before more staff rely on them day to day; and Web Push
(previous section) needs the three `VAPID_*` secrets set before it does
anything beyond the in-app bell + polling refresh, which already work
without them.
