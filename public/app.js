import { api, getRole, setRole, getRememberedName, rememberName } from "./api.js";

// ---------------------------------------------------------------- helpers

function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function nowLocalInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function toast(message, isError = false) {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
}

function openModal(titleHtml, bodyHtml) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" data-close>
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h2>${titleHtml}</h2><button class="icon-btn" data-close>✕</button></div>
        ${bodyHtml}
      </div>
    </div>`;
  root.querySelectorAll("[data-close]").forEach((elm) =>
    elm.addEventListener("click", (e) => {
      if (e.target.hasAttribute("data-close")) closeModal();
    })
  );
}

// ---------------------------------------------------------------- caches

let suppliersCache = null;
async function getSuppliers(force = false) {
  if (!suppliersCache || force) suppliersCache = await api.get("/api/suppliers");
  return suppliersCache;
}
function supplierName(id) {
  const s = (suppliersCache || []).find((x) => x.id === id);
  return s ? `${s.name} (${s.code})` : `#${id}`;
}

let materialsCache = null;
async function getMaterials(force = false) {
  if (!materialsCache || force) materialsCache = await api.get("/api/materials");
  return materialsCache;
}

let typesCache = null;
async function getTypes(force = false) {
  if (!typesCache || force) typesCache = await api.get("/api/material-types");
  return typesCache;
}

let subtypesCache = null;
async function getSubtypes(force = false) {
  if (!subtypesCache || force) subtypesCache = await api.get("/api/material-subtypes");
  return subtypesCache;
}

// ---------------------------------------------------------------- routes

const ROUTES = {
  warehouse: [
    { id: "receive", label: "Receive" },
    { id: "todo", label: "To Do" },
    { id: "history", label: "History" },
  ],
  quality: [
    { id: "todo", label: "To Do" },
    { id: "history", label: "History" },
    { id: "codes", label: "Codes" },
    { id: "specs", label: "Specifications" },
  ],
};

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [role, tab] = hash.split("/");
  if (role === getRole() && ROUTES[role]?.some((r) => r.id === tab)) return tab;
  return ROUTES[getRole()][0].id;
}

function goTo(tab) {
  location.hash = `#${getRole()}/${tab}`;
}

// ---------------------------------------------------------------- topbar

function renderTopbar() {
  const role = getRole();
  const tabsEl = document.getElementById("tabs");
  const active = currentRoute();
  tabsEl.innerHTML = ROUTES[role]
    .map((r) => `<button class="tab-btn${r.id === active ? " active" : ""}" data-tab="${r.id}">${r.label}</button>`)
    .join("");
  tabsEl.querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => goTo(btn.dataset.tab))
  );

  const roleSelect = document.getElementById("role-select");
  roleSelect.value = role;
  roleSelect.onchange = () => {
    setRole(roleSelect.value);
    location.hash = `#${roleSelect.value}/${ROUTES[roleSelect.value][0].id}`;
    renderTopbar();
    renderView();
    refreshNotifCount();
  };
}

// ---------------------------------------------------------------- notifications

async function refreshNotifCount() {
  try {
    const list = await api.get("/api/notifications?unread=true");
    const countEl = document.getElementById("notif-count");
    if (list.length > 0) {
      countEl.hidden = false;
      countEl.textContent = list.length > 9 ? "9+" : list.length;
    } else {
      countEl.hidden = true;
    }
  } catch {
    // silent — notification badge is best-effort
  }
}

async function toggleNotifPanel() {
  const existing = document.querySelector(".notif-panel");
  if (existing) {
    existing.remove();
    return;
  }
  const list = await api.get("/api/notifications");
  const panel = document.createElement("div");
  panel.className = "notif-panel";
  panel.innerHTML = list.length
    ? list
        .map(
          (n) => `
      <div class="notif-item${n.read_at ? "" : " unread"}" data-id="${n.id}">
        ${esc(n.message)}
        <span class="when">${fmtDateTime(n.created_at)} · ${esc(n.kind)}</span>
      </div>`
        )
        .join("")
    : `<div class="empty-state">No notifications yet</div>`;
  document.body.appendChild(panel);
  panel.querySelectorAll("[data-id]").forEach((item) =>
    item.addEventListener("click", async () => {
      await api.post(`/api/notifications/${item.dataset.id}/read`, {});
      item.classList.remove("unread");
      refreshNotifCount();
    })
  );
  setTimeout(() => {
    document.addEventListener(
      "click",
      function onDoc(e) {
        if (!panel.contains(e.target) && e.target.id !== "notif-btn") {
          panel.remove();
          document.removeEventListener("click", onDoc);
        }
      },
      { once: false }
    );
  }, 0);
}

// ---------------------------------------------------------------- view: Receive

async function viewReceive() {
  const suppliers = await getSuppliers();
  const view = document.getElementById("view");
  view.innerHTML = `
    <div class="view-head">
      <div><h1>Receive material</h1><p>Log an import or sample the moment it physically arrives.</p></div>
    </div>
    <form class="card form-grid" id="receive-form">
      <div class="field-row">
        <div class="field">
          <label>Type</label>
          <select name="type" id="rf-type">
            <option value="import">Import</option>
            <option value="sample">Sample</option>
          </select>
        </div>
        <div class="field">
          <label>Received at</label>
          <input type="datetime-local" name="received_at" value="${nowLocalInput()}" required />
        </div>
        <div class="field">
          <label>Your name</label>
          <input type="text" name="created_by" value="${esc(getRememberedName())}" required />
        </div>
      </div>
      <div class="field-row">
        <div class="field" style="flex:2">
          <label>Supplier</label>
          <div style="display:flex; gap:8px;">
            <select name="supplier_code" id="rf-supplier" style="flex:1">
              ${suppliers.map((s) => `<option value="${esc(s.code)}">${esc(s.name)} (${esc(s.code)})</option>`).join("")}
            </select>
            <button type="button" class="btn ghost sm" id="rf-new-supplier">+ New</button>
          </div>
        </div>
        <div class="field" id="rf-sample-sender-field" hidden style="flex:1">
          <label>Sample sent by</label>
          <input type="text" name="sample_sent_by" placeholder="e.g. Jane Doe (supplier rep)" />
        </div>
      </div>

      <div>
        <label class="small muted">Lines received</label>
        <div class="repeatable" id="rf-lines"></div>
        <button type="button" class="btn ghost sm" id="rf-add-line" style="margin-top:8px">+ Add material line</button>
      </div>

      <div style="display:flex; gap:10px; justify-content:flex-end;">
        <button type="submit" class="btn primary">Register receipt</button>
      </div>
    </form>
  `;

  const linesEl = document.getElementById("rf-lines");

  function addLine() {
    const item = document.createElement("div");
    item.className = "repeatable-item line-item";
    item.innerHTML = `
      <div class="repeatable-item-head">
        <b class="small">Material line</b>
        <button type="button" class="btn ghost sm" data-remove-line>Remove line</button>
      </div>
      <div class="field-row">
        <div class="field"><label>Material code (if known)</label><input type="text" data-f="material_code" /></div>
        <div class="field"><label>Material name (as on paperwork)</label><input type="text" data-f="material_name_text" required /></div>
        <div class="field" style="max-width:120px"><label>Unit</label><input type="text" data-f="unit" placeholder="KG" required /></div>
      </div>
      <div class="batches"></div>
      <button type="button" class="btn ghost sm" data-add-batch>+ Add supplier batch</button>
    `;
    item.querySelector("[data-remove-line]").addEventListener("click", () => item.remove());
    const batchesEl = item.querySelector(".batches");
    function addBatch() {
      const row = document.createElement("div");
      row.className = "field-row batch-item";
      row.innerHTML = `
        <div class="field"><label>Supplier batch #</label><input type="text" data-f="supplier_batch_no" required /></div>
        <div class="field" style="max-width:140px"><label>Qty as received</label><input type="number" step="any" data-f="qty_as_received" required /></div>
        <div style="align-self:flex-end"><button type="button" class="btn ghost sm" data-remove-batch>✕</button></div>
      `;
      row.querySelector("[data-remove-batch]").addEventListener("click", () => row.remove());
      batchesEl.appendChild(row);
    }
    item.querySelector("[data-add-batch]").addEventListener("click", addBatch);
    addBatch();
    linesEl.appendChild(item);
  }

  document.getElementById("rf-add-line").addEventListener("click", addLine);
  addLine();

  document.getElementById("rf-type").addEventListener("change", (e) => {
    document.getElementById("rf-sample-sender-field").hidden = e.target.value !== "sample";
  });

  document.getElementById("rf-new-supplier").addEventListener("click", () => {
    openModal(
      "New supplier",
      `<form class="form-grid" id="new-supplier-form">
        <div class="field"><label>Code</label><input name="code" required /></div>
        <div class="field"><label>Name</label><input name="name" required /></div>
        <button type="submit" class="btn primary">Create</button>
      </form>`
    );
    document.getElementById("new-supplier-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api.post("/api/suppliers", { code: fd.get("code"), name: fd.get("name") });
        await getSuppliers(true);
        closeModal();
        viewReceive();
        toast("Supplier added");
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  document.getElementById("receive-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    rememberName(fd.get("created_by"));

    const lines = [...linesEl.querySelectorAll(".line-item")].map((item) => {
      const get = (f) => item.querySelector(`[data-f="${f}"]`)?.value || "";
      const batches = [...item.querySelectorAll(".batch-item")].map((b) => ({
        supplier_batch_no: b.querySelector('[data-f="supplier_batch_no"]').value,
        qty_as_received: Number(b.querySelector('[data-f="qty_as_received"]').value),
      }));
      return {
        material_code: get("material_code") || null,
        material_name_text: get("material_name_text"),
        unit: get("unit"),
        batches,
      };
    });

    const body = {
      type: fd.get("type"),
      received_at: new Date(fd.get("received_at")).toISOString(),
      supplier_code: fd.get("supplier_code"),
      created_by: fd.get("created_by"),
      lines,
    };
    if (fd.get("type") === "sample" && fd.get("sample_sent_by")) {
      body.sample_sent_by = fd.get("sample_sent_by");
    }

    try {
      const result = await api.post("/api/receipts", body);
      toast(`Receipt #${result.id} registered`);
      goTo(fd.get("type") === "sample" ? "samples" : "imports");
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------------------------------------------------------------- shared receipt list/detail

function statusPill(status) {
  return `<span class="status-pill ${esc(status)}">${esc(status)}</span>`;
}

function batchStatusInline(b) {
  if (b.status === undefined) return `<span class="muted small">with Quality</span>`; // redacted (sample, warehouse view)
  if (b.status === "pending") return `<span class="muted small">awaiting decision</span>`;
  if (b.status === "rejected") return statusPill("rejected");
  return `${statusPill(b.status)}${b.internal_batch_no ? ` <span class="mono small">${esc(b.internal_batch_no)}</span>` : ""}`;
}

function renderLineDetail(line, { role, receiptType, canFinalize, canDecide }) {
  const spec = line.spec;
  const specHtml = spec
    ? `<span class="spec-chip">Spec v${spec.version}: ${spec.parameters
        .map((p) => `${esc(p.parameter_name)}${p.unit ? " (" + esc(p.unit) + ")" : ""}`)
        .join(", ") || "no parameters"}</span>`
    : line.material_code
      ? `<span class="spec-chip muted">No active spec</span>`
      : "";

  const importBadge =
    line.import_code
      ? `<span class="badge ${line.import_scenario === "repeat" ? "repeat" : "flag"}">${esc(line.import_code)}${
          role === "quality" && line.import_scenario ? " · " + esc(line.import_scenario.replace("_", " ")) : ""
        }</span>`
      : "";

  const batchesHtml = line.batches
    .map((b) => {
      const actions = [];
      if (canDecide && b.status === "pending") {
        actions.push(`<button class="btn sm primary" data-decide="${b.id}">Decide</button>`);
      }
      if (canFinalize && b.status !== "pending" && b.status !== "rejected" && b.qty_actual_weighed == null) {
        actions.push(`<button class="btn sm ghost" data-finalize="${b.id}">Finalize weight</button>`);
      }
      const qtyLine =
        b.qty_actual_weighed != null
          ? `${b.qty_as_received} as received · ${b.qty_actual_weighed} actual`
          : `${b.qty_as_received} as received`;
      return `
        <div class="batch-row">
          <div><span class="batch-id">${esc(b.supplier_batch_no)}</span> <span class="batch-qty">${qtyLine} ${esc(line.unit)}</span></div>
          <div class="hstack">
            ${b.expiry_date ? `<span class="small muted">exp ${fmtDate(b.expiry_date)}</span>` : ""}
            ${batchStatusInline(b)}
            ${actions.join("")}
          </div>
        </div>`;
    })
    .join("");

  return `
    <div class="line-block" data-line-id="${line.id}">
      <div class="line-head">
        <div class="line-material">
          ${esc(line.material_name_text)}
          ${line.material_code ? `<span class="code">${esc(line.material_code)}</span>` : `<span class="badge neutral">uncoded</span>`}
        </div>
        <div class="hstack">
          ${importBadge}
          ${specHtml}
          ${role === "quality" && !line.material_code ? `<button class="btn sm ghost" data-associate="${line.id}">Associate a Code</button>` : ""}
        </div>
      </div>
      ${batchesHtml}
    </div>`;
}

/** True if any field of this receipt (across its lines/batches) matches
 *  the search text: Receipt #, Material Code, Supplier batch#, Internal
 *  batch#, or Status (receipt- or batch-level). */
function receiptMatchesQuery(receipt, query) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const idMatch = String(receipt.id).includes(q) || `#${receipt.id}`.includes(q);
  if (idMatch) return true;
  if ((receipt.status || "").toLowerCase().includes(q)) return true;
  for (const line of receipt.lines) {
    if ((line.material_code || "").toLowerCase().includes(q)) return true;
    for (const b of line.batches) {
      if ((b.supplier_batch_no || "").toLowerCase().includes(q)) return true;
      if ((b.internal_batch_no || "").toLowerCase().includes(q)) return true;
      if ((b.status || "").toLowerCase().includes(q)) return true;
    }
  }
  return false;
}

/** True while an import receipt still has an approved/partial batch that
 *  hasn't been weighed yet — Quality may be fully "decided," but that's
 *  still a to-do for Warehouse. */
function receiptNeedsWeighIn(receipt) {
  return receipt.lines.some((line) =>
    line.batches.some((b) => (b.status === "approved" || b.status === "partial") && b.qty_actual_weighed == null)
  );
}

async function fetchReceiptsBucket({ role, type, bucket }) {
  const receipts = await api.get(`/api/receipts?${new URLSearchParams({ type })}`);
  const full = await Promise.all(receipts.map((r) => api.get(`/api/receipts/${r.id}`)));
  return full.filter((r) => {
    const decidedByQuality = r.status === "decided";
    // Warehouse's own to-do (weighing an approved batch) can outlive
    // Quality's decision, so "decided" alone isn't enough to file it
    // under History for them.
    const stillOpen = role === "warehouse" ? !decidedByQuality || receiptNeedsWeighIn(r) : !decidedByQuality;
    return bucket === "history" ? !stillOpen : stillOpen;
  });
}

function buildReceiptCard(receipt, { role, type }) {
  const canDecide = role === "quality";
  const canFinalize = role === "warehouse" && type === "import";

  const linesHtml = receipt.lines
    .map((line) => renderLineDetail(line, { role, receiptType: type, canFinalize, canDecide }))
    .join("");

  const senderHtml =
    type === "sample"
      ? `<div class="small muted" data-sender-block>
          Sent by: <span data-sender-value>${receipt.sample_sent_by ? esc(receipt.sample_sent_by) : "not recorded"}</span>
          <button class="btn ghost sm" data-edit-sender style="margin-left:6px">Edit</button>
        </div>`
      : "";

  const card = document.createElement("div");
  card.className = "card receipt-card";
  card.dataset.receiptId = receipt.id;
  card.innerHTML = `
    <div class="receipt-card-top">
      <div>
        <div class="receipt-title">Receipt #${receipt.id} · ${supplierName(receipt.supplier_id)}</div>
        <div class="receipt-meta">${fmtDateTime(receipt.received_at)} · logged by ${esc(receipt.created_by)}</div>
      </div>
      <div class="hstack">
        ${role === "quality" || type !== "sample" ? statusPill(receipt.status) : ""}
      </div>
    </div>
    ${senderHtml}
    ${linesHtml}
  `;

  // sample sender edit
  const editBtn = card.querySelector("[data-edit-sender]");
  if (editBtn) {
    editBtn.addEventListener("click", () => {
      const block = card.querySelector("[data-sender-block]");
      const current = receipt.sample_sent_by || "";
      block.innerHTML = `
        <input type="text" value="${esc(current)}" data-sender-input style="max-width:240px" />
        <button class="btn sm primary" data-save-sender>Save</button>`;
      block.querySelector("[data-save-sender]").addEventListener("click", async () => {
        const value = block.querySelector("[data-sender-input]").value.trim();
        if (!value) return toast("Enter a name first", true);
        try {
          await api.patch(`/api/receipts/${receipt.id}/sample-sender`, { sample_sent_by: value });
          toast("Sample sender updated");
          refreshCurrentView();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  }

  // decide
  card.querySelectorAll("[data-decide]").forEach((btn) =>
    btn.addEventListener("click", () => openDecideModal(btn.dataset.decide, () => refreshCurrentView()))
  );
  // finalize
  card.querySelectorAll("[data-finalize]").forEach((btn) =>
    btn.addEventListener("click", () => openFinalizeModal(btn.dataset.finalize, () => refreshCurrentView()))
  );
  // associate code
  card.querySelectorAll("[data-associate]").forEach((btn) =>
    btn.addEventListener("click", () => openAssociateModal(btn.dataset.associate, () => refreshCurrentView()))
  );

  return card;
}

async function renderReceiptsInto(container, { role, type, bucket, query }) {
  container.innerHTML = `<div class="empty-state">Loading…</div>`;
  await getSuppliers();
  const all = await fetchReceiptsBucket({ role, type, bucket });
  const matches = all.filter((r) => receiptMatchesQuery(r, query));

  if (all.length === 0) {
    const noun = type === "sample" ? "samples" : "imports";
    container.innerHTML = `<div class="empty-state">No ${bucket === "history" ? "decided" : "pending"} ${noun}.</div>`;
    return;
  }
  if (matches.length === 0) {
    container.innerHTML = `<div class="empty-state">No results for "${esc(query)}".</div>`;
    return;
  }
  container.innerHTML = "";
  for (const r of matches) {
    container.appendChild(buildReceiptCard(r, { role, type }));
  }
}

// ---------------------------------------------------------------- decide / finalize / associate modals

async function openDecideModal(batchId, onDone) {
  openModal(
    "Decide batch",
    `<form class="form-grid" id="decide-form">
      <div class="field">
        <label>Decision</label>
        <select name="decision" id="decide-decision">
          <option value="approve">Approve (whole batch)</option>
          <option value="partial">Approve partially</option>
          <option value="reject">Reject</option>
        </select>
      </div>
      <div class="field-row" id="decide-qty-row" hidden>
        <div class="field"><label>Qty accepted</label><input type="number" step="any" name="qty_accepted" /></div>
        <div class="field"><label>Qty rejected</label><input type="number" step="any" name="qty_rejected" /></div>
      </div>
      <div class="field-row" id="decide-approve-fields">
        <div class="field"><label>Expiry date</label><input type="date" name="expiry_date" /></div>
        <div class="field"><label>Production date</label><input type="date" name="production_date" /></div>
      </div>
      <div class="field-row" id="decide-approve-fields2">
        <div class="field"><label>Internal batch # (leave blank to auto-generate)</label><input type="text" name="internal_batch_no" /></div>
        <div class="field"><label>Import code override (leave blank to auto-generate)</label><input type="text" name="import_code" /></div>
      </div>
      <div class="field"><label>Remarks</label><textarea name="coa_remarks"></textarea></div>
      <div class="field"><label>Decided by</label><input type="text" name="decided_by" value="${esc(getRememberedName())}" required /></div>
      <button type="submit" class="btn primary">Submit decision</button>
    </form>`
  );

  const decisionSelect = document.getElementById("decide-decision");
  const qtyRow = document.getElementById("decide-qty-row");
  const approveFields = document.getElementById("decide-approve-fields");
  const approveFields2 = document.getElementById("decide-approve-fields2");
  function syncFields() {
    const v = decisionSelect.value;
    qtyRow.hidden = v !== "partial";
    approveFields.hidden = v === "reject";
    approveFields2.hidden = v === "reject";
  }
  decisionSelect.addEventListener("change", syncFields);
  syncFields();

  document.getElementById("decide-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    rememberName(fd.get("decided_by"));
    const body = { decision: fd.get("decision"), decided_by: fd.get("decided_by") };
    if (fd.get("decision") === "partial") {
      body.qty_accepted = Number(fd.get("qty_accepted"));
      body.qty_rejected = Number(fd.get("qty_rejected"));
    }
    if (fd.get("decision") !== "reject") {
      if (fd.get("expiry_date")) body.expiry_date = fd.get("expiry_date");
      if (fd.get("production_date")) body.production_date = fd.get("production_date");
      if (fd.get("internal_batch_no")) body.internal_batch_no = fd.get("internal_batch_no");
    }
    if (fd.get("import_code")) body.import_code = fd.get("import_code");
    if (fd.get("coa_remarks")) body.coa_remarks = fd.get("coa_remarks");

    try {
      await api.post(`/api/batches/${batchId}/decision`, body);
      toast("Decision recorded");
      closeModal();
      onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function openFinalizeModal(batchId, onDone) {
  openModal(
    "Finalize actual weight",
    `<form class="form-grid" id="finalize-form">
      <div class="field"><label>Actual weighed quantity</label><input type="number" step="any" name="qty_actual_weighed" required /></div>
      <button type="submit" class="btn primary">Save</button>
    </form>`
  );
  document.getElementById("finalize-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.post(`/api/batches/${batchId}/finalize-weight`, { qty_actual_weighed: Number(fd.get("qty_actual_weighed")) });
      toast("Actual weight recorded");
      closeModal();
      onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function openAssociateModal(lineId, onDone) {
  const materials = await getMaterials();
  const types = await getTypes();
  const subtypes = await getSubtypes();
  openModal(
    "Associate a Code",
    `<div class="form-grid">
      <div class="field">
        <label>Mode</label>
        <select id="assoc-mode">
          <option value="existing">Link to an existing material</option>
          <option value="new">Create a new material code</option>
        </select>
      </div>
      <div id="assoc-existing" class="form-grid">
        <div class="field">
          <label>Existing material</label>
          <select name="material_code">
            ${materials.map((m) => `<option value="${esc(m.code)}">${esc(m.code)} — ${esc(m.name)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div id="assoc-new" class="form-grid" hidden>
        <div class="field-row">
          <div class="field"><label>New code</label><input type="text" name="new_code" /></div>
          <div class="field"><label>Name</label><input type="text" name="new_name" /></div>
          <div class="field" style="max-width:100px"><label>Unit</label><input type="text" name="new_unit" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Type</label><select name="new_type"><option value="">—</option>${types.map((t) => `<option value="${esc(t.code)}">${esc(t.name)}</option>`).join("")}</select></div>
          <div class="field"><label>Subtype</label><select name="new_subtype"><option value="">—</option>${subtypes.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join("")}</select></div>
        </div>
        <div class="field"><label>Spec title</label><input type="text" name="spec_title" placeholder="e.g. Initial Rev A" /></div>
        <p class="small muted">Spec parameters can be added afterward from the Specifications tab — this creates the material with an empty or subtype-templated starting spec.</p>
      </div>
      <div class="field"><label>Your name (Quality)</label><input type="text" id="assoc-by" value="${esc(getRememberedName())}" /></div>
      <button type="button" class="btn primary" id="assoc-submit">Associate</button>
    </div>`
  );

  const modeSelect = document.getElementById("assoc-mode");
  modeSelect.addEventListener("change", () => {
    document.getElementById("assoc-existing").hidden = modeSelect.value !== "existing";
    document.getElementById("assoc-new").hidden = modeSelect.value !== "new";
  });

  document.getElementById("assoc-submit").addEventListener("click", async () => {
    const by = document.getElementById("assoc-by").value || "quality";
    rememberName(by);
    let body;
    if (modeSelect.value === "existing") {
      const code = document.querySelector('#assoc-existing [name="material_code"]').value;
      body = { mode: "existing", material_code: code };
    } else {
      const get = (n) => document.querySelector(`#assoc-new [name="${n}"]`).value;
      body = {
        mode: "new",
        new_material: {
          code: get("new_code"),
          name: get("new_name"),
          unit: get("new_unit"),
          type_code: get("new_type") || null,
          subtype_code: get("new_subtype") || null,
        },
        spec: { title: get("spec_title") || "Initial spec", created_by: by },
      };
    }
    try {
      await api.post(`/api/receipt-lines/${lineId}/associate-code`, body);
      toast("Code associated");
      await getMaterials(true);
      closeModal();
      onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------------------------------------------------------------- view: receipt buckets (To Do / History)

// Remembers each role+bucket's last-used Imports/Samples toggle and search
// text, so switching tabs and coming back doesn't lose your place.
const listState = {};
function getListState(role, bucket) {
  const key = `${role}:${bucket}`;
  if (!listState[key]) listState[key] = { type: "import", query: "" };
  return listState[key];
}

const BUCKET_COPY = {
  todo: {
    warehouse: "Awaiting a Quality decision, or still needing an actual weight.",
    quality: "Review and decide against spec.",
  },
  history: {
    warehouse: "Decided by Quality, and nothing left for you to do.",
    quality: "Receipts Quality has finished deciding.",
  },
};

async function viewReceiptBucket({ role, bucket }) {
  const state = getListState(role, bucket);
  const view = document.getElementById("view");
  const title = bucket === "history" ? "History" : "To Do";

  view.innerHTML = `
    <div class="view-head"><div><h1>${title}</h1><p>${BUCKET_COPY[bucket][role]}</p></div></div>
    <div class="list-controls">
      <div class="subtabs">
        <button class="subtab-btn${state.type === "import" ? " active" : ""}" data-t="import">Imports</button>
        <button class="subtab-btn${state.type === "sample" ? " active" : ""}" data-t="sample">Samples</button>
      </div>
      <input type="search" class="search-input" id="receipt-search"
        placeholder="Search receipt #, material code, batch #, status…" value="${esc(state.query)}" />
    </div>
    <div id="receipt-list"></div>
  `;

  view.querySelectorAll("[data-t]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.type = btn.dataset.t;
      viewReceiptBucket({ role, bucket });
    })
  );

  let debounceTimer;
  document.getElementById("receipt-search").addEventListener("input", (e) => {
    state.query = e.target.value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      renderReceiptsInto(document.getElementById("receipt-list"), { role, type: state.type, bucket, query: state.query });
    }, 150);
  });

  await renderReceiptsInto(document.getElementById("receipt-list"), { role, type: state.type, bucket, query: state.query });
}

// ---------------------------------------------------------------- view: Codes

const CODES_SUBTABS = [
  { id: "types", label: "Types & Subtypes" },
  { id: "materials", label: "Materials" },
  { id: "schemes", label: "Numbering Schemes" },
];
let codesSubtab = "types";

async function viewCodes() {
  const view = document.getElementById("view");
  view.innerHTML = `
    <div class="view-head"><div><h1>Codes</h1><p>Material master data, classification, and numbering schemes.</p></div></div>
    <div class="subtabs">
      ${CODES_SUBTABS.map(
        (t) => `<button class="subtab-btn${codesSubtab === t.id ? " active" : ""}" data-sub="${t.id}">${t.label}</button>`
      ).join("")}
    </div>
    <div id="codes-section"></div>
  `;
  view.querySelectorAll("[data-sub]").forEach((btn) =>
    btn.addEventListener("click", () => {
      codesSubtab = btn.dataset.sub;
      viewCodes();
    })
  );

  const [types, subtypes, materials] = await Promise.all([getTypes(true), getSubtypes(true), getMaterials(true)]);
  const section = document.getElementById("codes-section");
  if (codesSubtab === "types") renderTypesSubtypesSection(section, { types, subtypes });
  else if (codesSubtab === "materials") renderMaterialsSection(section, { types, subtypes, materials });
  else renderSchemesSection(section);
}

function renderTypesSubtypesSection(section, { types, subtypes }) {
  section.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:12px">Material types &amp; subtypes</h3>
      <div class="field-row">
        <div class="table-scroll" style="flex:1"><table class="data-table"><thead><tr><th>Type</th><th>Name</th></tr></thead>
          <tbody>${types.map((t) => `<tr><td class="mono">${esc(t.code)}</td><td>${esc(t.name)}</td></tr>`).join("") || `<tr><td colspan="2" class="muted">None yet</td></tr>`}</tbody></table></div>
        <div class="table-scroll" style="flex:1"><table class="data-table"><thead><tr><th>Subtype</th><th>Type</th><th>Name</th></tr></thead>
          <tbody>${subtypes.map((s) => `<tr><td class="mono">${esc(s.code)}</td><td class="mono">${esc(s.type_code)}</td><td>${esc(s.name)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">None yet</td></tr>`}</tbody></table></div>
      </div>
      <div class="field-row" style="margin-top:14px">
        <form class="form-grid" id="new-type-form" style="flex:1">
          <b class="small">New type</b>
          <div class="field-row"><input name="code" placeholder="Code (e.g. RM)" required /><input name="name" placeholder="Name" required /><button class="btn ghost sm">Add</button></div>
        </form>
        <form class="form-grid" id="new-subtype-form" style="flex:1">
          <b class="small">New subtype</b>
          <div class="field-row">
            <input name="code" placeholder="Code (e.g. SOLVENT)" required />
            <select name="type_code" required><option value="">Type…</option>${types.map((t) => `<option value="${esc(t.code)}">${esc(t.code)}</option>`).join("")}</select>
            <input name="name" placeholder="Name" required />
            <button class="btn ghost sm">Add</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById("new-type-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.put("/api/material-types", { code: fd.get("code"), name: fd.get("name") });
      toast("Type added");
      viewCodes();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById("new-subtype-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.put("/api/material-subtypes", { code: fd.get("code"), type_code: fd.get("type_code"), name: fd.get("name") });
      toast("Subtype added");
      viewCodes();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function renderMaterialsSection(section, { types, subtypes, materials }) {
  section.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:12px">Materials</h3>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>Code</th><th>Name</th><th>Unit</th><th>Type/Subtype</th><th>Expiry?</th></tr></thead>
        <tbody>${
          materials
            .map(
              (m) => `<tr><td class="mono">${esc(m.code)}</td><td>${esc(m.name)}</td><td>${esc(m.unit)}</td><td>${esc(m.type_code || "—")}${m.subtype_code ? " / " + esc(m.subtype_code) : ""}</td><td>${m.requires_expiry ? "Yes" : "No"}</td></tr>`
            )
            .join("") || `<tr><td colspan="5" class="muted">None yet</td></tr>`
        }</tbody></table></div>
      <form class="form-grid" id="new-material-form" style="margin-top:14px">
        <b class="small">New / edit material</b>
        <div class="field-row">
          <input name="code" placeholder="Code" required />
          <input name="name" placeholder="Name" required />
          <input name="unit" placeholder="Unit (KG)" required style="max-width:100px" />
          <select name="type_code"><option value="">Type…</option>${types.map((t) => `<option value="${esc(t.code)}">${esc(t.code)}</option>`).join("")}</select>
          <select name="subtype_code"><option value="">Subtype…</option>${subtypes.map((s) => `<option value="${esc(s.code)}">${esc(s.code)}</option>`).join("")}</select>
          <label class="small" style="display:flex;align-items:center;gap:4px;"><input type="checkbox" name="requires_expiry" checked /> requires expiry</label>
          <button class="btn primary sm">Save</button>
        </div>
      </form>
    </div>
  `;

  document.getElementById("new-material-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.put("/api/materials", {
        code: fd.get("code"),
        name: fd.get("name"),
        unit: fd.get("unit"),
        type_code: fd.get("type_code") || null,
        subtype_code: fd.get("subtype_code") || null,
        requires_expiry: fd.get("requires_expiry") === "on",
      });
      toast("Material saved");
      viewCodes();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function renderSchemesSection(section) {
  section.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:12px">Numbering schemes</h3>
      <form class="form-grid" id="batch-scheme-form">
        <b class="small">Internal batch # pattern (optionally per supplier)</b>
        <div class="field-row">
          <input name="supplier_code" placeholder="Supplier code (blank = global default)" />
          <input name="pattern_template" placeholder="{supplier_code}{MMYY}{seq:04d}" required style="flex:2" />
          <button class="btn ghost sm">Save</button>
        </div>
      </form>
      <form class="form-grid" id="rmf-scheme-form" style="margin-top:10px">
        <b class="small">Import code — RMF pattern (novel combinations)</b>
        <div class="field-row"><input name="pattern_template" placeholder="RMF{seq:04d}" required style="flex:1" /><button class="btn ghost sm">Save</button></div>
      </form>
      <form class="form-grid" id="rms-scheme-form" style="margin-top:10px">
        <b class="small">Import code — RMS pattern (regular repeats)</b>
        <div class="field-row"><input name="pattern_template" placeholder="RMS{seq:04d}" required style="flex:1" /><button class="btn ghost sm">Save</button></div>
      </form>
    </div>
  `;

  document.getElementById("batch-scheme-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.put("/api/batch-number-schemes", {
        supplier_code: fd.get("supplier_code") || undefined,
        pattern_template: fd.get("pattern_template"),
      });
      toast("Batch-number scheme saved");
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById("rmf-scheme-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api.put("/api/import-code-schemes/RMF", { pattern_template: new FormData(e.target).get("pattern_template") });
      toast("RMF pattern saved");
    } catch (err) {
      toast(err.message, true);
    }
  });
  document.getElementById("rms-scheme-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api.put("/api/import-code-schemes/RMS", { pattern_template: new FormData(e.target).get("pattern_template") });
      toast("RMS pattern saved");
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------------------------------------------------------------- view: Specifications

const PARAM_TYPES = ["numeric_range", "pass_fail", "time_range", "text_value"];

function paramRowHtml(p = {}) {
  return `
    <div class="repeatable-item param-item">
      <div class="field-row">
        <div class="field" style="flex:2"><label>Parameter</label><input data-f="parameter_name" value="${esc(p.parameter_name || "")}" required /></div>
        <div class="field"><label>Type</label>
          <select data-f="param_type">${PARAM_TYPES.map((t) => `<option value="${t}" ${p.param_type === t ? "selected" : ""}>${t}</option>`).join("")}</select>
        </div>
        <div><label>&nbsp;</label><button type="button" class="btn ghost sm" data-remove-param>✕</button></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Method</label><input data-f="method" value="${esc(p.method || "")}" /></div>
        <div class="field"><label>Min</label><input type="number" step="any" data-f="min_value" value="${p.min_value ?? ""}" /></div>
        <div class="field"><label>Max</label><input type="number" step="any" data-f="max_value" value="${p.max_value ?? ""}" /></div>
        <div class="field"><label>Unit</label><input data-f="unit" value="${esc(p.unit || "")}" /></div>
      </div>
    </div>`;
}

function wireParamList(container, initial = []) {
  function addRow(p) {
    const wrap = document.createElement("div");
    wrap.innerHTML = paramRowHtml(p);
    const item = wrap.firstElementChild;
    item.querySelector("[data-remove-param]").addEventListener("click", () => item.remove());
    container.appendChild(item);
  }
  (initial.length ? initial : []).forEach(addRow);
  return addRow;
}

function collectParams(container) {
  return [...container.querySelectorAll(".param-item")].map((item) => {
    const get = (f) => item.querySelector(`[data-f="${f}"]`).value;
    const type = get("param_type");
    const needsBounds = type === "numeric_range" || type === "time_range";
    return {
      parameter_name: get("parameter_name"),
      param_type: type,
      method: get("method") || null,
      unit: get("unit") || null,
      min_value: needsBounds && get("min_value") !== "" ? Number(get("min_value")) : null,
      max_value: needsBounds && get("max_value") !== "" ? Number(get("max_value")) : null,
    };
  });
}

async function viewSpecs() {
  const view = document.getElementById("view");
  const [materials, subtypes] = await Promise.all([getMaterials(true), getSubtypes(true)]);

  view.innerHTML = `
    <div class="view-head"><div><h1>Specifications</h1><p>Structured, versioned test parameters — never a blank page.</p></div></div>

    <div class="card">
      <h3 style="margin-bottom:12px">Spec for a material</h3>
      <div class="field"><label>Material</label>
        <select id="spec-material">${materials.map((m) => `<option value="${esc(m.code)}">${esc(m.code)} — ${esc(m.name)}</option>`).join("")}</select>
      </div>
      <div id="spec-history" style="margin-top:14px"></div>
      <form class="form-grid" id="new-spec-form" style="margin-top:16px; border-top:1px solid var(--rule); padding-top:14px;">
        <b class="small">New spec version</b>
        <div class="field-row">
          <div class="field"><label>Title</label><input name="title" required /></div>
          <div class="field"><label>Created by</label><input name="created_by" value="${esc(getRememberedName())}" required /></div>
        </div>
        <div class="field"><label>Notes</label><textarea name="notes"></textarea></div>
        <div id="spec-params" class="repeatable"></div>
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn ghost sm" id="spec-add-param">+ Add parameter</button>
          <button type="button" class="btn ghost sm" id="spec-prefill">Prefill from subtype template</button>
        </div>
        <button type="submit" class="btn primary">Create spec version</button>
      </form>
    </div>

    <div class="card">
      <h3 style="margin-bottom:12px">Subtype default spec templates</h3>
      <div class="field"><label>Subtype</label>
        <select id="template-subtype">${subtypes.map((s) => `<option value="${esc(s.code)}">${esc(s.code)} — ${esc(s.name)}</option>`).join("")}</select>
      </div>
      <div id="template-params" class="repeatable" style="margin-top:10px"></div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button type="button" class="btn ghost sm" id="template-add-param">+ Add parameter</button>
        <button type="button" class="btn primary sm" id="template-save">Save template</button>
      </div>
    </div>
  `;

  const specMaterialSelect = document.getElementById("spec-material");
  const historyEl = document.getElementById("spec-history");
  const paramsContainer = document.getElementById("spec-params");
  let addParamRow = wireParamList(paramsContainer);

  async function loadHistory() {
    const code = specMaterialSelect.value;
    const specs = await api.get(`/api/materials/${encodeURIComponent(code)}/specs`);
    historyEl.innerHTML = specs.length
      ? specs
          .map(
            (s) => `
        <div class="card" style="box-shadow:none; padding:12px 14px; margin-bottom:8px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <b class="small">v${s.version} — ${esc(s.title)}</b>
            <span class="status-pill ${s.status === "active" ? "approved" : "neutral"}">${esc(s.status)}</span>
          </div>
          <div class="small muted" style="margin-top:4px;">
            ${s.parameters.map((p) => `${esc(p.parameter_name)}${p.min_value != null ? ` (${p.min_value}–${p.max_value}${p.unit ? " " + esc(p.unit) : ""})` : ""}`).join(" · ") || "No parameters"}
          </div>
        </div>`
          )
          .join("")
      : `<div class="empty-state">No specs yet for this material.</div>`;
  }
  specMaterialSelect.addEventListener("change", loadHistory);
  await loadHistory();

  document.getElementById("spec-add-param").addEventListener("click", () => addParamRow({}));

  document.getElementById("spec-prefill").addEventListener("click", async () => {
    const material = materials.find((m) => m.code === specMaterialSelect.value);
    if (!material?.subtype_code) return toast("This material has no subtype set", true);
    const template = await api.get(`/api/material-subtypes/${encodeURIComponent(material.subtype_code)}/spec-template`);
    paramsContainer.innerHTML = "";
    template.parameters.forEach((p) => addParamRow(p));
    toast(`Prefilled from ${material.subtype_code} template`);
  });

  document.getElementById("new-spec-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    rememberName(fd.get("created_by"));
    const params = collectParams(paramsContainer);
    try {
      await api.post(`/api/materials/${encodeURIComponent(specMaterialSelect.value)}/specs`, {
        title: fd.get("title"),
        notes: fd.get("notes") || null,
        created_by: fd.get("created_by"),
        parameters: params.length ? params : undefined,
      });
      toast("Spec version created");
      e.target.reset();
      paramsContainer.innerHTML = "";
      await loadHistory();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // subtype templates
  const templateSubtypeSelect = document.getElementById("template-subtype");
  const templateParams = document.getElementById("template-params");
  let addTemplateRow = wireParamList(templateParams);

  async function loadTemplate() {
    templateParams.innerHTML = "";
    const t = await api.get(`/api/material-subtypes/${encodeURIComponent(templateSubtypeSelect.value)}/spec-template`);
    t.parameters.forEach((p) => addTemplateRow(p));
  }
  templateSubtypeSelect.addEventListener("change", loadTemplate);
  await loadTemplate();

  document.getElementById("template-add-param").addEventListener("click", () => addTemplateRow({}));
  document.getElementById("template-save").addEventListener("click", async () => {
    try {
      await api.put(`/api/material-subtypes/${encodeURIComponent(templateSubtypeSelect.value)}/spec-template`, {
        parameters: collectParams(templateParams),
      });
      toast("Template saved");
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------------------------------------------------------------- router

let lastRouteArgs = null;

async function renderView() {
  const role = getRole();
  const tab = currentRoute();
  try {
    if (role === "warehouse" && tab === "receive") {
      lastRouteArgs = { fn: viewReceive, args: undefined };
      await viewReceive();
    } else if (tab === "todo") {
      lastRouteArgs = { fn: viewReceiptBucket, args: { role, bucket: "todo" } };
      await viewReceiptBucket({ role, bucket: "todo" });
    } else if (tab === "history") {
      lastRouteArgs = { fn: viewReceiptBucket, args: { role, bucket: "history" } };
      await viewReceiptBucket({ role, bucket: "history" });
    } else if (role === "quality" && tab === "codes") {
      lastRouteArgs = { fn: viewCodes };
      await viewCodes();
    } else if (role === "quality" && tab === "specs") {
      lastRouteArgs = { fn: viewSpecs };
      await viewSpecs();
    }
  } catch (err) {
    document.getElementById("view").innerHTML = `<div class="empty-state">Couldn't load this screen: ${esc(err.message)}</div>`;
  }
}

function refreshCurrentView() {
  if (lastRouteArgs) lastRouteArgs.args ? lastRouteArgs.fn(lastRouteArgs.args) : lastRouteArgs.fn();
  refreshNotifCount();
}

window.addEventListener("hashchange", () => {
  renderTopbar();
  renderView();
});

document.getElementById("notif-btn").addEventListener("click", toggleNotifPanel);

if (!location.hash) location.hash = `#${getRole()}/${ROUTES[getRole()][0].id}`;
renderTopbar();
renderView();
refreshNotifCount();
setInterval(refreshNotifCount, 20000);
