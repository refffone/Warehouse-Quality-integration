import { error, json } from "../http";
import type { Env } from "../types";

export type ServiceStatus = "active" | "suspended";

// ---------------------------------------------------------------- auth
//
// Deliberately separate from the app's X-Role stand-in: that's a header
// the client sets itself and anyone can spoof from devtools. This checks
// a real secret (ADMIN_PASSWORD, a Worker secret — never in source, never
// sent to the frontend) via HTTP Basic Auth, which the browser prompts
// for natively and then caches per-origin for the rest of the session.

function parseBasicAuth(request: Request): { user: string; pass: string } | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(":");
    if (sep === -1) return null;
    return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

/** Returns a 401 challenge if the caller isn't authenticated as the owner,
 *  or null if they are — call at the top of every /admin* handler. */
export function requireAdminAuth(request: Request, env: Env): Response | null {
  const creds = parseBasicAuth(request);
  if (!creds || !env.ADMIN_PASSWORD || creds.pass !== env.ADMIN_PASSWORD) {
    return new Response("Admin access required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Admin"' },
    });
  }
  return null;
}

// ---------------------------------------------------------------- service status

export async function getServiceStatus(env: Env): Promise<ServiceStatus> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'service_status'").first<{
    value: string;
  }>();
  return row?.value === "suspended" ? "suspended" : "active";
}

async function setServiceStatus(env: Env, status: ServiceStatus): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('service_status', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  )
    .bind(status)
    .run();
}

export async function adminGetStatus(request: Request, env: Env): Promise<Response> {
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;
  return json({ status: await getServiceStatus(env) });
}

export async function adminSetStatus(request: Request, env: Env): Promise<Response> {
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;
  const input = await request.json<{ status?: string }>();
  if (input.status !== "active" && input.status !== "suspended") {
    return error("status must be 'active' or 'suspended'");
  }
  await setServiceStatus(env, input.status);
  return json({ status: input.status });
}

// ---------------------------------------------------------------- branding
//
// The identity that appears on exported reports (PDF/Excel) — deliberately
// separate from the app's own visual identity (Fraunces/IBM Plex, the
// "Warehouse · Quality" wordmark), which stays the app owner's brand.
// This is the client's own company name/logo, only ever used inside
// documents they export, so it belongs here rather than in app.js.

export interface Branding {
  company_name: string;
  logo_data_url: string | null;
}

const MAX_LOGO_BYTES = 400 * 1024; // raw image bytes; base64 in the DB runs ~1.33x this

export async function getBranding(env: Env): Promise<Branding> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM app_settings WHERE key IN ('company_name', 'company_logo')"
  ).all<{ key: string; value: string }>();
  const map = new Map((rows.results ?? []).map((r) => [r.key, r.value]));
  return {
    company_name: map.get("company_name") ?? "",
    logo_data_url: map.get("company_logo") || null,
  };
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  )
    .bind(key, value)
    .run();
}

export async function adminGetBranding(request: Request, env: Env): Promise<Response> {
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;
  return json(await getBranding(env));
}

export async function adminSetBranding(request: Request, env: Env): Promise<Response> {
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;
  const input = await request.json<{ company_name?: string; logo_data_url?: string | null }>();

  if (input.company_name !== undefined) {
    await setSetting(env, "company_name", input.company_name.slice(0, 200));
  }
  if (input.logo_data_url !== undefined) {
    if (!input.logo_data_url) {
      await setSetting(env, "company_logo", "");
    } else {
      if (!/^data:image\/(png|jpeg);base64,/.test(input.logo_data_url)) {
        return error("Logo must be a PNG or JPEG image");
      }
      const approxBytes = (input.logo_data_url.length * 3) / 4;
      if (approxBytes > MAX_LOGO_BYTES) {
        return error("Logo is too large — please use an image under 400KB");
      }
      await setSetting(env, "company_logo", input.logo_data_url);
    }
  }
  return json(await getBranding(env));
}

/** What every non-admin request sees while suspended — an API call gets a
 *  clean JSON error the frontend's existing toast handling already knows
 *  how to show; a page load gets a plain, unmissable notice instead of a
 *  broken app. */
export function suspendedResponse(pathname: string): Response {
  if (pathname.startsWith("/api/")) {
    return error("Service suspended — contact your provider to restore access", 403);
  }
  return new Response(SUSPENDED_HTML, {
    status: 403,
    headers: { "content-type": "text/html;charset=utf-8" },
  });
}

const SUSPENDED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Service Suspended</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f4f3f7; color: #221f2b;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
  .card { max-width: 420px; text-align: center; }
  h1 { font-size: 1.25rem; margin-bottom: 8px; }
  p { color: #63607a; line-height: 1.5; }
</style></head>
<body><div class="card">
  <h1>Service Suspended</h1>
  <p>This account's access has been paused. Please contact your provider to restore service.</p>
</div></body></html>`;

/** Owner-only control page: current status + a toggle. Deliberately not
 *  part of the app's own frontend (no shared JS/CSS, no role system) —
 *  this must keep working even if the rest of the app is broken. */
export function adminPage(request: Request, env: Env): Response {
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;
  return new Response(ADMIN_HTML, { headers: { "content-type": "text/html;charset=utf-8" } });
}

const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Admin</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f4f3f7; color: #221f2b;
         display: flex; flex-direction: column; align-items: center; min-height: 100vh; margin: 0; padding: 40px 24px; gap: 20px; }
  .card { max-width: 420px; width: 100%; background: #fff; border: 1px solid #e3e1ec; border-radius: 12px;
          padding: 28px; box-shadow: 0 4px 16px rgba(30,20,60,0.06); }
  h1 { font-size: 1.15rem; margin: 0 0 4px; }
  .sub { color: #8a879c; font-size: 0.85rem; margin: 0 0 20px; }
  .status-row { display: flex; align-items: center; justify-content: space-between;
                padding: 14px 16px; border-radius: 8px; background: #f4f3f7; margin-bottom: 16px; }
  .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 0.8rem; font-weight: 600; }
  .pill.active { background: #dcf3e6; color: #1c6b45; }
  .pill.suspended { background: #fadfe3; color: #9c1f38; }
  button { width: 100%; padding: 11px; border-radius: 8px; border: none; font-size: 0.95rem; font-weight: 600;
           cursor: pointer; color: #fff; }
  button.suspend { background: #b3273f; }
  button.activate { background: #1c6b45; }
  button.save { background: #3d3557; margin-top: 4px; }
  button:disabled { opacity: 0.6; cursor: default; }
  .msg { margin-top: 12px; font-size: 0.85rem; color: #8a879c; min-height: 1.2em; }
  label { display: block; font-size: 0.8rem; font-weight: 600; color: #4d4a5f; margin: 14px 0 6px; }
  label:first-of-type { margin-top: 0; }
  input[type="text"] { width: 100%; box-sizing: border-box; padding: 9px 10px; border-radius: 6px;
                        border: 1px solid #d8d5e3; font-size: 0.9rem; }
  .logo-row { display: flex; align-items: center; gap: 14px; }
  .logo-preview { width: 64px; height: 64px; border-radius: 8px; border: 1px solid #e3e1ec; background: #f4f3f7;
                   display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
  .logo-preview img { max-width: 100%; max-height: 100%; }
  .logo-preview span { font-size: 0.7rem; color: #b3b0c2; text-align: center; }
  input[type="file"] { font-size: 0.82rem; }
</style></head>
<body>
  <div class="card">
    <h1>Service Control</h1>
    <p class="sub">Owner only. Toggling this affects every user immediately.</p>
    <div class="status-row">
      <span>Status</span>
      <span id="pill" class="pill">…</span>
    </div>
    <button id="toggle-btn" disabled>Loading…</button>
    <div class="msg" id="status-msg"></div>
  </div>

  <div class="card">
    <h1>Report Branding</h1>
    <p class="sub">Used on exported PDF/Excel reports only — separate from the app's own look.</p>
    <label for="company-name">Company name</label>
    <input type="text" id="company-name" placeholder="Acme Chemicals Ltd." maxlength="200" />
    <label>Logo</label>
    <div class="logo-row">
      <div class="logo-preview" id="logo-preview"><span>No logo</span></div>
      <input type="file" id="logo-file" accept="image/png,image/jpeg" />
    </div>
    <button class="save" id="branding-save">Save branding</button>
    <div class="msg" id="branding-msg"></div>
  </div>

  <script>
    const pill = document.getElementById('pill');
    const btn = document.getElementById('toggle-btn');
    const statusMsg = document.getElementById('status-msg');
    let current = null;

    function render() {
      pill.textContent = current;
      pill.className = 'pill ' + current;
      if (current === 'active') {
        btn.textContent = 'Suspend service';
        btn.className = 'suspend';
      } else {
        btn.textContent = 'Reactivate service';
        btn.className = 'activate';
      }
      btn.disabled = false;
    }

    async function loadStatus() {
      const res = await fetch('/admin/api/status');
      const body = await res.json();
      current = body.status;
      render();
    }

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const next = current === 'active' ? 'suspended' : 'active';
      try {
        const res = await fetch('/admin/api/status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: next }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        current = next;
        render();
        statusMsg.textContent = 'Updated just now.';
      } catch (err) {
        statusMsg.textContent = err.message;
        btn.disabled = false;
      }
    });

    // ---- branding ----
    const nameInput = document.getElementById('company-name');
    const fileInput = document.getElementById('logo-file');
    const preview = document.getElementById('logo-preview');
    const saveBtn = document.getElementById('branding-save');
    const brandingMsg = document.getElementById('branding-msg');
    let pendingLogoDataUrl = undefined; // undefined = unchanged, null = cleared, string = new

    function showPreview(dataUrl) {
      preview.innerHTML = dataUrl ? '<img src="' + dataUrl + '" />' : '<span>No logo</span>';
    }

    async function loadBranding() {
      const res = await fetch('/admin/api/branding');
      const body = await res.json();
      nameInput.value = body.company_name || '';
      showPreview(body.logo_data_url);
    }

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      if (file.size > 400 * 1024) {
        brandingMsg.textContent = 'Logo is too large — please use an image under 400KB.';
        fileInput.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        pendingLogoDataUrl = reader.result;
        showPreview(pendingLogoDataUrl);
      };
      reader.readAsDataURL(file);
    });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        const body = { company_name: nameInput.value };
        if (pendingLogoDataUrl !== undefined) body.logo_data_url = pendingLogoDataUrl;
        const res = await fetch('/admin/api/branding', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        pendingLogoDataUrl = undefined;
        brandingMsg.textContent = 'Saved just now.';
      } catch (err) {
        brandingMsg.textContent = err.message;
      } finally {
        saveBtn.disabled = false;
      }
    });

    loadStatus().catch((err) => { statusMsg.textContent = err.message; });
    loadBranding().catch((err) => { brandingMsg.textContent = err.message; });
  </script>
</body></html>`;
