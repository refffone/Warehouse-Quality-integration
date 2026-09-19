// Seeds the staging/demo environment with a realistic, fixed set of
// fictional data (suppliers, materials, specs, receipts across every
// status) through the app's own APIs — the same approach used to verify
// changes throughout development, chosen over hand-written SQL fixtures so
// seeded data always goes through the app's real business logic (import
// codes, receipt numbers, batch numbers) instead of drifting from it.
//
// Idempotent: every entity uses a fixed "DEMO-" code/name, and creation
// calls treat "already exists" (400/409) as success — so re-running this
// on every staging deploy converges on the same canonical dataset instead
// of duplicating it. It never deletes anything, so edits made *during* a
// demo (deciding a pending batch, adding a note) just sit alongside the
// canonical set until the next deploy re-seeds it.
//
// Run via: APP_URL=... ADMIN_PASSWORD=... node scripts/seed-demo-data.mjs
import { setTimeout as sleep } from "node:timers/promises";

const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
const adminPassword = process.env.ADMIN_PASSWORD;
if (!base || !adminPassword) {
  console.error("Usage: APP_URL=https://... ADMIN_PASSWORD=... node scripts/seed-demo-data.mjs");
  process.exit(1);
}

const authHeader = "Basic " + Buffer.from(`admin:${adminPassword}`).toString("base64");

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${base}/`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error(`Server never became ready at ${base}`);
}

// `wrangler secret put` (just run before this script) triggers a new Worker
// deployment; Cloudflare's edge takes a moment to roll it out everywhere, so
// the first authenticated request can land on a stale edge PoP still serving
// the previous (unset) ADMIN_PASSWORD and get a spurious 401. Retry a few
// times with backoff before giving up — a real bad password still fails
// after exhausting retries.
async function createAccount(username, password, role, displayName, attempts = 5) {
  let lastStatus, lastBody;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(`${base}/admin/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader },
      body: JSON.stringify({ username, password, role, display_name: displayName }),
    });
    if (res.ok || res.status === 400 || res.status === 409) return;
    if (res.status !== 401 || attempt === attempts) {
      throw new Error(`createAccount(${username}) failed: ${res.status} ${await res.text()}`);
    }
    lastStatus = res.status;
    lastBody = await res.text();
    await sleep(1500 * attempt);
  }
  throw new Error(`createAccount(${username}) failed: ${lastStatus} ${lastBody}`);
}

function session(username, password) {
  let cookie = null;
  async function api(path, opts = {}) {
    const res = await fetch(`${base}${path}`, {
      ...opts,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
    });
    return res;
  }
  return {
    async login() {
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) throw new Error(`login(${username}) failed: ${res.status} ${await res.text()}`);
      cookie = res.headers.get("set-cookie").split(";")[0];
    },
    api,
    async post(path, body) {
      const res = await api(path, { method: "POST", body: JSON.stringify(body) });
      return { status: res.status, body: await res.text() };
    },
    async put(path, body) {
      const res = await api(path, { method: "PUT", body: JSON.stringify(body) });
      return { status: res.status, body: await res.text() };
    },
    async get(path) {
      const res = await api(path);
      return { status: res.status, body: await res.text() };
    },
  };
}

function ok(label, res, extraOkStatus = []) {
  if (res.status >= 200 && res.status < 300) return JSON.parse(res.body);
  if ([400, 409, ...extraOkStatus].includes(res.status)) return null; // already exists — fine
  throw new Error(`${label} failed: ${res.status} ${res.body}`);
}

console.log(`Seeding demo data at ${base} ...`);
await waitForServer();

await createAccount("quality", "demo12345", "quality", "Demo Quality");
await createAccount("warehouse", "demo12345", "warehouse", "Demo Warehouse");

const qc = session("quality", "demo12345");
const wh = session("warehouse", "demo12345");
await qc.login();
await wh.login();

// ---------------------------------------------------------------- master data

const SUPPLIERS = [
  { code: "DEMO-SUP-01", name: "Al Nahda Chemicals", abbreviation: "ANC" },
  { code: "DEMO-SUP-02", name: "Gulf Resins & Polymers", abbreviation: "GRP" },
  { code: "DEMO-SUP-03", name: "Horizon Specialty Additives", abbreviation: "HSA" },
  { code: "DEMO-SUP-04", name: "BlueWave Solvents Trading", abbreviation: "BWS" },
];
for (const s of SUPPLIERS) ok("seedSupplier", await qc.post("/api/suppliers", s));

const MATERIALS = [
  { code: "DEMO-RM-001", name: "Short Alkyd Resin 70%", unit: "KG" },
  { code: "DEMO-RM-002", name: "Titanium Dioxide Rutile", unit: "KG" },
  { code: "DEMO-RM-003", name: "Xylene (Mixed)", unit: "KG" },
  { code: "DEMO-RM-004", name: "Calcium Carbonate Fine", unit: "KG" },
  { code: "DEMO-RM-005", name: "Anti-Foam Additive", unit: "KG" },
];
for (const m of MATERIALS) ok("seedMaterial", await qc.put("/api/materials", m));

const spec1 = ok(
  "seedSpec1",
  await qc.post("/api/materials/DEMO-RM-001/specs", {
    scope: "supply",
    title: "Standard supply spec",
    created_by: "Demo Quality",
    parameters: [
      { parameter_name: "Viscosity", param_type: "time_range", method: "W-QC-01-01", conditions: "Cup#4, 25°C", min_value: 60, max_value: 90 },
      { parameter_name: "Solid Content", param_type: "numeric_range", method: "W-QC-01-05", min_value: 68, max_value: 72, unit: "%" },
      { parameter_name: "Density", param_type: "numeric_range", method: "W-QC-01-04", min_value: 1.0, max_value: 1.04, unit: "g/ml" },
      { parameter_name: "Appearance", param_type: "appearance", method: "Visual", expected_text: "Clear, pale yellow liquid, free of particles" },
    ],
  })
);
const spec2 = ok(
  "seedSpec2",
  await qc.post("/api/materials/DEMO-RM-002/specs", {
    scope: "supply",
    title: "Standard supply spec",
    created_by: "Demo Quality",
    parameters: [
      { parameter_name: "Whiteness Index", param_type: "min", method: "W-QC-02-01", min_value: 95, unit: "" },
      { parameter_name: "Oil Absorption", param_type: "max", method: "W-QC-02-03", max_value: 20, unit: "g/100g" },
    ],
  })
);

// A supply spec covers imports; only DEMO-RM-001/002 need one for the demo
// receipts below (the rest are received without a spec check attached, a
// realistic "material not yet under formal spec" case worth showing too).

// ---------------------------------------------------------------- receipts

async function receive(sess, payload) {
  const res = await sess.post("/api/receipts", payload);
  if (res.status === 201) return JSON.parse(res.body);
  // Idempotency for receipts is trickier (no natural unique key exposed to
  // us) — rather than risk silently skipping a real duplicate-looking
  // receipt, only treat a conflict as "already seeded" when the message
  // says so; anything else is a real failure worth surfacing.
  if (res.status >= 400 && /already/i.test(res.body)) return null;
  throw new Error(`receive failed: ${res.status} ${res.body}`);
}

const now = () => new Date().toISOString().slice(0, 16);

// A pending import — shows up in both To Do lists, untouched.
await receive(wh, {
  type: "import",
  supplier_code: "DEMO-SUP-01",
  created_by: "Demo Warehouse",
  received_at: now(),
  lines: [
    {
      material_code: "DEMO-RM-001",
      material_name_text: "Short Alkyd Resin 70%",
      unit: "KG",
      batches: [{ supplier_batch_no: "ANC-2201", qty_as_received: 2000 }],
    },
  ],
});

// An import Quality has approved and Warehouse has weighed in — shows in
// History as a clean pass, with a real COA available.
const approvedReceipt = await receive(wh, {
  type: "import",
  supplier_code: "DEMO-SUP-02",
  created_by: "Demo Warehouse",
  received_at: now(),
  lines: [
    {
      material_code: "DEMO-RM-002",
      material_name_text: "Titanium Dioxide Rutile",
      unit: "KG",
      batches: [{ supplier_batch_no: "GRP-5510", qty_as_received: 1000 }],
    },
  ],
});
if (approvedReceipt) {
  const detail = JSON.parse((await qc.get(`/api/receipts/${approvedReceipt.id}`)).body);
  const batch = detail.lines[0].batches[0];
  const params = spec2 ? spec2.parameters : [];
  if (params.length) {
    ok(
      "testResults",
      await qc.post(`/api/batches/${batch.id}/test-results`, {
        tested_by: "Demo Quality",
        results: [
          { spec_parameter_id: params[0].id, measured_value: "97", result: "pass" },
          { spec_parameter_id: params[1].id, measured_value: "14", result: "pass" },
        ],
      })
    );
  }
  ok("decide", await qc.post(`/api/batches/${batch.id}/decision`, { decision: "approve", decided_by: "Demo Quality" }));
  ok("finalize", await wh.post(`/api/batches/${batch.id}/finalize-weight`, { qty_actual_weighed: 998 }));
}

// A rejected import — the "something went wrong" case a demo needs to show.
const rejectedReceipt = await receive(wh, {
  type: "import",
  supplier_code: "DEMO-SUP-03",
  created_by: "Demo Warehouse",
  received_at: now(),
  lines: [
    {
      material_code: "DEMO-RM-003",
      material_name_text: "Xylene (Mixed)",
      unit: "KG",
      batches: [{ supplier_batch_no: "HSA-0087", qty_as_received: 500 }],
    },
  ],
});
if (rejectedReceipt) {
  const detail = JSON.parse((await qc.get(`/api/receipts/${rejectedReceipt.id}`)).body);
  const batch = detail.lines[0].batches[0];
  ok(
    "decide",
    await qc.post(`/api/batches/${batch.id}/decision`, {
      decision: "reject",
      decided_by: "Demo Quality",
    })
  );
}

// A partial acceptance — the nuanced middle case.
const partialReceipt = await receive(wh, {
  type: "import",
  supplier_code: "DEMO-SUP-04",
  created_by: "Demo Warehouse",
  received_at: now(),
  lines: [
    {
      material_code: "DEMO-RM-004",
      material_name_text: "Calcium Carbonate Fine",
      unit: "KG",
      batches: [{ supplier_batch_no: "BWS-3390", qty_as_received: 3000 }],
    },
  ],
});
if (partialReceipt) {
  const detail = JSON.parse((await qc.get(`/api/receipts/${partialReceipt.id}`)).body);
  const batch = detail.lines[0].batches[0];
  ok(
    "decide",
    await qc.post(`/api/batches/${batch.id}/decision`, {
      decision: "partial",
      decided_by: "Demo Quality",
      qty_accepted: 2600,
      qty_rejected: 400,
    })
  );
}

// A sample Quality received directly — exercises the QS-#### series and
// the "hidden from Warehouse" behavior.
const sampleReceipt = await receive(qc, {
  type: "sample",
  supplier_code: "DEMO-SUP-01",
  created_by: "Demo Quality",
  sample_sent_by: "Nadia (ANC Sales)",
  received_at: now(),
  lines: [
    {
      material_code: "DEMO-RM-005",
      material_name_text: "Anti-Foam Additive",
      unit: "KG",
      batches: [{ supplier_batch_no: "ANC-SMP-14", qty_as_received: 5 }],
    },
  ],
});
if (sampleReceipt) {
  const detail = JSON.parse((await qc.get(`/api/receipts/${sampleReceipt.id}`)).body);
  const batch = detail.lines[0].batches[0];
  ok("decide", await qc.post(`/api/batches/${batch.id}/decision`, { decision: "approve", decided_by: "Demo Quality" }));
}

console.log("Demo data seeded.");
console.log("Sign in at " + base + "/login/quality with quality / demo12345");
console.log("Sign in at " + base + "/login/warehouse with warehouse / demo12345");
