import { expect, test } from "./fixtures";
import { login, openReceiptCard, receiveMaterial, receiveMaterialWithNumber, seedMaterial, seedSpec, seedSupplier } from "./helpers";

// Matching samples to materials. A sample of an unknown material carries a
// stand-in (its RMS number) until Quality matches it: to an existing
// material as an alternative, or to a new code created from the supplier's
// first supply. Codes namespaced SM1-, SM2- since local D1 persists across
// tests within a run.

async function firstLine(page: import("@playwright/test").Page, receiptId: number) {
  const receipt = await (await page.request.get(`/api/receipts/${receiptId}`)).json();
  return receipt.lines[0] as { id: number; material_code: string; import_code: string };
}

test.describe("Sample matching", () => {
  test("matches a sample to an existing material as an alternative, with a spec for its manufacturer", async ({ page }) => {
    await login(page, "quality");
    await seedMaterial(page, { code: "SM1-MAT", name: "Existing Resin", unit: "KG" });
    await seedSpec(page, "SM1-MAT", {
      title: "Existing Resin spec",
      created_by: "E2E Quality",
      parameters: [{ parameter_name: "Purity", param_type: "numeric_range", min_value: 95, max_value: 100, unit: "%" }],
    });
    await seedSupplier(page, "SM1-SUP", "Alternative Supplier");
    const { id: receiptId } = await receiveMaterialWithNumber(
      page,
      { byQuality: true, supplierCode: "SM1-SUP", createdBy: "E2E Quality" },
      [{ name: "Alt Resin X-70", unit: "KG", batches: [{ batchNo: "SM1-S1", qty: 1 }] }]
    );

    // The unknown sample got a stand-in: its own RMS number, not a material.
    const line = await firstLine(page, receiptId);
    expect(line.material_code).toBe(line.import_code);
    expect(line.material_code).toMatch(/^RMS\d{4}$/);
    const listed = await (await page.request.get("/api/materials")).json();
    expect(listed.some((m: { code: string }) => m.code === line.material_code)).toBe(false);

    // It can be spec'd and tested before it's matched.
    await page.request.patch(`/api/receipt-lines/${line.id}/product-info`, { data: { manufacturer: "ACME Chem" } });
    const spec = await page.request.post(`/api/receipt-lines/${line.id}/spec`, {
      data: {
        mode: "one_time",
        created_by: "E2E Quality",
        parameters: [{ parameter_name: "Purity", param_type: "numeric_range", min_value: 90, max_value: 100, unit: "%" }],
      },
    });
    expect(spec.status()).toBe(201);

    await login(page, "quality");
    let card = await openReceiptCard(page, "todo", receiptId, "sample");
    await expect(card.locator(".line-head")).toContainText("Not matched");
    await card.locator("[data-associate]").click();
    await expect(page.locator('#assoc-mode option[value="new"]')).toHaveCount(0);
    await page.locator("#assoc-existing .search-input").fill("SM1-MAT");
    await page.locator("#assoc-existing .search-result-item").filter({ hasText: "SM1-MAT" }).first().click();
    await page.locator("#assoc-mfr-spec").check();
    await page.locator("#assoc-by").fill("E2E Quality");
    await page.locator("#assoc-submit").click();
    await expect(page.locator("#modal-root")).toBeEmpty();

    card = page.locator(`.receipt-card[data-receipt-id="${receiptId}"]`);
    await expect(card.locator(".line-head .code")).toContainText("SM1-MAT");
    await expect(card.locator("[data-associate]")).toHaveCount(0);
    // It keeps the spec it was tested against.
    await expect(card).toContainText("One-time spec: Purity (%)");

    const specs = await (await page.request.get("/api/materials/SM1-MAT/specs")).json();
    const acme = specs.filter((s: { variant: string | null }) => s.variant === "ACME Chem");
    expect(acme.map((s: { scope: string }) => s.scope).sort()).toEqual(["sample", "supply"]);
    expect(acme[0].parameters[0]).toMatchObject({ parameter_name: "Purity", min_value: 90 });
    // The material's normal spec is untouched.
    expect(specs.find((s: { variant: string | null; scope: string }) => !s.variant && s.scope === "supply").parameters[0].min_value).toBe(95);

    // The stand-in is gone.
    const moved = await firstLine(page, receiptId);
    expect(moved.material_code).toBe("SM1-MAT");
    expect(moved.import_code).toBe(line.import_code);
  });

  test("creates a new code from a first supply and brings its sample along", async ({ page }) => {
    await login(page, "quality");
    await seedSupplier(page, "SM2-SUP", "New Material Supplier");
    const { id: sampleReceiptId } = await receiveMaterialWithNumber(
      page,
      { byQuality: true, supplierCode: "SM2-SUP", createdBy: "E2E Quality" },
      [{ name: "Fancy Binder SM2", unit: "KG", batches: [{ batchNo: "SM2-S1", qty: 1 }] }]
    );
    const sampleLine = await firstLine(page, sampleReceiptId);
    await page.request.post(`/api/receipt-lines/${sampleLine.id}/spec`, {
      data: {
        mode: "one_time",
        created_by: "E2E Quality",
        parameters: [{ test_code: "SOLID_CONTENT", parameter_name: "Solid Content", param_type: "numeric_range", min_value: 49, max_value: 51 }],
      },
    });

    // A material code can't look like a record number.
    const bad = await page.request.put("/api/materials", { data: { code: "RMS9999", name: "Nope", unit: "KG" } });
    expect(bad.status()).toBe(400);

    await login(page, "warehouse");
    const supplyReceiptId = await receiveMaterial(page, { supplierCode: "SM2-SUP", createdBy: "E2E Warehouse" }, [
      { name: "Fancy Binder SM2", unit: "KG", batches: [{ batchNo: "SM2-B1", qty: 500 }] },
    ]);

    await login(page, "quality");
    let card = await openReceiptCard(page, "todo", supplyReceiptId);
    await expect(card.locator("[data-associate]")).toContainText("Match or create code");
    await card.locator("[data-associate]").click();
    await page.locator("#assoc-mode").selectOption("new");
    // The same supplier's sample with the same name is suggested and ticked.
    const suggested = page.locator("#assoc-samples .sample-pick", { hasText: sampleLine.import_code });
    await expect(suggested).toContainText("Suggested");
    await expect(suggested.locator("input")).toBeChecked();
    // Record numbers are refused as material codes.
    await page.locator('#assoc-new [name="new_code"]').fill("RMF4444");
    await page.locator("#assoc-submit").click();
    await expect(page.locator(".toast").last()).toContainText("record number");
    await page.locator('#assoc-new [name="new_code"]').fill("SM2-NEW");
    await page.locator("#assoc-by").fill("E2E Quality");
    await page.locator("#assoc-submit").click();
    await expect(page.locator("#modal-root")).toBeEmpty();

    card = page.locator(`.receipt-card[data-receipt-id="${supplyReceiptId}"]`);
    await expect(card.locator(".line-head .code")).toContainText("SM2-NEW");
    const supplyAsQuality = await firstLine(page, supplyReceiptId);
    const firstLineAsQuality = async () => supplyAsQuality;
    await expect(card.locator(".line-head .badge.flag")).toContainText(/RMF\d{4}/);
    await expect(card.locator(".line-head")).toContainText(`From sample ${sampleLine.import_code}`);
    await expect(card).toContainText("Spec v1: Solid Content (%)");

    // Both of the new material's specs come from the sample.
    const specs = await (await page.request.get("/api/materials/SM2-NEW/specs")).json();
    expect(specs.map((s: { scope: string }) => s.scope).sort()).toEqual(["sample", "supply"]);
    for (const s of specs) expect(s.parameters[0]).toMatchObject({ parameter_name: "Solid Content", min_value: 49, max_value: 51 });

    // Warehouse sees the supply's material code, never its record code or
    // its first-supply label, and can't find it by that record code.
    await login(page, "warehouse");
    const whCard = await openReceiptCard(page, "todo", supplyReceiptId);
    await expect(whCard.locator(".line-head .code")).toContainText("SM2-NEW");
    await expect(whCard).not.toContainText(/RM[FPS]\d{4}/);
    await expect(whCard).not.toContainText("First supply");
    const whLine = (await (await page.request.get(`/api/receipts/${supplyReceiptId}`)).json()).lines[0];
    expect(whLine).toMatchObject({ material_code: "SM2-NEW", import_code: null, supply_kind: null });
    const recordCode = (await firstLineAsQuality()).import_code;
    const found = await (await page.request.get(`/api/receipts/detailed?type=import&q=${recordCode}`)).json();
    expect(found.items.some((r: { id: number }) => r.id === supplyReceiptId)).toBe(false);
    await login(page, "quality");

    // The sample moved to the new code and points at the supply.
    const sampleCard = await openReceiptCard(page, "todo", sampleReceiptId, "sample");
    await expect(sampleCard.locator(".line-head .code")).toContainText("SM2-NEW");
    await expect(sampleCard.locator(".line-head")).toContainText(/Led to RMF\d{4}/);
  });
});
