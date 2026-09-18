import { expect, test } from "./fixtures";
import { decideBatch, goToNav, login, openReceiptCard, receiveMaterial, recordTestResults, seedMaterial, seedSpec, seedSupplier } from "./helpers";

// Quality's To Do as a work queue: one row per pending batch, grouped into
// stages by what it needs next, worked from the row's own button. Codes
// namespaced QA9- since local D1 persists across tests within a run.

test.describe("Quality: work queue", () => {
  test("moves a batch through its stages from the row's next-step button", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "QA9-MAT", name: "Queue Test Resin", unit: "KG" });
    await seedSpec(page, "QA9-MAT", {
      title: "Queue spec",
      created_by: "E2E Quality",
      parameters: [{ parameter_name: "Purity", param_type: "numeric_range", min_value: 95, max_value: 100, unit: "%" }],
    });
    await login(page, "warehouse");
    await seedSupplier(page, "QA9-SUP", "Queue Supplier");
    const receiptId = await receiveMaterial(page, { supplierCode: "QA9-SUP", createdBy: "E2E Warehouse" }, [
      { code: "QA9-MAT", name: "Queue Test Resin", unit: "KG", batches: [{ batchNo: "QA9-B1", qty: 250 }] },
      { name: "Queue Mystery Powder", unit: "KG", batches: [{ batchNo: "QA9-B2", qty: 40 }] },
    ]);

    await login(page, "quality");
    await goToNav(page, "todo");
    await page.locator("#queue-sort").selectOption("newest");
    const rows = page.locator(`.queue-row[data-receipt-id="${receiptId}"]`);
    await expect(rows).toHaveCount(2);
    const coded = rows.filter({ hasText: "QA9-B1" });
    const uncoded = rows.filter({ hasText: "QA9-B2" });

    // Each row offers only the step its stage calls for.
    await expect(uncoded.locator("[data-next]")).toHaveText("Match or create code");
    await expect(coded.locator("[data-next]")).toHaveText("Record results");

    // The stage chips filter the list.
    await page.locator('[data-stage="needs_code"]').click();
    await expect(page.locator('[data-stage="needs_code"]')).toHaveClass(/active/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("QA9-B2");
    await page.locator('[data-stage="all"]').click();
    await expect(rows).toHaveCount(2);

    // Record results from the row: the batch moves to Ready to decide.
    await coded.locator("[data-next]").click();
    const results = page.locator("#test-results-form");
    await results.locator("[data-result-row]").filter({ hasText: "Purity" }).locator('[data-f="measured_value"]').fill("98");
    await results.locator('input[name="tested_by"]').fill("E2E Quality");
    await results.locator('button[type="submit"]').click();
    await expect(results).toBeHidden();
    await expect(coded.locator("[data-next]")).toHaveText("Decide");

    // Decide from the row: the batch leaves the queue.
    await coded.locator("[data-next]").click();
    const decide = page.locator("#decide-form");
    await decide.locator('select[name="decision"]').selectOption("approve");
    await decide.locator('input[name="decided_by"]').fill("E2E Quality");
    await decide.locator('button[type="submit"]').click();
    await expect(decide).toBeHidden();
    await expect(rows).toHaveCount(1);

    // Clicking a row opens the whole record beside the list.
    await uncoded.click();
    await expect(page.locator(`#queue-panel .receipt-card[data-receipt-id="${receiptId}"]`)).toBeVisible();
    await expect(page.locator("#queue-panel .line-block.focused")).toContainText("Queue Mystery Powder");
    await page.locator("[data-close-panel]").click();
    await expect(page.locator("#queue-panel")).toBeHidden();
  });

  test("Warehouse weighs an approved batch in the row and follows the rest with Quality", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "SM9-WH", name: "Weigh Row Solvent", unit: "KG" });
    await login(page, "warehouse");
    await seedSupplier(page, "SM9-SUP", "Weigh Row Supplier");
    const receiptId = await receiveMaterial(page, { supplierCode: "SM9-SUP", createdBy: "E2E Warehouse" }, [
      { code: "SM9-WH", name: "Weigh Row Solvent", unit: "KG", batches: [{ batchNo: "QA9-W1", qty: 300 }, { batchNo: "QA9-W2", qty: 200 }] },
    ]);

    // Both batches wait with Quality: shown in plain words, no record codes.
    await goToNav(page, "todo");
    await page.locator("#wh-with-quality summary").click();
    const withQuality = page.locator(`#wh-with-quality .wh-row[data-receipt-id="${receiptId}"]`);
    await expect(withQuality).toHaveCount(2);
    await expect(withQuality.first()).toContainText("Waiting for spec");
    await expect(withQuality.first()).not.toContainText(/RM[FPS]\d{4}/);

    // Quality approves one of them.
    await login(page, "quality");
    const card = await openReceiptCard(page, "todo", receiptId);
    await decideBatch(card, '.batch-row:has-text("QA9-W1") [data-decide]', { decision: "approve", decidedBy: "E2E Quality" });

    // It moves to Warehouse's own job, weighed right in the row.
    await login(page, "warehouse");
    await goToNav(page, "todo");
    const toWeigh = page.locator(`.wh-table .wh-row[data-receipt-id="${receiptId}"]:has(form[data-weigh])`);
    await expect(toWeigh).toHaveCount(1);
    await expect(toWeigh).toContainText("QA9-W1");
    // The badge counts Warehouse's own job: everything waiting to be weighed.
    await expect(page.locator("#todo-tab-badge")).toHaveText(String(await page.locator("form[data-weigh]").count()));
    await toWeigh.locator("input").fill("297.5");
    await toWeigh.locator("input").press("Enter");
    await expect(toWeigh).toHaveCount(0);

    const receipt = await (await page.request.get(`/api/receipts/${receiptId}`)).json();
    const weighed = receipt.lines[0].batches.find((b: { supplier_batch_no: string }) => b.supplier_batch_no === "QA9-W1");
    expect(weighed.qty_actual_weighed).toBe(297.5);
  });

  test("History lists decided batches with filters, per role", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "SM8-MAT", name: "History Register Pigment", unit: "KG" });
    await login(page, "warehouse");
    await seedSupplier(page, "SM8-SUP", "History Supplier");
    const receiptId = await receiveMaterial(page, { supplierCode: "SM8-SUP", createdBy: "E2E Warehouse" }, [
      { code: "SM8-MAT", name: "History Register Pigment", unit: "KG", batches: [{ batchNo: "SM8-B1", qty: 100 }, { batchNo: "SM8-B2", qty: 60 }] },
    ]);
    await login(page, "quality");
    let card = await openReceiptCard(page, "todo", receiptId);
    await decideBatch(card, '.batch-row:has-text("SM8-B1") [data-decide]', { decision: "approve", decidedBy: "E2E Quality" });
    card = page.locator(`#queue-panel .receipt-card[data-receipt-id="${receiptId}"]`);
    await decideBatch(card, '.batch-row:has-text("SM8-B2") [data-decide]', { decision: "reject", decidedBy: "E2E Quality" });

    // Quality: one row per decided batch, record code and COA on the row.
    await goToNav(page, "history");
    const rows = page.locator(`.hist-row[data-receipt-id="${receiptId}"]`);
    await expect(rows).toHaveCount(2);
    await expect(rows.first().locator(".q-record")).toContainText(/RMF\d{4}/);
    await expect(rows.filter({ hasText: "SM8-B1" }).locator("[data-coa]")).toHaveCount(2);
    // The decision filter narrows it.
    await page.click('[data-decision="rejected"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("SM8-B2");
    await page.click('[data-decision=""]');
    await expect(rows).toHaveCount(2);

    // Warehouse: weighs the approved batch, then sees both in History with
    // its own columns and no record codes.
    await login(page, "warehouse");
    await goToNav(page, "todo");
    const weigh = page.locator(`.wh-row[data-receipt-id="${receiptId}"]:has(form[data-weigh])`);
    await weigh.locator("input").fill("98");
    await weigh.locator("input").press("Enter");
    await expect(weigh).toHaveCount(0);
    await goToNav(page, "history");
    await expect(rows).toHaveCount(2);
    await expect(page.locator("#history-register")).not.toContainText(/RM[FPS]\d{4}/);
    await expect(rows.filter({ hasText: "SM8-B1" }).locator(".q-diff")).toContainText("-2.0%");

    // The export follows the filters.
    const exported = await page.request.get(`/api/reports/history-register?format=xlsx&q=SM8-B1`);
    expect(exported.status()).toBe(200);
  });

  test("retests a decided batch from History as a new round", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "SM7-MAT", name: "Retest Binder", unit: "KG" });
    await seedSpec(page, "SM7-MAT", {
      title: "Retest spec",
      created_by: "E2E Quality",
      parameters: [{ parameter_name: "Purity", param_type: "numeric_range", min_value: 95, max_value: 100, unit: "%" }],
    });
    await login(page, "warehouse");
    await seedSupplier(page, "SM7-SUP", "Retest Supplier");
    const receiptId = await receiveMaterial(page, { supplierCode: "SM7-SUP", createdBy: "E2E Warehouse" }, [
      { code: "SM7-MAT", name: "Retest Binder", unit: "KG", batches: [{ batchNo: "SM7-B1", qty: 500 }] },
    ]);

    // Round 1: tested, approved with an expiry date, weighed.
    await login(page, "quality");
    let card = await openReceiptCard(page, "todo", receiptId);
    await recordTestResults(card, "[data-test]", "E2E Quality", [{ parameterName: "Purity", measuredValue: "97", result: "pass" }]);
    await card.locator("[data-decide]").click();
    let decide = page.locator("#decide-form");
    await decide.locator('input[name="expiry_date"]').fill("2027-01-31");
    await decide.locator('input[name="decided_by"]').fill("E2E Quality");
    await decide.locator('button[type="submit"]').click();
    await expect(decide).toBeHidden();
    const batchId = (await (await page.request.get(`/api/receipts/${receiptId}`)).json()).lines[0].batches[0].id;
    const firstNo = (await (await page.request.get(`/api/receipts/${receiptId}`)).json()).lines[0].batches[0].internal_batch_no;
    await login(page, "warehouse");
    await goToNav(page, "todo");
    await page.locator(`.wh-row[data-receipt-id="${receiptId}"] form[data-weigh] input`).fill("499");
    await page.locator(`.wh-row[data-receipt-id="${receiptId}"] form[data-weigh] input`).press("Enter");
    await expect(page.locator(`.wh-row[data-receipt-id="${receiptId}"] form[data-weigh]`)).toHaveCount(0);

    // Quality starts a retest from History, putting the stock on hold.
    await login(page, "quality");
    card = await openReceiptCard(page, "history", receiptId);
    await card.locator("[data-retest]").click();
    const retest = page.locator("#retest-form");
    await retest.locator('select[name="reason"]').selectOption("shelf_life");
    await expect(retest.locator('input[name="on_hold"]')).toBeChecked();
    await retest.locator('input[name="started_by"]').fill("E2E Quality");
    await retest.locator('button[type="submit"]').click();
    await expect(retest).toBeHidden();

    // It's back in Quality's To Do under Retest.
    await goToNav(page, "todo");
    await page.locator('[data-stage="retest"]').click();
    const row = page.locator(`.queue-row[data-receipt-id="${receiptId}"]`);
    await expect(row).toContainText("Retest · round 2 · Shelf life ending");
    await expect(row.locator("[data-next]")).toHaveText("Record results");

    // Warehouse sees it on hold, without the reason.
    await login(page, "warehouse");
    await goToNav(page, "todo");
    await page.locator("#wh-with-quality summary").click();
    const held = page.locator(`#wh-with-quality .wh-row[data-receipt-id="${receiptId}"]`);
    await expect(held).toContainText("Retest · on hold");
    await expect(held).not.toContainText("Shelf life");

    // Round 2: new results, approved with a new expiry; same internal batch number.
    await login(page, "quality");
    card = await openReceiptCard(page, "todo", receiptId);
    await recordTestResults(card, "[data-test]", "E2E Quality", [{ parameterName: "Purity", measuredValue: "96", result: "pass" }]);
    await card.locator("[data-decide]").click();
    decide = page.locator("#decide-form");
    await expect(decide).toContainText("Retest, round 2");
    await expect(decide.locator('input[name="expiry_date"]')).toHaveValue("2027-01-31");
    await decide.locator('input[name="expiry_date"]').fill("2027-07-31");
    await decide.locator('input[name="decided_by"]').fill("E2E Quality");
    await decide.locator('button[type="submit"]').click();
    await expect(decide).toBeHidden();

    const batch = (await (await page.request.get(`/api/receipts/${receiptId}`)).json()).lines[0].batches[0];
    expect(batch).toMatchObject({ status: "approved", current_round: 2, on_hold: 0, internal_batch_no: firstNo, qty_actual_weighed: 499 });
    expect(batch.expiry_date).toContain("2027-07-31");
    expect(batch.test_results.map((r: { measured_value: string }) => r.measured_value)).toEqual(["96"]);
    const rounds = await (await page.request.get(`/api/batches/${batchId}/rounds`)).json();
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ round_no: 1, status: "approved" });
    expect(rounds[0].expiry_date).toContain("2027-01-31");
    expect(rounds[1]).toMatchObject({ round_no: 2, reason: "shelf_life", status: "approved" });
    // Both rounds print a COA.
    expect((await page.request.get(`/api/batches/${batchId}/coa?format=pdf&round=1`)).status()).toBe(200);
    expect((await page.request.get(`/api/batches/${batchId}/coa?format=pdf`)).status()).toBe(200);

    // History's panel lists both rounds.
    card = await openReceiptCard(page, "history", receiptId);
    await expect(page.locator("#queue-panel .rounds-table tbody tr")).toHaveCount(2);
  });
});
