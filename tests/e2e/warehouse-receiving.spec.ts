import { expect, test } from "./fixtures";
import {
  decideBatch,
  finalizeWeight,
  login,
  openReceiptCard,
  receiveMaterial,
  seedMaterial,
  seedSupplier,
} from "./helpers";

// Every test here logs in as Warehouse and drives the real Receive wizard
// through the UI — no API shortcuts for the transaction under test.
// Supplier/material codes are namespaced per test (WH1-, WH2-, ...) since
// local D1 isn't reset between tests within a run.

test.describe("Warehouse: receiving", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, "warehouse");
  });

  test("receives one material with a single batch", async ({ page }) => {
    await seedSupplier(page, "WH1-SUP", "Warehouse Test Supplier One");

    const receiptId = await receiveMaterial(
      page,
      { supplierCode: "WH1-SUP", createdBy: "E2E Warehouse" },
      [{ name: "Single Batch Resin", unit: "KG", batches: [{ batchNo: "WH1-B1", qty: 500 }] }]
    );

    const card = await openReceiptCard(page, "todo", receiptId);
    await expect(card).toContainText("WH1-SUP"); // the actual supplier picked, not a stale/wrong one
    await expect(card).toContainText("Single Batch Resin");
    await expect(card.locator(".batch-row")).toHaveCount(1);
    await expect(card.locator(".batch-row")).toContainText("WH1-B1");
    await expect(card.locator(".batch-row")).toContainText("500");
  });

  test("receives one material with several batches", async ({ page }) => {
    await seedSupplier(page, "WH2-SUP", "Warehouse Test Supplier Two");

    const receiptId = await receiveMaterial(
      page,
      { supplierCode: "WH2-SUP", createdBy: "E2E Warehouse" },
      [
        {
          name: "Multi Batch Resin",
          unit: "KG",
          batches: [
            { batchNo: "WH2-B1", qty: 200 },
            { batchNo: "WH2-B2", qty: 300 },
            { batchNo: "WH2-B3", qty: 150 },
          ],
        },
      ]
    );

    const card = await openReceiptCard(page, "todo", receiptId);
    await expect(card).toContainText("WH2-SUP");
    await expect(card.locator(".batch-row")).toHaveCount(3);
    for (const batchNo of ["WH2-B1", "WH2-B2", "WH2-B3"]) {
      await expect(card.locator(".batch-row").filter({ hasText: batchNo })).toBeVisible();
    }
  });

  test("receives multiple materials, each with multiple batches", async ({ page }) => {
    await seedSupplier(page, "WH3-SUP", "Warehouse Test Supplier Three");

    const receiptId = await receiveMaterial(
      page,
      { supplierCode: "WH3-SUP", createdBy: "E2E Warehouse" },
      [
        {
          name: "Material Alpha",
          unit: "KG",
          batches: [
            { batchNo: "WH3-A1", qty: 100 },
            { batchNo: "WH3-A2", qty: 120 },
          ],
        },
        {
          name: "Material Beta",
          unit: "PCS",
          batches: [
            { batchNo: "WH3-B1", qty: 40 },
            { batchNo: "WH3-B2", qty: 60 },
            { batchNo: "WH3-B3", qty: 10 },
          ],
        },
      ]
    );

    const card = await openReceiptCard(page, "todo", receiptId);
    await expect(card).toContainText("WH3-SUP");
    await expect(card.locator(".line-block")).toHaveCount(2);
    await expect(card).toContainText("Material Alpha");
    await expect(card).toContainText("Material Beta");
    await expect(card.locator(".batch-row")).toHaveCount(5);
  });

  test("receives a sample and records who sent it", async ({ page }) => {
    await seedSupplier(page, "WH4-SUP", "Warehouse Test Supplier Four");

    const receiptId = await receiveMaterial(
      page,
      {
        type: "sample",
        supplierCode: "WH4-SUP",
        createdBy: "E2E Warehouse",
        sampleSentBy: "Sample Courier Co.",
      },
      [{ name: "Sample Material", unit: "KG", batches: [{ batchNo: "WH4-S1", qty: 2 }] }]
    );

    const card = await openReceiptCard(page, "todo", receiptId, "sample");
    await expect(card).toContainText("WH4-SUP");
    await expect(card).toContainText("Sample Material");
    await expect(card).toContainText("Sample Courier Co.");
  });

  test("finalizes actual weight once Quality has approved an import batch", async ({ page }) => {
    // Deciding a batch requires its line to already have a material code
    // (src/routes/receipts.ts's decideBatch 400s otherwise), so Quality
    // needs to code this material before Warehouse can receive against
    // it and get it decided.
    await login(page, "quality");
    await seedMaterial(page, { code: "WH5-MAT", name: "Weigh-Check Material", unit: "KG" });

    await login(page, "warehouse");
    await seedSupplier(page, "WH5-SUP", "Warehouse Test Supplier Five");

    const receiptId = await receiveMaterial(
      page,
      { supplierCode: "WH5-SUP", createdBy: "E2E Warehouse" },
      [{ code: "WH5-MAT", name: "Weigh-Check Material", unit: "KG", batches: [{ batchNo: "WH5-B1", qty: 1000 }] }]
    );

    // Quality approves the batch first — a prerequisite step, not itself
    // under test here (that's covered by quality-decisions.spec.ts).
    await login(page, "quality");
    let card = await openReceiptCard(page, "todo", receiptId);
    await decideBatch(card, '[data-decide]', { decision: "approve", decidedBy: "E2E Quality" });

    // Back to Warehouse for the actual transaction under test: recording
    // the real weighed quantity, which can differ from what the supplier's
    // paperwork claimed. For Quality, a fully-decided receipt moves
    // straight to History — but Warehouse's own To Do also tracks "still
    // needs a weigh-in" separately from "still needs a decision"
    // (`fetchReceiptsBucket`'s `receiptNeedsWeighIn` check in app.js), so
    // an approved-but-unweighed import stays in Warehouse's To Do even
    // though it already left Quality's.
    await login(page, "warehouse");
    card = await openReceiptCard(page, "todo", receiptId);
    await expect(card).toContainText("WH5-SUP");
    await finalizeWeight(card, "[data-finalize]", 987);

    // Now that it's both decided *and* weighed, it no longer needs
    // anything from Warehouse either, so it finally does move to History.
    card = await openReceiptCard(page, "history", receiptId);
    await expect(card.locator(".batch-row")).toContainText("987");
    await expect(card.locator('[data-finalize]')).toHaveCount(0); // can't finalize twice
  });
});
