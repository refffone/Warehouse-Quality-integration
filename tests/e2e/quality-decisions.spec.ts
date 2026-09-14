import { expect, test } from "./fixtures";
import {
  associateCode,
  decideBatch,
  finalizeWeight,
  goToNav,
  login,
  openReceiptCard,
  receiveMaterial,
  recordTestResults,
  seedMaterial,
  seedSpec,
  seedSupplier,
} from "./helpers";

// Receiving itself is Warehouse's transaction and is already thoroughly
// covered in warehouse-receiving.spec.ts, so here it's just a quick,
// unexercised setup step (still through the real UI, just not the thing
// being asserted on) before each Quality scenario. Codes namespaced QA1-
// through QA7- since local D1 persists across tests within a run.

test.describe("Quality: decisions and master data", () => {
  test("approves a batch fully, after recording passing test results", async ({ page }) => {
    // Material + spec creation require the quality role; supplier
    // creation is open to either — seed those first before switching to
    // warehouse for the actual receiving step.
    await login(page, "quality");
    await seedMaterial(page, { code: "QA1-MAT", name: "Approve Test Material", unit: "KG" });
    await seedSpec(page, "QA1-MAT", {
      title: "Initial Spec",
      created_by: "E2E Quality",
      parameters: [{ parameter_name: "Purity", param_type: "numeric_range", min_value: 95, max_value: 100, unit: "%" }],
    });

    await login(page, "warehouse");
    await seedSupplier(page, "QA1-SUP", "Quality Test Supplier One");
    const receiptId = await receiveMaterial(
      page,
      { supplierCode: "QA1-SUP", createdBy: "E2E Warehouse" },
      [{ code: "QA1-MAT", name: "Approve Test Material", unit: "KG", batches: [{ batchNo: "QA1-B1", qty: 400 }] }]
    );

    await login(page, "quality");
    let card = await openReceiptCard(page, "todo", receiptId);
    await recordTestResults(card, "[data-test]", "E2E Quality", [
      { parameterName: "Purity", measuredValue: "98", result: "pass" },
    ]);
    await decideBatch(card, "[data-decide]", { decision: "approve", decidedBy: "E2E Quality" });

    // Deciding this receipt's only batch marks the whole receipt
    // "decided" (see `WHERE r.status != 'decided'` in
    // src/routes/receipts.ts) — it moves from To Do into History, so the
    // status pill has to be checked there, not on the (now stale) To Do
    // card.
    card = await openReceiptCard(page, "history", receiptId);
    await expect(card).toContainText("QA1-SUP");
    await expect(card.locator(".batch-row .status-pill.approved")).toBeVisible();
    await expect(card.locator("[data-decide]")).toHaveCount(0);
  });

  test("partially approves a batch by splitting accepted/rejected quantity", async ({ page }) => {
    // Deciding a batch — of any decision, including partial — requires
    // its line to already have a material code (`decideBatch` in
    // src/routes/receipts.ts 400s with "Associate a material code on this
    // line before testing it" otherwise), so this needs a coded material
    // seeded up front, same as the full-approve test.
    await login(page, "quality");
    await seedMaterial(page, { code: "QA2-MAT", name: "Partial Approve Material", unit: "KG" });

    await login(page, "warehouse");
    await seedSupplier(page, "QA2-SUP", "Quality Test Supplier Two");
    const receiptId = await receiveMaterial(
      page,
      { supplierCode: "QA2-SUP", createdBy: "E2E Warehouse" },
      [{ code: "QA2-MAT", name: "Partial Approve Material", unit: "KG", batches: [{ batchNo: "QA2-B1", qty: 1000 }] }]
    );

    await login(page, "quality");
    let card = await openReceiptCard(page, "todo", receiptId);
    await decideBatch(card, "[data-decide]", {
      decision: "partial",
      qtyAccepted: 700,
      qtyRejected: 300,
      decidedBy: "E2E Quality",
    });

    card = await openReceiptCard(page, "history", receiptId);
    await expect(card).toContainText("QA2-SUP");
    await expect(card.locator(".batch-row .status-pill.partial")).toBeVisible();
  });

  test("rejects a batch outright", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "QA3-MAT", name: "Reject Test Material", unit: "KG" });

    await login(page, "warehouse");
    await seedSupplier(page, "QA3-SUP", "Quality Test Supplier Three");
    const receiptId = await receiveMaterial(
      page,
      { supplierCode: "QA3-SUP", createdBy: "E2E Warehouse" },
      [{ code: "QA3-MAT", name: "Reject Test Material", unit: "KG", batches: [{ batchNo: "QA3-B1", qty: 250 }] }]
    );

    await login(page, "quality");
    let card = await openReceiptCard(page, "todo", receiptId);
    await decideBatch(card, "[data-decide]", { decision: "reject", decidedBy: "E2E Quality" });

    card = await openReceiptCard(page, "history", receiptId);
    await expect(card).toContainText("QA3-SUP");
    await expect(card.locator(".batch-row .status-pill.rejected")).toBeVisible();
  });

  test("associates an existing material code to an uncoded receipt line", async ({ page }) => {
    await login(page, "warehouse");
    await seedSupplier(page, "QA4-SUP", "Quality Test Supplier Four");
    await login(page, "quality");
    await seedMaterial(page, { code: "QA4-EXIST", name: "Pre-existing Material", unit: "KG" });

    await login(page, "warehouse");
    const receiptId = await receiveMaterial(
      page,
      { supplierCode: "QA4-SUP", createdBy: "E2E Warehouse" },
      // No `code` — the line arrives at Quality uncoded, exactly the
      // scenario associate-a-code exists for.
      [{ name: "Pre-existing Material (typo'd on paperwork)", unit: "KG", batches: [{ batchNo: "QA4-B1", qty: 80 }] }]
    );

    await login(page, "quality");
    const card = await openReceiptCard(page, "todo", receiptId);
    await expect(card.locator(".line-block")).toContainText("uncoded");
    await associateCode(card, ".line-block", "E2E Quality", { mode: "existing", code: "QA4-EXIST" });

    await expect(card.locator(".line-block .code")).toContainText("QA4-EXIST");
    await expect(card.locator("[data-associate]")).toHaveCount(0);
  });

  test("associates a brand-new material code to an uncoded receipt line", async ({ page }) => {
    await login(page, "warehouse");
    await seedSupplier(page, "QA5-SUP", "Quality Test Supplier Five");
    const receiptId = await receiveMaterial(
      page,
      { supplierCode: "QA5-SUP", createdBy: "E2E Warehouse" },
      [{ name: "Never Seen Before Material", unit: "L", batches: [{ batchNo: "QA5-B1", qty: 30 }] }]
    );

    await login(page, "quality");
    const card = await openReceiptCard(page, "todo", receiptId);
    await associateCode(card, ".line-block", "E2E Quality", {
      mode: "new",
      code: "QA5-NEW",
      name: "Never Seen Before Material",
      unit: "L",
    });

    await expect(card.locator(".line-block .code")).toContainText("QA5-NEW");

    // Confirm the new code is now a real, independently-listed material —
    // not just text on this one receipt line.
    await goToNav(page, "codes");
    await page.click('[data-sub="materials"]');
    await expect(page.locator("table.data-table")).toContainText("QA5-NEW");
  });

  test("creates a new material code directly from the Codes tab", async ({ page }) => {
    await login(page, "quality");
    await goToNav(page, "codes");
    await page.click('[data-sub="materials"]');

    await page.fill('#new-material-form [name="code"]', "QA6-DIRECT");
    await page.fill('#new-material-form [name="name"]', "Directly Created Material");
    await page.fill('#new-material-form [name="unit"]', "KG");
    // This particular Save button (unlike every other form's submit
    // button in the app) has no explicit type="submit" attribute in the
    // markup — it still submits the form via the default button type,
    // but a `button[type="submit"]` selector never matches it.
    await page.click("#new-material-form button.primary");

    await expect(page.locator(".toast").last()).toBeVisible();
    await expect(page.locator("table.data-table")).toContainText("QA6-DIRECT");
    await expect(page.locator("table.data-table")).toContainText("Directly Created Material");
  });

  test("creates a new spec version for a material", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "QA7-MAT", name: "Spec Test Material", unit: "KG" });

    await goToNav(page, "specs");
    const search = page.locator("#spec-material");
    await search.fill("QA7-MAT");
    // viewSpecs() prefills this field with a default material code before
    // we search — same prefill-then-focus race as the combos in
    // tests/e2e/helpers.ts, so filter by the intended code rather than
    // blindly taking the first result.
    await page.locator("#spec-material-results .search-result-item").filter({ hasText: "QA7-MAT" }).first().click();

    await page.fill('#new-spec-form [name="title"]', "First Real Spec");
    await page.fill('#new-spec-form [name="created_by"]', "E2E Quality");
    await page.click("#spec-add-param");
    const paramRow = page.locator(".param-item").last();
    await paramRow.locator('[data-f="parameter_name"]').fill("Moisture Content");
    await paramRow.locator('[data-f="param_type"]').selectOption("numeric_range");
    await paramRow.locator('[data-f="min_value"]').fill("0");
    await paramRow.locator('[data-f="max_value"]').fill("5");
    await paramRow.locator('[data-f="unit"]').fill("%");
    await page.click('#new-spec-form button[type="submit"]');

    await expect(page.locator(".toast").last()).toBeVisible();
    await expect(page.locator("#spec-history")).toContainText("First Real Spec");
    await expect(page.locator("#spec-history")).toContainText("Moisture Content");
  });

  test("finalizes actual count (not weight) for a count-basis packaging material", async ({ page }) => {
    // "Pallets" packaging always forces qty_basis to "count" — warehouse
    // verifies these by how many actually arrived, never by weight, so
    // Finalize should read/say "count" throughout, not "weight".
    await login(page, "quality");
    await seedMaterial(page, { code: "QA8-MAT", name: "Count-Basis Packaging Material", unit: "pcs" });

    await login(page, "warehouse");
    await seedSupplier(page, "QA8-SUP", "Quality Test Supplier Eight");
    const receiptId = await receiveMaterial(
      page,
      { supplierCode: "QA8-SUP", createdBy: "E2E Warehouse" },
      [
        {
          code: "QA8-MAT",
          name: "Count-Basis Packaging Material",
          unit: "pcs",
          packagingType: "pallets",
          batches: [{ batchNo: "QA8-B1", containerQty: 2, qtySecondary: 1197 }],
        },
      ]
    );

    await login(page, "quality");
    let card = await openReceiptCard(page, "todo", receiptId);
    await decideBatch(card, "[data-decide]", { decision: "approve", decidedBy: "E2E Quality" });

    // Same Warehouse-specific "still needs a weigh-in" (here: count-in)
    // bucket behavior as warehouse-receiving.spec.ts's finalize test —
    // an approved-but-unfinalized batch stays in Warehouse's own To Do
    // even after leaving Quality's.
    await login(page, "warehouse");
    card = await openReceiptCard(page, "todo", receiptId);
    await expect(card).toContainText("QA8-SUP");
    const finalizeBtn = card.locator("[data-finalize]");
    await expect(finalizeBtn).toHaveText(/count/i);
    await expect(finalizeBtn).not.toHaveText(/weight/i);
    await finalizeWeight(card, "[data-finalize]", 2390); // a couple of units short on the actual count

    card = await openReceiptCard(page, "history", receiptId);
    await expect(card.locator(".batch-row")).toContainText("2390 pcs");
    await expect(card.locator('[data-finalize]')).toHaveCount(0);
  });
});
