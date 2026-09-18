import { expect, type Page } from "@playwright/test";
import { QUALITY_USER, WAREHOUSE_USER } from "./constants";

export type Role = "warehouse" | "quality";

const USERS: Record<Role, { username: string; password: string }> = {
  warehouse: WAREHOUSE_USER,
  quality: QUALITY_USER,
};

/** Real login through the actual login page — no cookie/localStorage
 *  shortcuts — since these are meant to be true click-through E2E tests. */
export async function login(page: Page, role: Role) {
  const user = USERS[role];
  // "domcontentloaded" instead of the default "load": the login/app pages
  // link Google Fonts, and in a network-restricted environment (this
  // sandbox included) that request can hang rather than fail fast,
  // stalling "load" for the full navigation timeout even though the page
  // itself is already interactive.
  await page.goto(`/login/${role}`, { waitUntil: "domcontentloaded" });
  await page.fill("#username", user.username);
  await page.fill("#password", user.password);
  await page.click("#submit-btn");
  await expect(page).toHaveURL(/\/app/);
}

export type NavTab =
  | "receive"
  | "todo"
  | "history"
  | "codes"
  | "suppliers"
  | "supplierassessment"
  | "specs"
  | "masterdata";

/** Clicks a left-nav tab by its stable data-tab id (not its visible
 *  label) so these tests don't depend on English UI text/wording. */
export async function goToNav(page: Page, tab: NavTab) {
  await page.click(`.tab-btn[data-tab="${tab}"]`);
}

export interface BatchInput {
  batchNo: string;
  /** Filled directly into qty_as_received — for a plain batch this is the
   *  only quantity there is; for a packaging-breakdown batch (see below),
   *  omit it and let auto-calc produce the total, or set it to also
   *  exercise the manual-override path (a typed total always wins over
   *  auto-calc, exactly like a real user editing it). */
   qty?: number;
  /** Physically counted containers (drums/IBCs/pallets) — only used when
   *  the line sets a packagingType other than the default. */
  containerQty?: number;
  /** Sub-units per container (bags/units per pallet) — bags_pallet/pallets only. */
  qtySecondary?: number;
  /** Weight per drum/IBC/bag — only meaningful when the line's qtyBasis is "weight". */
  perUnitWeight?: number;
}
export type PackagingType = "drum" | "ibc" | "tank" | "bags_pallet" | "pallets";
export type QtyBasis = "weight" | "count";
export interface MaterialLineInput {
  code?: string; // pick an existing code via the search combo
  name: string;
  unit: string;
  /** Defaults to the wizard's own default (drum). */
  packagingType?: PackagingType;
  /** Only meaningful for drum/ibc/bags_pallet — tank/pallets force their
   *  own basis regardless of what's passed here. */
  qtyBasis?: QtyBasis;
  batches: BatchInput[];
}
export interface ReceiveDetails {
  type?: "import" | "sample";
  supplierCode: string;
  createdBy: string;
  receivedAt?: string; // datetime-local value, defaults to "now" already prefilled by the app
  sampleSentBy?: string;
  /** Quality registering a sample it received directly, from the To Do
   *  screen's "Receive sample" button (the type is fixed to sample). */
  byQuality?: boolean;
}

/** Drives the full two-step Receive wizard for one receipt (one or more
 *  material lines, each with one or more supplier batches) and returns
 *  the new receipt's id. */
export async function receiveMaterial(
  page: Page,
  details: ReceiveDetails,
  lines: MaterialLineInput[]
): Promise<number> {
  return (await receiveMaterialWithNumber(page, details, lines)).id;
}

/** Same as receiveMaterial, also returning the receipt number it was given
 *  (the warehouse serial, or QS-#### for a Quality-received sample). */
export async function receiveMaterialWithNumber(
  page: Page,
  details: ReceiveDetails,
  lines: MaterialLineInput[]
): Promise<{ id: number; receiptNo: string }> {
  // app.js caches suppliers/materials in module-level variables and only
  // refetches when explicitly forced — the first render after login
  // (the To Do list, which needs supplier names for its cards) already
  // populates that cache, so a supplier/material seeded via the API
  // *after* login never shows up in the search combos below without a
  // reload to reset it. A real user hitting this would just refresh, so
  // this is the equivalent click-free step of doing that.
  await page.reload({ waitUntil: "domcontentloaded" });
  if (details.byQuality) {
    await goToNav(page, "todo");
    await page.click("#receive-sample-btn");
  } else {
    await goToNav(page, "receive");
    if (details.type === "sample") {
      await page.selectOption("#rf-type", "sample");
    }
  }
  await page.fill('input[name="created_by"]', details.createdBy);
  // #rf-supplier is a live search-and-select combo, not a plain input —
  // .fill() alone sets the value but never clicks a suggestion, so the
  // results dropdown (position: absolute) never hides and ends up
  // covering the submit button below it. Search, then click the match,
  // exactly like a real user would.
  //
  // The wired-up combo (wireCodeSearch in app.js) also re-renders its
  // results synchronously on focus, using whatever value the field had
  // *before* .fill()'s new value takes effect (the wizard prefills this
  // field with its first supplier as a default) — so a blind `.first()`
  // click can grab that stale default instead of the actual match, if it
  // resolves before the real query's 150ms debounce fires. Filtering by
  // the intended code makes Playwright's auto-waiting retry until the
  // *correct* result exists, sidestepping the race instead of just
  // hoping we win it.
  await page.fill("#rf-supplier", details.supplierCode);
  await page
    .locator("#rf-supplier-results .search-result-item")
    .filter({ hasText: details.supplierCode })
    .first()
    .click();
  if (details.sampleSentBy) {
    await page.fill('input[name="sample_sent_by"]', details.sampleSentBy);
  }
  await page.click('#receive-step1-form button[type="submit"]');
  await expect(page.locator("#rf-lines")).toBeVisible();

  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.click("#rf-add-line");
    const item = page.locator(".line-item").nth(i);
    const line = lines[i];

    if (line.code) {
      const codeSearch = item.locator(".search-input");
      await codeSearch.fill(line.code);
      await item.locator(".search-result-item").filter({ hasText: line.code }).first().click();
    }
    // Fill/override the name regardless — the search selection only
    // prefills it when blank, and we want deterministic content either way.
    await item.locator('[data-f="material_name_text"]').fill(line.name);
    await item.locator('[data-f="unit"]').fill(line.unit);

    // Packaging type/basis first — each batch row's field visibility
    // (container_qty/qty_secondary/per_unit_weight) reacts to these via a
    // change listener, so later fills below land on visible fields.
    if (line.packagingType) {
      await item.locator('select[data-f="packaging_type"]').selectOption(line.packagingType);
    }
    if (line.qtyBasis) {
      await item.locator('select[data-f="qty_basis"]').selectOption(line.qtyBasis);
    }

    for (let b = 0; b < line.batches.length; b++) {
      if (b > 0) await item.locator("[data-add-batch]").click();
      const batchRow = item.locator(".batch-item").nth(b);
      const batch = line.batches[b];
      await batchRow.locator('[data-f="supplier_batch_no"]').fill(batch.batchNo);
      if (batch.containerQty != null) {
        await batchRow.locator('[data-f="container_qty"]').fill(String(batch.containerQty));
      }
      if (batch.qtySecondary != null) {
        await batchRow.locator('[data-f="qty_secondary"]').fill(String(batch.qtySecondary));
      }
      if (batch.perUnitWeight != null) {
        await batchRow.locator('[data-f="per_unit_weight"]').fill(String(batch.perUnitWeight));
      }
      // A typed qty always wins — mirrors the real "auto-calc until you
      // touch the total field yourself" behavior. Omit it on a packaging
      // batch to assert on the auto-calculated total instead.
      if (batch.qty != null) {
        await batchRow.locator('[data-f="qty_as_received"]').fill(String(batch.qty));
      }
    }
  }

  // The toast shows the receipt number people use, not the internal id,
  // so read both from the server's answer.
  const created = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/receipts" && r.request().method() === "POST"
  );
  await page.click('#receive-step2-form button[type="submit"]');
  const res = await created;
  if (!res.ok()) throw new Error(`Registering the receipt failed: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { id: number; receipt_no: string };
  await expect(page.locator(".toast").last()).toContainText(body.receipt_no);
  return { id: body.id, receiptNo: body.receipt_no };
}

/** Navigates to To Do or History, switches to the Imports/Samples subtab,
 *  and returns the locator for one specific receipt's card. Quality's To Do
 *  is a queue of batch rows: there the card is the one in the side panel
 *  that opens when the receipt's row is clicked. */
export async function openReceiptCard(page: Page, bucket: "todo" | "history", receiptId: number, type: "import" | "sample" = "import") {
  await goToNav(page, bucket);
  await page.locator("#quality-queue, .list-controls").first().waitFor();
  if (bucket === "todo" && (await page.locator("#quality-queue").count())) {
    // Test receipts are the newest, so they're on the first page.
    if ((await page.locator("#queue-sort").inputValue()) !== "newest") {
      await page.locator("#queue-sort").selectOption("newest");
      await expect(page.locator("#queue-sort")).toHaveValue("newest");
    }
    await page.click(`.queue-filters [data-t="${type}"]`);
    await expect(page.locator(`.queue-filters [data-t="${type}"]`)).toHaveClass("on");
    await page.locator(`.queue-row[data-receipt-id="${receiptId}"]`).first().click();
    const card = page.locator(`#queue-panel .receipt-card[data-receipt-id="${receiptId}"]`);
    await expect(card).toBeVisible();
    return card;
  }
  await page.click(`[data-t="${type}"]`);
  const card = page.locator(`.receipt-card[data-receipt-id="${receiptId}"]`);
  await expect(card).toBeVisible();
  return card;
}

export interface DecisionInput {
  decision: "approve" | "concession" | "partial" | "reject";
  qtyAccepted?: number;
  qtyRejected?: number;
  concessionReason?: string;
  concessionApprovedBy?: string;
  decidedBy: string;
}

/** Opens the Decide modal for one batch (via its data-decide button,
 *  scoped inside the given receipt card) and submits it. */
export async function decideBatch(card: ReturnType<Page["locator"]>, batchButtonSelector: string, input: DecisionInput) {
  await card.locator(batchButtonSelector).click();
  const modal = card.page().locator("#decide-form");
  await expect(modal).toBeVisible();
  await modal.locator('select[name="decision"]').selectOption(input.decision);
  if (input.decision === "partial") {
    await modal.locator('input[name="qty_accepted"]').fill(String(input.qtyAccepted));
    await modal.locator('input[name="qty_rejected"]').fill(String(input.qtyRejected));
  }
  if (input.decision === "concession") {
    await modal.locator('input[name="concession_reason"]').fill(input.concessionReason ?? "");
    await modal.locator('input[name="concession_approved_by"]').fill(input.concessionApprovedBy ?? "");
  }
  await modal.locator('input[name="decided_by"]').fill(input.decidedBy);
  await modal.locator('button[type="submit"]').click();
  await expect(modal).toBeHidden();
}

export interface TestResultInput {
  parameterName: string;
  measuredValue: string;
  result: "pass" | "fail";
}

/** Opens Record Test Results for one batch and fills every parameter row
 *  by matching on its visible parameter name label. */
export async function recordTestResults(
  card: ReturnType<Page["locator"]>,
  batchButtonSelector: string,
  testedBy: string,
  results: TestResultInput[]
) {
  await card.locator(batchButtonSelector).click();
  const modal = card.page().locator("#test-results-form");
  await expect(modal).toBeVisible();
  for (const r of results) {
    const row = modal.locator("[data-result-row]").filter({ hasText: r.parameterName });
    await row.locator('[data-f="measured_value"]').fill(r.measuredValue);
    await row.locator('[data-f="result"]').selectOption(r.result);
  }
  await modal.locator('input[name="tested_by"]').fill(testedBy);
  await modal.locator('button[type="submit"]').click();
  await expect(modal).toBeHidden();
}

/** Opens Finalize (weight or count, depending on the line's qty_basis —
 *  same modal/field either way, just relabeled) for one batch and submits
 *  the actual quantity — Warehouse's own action, only available once
 *  Quality has approved/partially-approved an import batch. */
export async function finalizeWeight(card: ReturnType<Page["locator"]>, batchButtonSelector: string, qty: number) {
  await card.locator(batchButtonSelector).click();
  const modal = card.page().locator("#finalize-form");
  await expect(modal).toBeVisible();
  await modal.locator('input[name="qty_actual_weighed"]').fill(String(qty));
  await modal.locator('button[type="submit"]').click();
  await expect(modal).toBeHidden();
}

/** Associates a code to an uncoded receipt line — either linking to an
 *  existing material code, or creating a brand-new one inline. For
 *  "existing" mode, call this only after a `login()` that happened
 *  *after* the target material was seeded — same materials-cache
 *  staleness as `receiveMaterial` (see its comment), except here there's
 *  no natural place to reload without losing the `card` locator's
 *  context, so callers need to order their own login/seed calls instead. */
export async function associateCode(
  card: ReturnType<Page["locator"]>,
  lineSelector: string,
  by: string,
  choice: { mode: "existing"; code: string } | { mode: "new"; code: string; name: string; unit: string }
) {
  const page = card.page();
  await card.locator(lineSelector).locator("[data-associate]").click();
  await expect(page.locator("#assoc-mode")).toBeVisible();

  if (choice.mode === "existing") {
    // Same prefill-then-focus race as the supplier/material combos in
    // receiveMaterial() — openAssociateModal() prefills this field with
    // materials[0].code as a default, so filter by the intended code
    // rather than blindly taking the first result.
    const search = page.locator("#assoc-existing .search-input");
    await search.fill(choice.code);
    await page.locator("#assoc-existing .search-result-item").filter({ hasText: choice.code }).first().click();
  } else {
    await page.locator("#assoc-mode").selectOption("new");
    await page.locator('#assoc-new [name="new_code"]').fill(choice.code);
    await page.locator('#assoc-new [name="new_name"]').fill(choice.name);
    await page.locator('#assoc-new [name="new_unit"]').fill(choice.unit);
  }
  await page.locator("#assoc-by").fill(by);
  await page.locator("#assoc-submit").click();
  await expect(page.locator("#modal-root")).toBeEmpty();
}

/** Seeding helpers for prerequisites a scenario needs but isn't itself
 *  testing (e.g. a supplier/material/spec must already exist before a
 *  decide/associate/finalize test can reach that step) — go through the
 *  real API, but never through the UI action that another test already
 *  covers as its own transaction. Each uses `page.request`, which shares
 *  the browser context's session cookie, so the caller must already be
 *  logged in with a role allowed to create that kind of record. */
export async function seedSupplier(page: Page, code: string, name: string, abbreviation?: string) {
  const res = await page.request.post("/api/suppliers", { data: { code, name, abbreviation } });
  // 409 = already exists (re-running against a database that kept it)
  if (!res.ok() && res.status() !== 400 && res.status() !== 409) {
    throw new Error(`seedSupplier failed: ${res.status()} ${await res.text()}`);
  }
}

export async function seedMaterial(
  page: Page,
  input: { code: string; name: string; unit: string; requires_expiry?: boolean }
) {
  const res = await page.request.put("/api/materials", { data: input });
  if (!res.ok()) throw new Error(`seedMaterial failed: ${res.status()} ${await res.text()}`);
}

export async function seedSpec(
  page: Page,
  materialCode: string,
  input: { title: string; created_by: string; parameters: Array<Record<string, unknown>> }
) {
  const res = await page.request.post(`/api/materials/${encodeURIComponent(materialCode)}/specs`, { data: input });
  if (!res.ok()) throw new Error(`seedSpec failed: ${res.status()} ${await res.text()}`);
}
