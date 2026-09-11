import { hashPassword } from "../auth";
import { error, json } from "../http";
import type { Env, Role } from "../types";

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

// ---------------------------------------------------------------- users
//
// Account management for the real warehouse/quality logins — the only
// way accounts get created, since there's no public sign-up. Passwords
// never leave this file in plaintext beyond the request that sets them.

interface UserListRow {
  id: number;
  username: string;
  role: Role;
  display_name: string;
  active: number;
  created_at: string;
}

export async function adminListUsers(request: Request, env: Env): Promise<Response> {
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;
  const rows = await env.DB.prepare(
    "SELECT id, username, role, display_name, active, created_at FROM users ORDER BY role, username"
  ).all<UserListRow>();
  return json(rows.results ?? []);
}

export async function adminCreateUser(request: Request, env: Env): Promise<Response> {
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;
  const input = await request.json<{ username?: string; password?: string; role?: string; display_name?: string }>();
  const username = (input.username ?? "").trim();
  const password = input.password ?? "";
  const role = input.role;
  const displayName = (input.display_name ?? "").trim();
  if (!username) return error("Username is required");
  if (password.length < 8) return error("Password must be at least 8 characters");
  if (role !== "warehouse" && role !== "quality") return error("Role must be 'warehouse' or 'quality'");
  if (!displayName) return error("Display name is required");

  const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  if (existing) return error("That username is already taken", 409);

  const { hash, salt } = await hashPassword(password);
  await env.DB.prepare(
    "INSERT INTO users (username, password_hash, password_salt, role, display_name) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(username, hash, salt, role, displayName)
    .run();
  return json({ ok: true }, 201);
}

export async function adminResetPassword(request: Request, env: Env, userId: number): Promise<Response> {
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;
  const input = await request.json<{ password?: string }>();
  const password = input.password ?? "";
  if (password.length < 8) return error("Password must be at least 8 characters");
  const { hash, salt } = await hashPassword(password);
  const res = await env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?")
    .bind(hash, salt, userId)
    .run();
  if (res.meta.changes === 0) return error("User not found", 404);
  return json({ ok: true });
}

export async function adminSetUserActive(request: Request, env: Env, userId: number, active: boolean): Promise<Response> {
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;
  const res = await env.DB.prepare("UPDATE users SET active = ? WHERE id = ?")
    .bind(active ? 1 : 0, userId)
    .run();
  if (res.meta.changes === 0) return error("User not found", 404);
  // Deactivating should also kill any live sessions immediately, not just
  // block future logins.
  if (!active) await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  return json({ ok: true });
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
  :root { --bg: #0a0d1a; --ink: #eef0fb; --ink-muted: #9aa2c7; }
  @media (prefers-color-scheme: light) { :root { --bg: #f4f5fb; --ink: #171a2b; --ink-muted: #565b7a; } }
  body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--ink);
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
  .card { max-width: 420px; text-align: center; }
  h1 { font-size: 1.25rem; margin-bottom: 8px; }
  p { color: var(--ink-muted); line-height: 1.5; }
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
  :root {
    --bg: #0a0d1a; --surface: #141830; --surface-2: rgba(30,35,60,0.6);
    --ink: #eef0fb; --ink-muted: #9aa2c7; --ink-faint: #666f99;
    --rule: rgba(150,160,255,0.16); --rule-strong: rgba(150,160,255,0.3);
    --accent: #7c6aff; --accent-ink: #ffffff;
    --good: #4fe3ab; --good-bg: rgba(79,227,171,0.14);
    --bad: #ff7aa0; --bad-bg: rgba(255,122,160,0.14);
    --shadow-card: 0 1px 0 rgba(255,255,255,0.05) inset, 0 10px 28px -14px rgba(0,0,0,0.7);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f4f5fb; --surface: #ffffff; --surface-2: #f1f2f5;
      --ink: #171a2b; --ink-muted: #565b7a; --ink-faint: #8b90b0;
      --rule: rgba(80,70,160,0.14); --rule-strong: rgba(80,70,160,0.24);
      --accent: #6552e0; --accent-ink: #ffffff;
      --good: #21855c; --good-bg: #e2f5ec;
      --bad: #c22e5a; --bad-bg: #fce8ee;
      --shadow-card: 0 1px 2px rgba(20,20,40,0.04), 0 4px 12px -4px rgba(20,20,40,0.08);
    }
  }
  body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--ink);
         display: flex; flex-direction: column; align-items: center; min-height: 100vh; margin: 0; padding: 40px 24px; gap: 20px; }
  .card { max-width: 420px; width: 100%; background: var(--surface); border: 1px solid var(--rule); border-radius: 12px;
          padding: 28px; box-shadow: var(--shadow-card); }
  h1 { font-size: 1.15rem; margin: 0 0 4px; }
  .sub { color: var(--ink-muted); font-size: 0.85rem; margin: 0 0 20px; }
  .status-row { display: flex; align-items: center; justify-content: space-between;
                padding: 14px 16px; border-radius: 8px; background: var(--surface-2); margin-bottom: 16px; }
  .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 0.8rem; font-weight: 600; }
  .pill.active { background: var(--good-bg); color: var(--good); }
  .pill.suspended { background: var(--bad-bg); color: var(--bad); }
  button { width: 100%; padding: 11px; border-radius: 8px; border: none; font-size: 0.95rem; font-weight: 600;
           cursor: pointer; color: #fff; }
  button.suspend { background: var(--bad); }
  button.activate { background: var(--good); }
  button.save { background: var(--accent); color: var(--accent-ink); margin-top: 4px; }
  button:disabled { opacity: 0.6; cursor: default; }
  .msg { margin-top: 12px; font-size: 0.85rem; color: var(--ink-muted); min-height: 1.2em; }
  label { display: block; font-size: 0.8rem; font-weight: 600; color: var(--ink-muted); margin: 14px 0 6px; }
  label:first-of-type { margin-top: 0; }
  input[type="text"], select { width: 100%; box-sizing: border-box; padding: 9px 10px; border-radius: 6px;
                        border: 1px solid var(--rule-strong); background: var(--surface); color: var(--ink);
                        font-size: 0.9rem; font-family: inherit; }
  .user-row { display: flex; align-items: center; justify-content: space-between; gap: 8px;
              padding: 8px 0; border-bottom: 1px solid var(--rule); font-size: 0.85rem; }
  .user-row:last-child { border-bottom: none; }
  .user-row .who { display: flex; flex-direction: column; }
  .user-row .who b { font-size: 0.88rem; }
  .user-row .who span { color: var(--ink-muted); font-size: 0.75rem; }
  .user-row button { width: auto; padding: 5px 10px; font-size: 0.78rem; background: var(--surface-2); color: var(--ink-muted); }
  .user-row button.deactivate { background: var(--bad-bg); color: var(--bad); }
  .user-row button.reactivate { background: var(--good-bg); color: var(--good); }
  .user-empty { color: var(--ink-faint); font-size: 0.82rem; padding: 8px 0; }
  .logo-row { display: flex; align-items: center; gap: 14px; }
  .logo-preview { width: 64px; height: 64px; border-radius: 8px; border: 1px solid var(--rule); background: var(--surface-2);
                   display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
  .logo-preview img { max-width: 100%; max-height: 100%; }
  .logo-preview span { font-size: 0.7rem; color: var(--ink-faint); text-align: center; }
  input[type="file"] { font-size: 0.82rem; color: var(--ink); }
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

  <div class="card">
    <h1>Accounts</h1>
    <p class="sub">Warehouse and Quality sign in with these — there's no public sign-up.</p>
    <div id="user-list"></div>
    <label for="new-username">Username</label>
    <input type="text" id="new-username" autocomplete="off" />
    <label for="new-display-name">Display name</label>
    <input type="text" id="new-display-name" autocomplete="off" />
    <label for="new-role">Role</label>
    <select id="new-role">
      <option value="warehouse">Warehouse</option>
      <option value="quality">Quality</option>
    </select>
    <label for="new-password">Password (min 8 characters)</label>
    <input type="text" id="new-password" autocomplete="off" />
    <button class="save" id="user-create">Create account</button>
    <div class="msg" id="user-msg"></div>
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

    // ---- accounts ----
    const userList = document.getElementById('user-list');
    const userMsg = document.getElementById('user-msg');
    const newUsername = document.getElementById('new-username');
    const newDisplayName = document.getElementById('new-display-name');
    const newRole = document.getElementById('new-role');
    const newPassword = document.getElementById('new-password');
    const userCreateBtn = document.getElementById('user-create');

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function loadUsers() {
      const res = await fetch('/admin/api/users');
      const rows = await res.json();
      if (!rows.length) {
        userList.innerHTML = '<div class="user-empty">No accounts yet.</div>';
        return;
      }
      userList.innerHTML = rows.map((u) => \`
        <div class="user-row" data-id="\${u.id}">
          <div class="who">
            <b>\${esc(u.display_name)} — \${esc(u.username)}</b>
            <span>\${u.role}\${u.active ? '' : ' · deactivated'}</span>
          </div>
          <div style="display:flex;gap:6px;">
            <button data-action="reset">Reset password</button>
            <button data-action="toggle" class="\${u.active ? 'deactivate' : 'reactivate'}">\${u.active ? 'Deactivate' : 'Reactivate'}</button>
          </div>
        </div>\`).join('');

      userList.querySelectorAll('[data-action="reset"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.closest('.user-row').dataset.id;
          const password = prompt('New password (min 8 characters):');
          if (!password) return;
          try {
            const res = await fetch('/admin/api/users/' + id + '/password', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed');
            userMsg.textContent = 'Password reset.';
          } catch (err) { userMsg.textContent = err.message; }
        });
      });
      userList.querySelectorAll('[data-action="toggle"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.user-row');
          const id = row.dataset.id;
          const reactivating = btn.classList.contains('reactivate');
          try {
            const res = await fetch('/admin/api/users/' + id + '/' + (reactivating ? 'reactivate' : 'deactivate'), { method: 'POST' });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed');
            await loadUsers();
          } catch (err) { userMsg.textContent = err.message; }
        });
      });
    }

    userCreateBtn.addEventListener('click', async () => {
      userCreateBtn.disabled = true;
      try {
        const res = await fetch('/admin/api/users', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: newUsername.value.trim(),
            display_name: newDisplayName.value.trim(),
            role: newRole.value,
            password: newPassword.value,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        newUsername.value = '';
        newDisplayName.value = '';
        newPassword.value = '';
        userMsg.textContent = 'Account created.';
        await loadUsers();
      } catch (err) {
        userMsg.textContent = err.message;
      } finally {
        userCreateBtn.disabled = false;
      }
    });

    loadUsers().catch((err) => { userMsg.textContent = err.message; });
  </script>
</body></html>`;
