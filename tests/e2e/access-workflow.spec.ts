import { expect, test } from "./fixtures";
import {
  decideBatch,
  login,
  openReceiptCard,
  recordTestResults,
  receiveMaterial,
  receiveMaterialWithNumber,
  seedMaterial,
  seedSpec,
  seedSupplier,
} from "./helpers";

// The Access-log alignment: sample / first supply / regular supply, each
// with its own code pool (RMS / RMF / RMP); Access-format internal batch
// numbers; and "accepted with concession". Codes namespaced AW1- through
// AW3- since local D1 persists across tests within a run.

const YY = String(new Date().getUTCFullYear()).slice(2);

test.describe("Access workflow alignment", () => {
  test("files supplies as first (RMF) then regular (RMP), and samples as RMS", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "AW1-MAT", name: "Access Flow Material", unit: "KG" });
    await seedSupplier(page, "AW1-SUP", "Access Flow Supplier", "AWA");

    await login(page, "warehouse");
    const line = { code: "AW1-MAT", name: "Access Flow Material", unit: "KG" };
    const first = await receiveMaterial(page, { supplierCode: "AW1-SUP", createdBy: "E2E Warehouse" }, [
      { ...line, batches: [{ batchNo: "AW1-B1", qty: 100 }] },
    ]);
    const regular = await receiveMaterial(page, { supplierCode: "AW1-SUP", createdBy: "E2E Warehouse" }, [
      { ...line, batches: [{ batchNo: "AW1-B2", qty: 100 }] },
    ]);
    const sample = await receiveMaterial(
      page,
      { type: "sample", supplierCode: "AW1-SUP", createdBy: "E2E Warehouse", sampleSentBy: "Rep" },
      [{ ...line, batches: [{ batchNo: "AW1-S1", qty: 1 }] }]
    );

    await login(page, "quality");
    let card = await openReceiptCard(page, "todo", first);
    await expect(card.locator(".line-head .badge.flag")).toContainText(/RMF\d{4}/);
    await expect(card.locator(".line-head .badge.flag")).toContainText("First supply");

    card = await openReceiptCard(page, "todo", regular);
    await expect(card.locator(".line-head .badge.repeat")).toContainText(/RMP\d{4}/);
    await expect(card.locator(".line-head .badge.repeat")).toContainText("Regular supply");

    card = await openReceiptCard(page, "todo", sample, "sample");
    await expect(card.locator(".line-head .badge", { hasText: /RMS\d{4}/ })).toContainText("Sample");

    // First supply batch gets an Access-format internal batch number:
    // abbreviation + 4-digit sequence (per material) + 2-digit year.
    card = await openReceiptCard(page, "todo", first);
    await decideBatch(card, "[data-decide]", { decision: "approve", decidedBy: "E2E Quality" });
    card = await openReceiptCard(page, "history", first);
    await expect(card.locator(".batch-row")).toContainText(`AWA0001${YY}`);
  });

  test("accepts a batch with concession and shows why", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "AW2-MAT", name: "Concession Material", unit: "KG" });

    await login(page, "warehouse");
    await seedSupplier(page, "AW2-SUP", "Concession Supplier");
    const receiptId = await receiveMaterial(page, { supplierCode: "AW2-SUP", createdBy: "E2E Warehouse" }, [
      { code: "AW2-MAT", name: "Concession Material", unit: "KG", batches: [{ batchNo: "AW2-B1", qty: 50 }] },
    ]);

    await login(page, "quality");
    let card = await openReceiptCard(page, "todo", receiptId);
    await decideBatch(card, "[data-decide]", {
      decision: "concession",
      concessionReason: "Viscosity slightly low",
      concessionApprovedBy: "Eng. Farouk",
      decidedBy: "E2E Quality",
    });

    card = await openReceiptCard(page, "history", receiptId);
    await expect(card.locator(".batch-row .status-pill.concession")).toBeVisible();
    await expect(card).toContainText("Viscosity slightly low");
    await expect(card).toContainText("Eng. Farouk");

    // Warehouse still treats it as accepted: it's waiting to be weighed in.
    await login(page, "warehouse");
    card = await openReceiptCard(page, "todo", receiptId);
    await expect(card.locator("[data-finalize]")).toBeVisible();
  });

  test("lets Quality reclassify a regular supply as a first supply", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "AW3-MAT", name: "Reclassify Material", unit: "KG" });

    await login(page, "warehouse");
    await seedSupplier(page, "AW3-SUP", "Reclassify Supplier");
    const line = { code: "AW3-MAT", name: "Reclassify Material", unit: "KG" };
    await receiveMaterial(page, { supplierCode: "AW3-SUP", createdBy: "E2E Warehouse" }, [
      { ...line, batches: [{ batchNo: "AW3-B1", qty: 10 }] },
    ]);
    const receiptId = await receiveMaterial(page, { supplierCode: "AW3-SUP", createdBy: "E2E Warehouse" }, [
      { ...line, batches: [{ batchNo: "AW3-B2", qty: 10 }] },
    ]);

    await login(page, "quality");
    const card = await openReceiptCard(page, "todo", receiptId);
    await expect(card.locator(".line-head .badge.repeat")).toContainText(/RMP\d{4}/);

    await card.locator("[data-classify]").click();
    const modal = page.locator("#classify-form");
    await modal.locator('select[name="supply_kind"]').selectOption("first");
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeHidden();

    const refreshed = page.locator(`.receipt-card[data-receipt-id="${receiptId}"]`);
    await expect(refreshed.locator(".line-head .badge.flag")).toContainText(/RMF\d{4}/);
  });

  test("judges measured values against the spec and asks why when overridden", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "AW4-MAT", name: "Spec Judge Material", unit: "KG" });
    await seedSpec(page, "AW4-MAT", {
      title: "Access-style spec",
      created_by: "E2E Quality",
      parameters: [
        { test_code: "WATER_CONTENT", param_type: "max", max_value: 0.05 },
        { test_code: "VISCOSITY", param_type: "time_range", min_value: 90, max_value: 110, conditions: "Cup #8 ISO" },
      ],
    });

    await login(page, "warehouse");
    await seedSupplier(page, "AW4-SUP", "Spec Judge Supplier");
    const receiptId = await receiveMaterial(page, { supplierCode: "AW4-SUP", createdBy: "E2E Warehouse" }, [
      { code: "AW4-MAT", name: "Spec Judge Material", unit: "KG", batches: [{ batchNo: "AW4-B1", qty: 20 }] },
    ]);

    await login(page, "quality");
    const card = await openReceiptCard(page, "todo", receiptId);
    await card.locator("[data-test]").click();
    const modal = page.locator("#test-results-form");
    const water = modal.locator("[data-result-row]").filter({ hasText: "Water Content" });
    const viscosity = modal.locator("[data-result-row]").filter({ hasText: "Viscosity" });
    await expect(water).toContainText("Max 0.05 %");
    await expect(viscosity).toContainText("1:30 – 1:50");
    await expect(viscosity).toContainText("Cup #8 ISO");

    // Typing a value picks the result automatically.
    await viscosity.locator('[data-f="measured_value"]').fill("1:40");
    await expect(viscosity.locator('[data-f="result"]')).toHaveValue("pass");
    await water.locator('[data-f="measured_value"]').fill("0.07");
    await expect(water.locator('[data-f="result"]')).toHaveValue("fail");

    // Disagreeing with the check needs a reason before it saves.
    await water.locator('[data-f="result"]').selectOption("pass");
    await expect(water.locator("[data-override-field]")).toBeVisible();
    await modal.locator('input[name="tested_by"]').fill("E2E Quality");
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeVisible();
    await water.locator('[data-f="override_reason"]').fill("Retested on second instrument");
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeHidden();

    const refreshed = page.locator(`.receipt-card[data-receipt-id="${receiptId}"]`);
    await refreshed.locator("[data-view-results]").click();
    await expect(page.locator(".modal")).toContainText("Retested on second instrument");
  });

  test("Quality records product details that Warehouse never sees", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "AW5-MAT", name: "Product Info Material", unit: "KG" });

    await login(page, "warehouse");
    await seedSupplier(page, "AW5-SUP", "Product Info Supplier");
    const receiptId = await receiveMaterial(page, { supplierCode: "AW5-SUP", createdBy: "E2E Warehouse" }, [
      { code: "AW5-MAT", name: "Product Info Material", unit: "KG", batches: [{ batchNo: "AW5-B1", qty: 10 }] },
    ]);
    let card = await openReceiptCard(page, "todo", receiptId);
    await expect(card.locator("[data-product-info]")).toHaveCount(0);

    await login(page, "quality");
    card = await openReceiptCard(page, "todo", receiptId);
    await card.locator("[data-product-info]").click();
    const modal = page.locator("#product-info-form");
    await modal.locator('[name="manufacturer"]').fill("Allnex");
    await modal.locator('[name="origin"]').fill("Germany");
    await modal.locator('[name="product_description"]').fill("Short oil alkyd resin with very good durability.");
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeHidden();

    card = page.locator(`.receipt-card[data-receipt-id="${receiptId}"]`);
    await expect(card).toContainText("Allnex · Germany");
    await expect(card).toContainText("Short oil alkyd resin");

    // Warehouse sees the same receipt without any of it — not in the page,
    // and not in the data the server sends.
    await login(page, "warehouse");
    card = await openReceiptCard(page, "todo", receiptId);
    await expect(card).not.toContainText("Allnex");
    await expect(card).not.toContainText("Short oil alkyd resin");
    const res = await page.request.get(`/api/receipts/${receiptId}`);
    const line = (await res.json()).lines[0];
    expect(line.manufacturer).toBeNull();
    expect(line.origin).toBeNull();
    expect(line.product_description).toBeNull();
    const denied = await page.request.patch(`/api/receipt-lines/${line.id}/product-info`, { data: { manufacturer: "X" } });
    expect(denied.status()).toBe(403);
  });

  test("Quality receives a sample directly: its own QS number, never shown to Warehouse", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "AW6-MAT", name: "Direct Sample Material", unit: "KG" });
    await seedSupplier(page, "AW6-SUP", "Direct Sample Supplier");

    // Warehouse deliveries are numbered on the warehouse serial...
    await login(page, "warehouse");
    const delivery = await receiveMaterialWithNumber(page, { supplierCode: "AW6-SUP", createdBy: "E2E Warehouse" }, [
      { code: "AW6-MAT", name: "Direct Sample Material", unit: "KG", batches: [{ batchNo: "AW6-B1", qty: 50 }] },
    ]);
    expect(delivery.receiptNo).toMatch(/^\d+$/);

    // ...while a sample Quality received itself gets a QS- number.
    await login(page, "quality");
    const direct = await receiveMaterialWithNumber(
      page,
      { byQuality: true, supplierCode: "AW6-SUP", createdBy: "E2E Quality", sampleSentBy: "Supplier rep" },
      [{ code: "AW6-MAT", name: "Direct Sample Material", unit: "KG", batches: [{ batchNo: "AW6-S1", qty: 1 }] }]
    );
    expect(direct.receiptNo).toMatch(/^QS-\d{4}$/);

    const card = await openReceiptCard(page, "todo", direct.id, "sample");
    await expect(card.locator(".receipt-title")).toContainText(direct.receiptNo);
    await expect(card).toContainText("Received by Quality");
    await expect(card.locator(".line-head .badge", { hasText: /RMS\d{4}/ })).toContainText("Sample");

    // Quality can't use the button to register a supply.
    const supply = await page.request.post("/api/receipts", {
      data: {
        type: "import",
        received_at: new Date().toISOString(),
        supplier_code: "AW6-SUP",
        created_by: "E2E Quality",
        lines: [{ material_code: "AW6-MAT", material_name_text: "Direct Sample Material", unit: "KG", batches: [{ supplier_batch_no: "X", qty_as_received: 1 }] }],
      },
    });
    expect(supply.status()).toBe(403);

    // Warehouse doesn't see it anywhere: not by id, not in its lists, not in search.
    await login(page, "warehouse");
    expect((await page.request.get(`/api/receipts/${direct.id}`)).status()).toBe(404);
    const samples = await (await page.request.get("/api/receipts/detailed?type=sample&limit=200")).json();
    expect(samples.items.some((r: { id: number }) => r.id === direct.id)).toBe(false);
    const search = await (await page.request.get(`/api/receipts/detailed?q=${encodeURIComponent(direct.receiptNo)}`)).json();
    expect(search.total).toBe(0);
    const own = await (await page.request.get(`/api/receipts/detailed?q=${encodeURIComponent(delivery.receiptNo)}&type=import`)).json();
    expect(own.items.some((r: { id: number }) => r.id === delivery.id)).toBe(true);
  });

  test("adds a one-time spec to a sample whose material has none, and prints its COA", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "AW7-MAT", name: "No Spec Sample Material", unit: "KG" });
    await seedSupplier(page, "AW7-SUP", "No Spec Supplier");
    const { id: receiptId } = await receiveMaterialWithNumber(
      page,
      { byQuality: true, supplierCode: "AW7-SUP", createdBy: "E2E Quality" },
      [{ code: "AW7-MAT", name: "No Spec Sample Material", unit: "KG", batches: [{ batchNo: "AW7-S1", qty: 1 }] }]
    );

    let card = await openReceiptCard(page, "todo", receiptId, "sample");
    await expect(card).toContainText("No active spec");
    await card.locator("[data-add-spec]").click();

    // Step 1: tick the tests as cards.
    const cards = page.locator("#line-spec-cards");
    await cards.locator(".test-card", { hasText: "Density" }).click();
    await cards.locator(".test-card", { hasText: "Visual Check" }).click();
    await expect(page.locator("#line-spec-count")).toContainText("2");
    await page.click("#line-spec-next");

    // Step 2: limits, in catalog order (Density, then Visual Check).
    const form = page.locator("#line-spec-form");
    const rows = form.locator(".param-item");
    await expect(rows).toHaveCount(2);
    await rows.nth(0).locator('[data-f="min_value"]').fill("0.95");
    await rows.nth(0).locator('[data-f="max_value"]').fill("1.05");
    await rows.nth(0).locator('[data-f="unit"]').fill("g/ml");
    await rows.nth(1).locator('[data-f="expected_text"]').fill("Clear liquid");
    await form.locator('input[name="created_by"]').fill("E2E Quality");
    await form.locator('button[type="submit"]').click();
    await expect(form).toBeHidden();

    card = page.locator(`.receipt-card[data-receipt-id="${receiptId}"]`);
    await expect(card).toContainText("One-time spec: Density (g/ml), Visual Check");
    await expect(card.locator("[data-add-spec]")).toHaveCount(0);

    await recordTestResults(card, "[data-test]", "E2E Quality", [
      { parameterName: "Density", measuredValue: "1.01", result: "pass" },
      { parameterName: "Visual Check", measuredValue: "Clear liquid", result: "pass" },
    ]);
    await decideBatch(card, "[data-decide]", { decision: "approve", decidedBy: "E2E Quality" });

    const receipt = await (await page.request.get(`/api/receipts/${receiptId}`)).json();
    const batch = receipt.lines[0].batches[0];
    expect(batch.test_results.map((r: { result: string }) => r.result)).toEqual(["pass", "pass"]);
    const coa = await page.request.get(`/api/batches/${batch.id}/coa?format=pdf`);
    expect(coa.status()).toBe(200);
    expect(coa.headers()["content-type"]).toContain("pdf");

    // The material itself still has no spec.
    expect(await (await page.request.get("/api/materials/AW7-MAT/specs")).json()).toEqual([]);
  });

  test("saves a spec written on a first supply as the material's new version", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "AW8-MAT", name: "First Supply No Spec", unit: "KG" });
    await login(page, "warehouse");
    await seedSupplier(page, "AW8-SUP", "First Supply Supplier");
    const receiptId = await receiveMaterial(page, { supplierCode: "AW8-SUP", createdBy: "E2E Warehouse" }, [
      { code: "AW8-MAT", name: "First Supply No Spec", unit: "KG", batches: [{ batchNo: "AW8-B1", qty: 200 }] },
    ]);

    await login(page, "quality");
    const card = await openReceiptCard(page, "todo", receiptId);
    await expect(card.locator(".line-head .badge.flag")).toContainText(/RMF\d{4}/);
    await card.locator("[data-add-spec]").click();
    await page.locator("#line-spec-cards .test-card", { hasText: "Solid Content" }).click();
    await page.click("#line-spec-next");
    const form = page.locator("#line-spec-form");
    await form.locator('[data-f="min_value"]').fill("49");
    await form.locator('[data-f="max_value"]').fill("51");
    await form.locator('input[name="mode"][value="version"]').check();
    await expect(form.locator('select[name="scope"]')).toHaveValue("supply");
    await form.locator('input[name="created_by"]').fill("E2E Quality");
    await form.locator('button[type="submit"]').click();
    await expect(form).toBeHidden();

    await expect(page.locator(`.receipt-card[data-receipt-id="${receiptId}"]`)).toContainText("Spec v1: Solid Content (%)");
    const specs = await (await page.request.get("/api/materials/AW8-MAT/specs")).json();
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ version: 1, scope: "supply", status: "active", receipt_line_id: null });
    expect(specs[0].change_reason).toMatch(/^Written for RMF\d{4}/);
  });
});
