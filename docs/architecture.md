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
of a sample record omits Quality's live test status entirely.

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

## 7. Next Step

Once the items in §6 are answered (or explicitly deferred), the next phase is
to turn §3–4 into an actual Cloudflare Workers project: D1 schema + migrations,
a minimal API, and two role-scoped UI views (Warehouse, Quality).
