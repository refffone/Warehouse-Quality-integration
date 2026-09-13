import { api, getRememberedName, rememberName, uploadFile } from "./api.js";
import { t, getLang, setLang, applyDocumentDirection } from "./i18n.js";
import { navIcon, icons } from "./icons.js";

// ---------------------------------------------------------------- session
//
// Populated once at boot from the httpOnly session cookie (GET /api/auth/me)
// — never localStorage, since the role is now a real, server-enforced
// fact rather than a client-picked stand-in. If there's no valid session
// the user is sent back to the landing page before any view renders.

let session = { role: null, name: "" };

function getRole() {
  return session.role;
}

async function logout() {
  try {
    await api.post("/api/auth/logout");
  } catch {
    // best-effort — the cookie may already be gone
  }
  location.href = "/";
}

// ---------------------------------------------------------------- helpers

function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** Wraps free-text/user data (names, codes, titles) in a <bdi> element —
 *  isolates its bidi direction from the surrounding text instead of
 *  letting it merge into one paragraph. Without this, a UI string that
 *  concatenates an Arabic label with a Latin supplier/material name (e.g.
 *  "إيصال رقم 1 · Greif Packaging Solutions") gets its word order jumbled
 *  by the Unicode Bidi Algorithm the moment that line wraps — the numeral
 *  or a trailing word can end up visually stranded on the wrong line. Safe
 *  to use everywhere, including English-only text, where <bdi> is a no-op. */
function bdi(str) {
  return `<bdi>${esc(str)}</bdi>`;
}

/** Same isolation as bdi(), but for a caller that already built (and
 *  escaped) its own HTML — e.g. supplierName()'s "name (code)" markup —
 *  rather than a single plain-text value. */
function bdiHtml(html) {
  return `<bdi>${html}</bdi>`;
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
  el.className = "toast" + (isError ? " error" : " success");
  el.innerHTML = `<span class="toast-icon">${isError ? icons.alertCircle : icons.check}</span><span>${esc(message)}</span>`;
  root.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function loadingState(label = t("common.loading")) {
  return `<div class="empty-state is-loading"><div class="empty-icon"><div class="spinner"></div></div><div class="empty-title">${esc(label)}</div></div>`;
}

function emptyState(iconSvg, title, sub) {
  return `<div class="empty-state"><div class="empty-icon">${iconSvg}</div><div class="empty-title">${esc(title)}</div>${sub ? `<div class="empty-sub">${esc(sub)}</div>` : ""}</div>`;
}

function errorState(message) {
  return `<div class="empty-state is-error"><div class="empty-icon">${icons.alertCircle}</div><div class="empty-title">${esc(message)}</div></div>`;
}

function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
}

function openModal(titleHtml, bodyHtml) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" data-close>
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h2>${titleHtml}</h2><button class="icon-btn" data-close>${icons.x}</button></div>
        <div class="modal-body">${bodyHtml}</div>
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
  return s ? `${esc(s.name)} <span class="mono small muted">(${esc(s.code)})</span>` : `#${id}`;
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

let functionsCache = null;
async function getFunctions(force = false) {
  if (!functionsCache || force) functionsCache = await api.get("/api/material-functions");
  return functionsCache;
}

// ---------------------------------------------------------------- routes

const ROUTES = {
  warehouse: [
    { id: "receive", labelKey: "nav.receive" },
    { id: "todo", labelKey: "nav.todo" },
    { id: "history", labelKey: "nav.history" },
    { id: "suppliers", labelKey: "nav.suppliers" },
    { id: "supplierassessment", labelKey: "nav.supplierAssessment" },
  ],
  quality: [
    { id: "todo", labelKey: "nav.todo" },
    { id: "history", labelKey: "nav.history" },
    { id: "codes", labelKey: "nav.codes" },
    { id: "suppliers", labelKey: "nav.suppliers" },
    { id: "specs", labelKey: "nav.specs" },
    { id: "masterdata", labelKey: "nav.masterdata" },
  ],
};

// Per-tab accent hue (same "each destination owns a distinct color" idea
// borrowed from chemerp-costing's module launcher for the landing cards) —
// receive/masterdata reuse the warehouse/quality landing-card hues for
// continuity, the rest are distinct chemerp module colors.
const ROUTE_COLOR = {
  receive: "192, 132, 252", // purple — matches the Warehouse landing card
  todo: "251, 191, 36", // amber
  history: "56, 189, 248", // sky
  codes: "45, 212, 191", // teal
  suppliers: "129, 140, 248", // indigo
  supplierassessment: "251, 146, 60", // orange — distinct from Quality's own emerald assessment
  specs: "251, 113, 133", // rose
  masterdata: "52, 211, 153", // emerald — matches the Quality landing card
};

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [role, tab] = hash.split("/");
  if (role === getRole() && ROUTES[role]?.some((r) => r.id === tab)) return tab;
  // Invalid or role-mismatched hash (e.g. a stale/bookmarked link, or a role
  // switch): fall back to this role's first tab, and correct the address bar
  // to match what's actually rendered — otherwise the URL keeps claiming a
  // screen (like #quality/masterdata) that was never reached.
  const fallback = ROUTES[getRole()][0].id;
  const correctedHash = `#${getRole()}/${fallback}`;
  if (location.hash !== correctedHash) history.replaceState(null, "", correctedHash);
  return fallback;
}

function goTo(tab) {
  location.hash = `#${getRole()}/${tab}`;
}

// ---------------------------------------------------------------- topbar

function applyStaticTranslations() {
  document.getElementById("signed-in-as-label").textContent = t("topbar.signedInAs");
  document.getElementById("signed-in-as-role").textContent =
    `(${session.role === "quality" ? t("topbar.roleQuality") : t("topbar.roleWarehouse")})`;
  document.getElementById("notif-btn").title = t("topbar.notifications");
  document.getElementById("push-btn").title = t("topbar.enablePush");
  document.getElementById("logout-label").textContent = t("topbar.logout");
  document.getElementById("lang-toggle").textContent = t("lang.toggle");
  document.querySelector(".brand-name").innerHTML =
    `${esc(t("topbar.roleWarehouse"))} <em>·</em> ${esc(t("topbar.roleQuality"))}`;
}

function renderTopbar() {
  applyStaticTranslations();
  const role = getRole();
  const tabsEl = document.getElementById("tabs");
  const active = currentRoute();
  tabsEl.innerHTML = ROUTES[role]
    .map(
      (r) =>
        `<button class="tab-btn${r.id === active ? " active" : ""}" data-tab="${r.id}" style="--tab-color:${ROUTE_COLOR[r.id]}">${navIcon(r.id)}<span class="tab-label">${t(r.labelKey)}</span>${
          r.id === "todo" ? `<span class="tab-badge" id="todo-tab-badge" hidden>0</span>` : ""
        }</button>`
    )
    .join("");
  tabsEl.querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => goTo(btn.dataset.tab))
  );

  document.getElementById("signed-in-as-name").textContent = session.name;
  document.getElementById("logout-btn").onclick = logout;

  document.getElementById("lang-toggle").onclick = () => {
    setLang(getLang() === "ar" ? "en" : "ar");
    location.reload();
  };

  refreshTodoCount();
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

async function refreshTodoCount() {
  try {
    const { count } = await api.get("/api/receipts/todo-count");
    const badge = document.getElementById("todo-tab-badge");
    if (!badge) return; // not rendered on a role/tab without a todo-count badge
    if (count > 0) {
      badge.hidden = false;
      badge.textContent = count > 99 ? "99+" : count;
    } else {
      badge.hidden = true;
    }
  } catch {
    // silent — same best-effort convention as the notification badge
  }
}

async function toggleNotifPanel() {
  const btn = document.getElementById("notif-btn");
  const existing = document.querySelector(".notif-panel");
  if (existing) {
    existing.remove();
    btn.classList.remove("open");
    return;
  }
  const list = await api.get("/api/notifications");
  const panel = document.createElement("div");
  panel.className = "notif-panel";
  panel.innerHTML = `
    <div class="notif-panel-head">${esc(t("topbar.notifications"))}</div>
    <div class="notif-panel-list">${
      list.length
        ? list
            .map(
              (n) => `
      <div class="notif-item${n.read_at ? "" : " unread"}" data-id="${n.id}">
        ${esc(n.message)}
        <span class="when">${fmtDateTime(n.created_at)} · ${esc(t(`notif.kind.${n.kind}`))}</span>
      </div>`
            )
            .join("")
        : emptyState(icons.bell, t("notif.empty"))
    }</div>`;
  document.body.appendChild(panel);
  btn.classList.add("open");
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
          btn.classList.remove("open");
          document.removeEventListener("click", onDoc);
        }
      },
      { once: false }
    );
  }, 0);
}

// ---------------------------------------------------------------- push notifications
//
// Web Push, so a device gets notified even when the app isn't in an open
// tab. iOS only delivers push to a home-screen-installed PWA (never a
// plain Safari tab), which is why index.html also ships a manifest — but
// desktop/Android work in a regular browser tab.

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

const PUSH_SUBSCRIBED_KEY = "wq_push_subscribed";

async function initPush() {
  const btn = document.getElementById("push-btn");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

  const registration = await navigator.serviceWorker.register("/sw.js").catch(() => null);
  if (!registration) return;

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "push-received") return;
    const tab = currentRoute();
    if (tab === "todo" || tab === "history") refreshCurrentView();
  });

  const existing = await registration.pushManager.getSubscription().catch(() => null);
  if (existing) {
    localStorage.setItem(PUSH_SUBSCRIBED_KEY, "1");
    btn.hidden = true;
    return;
  }
  if (Notification.permission === "denied") {
    btn.hidden = true;
    return;
  }

  btn.hidden = false;
  btn.onclick = () => subscribeToPush(registration);
}

async function subscribeToPush(registration) {
  try {
    const { key } = await api.get("/api/push/vapid-public-key");
    if (!key) {
      toast(t("push.failed"), true);
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast(t("push.denied"), true);
      return;
    }
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
    await api.post("/api/push/subscribe", subscription.toJSON());
    localStorage.setItem(PUSH_SUBSCRIBED_KEY, "1");
    document.getElementById("push-btn").hidden = true;
    toast(t("push.enabled"));
  } catch {
    toast(t("push.failed"), true);
  }
}

// ---------------------------------------------------------------- view: Receive (2-step)

function freshReceiveWizard() {
  return {
    step: 1,
    type: "import",
    received_at: nowLocalInput(),
    created_by: getRememberedName(),
    supplier_code: null,
    sample_sent_by: "",
  };
}
let receiveWizard = freshReceiveWizard();

function wizardStepsHtml(current) {
  return `
    <div class="wizard-steps">
      <span class="wizard-step${current === 1 ? " active" : ""}"><span class="wizard-step-num">1</span> ${esc(t("receive.step1"))}</span>
      <span class="wizard-step-rule"></span>
      <span class="wizard-step${current === 2 ? " active" : ""}"><span class="wizard-step-num">2</span> ${esc(t("receive.step2"))}</span>
    </div>`;
}

async function viewReceive() {
  const suppliers = await getSuppliers();
  if (!receiveWizard.supplier_code && suppliers.length) receiveWizard.supplier_code = suppliers[0].code;
  if (receiveWizard.step === 2) await renderReceiveStep2();
  else renderReceiveStep1(suppliers);
}

function renderReceiveStep1(suppliers) {
  const view = document.getElementById("view");
  const w = receiveWizard;
  view.innerHTML = `
    <div class="view-head"><div><h1>${esc(t("receive.title"))}</h1><p>${esc(t("receive.subtitle"))}</p></div></div>
    ${wizardStepsHtml(1)}
    <form class="card form-grid" id="receive-step1-form">
      <div class="field-row">
        <div class="field">
          <label>${esc(t("receive.type"))}</label>
          <select name="type" id="rf-type">
            <option value="import" ${w.type === "import" ? "selected" : ""}>${esc(t("receive.typeImport"))}</option>
            <option value="sample" ${w.type === "sample" ? "selected" : ""}>${esc(t("receive.typeSample"))}</option>
          </select>
        </div>
        <div class="field">
          <label>${esc(t("receive.receivedAt"))}</label>
          <input type="datetime-local" name="received_at" value="${esc(w.received_at)}" required />
        </div>
        <div class="field">
          <label>${esc(t("receive.yourName"))}</label>
          <input type="text" name="created_by" value="${esc(w.created_by)}" required />
        </div>
      </div>
      <div class="field-row">
        <div class="field" style="flex:2">
          <label>${esc(t("receive.supplier"))}</label>
          <div style="display:flex; gap:8px; align-items:flex-start;">
            <div style="flex:1">${codeSearchHtml("rf-supplier", t("common.searchByCodeOrName"), "supplier_code")}</div>
            <button type="button" class="btn ghost sm" id="rf-new-supplier">${esc(t("receive.new"))}</button>
          </div>
        </div>
        <div class="field" id="rf-sample-sender-field" ${w.type === "sample" ? "" : "hidden"} style="flex:1">
          <label>${esc(t("receive.sampleSentBy"))}</label>
          <input type="text" name="sample_sent_by" placeholder="${esc(t("receive.sampleSentByPlaceholder"))}" value="${esc(w.sample_sent_by)}" />
        </div>
      </div>
      <div style="display:flex; gap:10px; justify-content:flex-end;">
        <button type="submit" class="btn primary">${esc(t("receive.nextStep"))}</button>
      </div>
    </form>
  `;

  document.getElementById("rf-type").addEventListener("change", (e) => {
    document.getElementById("rf-sample-sender-field").hidden = e.target.value !== "sample";
  });

  const supplierInput = wireCodeSearch("rf-supplier", suppliers, () => {});
  if (w.supplier_code) supplierInput.value = w.supplier_code;

  document.getElementById("rf-new-supplier").addEventListener("click", () => {
    openModal(
      esc(t("receive.newSupplier")),
      `<form class="form-grid" id="new-supplier-form">
        <div class="field"><label>${esc(t("common.code"))}</label><input name="code" required /></div>
        <div class="field"><label>${esc(t("common.name"))}</label><input name="name" required /></div>
        <button type="submit" class="btn primary">${esc(t("common.create"))}</button>
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
        toast(t("receive.supplierAdded"));
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  document.getElementById("receive-step1-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    w.type = fd.get("type");
    w.received_at = fd.get("received_at");
    w.created_by = fd.get("created_by");
    w.supplier_code = fd.get("supplier_code");
    w.sample_sent_by = fd.get("sample_sent_by") || "";
    rememberName(w.created_by);
    w.step = 2;
    viewReceive();
  });
}

async function renderReceiveStep2() {
  const view = document.getElementById("view");
  const w = receiveWizard;
  const materials = await getMaterials();
  const materialNamesHtml = [...new Set(materials.map((m) => m.name))]
    .map((name) => `<option value="${esc(name)}"></option>`)
    .join("");

  view.innerHTML = `
    <div class="view-head"><div><h1>${esc(t("receive.title"))}</h1><p>${esc(t("receive.subtitle"))}</p></div></div>
    ${wizardStepsHtml(2)}
    <div class="card small muted" style="display:flex; justify-content:space-between; align-items:center;">
      <span>${w.type === "sample" ? esc(t("receive.typeSample")) : esc(t("receive.typeImport"))} · <bdi class="mono">${esc(w.supplier_code)}</bdi> · ${fmtDateTime(new Date(w.received_at).toISOString())} · ${bdi(w.created_by)}</span>
      <button type="button" class="btn ghost sm" id="rf-back">${esc(t("receive.editDetails"))}</button>
    </div>
    <form class="card form-grid" id="receive-step2-form">
      <div>
        <label class="small muted">${esc(t("receive.linesReceived"))}</label>
        <div class="repeatable" id="rf-lines"></div>
        <button type="button" class="btn ghost sm" id="rf-add-line" style="margin-top:8px">${esc(t("receive.addMaterialLine"))}</button>
      </div>
      <div style="display:flex; gap:10px; justify-content:flex-end;">
        <button type="submit" class="btn primary">${esc(t("receive.registerReceipt"))}</button>
      </div>
    </form>
    <datalist id="rf-material-names">${materialNamesHtml}</datalist>
  `;

  document.getElementById("rf-back").addEventListener("click", () => {
    w.step = 1;
    viewReceive();
  });

  const linesEl = document.getElementById("rf-lines");
  let lineSeq = 0;

  function addLine() {
    const item = document.createElement("div");
    item.className = "repeatable-item line-item";
    const codeInputId = `rf-line-code-${lineSeq++}`;
    item.innerHTML = `
      <div class="repeatable-item-head">
        <b class="small">${esc(t("receive.materialLine"))}</b>
        <button type="button" class="btn ghost sm" data-remove-line>${esc(t("receive.removeLine"))}</button>
      </div>
      <div class="field-row">
        <div class="field"><label>${esc(t("receive.materialCodeIfKnown"))}</label>${codeSearchHtml(codeInputId, t("receive.materialCodeSearchPlaceholder"))}</div>
        <div class="field"><label>${esc(t("receive.materialNameAsOnPaperwork"))}</label><input type="text" data-f="material_name_text" list="rf-material-names" required /></div>
        <div class="field" style="max-width:120px"><label>${esc(t("common.unit"))}</label><input type="text" data-f="unit" placeholder="KG" required /></div>
      </div>
      <div class="batches"></div>
      <button type="button" class="btn ghost sm" data-add-batch>${esc(t("receive.addSupplierBatch"))}</button>
    `;
    item.querySelector("[data-remove-line]").addEventListener("click", () => item.remove());
    linesEl.appendChild(item); // wireCodeSearch looks the input up by id via document.getElementById, so it needs to be in the live DOM first

    // Material code is a search-and-select over existing codes only (the
    // DB has a foreign key from receipt_lines.material_code to
    // materials.code, so a typo'd/nonexistent code here used to 500 at
    // submit time) — selecting one also prefills the name below, if the
    // warehouse user hasn't already typed something of their own.
    const nameInput = item.querySelector('[data-f="material_name_text"]');
    const codeInput = wireCodeSearch(codeInputId, materials, (code) => {
      const material = materials.find((m) => m.code === code);
      if (material && !nameInput.value.trim()) nameInput.value = material.name;
    });
    codeInput.dataset.f = "material_code";

    const batchesEl = item.querySelector(".batches");
    function addBatch() {
      const row = document.createElement("div");
      row.className = "field-row batch-item";
      row.innerHTML = `
        <div class="field"><label>${esc(t("receive.supplierBatchNo"))}</label><input type="text" data-f="supplier_batch_no" required /></div>
        <div class="field" style="max-width:140px"><label>${esc(t("receive.qtyAsReceived"))}</label><input type="number" step="any" data-f="qty_as_received" required /></div>
        <div style="align-self:flex-end"><button type="button" class="btn ghost sm" data-remove-batch>✕</button></div>
      `;
      row.querySelector("[data-remove-batch]").addEventListener("click", () => row.remove());
      batchesEl.appendChild(row);
    }
    item.querySelector("[data-add-batch]").addEventListener("click", addBatch);
    addBatch();
  }

  document.getElementById("rf-add-line").addEventListener("click", addLine);
  addLine();

  document.getElementById("receive-step2-form").addEventListener("submit", async (e) => {
    e.preventDefault();

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

    const knownCodes = new Set(materials.map((m) => m.code));
    const badCode = lines.find((l) => l.material_code && !knownCodes.has(l.material_code));
    if (badCode) return toast(t("receive.unknownMaterialCode", { code: badCode.material_code }), true);

    const body = {
      type: w.type,
      received_at: new Date(w.received_at).toISOString(),
      supplier_code: w.supplier_code,
      created_by: w.created_by,
      lines,
    };
    if (w.type === "sample" && w.sample_sent_by) body.sample_sent_by = w.sample_sent_by;

    try {
      const result = await api.post("/api/receipts", body);
      toast(t("receive.receiptRegistered", { id: result.id }));
      receiveWizard = freshReceiveWizard();
      goTo("todo");
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------------------------------------------------------------- shared receipt list/detail

function statusPill(status) {
  return `<span class="status-pill ${esc(status)}">${esc(t(`status.${status}`))}</span>`;
}

function batchStatusInline(b) {
  if (b.status === undefined) return `<span class="muted small">${esc(t("line.withQuality"))}</span>`; // redacted (sample, warehouse view)
  if (b.status === "pending") return `<span class="muted small">${esc(t("line.awaitingDecision"))}</span>`;
  if (b.status === "rejected") return statusPill("rejected");
  return `${statusPill(b.status)}${b.internal_batch_no ? ` <bdi class="mono small">${esc(b.internal_batch_no)}</bdi>` : ""}`;
}

function resultsSummaryBadge(results) {
  if (!results || results.length === 0) return "";
  const failed = results.filter((r) => r.result === "fail").length;
  return failed > 0
    ? `<span class="badge flag">${esc(t("results.failedOf", { failed, total: results.length }))}</span>`
    : `<span class="badge repeat">${esc(t("results.passedOf", { total: results.length }))}</span>`;
}

function openResultsModal(results) {
  const rows = (results || [])
    .map(
      (r) => `
      <tr>
        <td>${esc(r.parameter_name)}</td>
        <td class="small muted">${esc(r.method || "—")}</td>
        <td class="mono small">${esc(r.measured_value || "—")}</td>
        <td><span class="status-pill ${r.result === "fail" ? "rejected" : "approved"}">${esc(t(`status.${r.result}`))}</span></td>
      </tr>`
    )
    .join("");
  openModal(
    esc(t("results.title")),
    `<div class="table-scroll"><table class="data-table">
      <thead><tr><th>${esc(t("results.parameter"))}</th><th>${esc(t("results.method"))}</th><th>${esc(t("results.measured"))}</th><th>${esc(t("results.result"))}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="muted">${esc(t("results.none"))}</td></tr>`}</tbody>
    </table></div>`
  );
}

// ---------------------------------------------------------------- reports (PDF/Excel export)

/** Generic branded-report download — same fetch/blob/object-URL pattern as
 *  downloadCoa, parameterized by report path + query params instead of a
 *  batch id, since every export screen shares this exact mechanic. */
async function downloadReport(reportPath, params, fallbackName) {
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`/api/reports/${reportPath}?${qs}`, { credentials: "same-origin" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || t("download.failed", { status: res.status }));
    }
    const blob = await res.blob();
    const match = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "");
    const filename = match ? match[1] : fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast(err.message, true);
  }
}

/** Local-calendar-day boundaries as ISO strings, computed in the browser
 *  so "today"/"this week"/"this month" always match the viewer's own
 *  clock — the backend just filters a from/to range, no timezone logic
 *  on the server side at all. Weeks start Monday. */
function periodRange(period, customDateStr) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  let from, to;
  if (period === "week") {
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
    from = startOfDay(monday);
    to = endOfDay(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6));
  } else if (period === "month") {
    from = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
    to = endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  } else if (period === "custom" && customDateStr) {
    const [y, m, d] = customDateStr.split("-").map(Number);
    from = startOfDay(new Date(y, m - 1, d));
    to = endOfDay(new Date(y, m - 1, d));
  } else {
    from = startOfDay(now);
    to = endOfDay(now);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Export toolbar markup — an optional period picker (Today/Week/Month/
 *  custom date) plus PDF/Excel buttons, reused identically across every
 *  report (Received Log, To Do, History, Code Spec, Master Data,
 *  Suppliers, Codes) instead of building this seven times. */
function exportBarHtml(id, { withPeriod }) {
  const periodHtml = withPeriod
    ? `
      <div class="subtabs" id="${id}-period">
        <button class="subtab-btn active" data-period="today">${esc(t("reports.periodToday"))}</button>
        <button class="subtab-btn" data-period="week">${esc(t("reports.periodWeek"))}</button>
        <button class="subtab-btn" data-period="month">${esc(t("reports.periodMonth"))}</button>
        <button class="subtab-btn" data-period="custom">${esc(t("reports.periodCustom"))}</button>
      </div>
      <input type="date" id="${id}-custom-date" class="small" hidden />`
    : "";
  return `
    <div class="export-bar hstack" id="${id}">
      <span class="small muted">${esc(t("reports.export"))}</span>
      ${periodHtml}
      <button type="button" class="btn ghost sm" data-export="pdf">${esc(t("reports.pdf"))}</button>
      <button type="button" class="btn ghost sm" data-export="xlsx">${esc(t("reports.excel"))}</button>
    </div>`;
}

/** Wires an exportBarHtml() instance. `getParams()` is called fresh at
 *  click time (not snapshotted at render time) so filters that can change
 *  after the bar renders — like the Codes List's live filters — are
 *  always read as-of the click, not as-of the page load. */
function wireExportBar(id, reportPathOrFn, { withPeriod, getParams, filenamePrefix }) {
  const bar = document.getElementById(id);
  if (!bar) return;
  let period = "today";
  let customDate = "";

  if (withPeriod) {
    const periodButtons = document.getElementById(`${id}-period`);
    const customInput = document.getElementById(`${id}-custom-date`);
    periodButtons.querySelectorAll("[data-period]").forEach((btn) =>
      btn.addEventListener("click", () => {
        period = btn.dataset.period;
        periodButtons.querySelectorAll("[data-period]").forEach((b) => b.classList.toggle("active", b === btn));
        customInput.hidden = period !== "custom";
        if (period === "custom") customInput.focus();
      })
    );
    customInput.addEventListener("change", () => {
      customDate = customInput.value;
    });
  }

  bar.querySelectorAll("[data-export]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (withPeriod && period === "custom" && !customDate) {
        toast(t("reports.selectDateFirst"), true);
        return;
      }
      const format = btn.dataset.export;
      const reportPath = typeof reportPathOrFn === "function" ? reportPathOrFn() : reportPathOrFn;
      if (!reportPath) return; // e.g. no material selected yet
      const params = { ...(getParams ? getParams() : {}), format };
      if (withPeriod) Object.assign(params, periodRange(period, customDate));
      downloadReport(reportPath, params, `${filenamePrefix}.${format}`);
    })
  );
}

/** Downloads a batch's COA via fetch (so the session cookie goes along),
 *  then triggers a normal browser save via a throwaway object-URL link. */
async function downloadCoa(batchId, format) {
  try {
    const res = await fetch(`/api/batches/${batchId}/coa?format=${format}`, {
      credentials: "same-origin",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || t("download.failed", { status: res.status }));
    }
    const blob = await res.blob();
    const match = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "");
    const filename = match ? match[1] : `coa.${format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------- Excel import (Suppliers & Materials)
//
// Shared preview-then-commit flow: pick a file, "Preview" posts it with
// commit=false (nothing written yet) and renders one row per sheet row
// with its would-be action (insert/update/error). "Confirm import" only
// appears once a preview comes back with zero errors, and re-posts the
// same file with commit=true.

function importSectionHtml(prefix, templateHref) {
  return `
    <div class="hstack" style="margin-top:14px; flex-wrap:wrap; border-top:1px solid var(--rule); padding-top:14px;">
      <a class="btn ghost sm" href="${esc(templateHref)}">${esc(t("import.downloadTemplate"))}</a>
      <label class="btn ghost sm" style="cursor:pointer;">
        ${esc(t("import.chooseFile"))}
        <input type="file" id="${prefix}-file" accept=".xlsx" hidden />
      </label>
      <span class="small muted" id="${prefix}-filename"></span>
      <button type="button" class="btn primary sm" id="${prefix}-preview" disabled>${esc(t("import.preview"))}</button>
    </div>
    <div id="${prefix}-results"></div>
  `;
}

/** `onImported` is called once a commit succeeds, so the caller can
 *  reload its list. */
function wireImportSection(prefix, importPath, onImported) {
  const fileInput = document.getElementById(`${prefix}-file`);
  const filenameEl = document.getElementById(`${prefix}-filename`);
  const previewBtn = document.getElementById(`${prefix}-preview`);
  const resultsEl = document.getElementById(`${prefix}-results`);
  let selectedFile = null;

  fileInput.addEventListener("change", () => {
    selectedFile = fileInput.files[0] || null;
    filenameEl.textContent = selectedFile ? selectedFile.name : "";
    previewBtn.disabled = !selectedFile;
    resultsEl.innerHTML = "";
  });

  const actionPill = { insert: "approved", update: "partial", error: "rejected" };

  function renderSummary(summary) {
    const rows = summary.rows
      .map(
        (r) => `<tr>
          <td>${r.row}</td>
          <td class="mono">${esc(r.code)}</td>
          <td><span class="status-pill ${actionPill[r.action]}">${esc(t(`import.action.${r.action}`))}</span></td>
          <td>${esc(r.message || "")}</td>
        </tr>`
      )
      .join("");

    resultsEl.innerHTML = `
      <div class="card" style="box-shadow:none; margin-top:12px; padding:14px;">
        <div class="small muted">${esc(
          t("import.summary", { inserts: summary.inserts, updates: summary.updates, errors: summary.errors })
        )}</div>
        ${
          rows
            ? `<div class="table-scroll" style="margin-top:8px">
                <table class="data-table">
                  <thead><tr><th>${esc(t("import.row"))}</th><th>${esc(t("common.code"))}</th><th>${esc(t("import.actionCol"))}</th><th>${esc(t("import.messageCol"))}</th></tr></thead>
                  <tbody>${rows}</tbody>
                </table>
              </div>`
            : ""
        }
        ${
          summary.committed
            ? `<div class="small" style="margin-top:10px; color:var(--good)">${esc(t("import.success"))}</div>`
            : summary.errors > 0
              ? `<div class="small" style="margin-top:10px; color:var(--bad)">${esc(t("import.fixErrors"))}</div>`
              : `<button type="button" class="btn primary sm" id="${prefix}-confirm" style="margin-top:10px">${esc(t("import.confirm"))}</button>`
        }
      </div>
    `;

    if (!summary.committed && summary.errors === 0) {
      document.getElementById(`${prefix}-confirm`).addEventListener("click", () => runImport(true));
    }
  }

  async function runImport(commit) {
    if (!selectedFile) return;
    const fd = new FormData();
    fd.append("file", selectedFile);
    try {
      const summary = await uploadFile(`${importPath}?commit=${commit}`, fd);
      renderSummary(summary);
      if (summary.committed) {
        toast(t("import.success"));
        if (onImported) onImported();
      }
    } catch (err) {
      toast(err.message, true);
    }
  }

  previewBtn.addEventListener("click", () => runImport(false));
}

function renderLineDetail(line, { role, receiptType, canFinalize, canDecide }) {
  const spec = line.spec;
  const specHtml = spec
    ? `<span class="spec-chip">${esc(t("line.specVersion", {
        version: spec.version,
        params: spec.parameters.map((p) => `${p.parameter_name}${p.unit ? " (" + p.unit + ")" : ""}`).join(", ") || t("line.noParameters"),
      }))}</span>`
    : line.material_code
      ? `<span class="spec-chip muted">${esc(t("line.noActiveSpec"))}</span>`
      : "";

  const importBadge =
    line.import_code
      ? `<span class="badge ${line.import_scenario === "repeat" ? "repeat" : "flag"}">${esc(line.import_code)}${
          role === "quality" && line.import_scenario ? " · " + esc(t(`status.${line.import_scenario}`)) : ""
        }</span>`
      : "";

  const batchesHtml = line.batches
    .map((b) => {
      const decided = b.status && b.status !== "pending";
      const actions = [];
      if (canDecide && b.status === "pending") {
        actions.push(`<button class="btn sm ghost" data-test="${b.id}">${esc(t("line.recordTestResults"))}</button>`);
        actions.push(`<button class="btn sm primary" data-decide="${b.id}">${esc(t("line.decide"))}</button>`);
      }
      if (canFinalize && b.status !== "pending" && b.status !== "rejected" && b.qty_actual_weighed == null) {
        actions.push(`<button class="btn sm ghost" data-finalize="${b.id}">${esc(t("line.finalizeWeight"))}</button>`);
      }
      if (decided && role === "quality") {
        actions.push(`<button class="btn sm ghost" data-coa="${b.id}" data-format="pdf">${esc(t("line.coaPdf"))}</button>`);
        actions.push(`<button class="btn sm ghost" data-coa="${b.id}" data-format="xlsx">${esc(t("line.coaExcel"))}</button>`);
      }
      // Numbers/units/codes are always Latin — bdi keeps each one a single
      // isolated left-to-right token so it can't get bidi-reordered against
      // the Arabic connector words around it (e.g. "100 kg" splitting away
      // from "as received"/"كما استُلمت" mid-sentence).
      const qtyValue = (qty, unit) => `<bdi>${esc(qty)} ${esc(unit)}</bdi>`;
      const qtyLine =
        b.qty_actual_weighed != null
          ? `${qtyValue(b.qty_as_received, line.unit)} ${esc(t("line.asReceivedLabel"))} · ${qtyValue(b.qty_actual_weighed, line.unit)} ${esc(t("line.actualLabel"))}`
          : `${qtyValue(b.qty_as_received, line.unit)} ${esc(t("line.asReceivedLabel"))}`;
      const resultsBadge = resultsSummaryBadge(b.test_results);
      return `
        <div class="batch-row">
          <div><bdi class="batch-id">${esc(b.supplier_batch_no)}</bdi> <span class="batch-qty">${qtyLine}</span></div>
          <div class="hstack">
            ${b.expiry_date ? `<span class="small muted">${esc(t("line.exp", { date: fmtDate(b.expiry_date) }))}</span>` : ""}
            ${batchStatusInline(b)}
            ${resultsBadge ? `<button class="btn sm ghost" data-view-results="${b.id}">${resultsBadge}</button>` : ""}
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
          ${line.material_code ? `<span class="code">${esc(line.material_code)}</span>` : `<span class="badge neutral">${esc(t("line.uncoded"))}</span>`}
        </div>
        <div class="hstack">
          ${importBadge}
          ${specHtml}
          ${role === "quality" && !line.material_code ? `<button class="btn sm ghost" data-associate="${line.id}">${esc(t("line.associateACode"))}</button>` : ""}
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
  const full = await api.get(`/api/receipts/detailed?${new URLSearchParams({ type })}`);
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
          ${esc(t("receipt.sentBy"))} <span data-sender-value>${receipt.sample_sent_by ? bdi(receipt.sample_sent_by) : esc(t("receipt.notRecorded"))}</span>
          <button class="btn ghost sm" data-edit-sender style="margin-inline-start:6px">${esc(t("common.edit"))}</button>
        </div>`
      : "";

  const card = document.createElement("div");
  card.className = "card receipt-card";
  card.dataset.receiptId = receipt.id;
  card.innerHTML = `
    <div class="receipt-card-top">
      <div>
        <div class="receipt-title">${esc(t("receipt.receiptNumber", { id: receipt.id }))} · ${bdiHtml(supplierName(receipt.supplier_id))}</div>
        <div class="receipt-meta">${fmtDateTime(receipt.received_at)} · ${esc(t("receipt.loggedBy"))} ${bdi(receipt.created_by)}</div>
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
        <button class="btn sm primary" data-save-sender>${esc(t("common.save"))}</button>`;
      block.querySelector("[data-save-sender]").addEventListener("click", async () => {
        const value = block.querySelector("[data-sender-input]").value.trim();
        if (!value) return toast(t("receipt.enterNameFirst"), true);
        try {
          await api.patch(`/api/receipts/${receipt.id}/sample-sender`, { sample_sent_by: value });
          toast(t("receipt.sampleSenderUpdated"));
          refreshCurrentView();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  }

  // Per-batch spec/results lookups, for buttons wired below.
  const specByBatch = {};
  const resultsByBatch = {};
  for (const line of receipt.lines) {
    for (const b of line.batches) {
      specByBatch[b.id] = line.spec;
      resultsByBatch[b.id] = b.test_results;
    }
  }

  // record test results
  card.querySelectorAll("[data-test]").forEach((btn) =>
    btn.addEventListener("click", () =>
      openTestResultsModal(
        btn.dataset.test,
        specByBatch[btn.dataset.test],
        resultsByBatch[btn.dataset.test],
        () => refreshCurrentView()
      )
    )
  );
  // decide
  card.querySelectorAll("[data-decide]").forEach((btn) =>
    btn.addEventListener("click", () =>
      openDecideModal(btn.dataset.decide, resultsByBatch[btn.dataset.decide], () => refreshCurrentView())
    )
  );
  // finalize
  card.querySelectorAll("[data-finalize]").forEach((btn) =>
    btn.addEventListener("click", () => openFinalizeModal(btn.dataset.finalize, () => refreshCurrentView()))
  );
  // associate code
  card.querySelectorAll("[data-associate]").forEach((btn) =>
    btn.addEventListener("click", () => openAssociateModal(btn.dataset.associate, () => refreshCurrentView()))
  );
  // view test results (read-only)
  card.querySelectorAll("[data-view-results]").forEach((btn) =>
    btn.addEventListener("click", () => openResultsModal(resultsByBatch[btn.dataset.viewResults]))
  );
  // COA download
  card.querySelectorAll("[data-coa]").forEach((btn) =>
    btn.addEventListener("click", () => downloadCoa(btn.dataset.coa, btn.dataset.format))
  );

  return card;
}

async function renderReceiptsInto(container, { role, type, bucket, query }) {
  container.innerHTML = loadingState();
  await getSuppliers();
  const all = await fetchReceiptsBucket({ role, type, bucket });
  const matches = all.filter((r) => receiptMatchesQuery(r, query));

  if (all.length === 0) {
    const key =
      bucket === "history"
        ? type === "sample" ? "bucket.noDecidedSamples" : "bucket.noDecidedImports"
        : type === "sample" ? "bucket.noPendingSamples" : "bucket.noPendingImports";
    container.innerHTML = emptyState(icons.inbox, t(key));
    return;
  }
  if (matches.length === 0) {
    container.innerHTML = emptyState(icons.search, t("bucket.noResultsFor", { query }));
    return;
  }
  container.innerHTML = "";
  for (const r of matches) {
    container.appendChild(buildReceiptCard(r, { role, type }));
  }
}

// ---------------------------------------------------------------- decide / finalize / associate modals

function paramSpecHint(p) {
  if (p.param_type === "numeric_range" || p.param_type === "time_range") {
    return `${p.min_value ?? ""}–${p.max_value ?? ""}${p.unit ? ` ${p.unit}` : ""}`;
  }
  if (p.param_type === "pass_fail") return t("test.specHint.passFail");
  return p.unit ?? "";
}

function testResultsRecap(results) {
  if (!results || results.length === 0) {
    return `<p class="small muted">${esc(t("test.recap.none"))}</p>`;
  }
  const rows = results
    .map(
      (r) => `
      <tr>
        <td>${esc(r.parameter_name)}</td>
        <td class="mono small">${esc(r.measured_value || "—")}</td>
        <td><span class="status-pill ${r.result === "fail" ? "rejected" : "approved"}">${esc(t(`status.${r.result}`))}</span></td>
      </tr>`
    )
    .join("");
  return `
    <div>
      <label class="small muted">${esc(t("test.recap.title"))}</label>
      <div class="table-scroll" style="margin-top:6px"><table class="data-table">
        <thead><tr><th>${esc(t("results.parameter"))}</th><th>${esc(t("results.measured"))}</th><th>${esc(t("results.result"))}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
}

async function openTestResultsModal(batchId, spec, existingResults, onDone) {
  const params = spec?.parameters ?? [];
  const existingByParam = {};
  for (const r of existingResults ?? []) existingByParam[r.spec_parameter_id] = r;

  if (!params.length) {
    openModal(
      esc(t("test.title")),
      `<p class="small muted">${esc(spec ? t("test.noParamsYet") : t("test.noActiveSpec"))}</p>`
    );
    return;
  }

  openModal(
    esc(t("test.title")),
    `<form class="form-grid" id="test-results-form">
      <label class="small muted">${esc(t("test.headerForSpec", { title: spec.title, version: spec.version }))}</label>
      <div class="repeatable">
        ${params
          .map((p) => {
            const existing = existingByParam[p.id];
            return `
          <div class="repeatable-item" data-result-row data-param-id="${p.id}">
            <div class="field-row">
              <div class="field" style="flex:2">
                <label>${esc(p.parameter_name)}${p.method ? ` <span class="muted">(${esc(p.method)})</span>` : ""}</label>
                <div class="small muted">${esc(t("test.spec", { hint: paramSpecHint(p) }))}</div>
              </div>
              <div class="field"><label>${esc(t("test.measuredValue"))}</label><input type="text" data-f="measured_value" value="${esc(existing?.measured_value || "")}" /></div>
              <div class="field" style="max-width:120px"><label>${esc(t("test.result"))}</label>
                <select data-f="result">
                  <option value="">—</option>
                  <option value="pass" ${existing?.result === "pass" ? "selected" : ""}>${esc(t("test.pass"))}</option>
                  <option value="fail" ${existing?.result === "fail" ? "selected" : ""}>${esc(t("test.fail"))}</option>
                </select>
              </div>
            </div>
          </div>`;
          })
          .join("")}
      </div>
      <div class="field"><label>${esc(t("test.testedBy"))}</label><input type="text" name="tested_by" value="${esc(getRememberedName())}" required /></div>
      <button type="submit" class="btn primary">${esc(t("test.save"))}</button>
    </form>`
  );

  document.getElementById("test-results-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    rememberName(fd.get("tested_by"));

    const results = [...document.querySelectorAll("[data-result-row]")]
      .map((row) => ({
        spec_parameter_id: Number(row.dataset.paramId),
        measured_value: row.querySelector('[data-f="measured_value"]').value || null,
        result: row.querySelector('[data-f="result"]').value,
      }))
      .filter((r) => r.result === "pass" || r.result === "fail");
    if (!results.length) return toast(t("test.enterAtLeastOne"), true);

    try {
      await api.post(`/api/batches/${batchId}/test-results`, { tested_by: fd.get("tested_by"), results });
      toast(t("test.saved"));
      closeModal();
      onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function openDecideModal(batchId, results, onDone) {
  const resultsHtml = testResultsRecap(results);

  openModal(
    esc(t("decide.title")),
    `<form class="form-grid" id="decide-form">
      <div class="field">
        <label>${esc(t("decide.decision"))}</label>
        <select name="decision" id="decide-decision">
          <option value="approve">${esc(t("decide.approveWhole"))}</option>
          <option value="partial">${esc(t("decide.approvePartial"))}</option>
          <option value="reject">${esc(t("decide.reject"))}</option>
        </select>
      </div>
      <div class="field-row" id="decide-qty-row" hidden>
        <div class="field"><label>${esc(t("decide.qtyAccepted"))}</label><input type="number" step="any" name="qty_accepted" /></div>
        <div class="field"><label>${esc(t("decide.qtyRejected"))}</label><input type="number" step="any" name="qty_rejected" /></div>
      </div>
      ${resultsHtml}
      <div class="field-row" id="decide-approve-fields">
        <div class="field"><label>${esc(t("decide.expiryDate"))}</label><input type="date" name="expiry_date" /></div>
        <div class="field"><label>${esc(t("decide.productionDate"))}</label><input type="date" name="production_date" /></div>
      </div>
      <div class="field-row" id="decide-approve-fields2">
        <div class="field"><label>${esc(t("decide.internalBatchNo"))}</label><input type="text" name="internal_batch_no" /></div>
        <div class="field"><label>${esc(t("decide.importCodeOverride"))}</label><input type="text" name="import_code" /></div>
      </div>
      <div class="field"><label>${esc(t("decide.remarks"))}</label><textarea name="coa_remarks"></textarea></div>
      <div class="field"><label>${esc(t("decide.decidedBy"))}</label><input type="text" name="decided_by" value="${esc(getRememberedName())}" required /></div>
      <button type="submit" class="btn primary">${esc(t("decide.submit"))}</button>
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
      toast(t("decide.recorded"));
      closeModal();
      onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function openFinalizeModal(batchId, onDone) {
  openModal(
    esc(t("finalize.title")),
    `<form class="form-grid" id="finalize-form">
      <div class="field"><label>${esc(t("finalize.actualQty"))}</label><input type="number" step="any" name="qty_actual_weighed" required /></div>
      <button type="submit" class="btn primary">${esc(t("finalize.save"))}</button>
    </form>`
  );
  document.getElementById("finalize-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.post(`/api/batches/${batchId}/finalize-weight`, { qty_actual_weighed: Number(fd.get("qty_actual_weighed")) });
      toast(t("finalize.recorded"));
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
    esc(t("associate.title")),
    `<div class="form-grid">
      <div class="field">
        <label>${esc(t("associate.mode"))}</label>
        <select id="assoc-mode">
          <option value="existing">${esc(t("associate.linkExisting"))}</option>
          <option value="new">${esc(t("associate.createNew"))}</option>
        </select>
      </div>
      <div id="assoc-existing" class="form-grid">
        <div class="field">
          <label>${esc(t("associate.existingMaterial"))}</label>
          ${codeSearchHtml("assoc-material", t("common.searchByCodeOrName"), "material_code")}
        </div>
      </div>
      <div id="assoc-new" class="form-grid" hidden>
        <div class="field-row">
          <div class="field"><label>${esc(t("associate.newCode"))}</label><input type="text" name="new_code" /></div>
          <div class="field"><label>${esc(t("common.name"))}</label><input type="text" name="new_name" /></div>
          <div class="field" style="max-width:100px"><label>${esc(t("common.unit"))}</label><input type="text" name="new_unit" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>${esc(t("common.type"))}</label><select name="new_type"><option value="">—</option>${types.map((ty) => `<option value="${esc(ty.code)}">${esc(ty.name)}</option>`).join("")}</select></div>
          <div class="field"><label>${esc(t("common.subtype"))}</label><select name="new_subtype"><option value="">—</option>${subtypes.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join("")}</select></div>
        </div>
        <div class="field"><label>${esc(t("associate.specTitle"))}</label><input type="text" name="spec_title" placeholder="${esc(t("associate.specTitlePlaceholder"))}" /></div>
        <p class="small muted">${esc(t("associate.specHint"))}</p>
      </div>
      <div class="field"><label>${esc(t("associate.yourNameQuality"))}</label><input type="text" id="assoc-by" value="${esc(getRememberedName())}" /></div>
      <button type="button" class="btn primary" id="assoc-submit">${esc(t("associate.submit"))}</button>
    </div>`
  );

  const modeSelect = document.getElementById("assoc-mode");
  modeSelect.addEventListener("change", () => {
    document.getElementById("assoc-existing").hidden = modeSelect.value !== "existing";
    document.getElementById("assoc-new").hidden = modeSelect.value !== "new";
  });

  const assocMaterialInput = wireCodeSearch("assoc-material", materials, () => {});
  if (materials.length) assocMaterialInput.value = materials[0].code;

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
        spec: { title: get("spec_title") || t("associate.initialSpecTitle"), created_by: by },
      };
    }
    try {
      await api.post(`/api/receipt-lines/${lineId}/associate-code`, body);
      toast(t("associate.codeAssociated"));
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
  todo: { warehouse: "bucket.todoCopy.warehouse", quality: "bucket.todoCopy.quality" },
  history: { warehouse: "bucket.historyCopy.warehouse", quality: "bucket.historyCopy.quality" },
};

/** Which report (if any) this role/bucket combination can export — the
 *  only three of the four combinations the user actually asked for:
 *  Warehouse's Received Log lives on their History tab (it is, in effect,
 *  a log of everything received over a period); Quality gets both their
 *  To Do (now, no period) and History (period) exported. */
function bucketExport(role, bucket) {
  if (role === "warehouse" && bucket === "history") return { path: "received-log", withPeriod: true, prefix: "received-log" };
  if (role === "quality" && bucket === "todo") return { path: "todos", withPeriod: false, prefix: "todo" };
  if (role === "quality" && bucket === "history") return { path: "history", withPeriod: true, prefix: "history" };
  return null;
}

async function viewReceiptBucket({ role, bucket }) {
  const state = getListState(role, bucket);
  const view = document.getElementById("view");
  const title = bucket === "history" ? t("bucket.historyTitle") : t("bucket.todoTitle");
  const exportInfo = bucketExport(role, bucket);

  view.innerHTML = `
    <div class="view-head"><div><h1>${esc(title)}</h1><p>${esc(t(BUCKET_COPY[bucket][role]))}</p></div></div>
    <div class="list-controls">
      <div class="subtabs">
        <button class="subtab-btn${state.type === "import" ? " active" : ""}" data-t="import">${esc(t("bucket.imports"))}</button>
        <button class="subtab-btn${state.type === "sample" ? " active" : ""}" data-t="sample">${esc(t("bucket.samples"))}</button>
      </div>
      <input type="search" class="search-input" id="receipt-search"
        placeholder="${esc(t("bucket.searchPlaceholder"))}" value="${esc(state.query)}" />
    </div>
    ${exportInfo ? exportBarHtml("bucket-export", { withPeriod: exportInfo.withPeriod }) : ""}
    <div id="receipt-list"></div>
  `;

  view.querySelectorAll("[data-t]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.type = btn.dataset.t;
      viewReceiptBucket({ role, bucket });
    })
  );

  if (exportInfo) {
    wireExportBar("bucket-export", exportInfo.path, { withPeriod: exportInfo.withPeriod, filenamePrefix: exportInfo.prefix });
  }

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
  { id: "types", labelKey: "codes.subtab.types" },
  { id: "materials", labelKey: "codes.subtab.materials" },
  { id: "list", labelKey: "codes.subtab.list" },
  { id: "schemes", labelKey: "codes.subtab.schemes" },
];
let codesSubtab = "types";

async function viewCodes() {
  const view = document.getElementById("view");
  view.innerHTML = `
    <div class="view-head"><div><h1>${esc(t("codes.title"))}</h1><p>${esc(t("codes.subtitle"))}</p></div></div>
    <div class="subtabs">
      ${CODES_SUBTABS.map(
        (sub) => `<button class="subtab-btn${codesSubtab === sub.id ? " active" : ""}" data-sub="${sub.id}">${esc(t(sub.labelKey))}</button>`
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

  const [types, subtypes, functions, materials] = await Promise.all([
    getTypes(true),
    getSubtypes(true),
    getFunctions(true),
    getMaterials(true),
  ]);
  const section = document.getElementById("codes-section");
  if (codesSubtab === "types") renderTypesSubtypesSection(section, { types, subtypes, functions });
  else if (codesSubtab === "materials") renderMaterialsSection(section, { types, subtypes, functions, materials });
  else if (codesSubtab === "list") renderCodesListSection(section, { types, subtypes, functions, materials });
  else renderSchemesSection(section);
}

function renderTypesSubtypesSection(section, { types, subtypes, functions }) {
  section.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:12px">${esc(t("codes.typesHeading"))}</h3>
      <div class="field-row">
        <div class="table-scroll" style="flex:1"><table class="data-table"><thead><tr><th>${esc(t("common.type"))}</th><th>${esc(t("common.name"))}</th></tr></thead>
          <tbody>${types.map((ty) => `<tr><td class="mono">${esc(ty.code)}</td><td>${esc(ty.name)}</td></tr>`).join("") || `<tr><td colspan="2" class="muted">${esc(t("common.noneYet"))}</td></tr>`}</tbody></table></div>
        <div class="table-scroll" style="flex:1"><table class="data-table"><thead><tr><th>${esc(t("common.subtype"))}</th><th>${esc(t("common.type"))}</th><th>${esc(t("common.name"))}</th></tr></thead>
          <tbody>${subtypes.map((s) => `<tr><td class="mono">${esc(s.code)}</td><td class="mono">${esc(s.type_code)}</td><td>${esc(s.name)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">${esc(t("common.noneYet"))}</td></tr>`}</tbody></table></div>
      </div>
      <div class="field-row" style="margin-top:14px">
        <form class="form-grid" id="new-type-form" style="flex:1">
          <b class="small">${esc(t("codes.newType"))}</b>
          <div class="field-row"><input name="code" placeholder="${esc(t("codes.typeCodePlaceholder"))}" required /><input name="name" placeholder="${esc(t("common.name"))}" required /><button class="btn primary sm">${esc(t("common.add"))}</button></div>
        </form>
        <form class="form-grid" id="new-subtype-form" style="flex:1">
          <b class="small">${esc(t("codes.newSubtype"))}</b>
          <div class="field-row">
            <input name="code" placeholder="${esc(t("codes.subtypeCodePlaceholder"))}" required />
            <select name="type_code" required><option value="">${esc(t("codes.typePlaceholder"))}</option>${types.map((ty) => `<option value="${esc(ty.code)}">${esc(ty.code)}</option>`).join("")}</select>
            <input name="name" placeholder="${esc(t("common.name"))}" required />
            <button class="btn primary sm">${esc(t("common.add"))}</button>
          </div>
        </form>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-bottom:12px">${esc(t("codes.functionsHeading"))}</h3>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>${esc(t("common.function"))}</th><th>${esc(t("common.name"))}</th></tr></thead>
        <tbody>${functions.map((f) => `<tr><td class="mono">${esc(f.code)}</td><td>${esc(f.name)}</td></tr>`).join("") || `<tr><td colspan="2" class="muted">${esc(t("common.noneYet"))}</td></tr>`}</tbody></table></div>
      <form class="form-grid" id="new-function-form" style="margin-top:14px">
        <b class="small">${esc(t("codes.newFunction"))}</b>
        <div class="field-row"><input name="code" placeholder="${esc(t("codes.functionCodePlaceholder"))}" required /><input name="name" placeholder="${esc(t("common.name"))}" required /><button class="btn primary sm">${esc(t("common.add"))}</button></div>
      </form>
    </div>
  `;

  document.getElementById("new-type-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.put("/api/material-types", { code: fd.get("code"), name: fd.get("name") });
      toast(t("codes.typeAdded"));
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
      toast(t("codes.subtypeAdded"));
      viewCodes();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById("new-function-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.put("/api/material-functions", { code: fd.get("code"), name: fd.get("name") });
      toast(t("codes.functionAdded"));
      viewCodes();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function renderMaterialsSection(section, { types, subtypes, functions, materials }) {
  section.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:12px">${esc(t("codes.materialsHeading"))}</h3>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>${esc(t("common.code"))}</th><th>${esc(t("common.name"))}</th><th>${esc(t("common.unit"))}</th><th>${esc(t("common.function"))}</th><th>${esc(t("codes.typeSubtype"))}</th><th>${esc(t("codes.expiry"))}</th></tr></thead>
        <tbody>${
          materials
            .map(
              (m) => `<tr><td class="mono">${esc(m.code)}</td><td>${esc(m.name)}</td><td>${esc(m.unit)}</td><td class="mono">${esc(m.function_code || "—")}</td><td>${esc(m.type_code || "—")}${m.subtype_code ? " / " + esc(m.subtype_code) : ""}</td><td>${m.requires_expiry ? esc(t("common.yes")) : esc(t("common.no"))}</td></tr>`
            )
            .join("") || `<tr><td colspan="6" class="muted">${esc(t("common.noneYet"))}</td></tr>`
        }</tbody></table></div>
      <form class="form-grid" id="new-material-form" style="margin-top:14px">
        <b class="small">${esc(t("codes.newEditMaterial"))}</b>
        <div class="field-row">
          <input name="code" placeholder="${esc(t("common.code"))}" required />
          <input name="name" placeholder="${esc(t("common.name"))}" required />
          <input name="unit" placeholder="${esc(t("common.unit"))} (KG)" required style="max-width:100px" />
          <select name="type_code"><option value="">${esc(t("codes.typePlaceholder"))}</option>${types.map((ty) => `<option value="${esc(ty.code)}">${esc(ty.code)}</option>`).join("")}</select>
          <select name="subtype_code"><option value="">${esc(t("common.subtype"))}…</option>${subtypes.map((s) => `<option value="${esc(s.code)}">${esc(s.code)}</option>`).join("")}</select>
          <select name="function_code"><option value="">${esc(t("codes.functionPlaceholder"))}</option>${functions.map((f) => `<option value="${esc(f.code)}">${esc(f.code)} — ${esc(f.name)}</option>`).join("")}</select>
          <label class="small" style="display:flex;align-items:center;gap:4px;"><input type="checkbox" name="requires_expiry" checked /> ${esc(t("codes.requiresExpiry"))}</label>
          <button class="btn primary sm">${esc(t("common.save"))}</button>
        </div>
      </form>
      ${importSectionHtml("materials-import", "/api/materials/import-template")}
      <div class="small muted" style="margin-top:14px;">${esc(t("codes.importSpecsHeading"))}</div>
      ${importSectionHtml("materials-specs-import", "/api/specs/import-template")}
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
        function_code: fd.get("function_code") || null,
        requires_expiry: fd.get("requires_expiry") === "on",
      });
      toast(t("codes.materialSaved"));
      viewCodes();
    } catch (err) {
      toast(err.message, true);
    }
  });

  wireImportSection("materials-import", "/api/materials/import", viewCodes);
  wireImportSection("materials-specs-import", "/api/specs/import", viewCodes);
}

const codesListState = { sortKey: "code", sortDir: "asc", query: "", filterType: "", filterSubtype: "", filterFunction: "" };

function renderCodesListSection(section, { types, subtypes, functions, materials }) {
  const columns = [
    { key: "code", labelKey: "common.code" },
    { key: "function_code", labelKey: "common.function" },
    { key: "type_code", labelKey: "common.type" },
    { key: "subtype_code", labelKey: "common.subtype" },
  ];

  section.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:12px">${esc(t("codes.listHeading"))}</h3>
      <div class="list-controls" style="border-bottom:none; padding-bottom:0;">
        <div class="hstack">
          <select id="codes-list-type"><option value="">${esc(t("codes.typePlaceholder"))}</option>${types.map((ty) => `<option value="${esc(ty.code)}">${esc(ty.code)} — ${esc(ty.name)}</option>`).join("")}</select>
          <select id="codes-list-subtype"><option value="">${esc(t("common.subtype"))}…</option>${subtypes.map((s) => `<option value="${esc(s.code)}">${esc(s.code)} — ${esc(s.name)}</option>`).join("")}</select>
          <select id="codes-list-function"><option value="">${esc(t("codes.functionPlaceholder"))}</option>${functions.map((f) => `<option value="${esc(f.code)}">${esc(f.code)} — ${esc(f.name)}</option>`).join("")}</select>
        </div>
        <input type="search" class="search-input" id="codes-list-search" placeholder="${esc(t("codes.listSearchPlaceholder"))}" value="${esc(codesListState.query)}" />
      </div>
      ${exportBarHtml("codes-list-export", { withPeriod: false })}
      <div class="table-scroll" style="margin-top:12px"><table class="data-table" id="codes-list-table"></table></div>
    </div>
  `;

  wireExportBar("codes-list-export", "codes", {
    withPeriod: false,
    filenamePrefix: "codes",
    getParams: () => ({
      query: codesListState.query,
      type: codesListState.filterType,
      subtype: codesListState.filterSubtype,
      function: codesListState.filterFunction,
    }),
  });

  const tableEl = document.getElementById("codes-list-table");

  function render() {
    const q = codesListState.query.trim().toLowerCase();
    let rows = materials.filter((m) => {
      if (q && !m.code.toLowerCase().includes(q) && !m.name.toLowerCase().includes(q)) return false;
      if (codesListState.filterType && m.type_code !== codesListState.filterType) return false;
      if (codesListState.filterSubtype && m.subtype_code !== codesListState.filterSubtype) return false;
      if (codesListState.filterFunction && m.function_code !== codesListState.filterFunction) return false;
      return true;
    });

    const { sortKey, sortDir } = codesListState;
    rows = rows.slice().sort((a, b) => {
      const cmp = String(a[sortKey] || "").localeCompare(String(b[sortKey] || ""));
      return sortDir === "asc" ? cmp : -cmp;
    });

    const theadHtml = `<tr>
      ${columns
        .map((c) => {
          const active = codesListState.sortKey === c.key;
          const arrow = active ? (codesListState.sortDir === "asc" ? " ▲" : " ▼") : "";
          return `<th data-sort-key="${c.key}" style="cursor:pointer; user-select:none;">${esc(t(c.labelKey))}${arrow}</th>`;
        })
        .join("")}
      <th>${esc(t("common.name"))}</th>
      <th>${esc(t("common.unit"))}</th>
    </tr>`;

    const tbodyHtml =
      rows
        .map(
          (m) => `<tr>
        <td class="mono">${esc(m.code)}</td>
        <td class="mono">${esc(m.function_code || "—")}</td>
        <td class="mono">${esc(m.type_code || "—")}</td>
        <td class="mono">${esc(m.subtype_code || "—")}</td>
        <td>${esc(m.name)}</td>
        <td>${esc(m.unit)}</td>
      </tr>`
        )
        .join("") || `<tr><td colspan="6" class="muted">${esc(t("common.noMatches"))}</td></tr>`;

    tableEl.innerHTML = `<thead>${theadHtml}</thead><tbody>${tbodyHtml}</tbody>`;

    tableEl.querySelectorAll("[data-sort-key]").forEach((th) =>
      th.addEventListener("click", () => {
        const key = th.dataset.sortKey;
        if (codesListState.sortKey === key) {
          codesListState.sortDir = codesListState.sortDir === "asc" ? "desc" : "asc";
        } else {
          codesListState.sortKey = key;
          codesListState.sortDir = "asc";
        }
        render();
      })
    );
  }

  document.getElementById("codes-list-type").value = codesListState.filterType;
  document.getElementById("codes-list-subtype").value = codesListState.filterSubtype;
  document.getElementById("codes-list-function").value = codesListState.filterFunction;

  document.getElementById("codes-list-type").addEventListener("change", (e) => {
    codesListState.filterType = e.target.value;
    render();
  });
  document.getElementById("codes-list-subtype").addEventListener("change", (e) => {
    codesListState.filterSubtype = e.target.value;
    render();
  });
  document.getElementById("codes-list-function").addEventListener("change", (e) => {
    codesListState.filterFunction = e.target.value;
    render();
  });

  let debounceTimer;
  document.getElementById("codes-list-search").addEventListener("input", (e) => {
    codesListState.query = e.target.value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, 150);
  });

  render();
}

function renderSchemesSection(section) {
  section.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:12px">${esc(t("codes.schemesHeading"))}</h3>
      <form class="form-grid" id="batch-scheme-form">
        <b class="small">${esc(t("codes.batchPatternHeading"))}</b>
        <div class="field-row">
          <input name="supplier_code" placeholder="${esc(t("codes.supplierCodeBlankDefault"))}" />
          <input name="pattern_template" placeholder="{supplier_code}{MMYY}{seq:04d}" required style="flex:2" />
          <button class="btn primary sm">${esc(t("common.save"))}</button>
        </div>
      </form>
      <form class="form-grid" id="rmf-scheme-form" style="margin-top:10px">
        <b class="small">${esc(t("codes.rmfHeading"))}</b>
        <div class="field-row"><input name="pattern_template" placeholder="RMF{seq:04d}" required style="flex:1" /><button class="btn primary sm">${esc(t("common.save"))}</button></div>
      </form>
      <form class="form-grid" id="rms-scheme-form" style="margin-top:10px">
        <b class="small">${esc(t("codes.rmsHeading"))}</b>
        <div class="field-row"><input name="pattern_template" placeholder="RMS{seq:04d}" required style="flex:1" /><button class="btn primary sm">${esc(t("common.save"))}</button></div>
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
      toast(t("codes.batchSchemeSaved"));
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById("rmf-scheme-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api.put("/api/import-code-schemes/RMF", { pattern_template: new FormData(e.target).get("pattern_template") });
      toast(t("codes.rmfSaved"));
    } catch (err) {
      toast(err.message, true);
    }
  });
  document.getElementById("rms-scheme-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api.put("/api/import-code-schemes/RMS", { pattern_template: new FormData(e.target).get("pattern_template") });
      toast(t("codes.rmsSaved"));
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
        <div class="field" style="flex:2"><label>${esc(t("results.parameter"))}</label><input data-f="parameter_name" value="${esc(p.parameter_name || "")}" required /></div>
        <div class="field"><label>${esc(t("common.type"))}</label>
          <select data-f="param_type">${PARAM_TYPES.map((pt) => `<option value="${pt}" ${p.param_type === pt ? "selected" : ""}>${esc(t("paramType." + pt))}</option>`).join("")}</select>
        </div>
        <div><label>&nbsp;</label><button type="button" class="btn ghost sm" data-remove-param>✕</button></div>
      </div>
      <div class="field-row">
        <div class="field"><label>${esc(t("common.method"))}</label><input data-f="method" value="${esc(p.method || "")}" /></div>
        <div class="field"><label>${esc(t("specs.paramMin"))}</label><input type="number" step="any" data-f="min_value" value="${p.min_value ?? ""}" /></div>
        <div class="field"><label>${esc(t("specs.paramMax"))}</label><input type="number" step="any" data-f="max_value" value="${p.max_value ?? ""}" /></div>
        <div class="field"><label>${esc(t("common.unit"))}</label><input data-f="unit" value="${esc(p.unit || "")}" /></div>
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

// ---------------------------------------------------------------- suppliers list (both roles)

async function viewSuppliers() {
  const view = document.getElementById("view");
  const suppliers = await getSuppliers(true);
  const role = getRole();

  const rows = suppliers
    .map(
      (s) =>
        `<tr><td class="mono">${esc(s.code)}</td><td>${esc(s.name)}</td><td>${s.total_receipts}</td></tr>`
    )
    .join("");

  view.innerHTML = `
    <div class="view-head"><div><h1>${esc(t("suppliersList.title"))}</h1><p>${esc(t("suppliersList.subtitle"))}</p></div></div>

    <div class="card">
      <h3 style="margin-bottom:12px">${esc(t("suppliersList.directory"))}</h3>
      ${exportBarHtml("suppliers-list-export", { withPeriod: false })}
      <div class="table-scroll" style="margin-top:12px">
        <table class="data-table">
          <thead><tr><th>${esc(t("common.code"))}</th><th>${esc(t("common.name"))}</th><th>${esc(t("suppliersList.totalReceipts"))}</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="3" class="muted">${esc(t("common.noneYet"))}</td></tr>`}</tbody>
        </table>
      </div>
      <form class="form-grid" id="new-supplier-form" style="margin-top:16px; border-top:1px solid var(--rule); padding-top:14px;">
        <b class="small">${esc(t("suppliersList.addSupplier"))}</b>
        <div class="field-row">
          <input name="code" placeholder="${esc(t("common.code"))}" required />
          <input name="name" placeholder="${esc(t("common.name"))}" required />
          <button class="btn primary sm">${esc(t("common.add"))}</button>
        </div>
      </form>
      ${importSectionHtml("suppliers-import", "/api/suppliers/import-template")}
      ${
        role === "quality"
          ? `<div class="small muted" style="margin-top:14px;">${esc(t("suppliersList.importSpecsHeading"))}</div>
             ${importSectionHtml("suppliers-specs-import", "/api/specs/import-template")}`
          : ""
      }
    </div>
  `;

  wireExportBar("suppliers-list-export", "suppliers", { withPeriod: false, filenamePrefix: "suppliers" });
  wireImportSection("suppliers-import", "/api/suppliers/import", viewSuppliers);
  if (role === "quality") wireImportSection("suppliers-specs-import", "/api/specs/import", viewSuppliers);

  document.getElementById("new-supplier-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.post("/api/suppliers", { code: fd.get("code"), name: fd.get("name") });
      toast(t("suppliersList.supplierAdded"));
      viewSuppliers();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------------------------------------------------------------- supplier assessment (warehouse only)
//
// A different question from Quality's own Master Data > Suppliers
// assessment: not "did the material pass QC" but "did the supplier ship
// what their paperwork claimed" — as-received qty (what the receipt says)
// vs actual weighed qty (what Warehouse physically found), per material
// code and overall.

function fmtVariance(pct) {
  if (pct == null) return "—";
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}
function varianceClass(pct) {
  if (pct == null) return "";
  return Math.abs(pct) < 2 ? "" : pct < 0 ? "bad" : "good";
}

async function viewSupplierAssessment() {
  const view = document.getElementById("view");
  const suppliers = await getSuppliers(true);

  view.innerHTML = `
    <div class="view-head"><div><h1>${esc(t("supplierAssessment.title"))}</h1><p>${esc(t("supplierAssessment.subtitle"))}</p></div></div>
    <div class="card">
      <div class="field"><label>${esc(t("common.supplier"))}</label>
        ${codeSearchHtml("weight-supplier-search", t("common.searchByCodeOrName"))}
      </div>
    </div>
    <div id="weight-assessment-body"></div>
  `;

  const body = document.getElementById("weight-assessment-body");
  let currentCode = null;

  async function loadAssessment(code) {
    currentCode = code;
    body.innerHTML = loadingState();
    const a = await api.get(`/api/suppliers/${encodeURIComponent(code)}/weight-assessment`);
    if (!body.isConnected || currentCode !== code) return;

    const materialRows = a.by_material
      .map(
        (m) => `
      <tr>
        <td class="mono">${esc(m.material_code || t("supplierAssessment.uncoded"))}</td>
        <td>${esc(m.material_name)}</td>
        <td>${m.batches}</td>
        <td>${m.qty_as_received} ${esc(m.unit || "")}</td>
        <td>${m.qty_actual_weighed} ${esc(m.unit || "")}</td>
        <td class="${varianceClass(m.variance_pct)}">${fmtVariance(m.variance_pct)}</td>
      </tr>`
      )
      .join("");

    body.innerHTML = `
      <div class="card">
        <h3>${esc(a.supplier.name)} <span class="mono small muted">(${esc(a.supplier.code)})</span></h3>
      </div>

      <div class="card">
        <h3 style="margin-bottom:10px">${esc(t("supplierAssessment.overall"))}</h3>
        <div class="stat-grid">
          <div class="stat-tile"><div class="stat-label">${esc(t("supplierAssessment.batchesFinalized"))}</div><div class="stat-value">${a.overall.batches}</div></div>
          <div class="stat-tile"><div class="stat-label">${esc(t("supplierAssessment.variance"))}</div><div class="stat-value ${varianceClass(a.overall.variance_pct)}">${fmtVariance(a.overall.variance_pct)}</div></div>
        </div>
        <div class="small muted" style="margin-top:8px">${esc(t("supplierAssessment.note"))}</div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:10px">${esc(t("supplierAssessment.byMaterial"))}</h3>
        ${
          a.by_material.length
            ? `<div class="table-scroll"><table class="data-table">
                <thead><tr><th>${esc(t("common.code"))}</th><th>${esc(t("common.name"))}</th><th>${esc(t("supplierAssessment.batches"))}</th><th>${esc(t("supplierAssessment.qtyAsReceived"))}</th><th>${esc(t("supplierAssessment.qtyActual"))}</th><th>${esc(t("supplierAssessment.variance"))}</th></tr></thead>
                <tbody>${materialRows}</tbody>
              </table></div>`
            : `<div class="small muted">${esc(t("supplierAssessment.noFinalizedYet"))}</div>`
        }
      </div>
    `;
  }

  const input = wireCodeSearch("weight-supplier-search", suppliers, loadAssessment);
  if (suppliers.length) {
    input.value = suppliers[0].code;
    await loadAssessment(suppliers[0].code);
  } else {
    body.innerHTML = emptyState(icons.navSuppliers, t("suppliers.noSuppliersYet"));
  }
}

async function viewSpecs() {
  const view = document.getElementById("view");
  const [materials, subtypes] = await Promise.all([getMaterials(true), getSubtypes(true)]);

  view.innerHTML = `
    <div class="view-head"><div><h1>${esc(t("specs.title"))}</h1><p>${esc(t("specs.subtitle"))}</p></div></div>

    <div class="card">
      <h3 style="margin-bottom:12px">${esc(t("specs.specForMaterial"))}</h3>
      <div class="field"><label>${esc(t("common.material"))}</label>
        ${codeSearchHtml("spec-material", t("common.searchByCodeOrName"))}
      </div>
      ${exportBarHtml("spec-export", { withPeriod: false })}
      <div id="spec-history" style="margin-top:14px"></div>
      <form class="form-grid" id="new-spec-form" style="margin-top:16px; border-top:1px solid var(--rule); padding-top:14px;">
        <b class="small">${esc(t("specs.newVersion"))}</b>
        <div class="field-row">
          <div class="field"><label>${esc(t("common.title"))}</label><input name="title" required /></div>
          <div class="field"><label>${esc(t("specs.createdBy"))}</label><input name="created_by" value="${esc(getRememberedName())}" required /></div>
        </div>
        <div class="field"><label>${esc(t("common.notes"))}</label><textarea name="notes"></textarea></div>
        <div id="spec-params" class="repeatable"></div>
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn ghost sm" id="spec-add-param">${esc(t("specs.addParameter"))}</button>
          <button type="button" class="btn ghost sm" id="spec-prefill">${esc(t("specs.prefillFromTemplate"))}</button>
        </div>
        <button type="submit" class="btn primary">${esc(t("specs.createVersion"))}</button>
      </form>
      ${importSectionHtml("specs-import", "/api/specs/import-template")}
    </div>

    <div class="card">
      <h3 style="margin-bottom:12px">${esc(t("specs.templatesHeading"))}</h3>
      <div class="field"><label>${esc(t("common.subtype"))}</label>
        <select id="template-subtype">${subtypes.map((s) => `<option value="${esc(s.code)}">${esc(s.code)} — ${esc(s.name)}</option>`).join("")}</select>
      </div>
      <div id="template-params" class="repeatable" style="margin-top:10px"></div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button type="button" class="btn ghost sm" id="template-add-param">${esc(t("specs.addParameter"))}</button>
        <button type="button" class="btn primary sm" id="template-save">${esc(t("specs.saveTemplate"))}</button>
      </div>
    </div>
  `;

  const historyEl = document.getElementById("spec-history");
  const paramsContainer = document.getElementById("spec-params");
  let addParamRow = wireParamList(paramsContainer);

  async function loadHistory() {
    const code = specMaterialSelect.value;
    if (!code) {
      historyEl.innerHTML = "";
      return;
    }
    const specs = await api.get(`/api/materials/${encodeURIComponent(code)}/specs`);
    historyEl.innerHTML = specs.length
      ? specs
          .map(
            (s) => `
        <div class="card" style="box-shadow:none; padding:12px 14px; margin-bottom:8px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <b class="small">v${s.version} — ${esc(s.title)}</b>
            <span class="status-pill ${s.status === "active" ? "approved" : "neutral"}">${esc(t(`status.${s.status}`))}</span>
          </div>
          <div class="small muted" style="margin-top:4px;">
            ${s.parameters.map((p) => `${esc(p.parameter_name)}${p.min_value != null ? ` (${p.min_value}–${p.max_value}${p.unit ? " " + esc(p.unit) : ""})` : ""}`).join(" · ") || esc(t("specs.noParameters"))}
          </div>
        </div>`
          )
          .join("")
      : emptyState(icons.navSpecs, t("specs.noSpecsYet"));
  }
  const specMaterialSelect = wireCodeSearch("spec-material", materials, loadHistory);
  if (materials.length) {
    specMaterialSelect.value = materials[0].code;
    await loadHistory();
  }
  wireExportBar(
    "spec-export",
    () => (specMaterialSelect.value ? `spec/${encodeURIComponent(specMaterialSelect.value)}` : null),
    { withPeriod: false, filenamePrefix: "spec" }
  );

  wireImportSection("specs-import", "/api/specs/import", viewSpecs);

  document.getElementById("spec-add-param").addEventListener("click", () => addParamRow({}));

  document.getElementById("spec-prefill").addEventListener("click", async () => {
    const material = materials.find((m) => m.code === specMaterialSelect.value);
    if (!material?.subtype_code) return toast(t("specs.noSubtypeSet"), true);
    const template = await api.get(`/api/material-subtypes/${encodeURIComponent(material.subtype_code)}/spec-template`);
    paramsContainer.innerHTML = "";
    template.parameters.forEach((p) => addParamRow(p));
    toast(t("specs.prefilledFrom", { code: material.subtype_code }));
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
      toast(t("specs.versionCreated"));
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
    if (!templateSubtypeSelect.value) return;
    const template = await api.get(`/api/material-subtypes/${encodeURIComponent(templateSubtypeSelect.value)}/spec-template`);
    template.parameters.forEach((p) => addTemplateRow(p));
  }
  templateSubtypeSelect.addEventListener("change", loadTemplate);
  await loadTemplate();

  document.getElementById("template-add-param").addEventListener("click", () => addTemplateRow({}));
  document.getElementById("template-save").addEventListener("click", async () => {
    try {
      await api.put(`/api/material-subtypes/${encodeURIComponent(templateSubtypeSelect.value)}/spec-template`, {
        parameters: collectParams(templateParams),
      });
      toast(t("specs.templateSaved"));
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------------------------------------------------------------- master data dossier

function fmtPct(rate) {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

async function downloadAttachment(id, filename) {
  try {
    const res = await fetch(`/api/attachments/${id}/download`, { credentials: "same-origin" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || t("download.failed", { status: res.status }));
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast(err.message, true);
  }
}

function dossierImportEntryHtml(entry) {
  const scenarioBadge = entry.import_scenario
    ? `<span class="badge ${entry.import_scenario === "repeat" ? "repeat" : "flag"}">${esc(t(`status.${entry.import_scenario}`))}</span>`
    : "";
  const batchRows = entry.batches
    .map(
      (b) => `
      <div class="batch-row">
        <div><bdi class="batch-id">${esc(b.supplier_batch_no)}</bdi></div>
        <div class="hstack">
          ${statusPill(b.status)}
          ${b.internal_batch_no ? `<bdi class="mono small">${esc(b.internal_batch_no)}</bdi>` : ""}
          ${b.status !== "pending" ? `<button class="btn sm ghost" data-dossier-coa="${b.id}" data-format="pdf">${esc(t("line.coaPdf"))}</button>
          <button class="btn sm ghost" data-dossier-coa="${b.id}" data-format="xlsx">${esc(t("line.coaExcel"))}</button>` : ""}
        </div>
      </div>`
    )
    .join("");
  const attachmentRows = entry.attachments
    .map(
      (a) => `
      <div class="attachment-row">
        <span><span class="badge neutral">${esc(t(`masterdata.kind${a.kind.charAt(0).toUpperCase()}${a.kind.slice(1)}`))}</span> ${bdi(a.filename)} <span class="muted">${t("masterdata.attachmentBy", { name: bdi(a.uploaded_by), date: esc(fmtDate(a.uploaded_at)) })}</span></span>
        <span class="hstack">
          <button class="btn sm ghost" data-attachment-download="${a.id}" data-filename="${esc(a.filename)}">${esc(t("common.download"))}</button>
          <button class="btn sm ghost" data-attachment-delete="${a.id}">${esc(t("common.remove"))}</button>
        </span>
      </div>`
    )
    .join("");

  return `
    <div class="dossier-import-entry" data-line-id="${entry.receipt_line_id}">
      <div class="line-head">
        <div>
          <bdi class="mono"><b>${esc(entry.import_code)}</b></bdi> ${scenarioBadge}
          <div class="small muted">${bdi(entry.material_name_text)} · ${bdi(entry.supplier_name)} <span class="mono">(${esc(entry.supplier_code)})</span> · ${esc(t("masterdata.receivedOn", { date: fmtDate(entry.received_at) }))}</div>
        </div>
      </div>
      <div style="margin-top:6px">${batchRows}</div>
      <div style="margin-top:8px">
        <div class="small muted" style="margin-bottom:4px">${esc(t("masterdata.attachments"))}</div>
        ${attachmentRows || `<div class="small muted">${esc(t("masterdata.attachmentsNone"))}</div>`}
        <form class="field-row" data-attachment-form style="margin-top:8px; align-items:flex-end;">
          <div class="field" style="max-width:120px"><label>${esc(t("masterdata.kind"))}</label>
            <select data-f="kind"><option value="photo">${esc(t("masterdata.kindPhoto"))}</option><option value="tds">${esc(t("masterdata.kindTds"))}</option><option value="msds">${esc(t("masterdata.kindMsds"))}</option></select>
          </div>
          <div class="field" style="flex:2"><label>${esc(t("masterdata.file"))}</label><input type="file" data-f="file" required /></div>
          <button type="submit" class="btn sm ghost">${esc(t("masterdata.attach"))}</button>
        </form>
      </div>
    </div>`;
}

function wireDossierImportEntries(container, onDone) {
  container.querySelectorAll("[data-dossier-coa]").forEach((btn) =>
    btn.addEventListener("click", () => downloadCoa(btn.dataset.dossierCoa, btn.dataset.format))
  );
  container.querySelectorAll("[data-attachment-download]").forEach((btn) =>
    btn.addEventListener("click", () => downloadAttachment(btn.dataset.attachmentDownload, btn.dataset.filename))
  );
  container.querySelectorAll("[data-attachment-delete]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm(t("masterdata.removeAttachmentConfirm"))) return;
      try {
        await api.delete(`/api/attachments/${btn.dataset.attachmentDelete}`);
        toast(t("masterdata.attachmentRemoved"));
        onDone();
      } catch (err) {
        toast(err.message, true);
      }
    })
  );
  container.querySelectorAll("[data-attachment-form]").forEach((form) =>
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const lineId = e.target.closest("[data-line-id]").dataset.lineId;
      const fileInput = form.querySelector('[data-f="file"]');
      const kind = form.querySelector('[data-f="kind"]').value;
      const file = fileInput.files[0];
      if (!file) return toast(t("masterdata.chooseFileFirst"), true);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      fd.append("uploaded_by", getRememberedName() || t("topbar.roleQuality"));
      try {
        await uploadFile(`/api/receipt-lines/${lineId}/attachments`, fd);
        toast(t("masterdata.fileAttached"));
        onDone();
      } catch (err) {
        toast(err.message, true);
      }
    })
  );
}

// Live search: type to filter a client-side list (already-loaded
// materials/suppliers, so no server round-trip) and pick a result from a
// custom-rendered panel — no native <select>/<datalist> dropdown.
// Matches the receipt search box's own conventions (search-input class,
// 150ms debounce). Selecting a result autofetches immediately.
function codeSearchHtml(id, placeholder, name) {
  return `
    <div class="search-combo">
      <input type="search" class="search-input" id="${id}" ${name ? `name="${esc(name)}"` : ""} placeholder="${esc(placeholder)}" autocomplete="off" />
      <div id="${id}-results" class="search-results" hidden></div>
    </div>
  `;
}

function wireCodeSearch(id, items, onSelect) {
  const input = document.getElementById(id);
  const results = document.getElementById(`${id}-results`);
  let debounceTimer;

  function currentMatches() {
    const q = input.value.trim().toLowerCase();
    if (!q) return [];
    return items.filter((i) => i.code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)).slice(0, 8);
  }

  function select(code) {
    input.value = code;
    results.hidden = true;
    onSelect(code);
  }

  function renderResults() {
    const matches = currentMatches();
    if (!input.value.trim()) {
      results.hidden = true;
      results.innerHTML = "";
      return;
    }
    results.innerHTML = matches.length
      ? matches
          .map((i) => `<button type="button" class="search-result-item" data-code="${esc(i.code)}"><span class="mono">${esc(i.code)}</span> — ${esc(i.name)}</button>`)
          .join("")
      : `<div class="search-result-empty">${esc(t("common.noMatches"))}</div>`;
    results.hidden = false;
    results.querySelectorAll("[data-code]").forEach((btn) =>
      btn.addEventListener("click", () => select(btn.dataset.code))
    );
  }

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderResults, 150);
  });
  input.addEventListener("focus", () => {
    if (input.value.trim()) renderResults();
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      results.hidden = true;
    }, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const top = currentMatches()[0];
      if (top) select(top.code);
    } else if (e.key === "Escape") {
      results.hidden = true;
    }
  });

  return input;
}

const MASTERDATA_SUBTABS = [
  { id: "dossier", labelKey: "masterdata.subtab.dossier" },
  { id: "suppliers", labelKey: "masterdata.subtab.suppliers" },
];
let masterDataSubtab = "dossier";

async function viewMasterData() {
  const view = document.getElementById("view");
  view.innerHTML = `
    <div class="view-head"><div><h1>${esc(t("masterdata.title"))}</h1><p>${esc(t("masterdata.subtitle"))}</p></div></div>
    <div class="subtabs">
      ${MASTERDATA_SUBTABS.map(
        (sub) => `<button class="subtab-btn${masterDataSubtab === sub.id ? " active" : ""}" data-sub="${sub.id}">${esc(t(sub.labelKey))}</button>`
      ).join("")}
    </div>
    <div id="masterdata-section"></div>
  `;
  view.querySelectorAll("[data-sub]").forEach((btn) =>
    btn.addEventListener("click", () => {
      masterDataSubtab = btn.dataset.sub;
      viewMasterData();
    })
  );

  const section = document.getElementById("masterdata-section");
  if (masterDataSubtab === "suppliers") await renderSupplierAssessmentSection(section);
  else await renderMaterialDossierSection(section);
}

async function renderMaterialDossierSection(section) {
  const materials = await getMaterials(true);

  section.innerHTML = `
    <div class="card">
      <div class="field"><label>${esc(t("common.material"))}</label>
        ${codeSearchHtml("dossier-material", t("common.searchByCodeOrName"))}
      </div>
      ${exportBarHtml("dossier-export", { withPeriod: false })}
      ${importSectionHtml("masterdata-specs-import", "/api/specs/import-template")}
    </div>
    <div id="dossier-body"></div>
  `;

  const body = document.getElementById("dossier-body");
  let rmsExpanded = false;
  let currentCode = null;

  wireExportBar(
    "dossier-export",
    () => (currentCode ? `master-data/${encodeURIComponent(currentCode)}` : null),
    { withPeriod: false, filenamePrefix: "master-data" }
  );
  wireImportSection("masterdata-specs-import", "/api/specs/import", () => currentCode && loadDossier(currentCode));

  async function loadDossier(code) {
    currentCode = code;
    body.innerHTML = loadingState();
    const d = await api.get(`/api/materials/${encodeURIComponent(code)}/dossier`);
    // The user may have switched subtabs/materials while this was in flight —
    // if this section's DOM is gone (or a newer load has since started), bail.
    if (!body.isConnected || currentCode !== code) return;

    const namesHtml = d.names.length
      ? `<div class="table-scroll"><table class="data-table">
          <thead><tr><th>${esc(t("common.name"))}</th><th>${esc(t("masterdata.timesReceived"))}</th><th>${esc(t("masterdata.lastReceived"))}</th></tr></thead>
          <tbody>${d.names.map((n) => `<tr><td>${esc(n.name)}</td><td>${n.count}</td><td>${fmtDate(n.last_received_at)}</td></tr>`).join("")}</tbody>
        </table></div>`
      : `<div class="small muted">${esc(t("masterdata.noReceivingHistory"))}</div>`;

    const specVersionOptions = d.specs
      .map((s) => `<option value="${s.version}">v${s.version} — ${esc(s.title)} (${esc(t(`status.${s.status}`))})</option>`)
      .join("");
    const specsHtml = d.specs.length
      ? `<div class="field" style="max-width:320px"><label>${esc(t("common.version"))}</label><select id="dossier-spec-version">${specVersionOptions}</select></div>
         <div id="dossier-spec-detail" style="margin-top:8px"></div>`
      : `<div class="small muted">${esc(t("masterdata.noSpecsCreated"))}</div>`;

    const supplierRows = d.metrics.by_supplier
      .map(
        (s) => `
        <tr>
          <td>${esc(s.supplier_name)} <span class="mono small muted">(${esc(s.supplier_code)})</span></td>
          <td>${s.imports}</td>
          <td>${s.approved}</td>
          <td>${s.rejected}</td>
          <td>${s.partial}</td>
          <td>${fmtPct(s.pass_rate)}</td>
        </tr>`
      )
      .join("");

    body.innerHTML = `
      <div class="card">
        <h3>${esc(d.material.code)} — ${esc(d.material.name)}</h3>
        <div class="small muted">${esc(d.material.unit)}${d.material.type_code ? ` · ${esc(d.material.type_code)}${d.material.subtype_code ? "/" + esc(d.material.subtype_code) : ""}` : ""}</div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:10px">${esc(t("masterdata.metrics"))}</h3>
        <div class="stat-grid">
          <div class="stat-tile"><div class="stat-label">${esc(t("masterdata.totalImports"))}</div><div class="stat-value">${d.metrics.overall.imports}</div></div>
          <div class="stat-tile"><div class="stat-label">${esc(t("masterdata.approved"))}</div><div class="stat-value good">${d.metrics.overall.approved}</div></div>
          <div class="stat-tile"><div class="stat-label">${esc(t("masterdata.rejected"))}</div><div class="stat-value bad">${d.metrics.overall.rejected}</div></div>
          <div class="stat-tile"><div class="stat-label">${esc(t("masterdata.partial"))}</div><div class="stat-value">${d.metrics.overall.partial}</div></div>
          <div class="stat-tile"><div class="stat-label">${esc(t("masterdata.pending"))}</div><div class="stat-value">${d.metrics.overall.pending}</div></div>
          <div class="stat-tile"><div class="stat-label">${esc(t("masterdata.passRate"))}</div><div class="stat-value">${fmtPct(d.metrics.overall.pass_rate)}</div></div>
        </div>
        <div class="small muted" style="margin-top:8px">${esc(t("masterdata.passRateNote"))}</div>
        ${
          supplierRows
            ? `<div class="table-scroll" style="margin-top:12px"><table class="data-table">
                <thead><tr><th>${esc(t("common.supplier"))}</th><th>${esc(t("masterdata.totalImports"))}</th><th>${esc(t("masterdata.approved"))}</th><th>${esc(t("masterdata.rejected"))}</th><th>${esc(t("masterdata.partial"))}</th><th>${esc(t("masterdata.passRate"))}</th></tr></thead>
                <tbody>${supplierRows}</tbody>
              </table></div>`
            : ""
        }
      </div>

      <div class="card">
        <h3 style="margin-bottom:10px">${esc(t("masterdata.namesHeading"))}</h3>
        ${namesHtml}
      </div>

      <div class="card">
        <h3 style="margin-bottom:10px">${esc(t("specs.title"))}</h3>
        ${specsHtml}
      </div>

      <div class="card">
        <h3 style="margin-bottom:10px">${esc(t("masterdata.rmfHeading"))}</h3>
        <div id="dossier-rmf">${d.rmf.length ? d.rmf.map(dossierImportEntryHtml).join("") : `<div class="small muted">${esc(t("masterdata.noNovelImports"))}</div>`}</div>
      </div>

      <div class="card">
        <button type="button" class="btn ghost sm" id="dossier-show-rms">${rmsExpanded ? esc(t("masterdata.hideRmss")) : esc(t("masterdata.showAllRmss", { n: d.rms.length }))}</button>
        <div id="dossier-rms" ${rmsExpanded ? "" : "hidden"} style="margin-top:10px">${d.rms.length ? d.rms.map(dossierImportEntryHtml).join("") : `<div class="small muted">${esc(t("masterdata.noRepeatImports"))}</div>`}</div>
      </div>
    `;

    const reload = () => loadDossier(currentCode);
    wireDossierImportEntries(document.getElementById("dossier-rmf"), reload);
    wireDossierImportEntries(document.getElementById("dossier-rms"), reload);

    document.getElementById("dossier-show-rms")?.addEventListener("click", (e) => {
      const el = document.getElementById("dossier-rms");
      el.hidden = !el.hidden;
      rmsExpanded = !el.hidden;
      e.target.textContent = el.hidden ? t("masterdata.showAllRmss", { n: d.rms.length }) : t("masterdata.hideRmss");
    });

    const versionSelect = document.getElementById("dossier-spec-version");
    if (versionSelect) {
      const detailEl = document.getElementById("dossier-spec-detail");
      function renderSpecDetail() {
        const spec = d.specs.find((s) => String(s.version) === versionSelect.value);
        detailEl.innerHTML = spec
          ? `<div class="small muted" style="margin-bottom:6px">${esc(spec.notes || "")}</div>
             <div class="table-scroll"><table class="data-table">
               <thead><tr><th>${esc(t("results.parameter"))}</th><th>${esc(t("results.method"))}</th><th>${esc(t("masterdata.specColumn"))}</th></tr></thead>
               <tbody>${spec.parameters
                 .map((p) => `<tr><td>${esc(p.parameter_name)}</td><td>${esc(p.method || "—")}</td><td>${esc(paramSpecHint(p))}</td></tr>`)
                 .join("")}</tbody>
             </table></div>`
          : "";
      }
      versionSelect.addEventListener("change", renderSpecDetail);
      renderSpecDetail();
    }
  }

  const input = wireCodeSearch("dossier-material", materials, (code) => {
    rmsExpanded = false;
    loadDossier(code);
  });

  if (materials.length) {
    input.value = materials[0].code;
    await loadDossier(materials[0].code);
  } else {
    body.innerHTML = emptyState(icons.navMasterdata, t("common.noneYet"));
  }
}

function ratingStarsHtml(rating) {
  const full = "★".repeat(rating.stars);
  const empty = "☆".repeat(5 - rating.stars);
  return `<span style="letter-spacing:2px; color:var(--accent)">${full}${empty}</span> <span class="small muted">${esc(t(`suppliers.rating.${rating.label}`))}${rating.low_volume ? " · " + esc(t("suppliers.limitedHistory")) : ""}</span>`;
}

async function renderSupplierAssessmentSection(section) {
  const suppliers = await getSuppliers(true);

  section.innerHTML = `
    <div class="card">
      <div class="field"><label>${esc(t("common.supplier"))}</label>
        ${codeSearchHtml("supplier-search", t("common.searchByCodeOrName"))}
      </div>
      ${exportBarHtml("suppliers-export", { withPeriod: false })}
    </div>
    <div id="supplier-body"></div>
  `;

  const body = document.getElementById("supplier-body");
  let currentSupplierCode = null;

  wireExportBar("suppliers-export", "suppliers", { withPeriod: false, filenamePrefix: "suppliers" });

  async function loadAssessment(code) {
    currentSupplierCode = code;
    body.innerHTML = loadingState();
    const a = await api.get(`/api/suppliers/${encodeURIComponent(code)}/assessment`);
    if (!body.isConnected || currentSupplierCode !== code) return;

    const codeRows = a.codes
      .map(
        (c) => `
        <tr${a.best_code && c.material_code === a.best_code.material_code ? ' style="font-weight:600"' : ""}>
          <td>${esc(c.material_code)}${a.best_code && c.material_code === a.best_code.material_code ? ` <span class="badge repeat">${esc(t("suppliers.best"))}</span>` : ""}</td>
          <td>${esc(c.material_name || "—")}</td>
          <td>${c.imports}</td>
          <td>${c.approved}</td>
          <td>${c.rejected}</td>
          <td>${c.partial}</td>
          <td>${fmtPct(c.pass_rate)}</td>
        </tr>`
      )
      .join("");

    body.innerHTML = `
      <div class="card">
        <h3>${esc(a.supplier.name)} <span class="mono small muted">(${esc(a.supplier.code)})</span></h3>
        <div style="margin-top:6px">${ratingStarsHtml(a.rating)}</div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:10px">${esc(t("suppliers.overallPerformance"))}</h3>
        <div class="stat-grid">
          <div class="stat-tile"><div class="stat-label">${esc(t("masterdata.totalImports"))}</div><div class="stat-value">${a.overall.imports}</div></div>
          <div class="stat-tile"><div class="stat-label">${esc(t("suppliers.codesSupplied"))}</div><div class="stat-value">${a.overall.distinct_codes}</div></div>
          <div class="stat-tile"><div class="stat-label">${esc(t("masterdata.approved"))}</div><div class="stat-value good">${a.overall.approved}</div></div>
          <div class="stat-tile"><div class="stat-label">${esc(t("masterdata.rejected"))}</div><div class="stat-value bad">${a.overall.rejected}</div></div>
          <div class="stat-tile"><div class="stat-label">${esc(t("masterdata.partial"))}</div><div class="stat-value">${a.overall.partial}</div></div>
          <div class="stat-tile"><div class="stat-label">${esc(t("masterdata.passRate"))}</div><div class="stat-value">${fmtPct(a.overall.pass_rate)}</div></div>
        </div>
        ${
          a.best_code
            ? `<div class="small muted" style="margin-top:8px">${t("suppliers.bestCodeProvided", { code: bdi(a.best_code.material_code), name: bdi(a.best_code.material_name || "—"), rate: esc(fmtPct(a.best_code.pass_rate)) })}</div>`
            : `<div class="small muted" style="margin-top:8px">${esc(t("suppliers.noDecidedYet"))}</div>`
        }
      </div>

      <div class="card">
        <h3 style="margin-bottom:10px">${esc(t("suppliers.codesSuppliedHeading"))}</h3>
        ${
          codeRows
            ? `<div class="table-scroll"><table class="data-table">
                <thead><tr><th>${esc(t("common.code"))}</th><th>${esc(t("common.name"))}</th><th>${esc(t("masterdata.totalImports"))}</th><th>${esc(t("masterdata.approved"))}</th><th>${esc(t("masterdata.rejected"))}</th><th>${esc(t("masterdata.partial"))}</th><th>${esc(t("masterdata.passRate"))}</th></tr></thead>
                <tbody>${codeRows}</tbody>
              </table></div>`
            : `<div class="small muted">${esc(t("suppliers.noCodedHistory"))}</div>`
        }
      </div>
    `;
  }

  const input = wireCodeSearch("supplier-search", suppliers, loadAssessment);

  if (suppliers.length) {
    input.value = suppliers[0].code;
    await loadAssessment(suppliers[0].code);
  } else {
    body.innerHTML = emptyState(icons.warehouse, t("suppliers.noSuppliersYet"));
  }
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
    } else if (role === "quality" && tab === "masterdata") {
      lastRouteArgs = { fn: viewMasterData };
      await viewMasterData();
    } else if (tab === "suppliers") {
      lastRouteArgs = { fn: viewSuppliers };
      await viewSuppliers();
    } else if (role === "warehouse" && tab === "supplierassessment") {
      lastRouteArgs = { fn: viewSupplierAssessment };
      await viewSupplierAssessment();
    }
  } catch (err) {
    document.getElementById("view").innerHTML = errorState(t("error.screenLoadFailed", { message: err.message }));
  }
}

function refreshCurrentView() {
  if (lastRouteArgs) lastRouteArgs.args ? lastRouteArgs.fn(lastRouteArgs.args) : lastRouteArgs.fn();
  refreshNotifCount();
  refreshTodoCount();
}

window.addEventListener("hashchange", () => {
  renderTopbar();
  renderView();
});

document.getElementById("notif-btn").addEventListener("click", toggleNotifPanel);

async function boot() {
  applyDocumentDirection();
  try {
    session = await api.get("/api/auth/me");
  } catch {
    location.href = "/";
    return;
  }
  if (!location.hash || !location.hash.startsWith(`#${session.role}/`)) {
    location.hash = `#${session.role}/${ROUTES[session.role][0].id}`;
  }
  renderTopbar();
  renderView();
  refreshNotifCount();
  initPush();
  setInterval(refreshNotifCount, 20000);
  setInterval(refreshTodoCount, 20000);
  // Polling backstop for "refresh when a receipt is registered" — works
  // even when push permission was never granted. Push (above) additionally
  // triggers an instant refresh via initPush()'s service-worker message
  // listener, so a subscribed device doesn't have to wait for this tick.
  setInterval(() => {
    const tab = currentRoute();
    if (tab === "todo" || tab === "history") refreshCurrentView();
  }, 20000);
}

boot();
