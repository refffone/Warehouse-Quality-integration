import { getSession } from "../auth";
import type { Env, Role } from "../types";

// Server-rendered entry pages (landing + the two role-locked logins) —
// deliberately separate documents from the SPA shell (public/index.html),
// the same way src/routes/admin.ts's pages are: they must render and work
// before any session exists, so they carry their own minimal HTML/CSS/JS
// rather than depending on app.js/i18n.js/api.js.

const SHARED_HEAD = `
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #f6f5fa; color: #211f2e; font-family: 'IBM Plex Sans', system-ui, sans-serif;
      padding: 24px;
    }
    .brand { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 28px; }
    .brand .mark { color: #6d5fd1; font-size: 1.4rem; }
    .brand .name { font-family: 'Fraunces', Georgia, serif; font-style: italic; font-weight: 500; font-size: 1.3rem; }
    .brand .name em { color: #6d5fd1; font-style: normal; }
  </style>`;

export function landingPage(): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Warehouse · Quality</title>${SHARED_HEAD}
<style>
  .picker { display: flex; flex-direction: column; align-items: center; }
  .cards { display: flex; gap: 20px; flex-wrap: wrap; justify-content: center; }
  a.card {
    width: 220px; padding: 32px 24px; background: #fff; border: 1px solid #e4e1ee; border-radius: 16px;
    box-shadow: 0 1px 2px rgba(109,95,209,0.06), 0 8px 24px -16px rgba(33,31,46,0.18);
    text-decoration: none; color: #211f2e; text-align: center; transition: transform 0.12s, box-shadow 0.12s;
  }
  a.card:hover { transform: translateY(-2px); box-shadow: 0 4px 8px rgba(109,95,209,0.1), 0 12px 28px -14px rgba(33,31,46,0.24); }
  a.card .icon { font-size: 2rem; margin-bottom: 12px; }
  a.card h2 { font-family: 'Fraunces', Georgia, serif; font-weight: 500; font-size: 1.15rem; margin: 0 0 6px; }
  a.card p { margin: 0; color: #726f80; font-size: 0.85rem; }
</style>
</head>
<body>
  <div class="picker">
    <div class="brand"><span class="mark">✦</span><span class="name">Warehouse <em>·</em> Quality</span></div>
    <div class="cards">
      <a class="card" href="/login/warehouse">
        <div class="icon">📦</div>
        <h2>Warehouse</h2>
        <p>Receive materials, track incoming batches</p>
      </a>
      <a class="card" href="/login/quality">
        <div class="icon">🧪</div>
        <h2>Quality</h2>
        <p>Test, decide, and manage master data</p>
      </a>
    </div>
  </div>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

export function loginPage(role: Role): Response {
  const label = role === "warehouse" ? "Warehouse" : "Quality";
  const icon = role === "warehouse" ? "📦" : "🧪";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${label} sign in · Warehouse · Quality</title>${SHARED_HEAD}
<style>
  .card {
    width: 100%; max-width: 360px; background: #fff; border: 1px solid #e4e1ee; border-radius: 16px;
    padding: 32px; box-shadow: 0 1px 2px rgba(109,95,209,0.06), 0 8px 24px -16px rgba(33,31,46,0.18);
  }
  .wrap { display: flex; flex-direction: column; align-items: center; }
  .role-badge { display: flex; align-items: center; gap: 8px; justify-content: center; margin-bottom: 4px; }
  .role-badge .icon { font-size: 1.3rem; }
  h1 { font-family: 'Fraunces', Georgia, serif; font-weight: 500; font-size: 1.2rem; text-align: center; margin: 0 0 24px; }
  label { display: block; font-size: 0.8rem; font-weight: 600; color: #4d4a5f; margin: 14px 0 6px; }
  label:first-of-type { margin-top: 0; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px;
          border: 1px solid #cfc9e0; font-size: 0.95rem; font-family: inherit; }
  button {
    width: 100%; margin-top: 20px; padding: 12px; border-radius: 8px; border: none; font-size: 0.95rem;
    font-weight: 600; cursor: pointer; color: #fff; background: #6d5fd1;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  .msg { margin-top: 12px; font-size: 0.85rem; color: #b5406b; min-height: 1.2em; text-align: center; }
  .back { display: block; text-align: center; margin-top: 18px; font-size: 0.8rem; color: #726f80; text-decoration: none; }
  .back:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand"><span class="mark">✦</span><span class="name">Warehouse <em>·</em> Quality</span></div>
    <div class="card">
      <div class="role-badge"><span class="icon">${icon}</span></div>
      <h1>${label} sign in</h1>
      <form id="login-form">
        <label for="username">Username</label>
        <input type="text" id="username" autocomplete="username" required />
        <label for="password">Password</label>
        <input type="password" id="password" autocomplete="current-password" required />
        <button id="submit-btn" type="submit">Sign in</button>
        <div class="msg" id="msg"></div>
      </form>
      <a class="back" href="/">← Choose a different portal</a>
    </div>
  </div>
  <script>
    const form = document.getElementById('login-form');
    const msg = document.getElementById('msg');
    const btn = document.getElementById('submit-btn');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      msg.textContent = '';
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
            role: ${JSON.stringify(role)},
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Sign in failed');
        location.href = '/app';
      } catch (err) {
        msg.textContent = err.message;
        btn.disabled = false;
      }
    });
  </script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

/** Guards the SPA shell itself: no valid session, no app — sent back to
 *  pick a portal instead of a flash of UI that's about to 401 on every
 *  API call. */
export async function requireAppSession(request: Request, env: Env): Promise<Response | null> {
  const session = await getSession(request, env);
  if (session) return null;
  return new Response(null, { status: 302, headers: { Location: "/" } });
}
