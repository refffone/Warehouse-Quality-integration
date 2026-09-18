import { expect, test } from "./fixtures";
import { goToNav, login, receiveMaterial, seedMaterial, seedSpec, seedSupplier } from "./helpers";

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
});
