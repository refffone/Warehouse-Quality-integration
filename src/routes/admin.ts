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
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
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
  button:disabled { opacity: 0.6; cursor: default; }
  .msg { margin-top: 12px; font-size: 0.85rem; color: #8a879c; min-height: 1.2em; }
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
    <div class="msg" id="msg"></div>
  </div>
  <script>
    const pill = document.getElementById('pill');
    const btn = document.getElementById('toggle-btn');
    const msg = document.getElementById('msg');
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

    async function load() {
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
        msg.textContent = 'Updated just now.';
      } catch (err) {
        msg.textContent = err.message;
        btn.disabled = false;
      }
    });

    load().catch((err) => { msg.textContent = err.message; });
  </script>
</body></html>`;
