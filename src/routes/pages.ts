import { getSession } from "../auth";
import type { Env, Role } from "../types";

// Server-rendered entry pages (landing + the two role-locked logins) —
// deliberately separate documents from the SPA shell (public/index.html),
// the same way src/routes/admin.ts's pages are: they must render and work
// before any session exists, so they carry their own minimal HTML/CSS/JS
// rather than depending on app.js/i18n.js/api.js. Same "Mission Control"
// visual identity as public/styles.css: dark by default, nebula + starfield
// + grain texture, glass panels — not gated behind prefers-color-scheme,
// since this is the app's actual identity rather than a dark-mode option.

const STARS =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='260' height='260'%3E%3Ccircle cx='20' cy='30' r='1.1' fill='white' opacity='0.9'/%3E%3Ccircle cx='75' cy='12' r='0.7' fill='white' opacity='0.5'/%3E%3Ccircle cx='130' cy='55' r='1.3' fill='white' opacity='0.8'/%3E%3Ccircle cx='190' cy='20' r='0.6' fill='white' opacity='0.4'/%3E%3Ccircle cx='40' cy='95' r='0.8' fill='white' opacity='0.6'/%3E%3Ccircle cx='100' cy='120' r='1.0' fill='white' opacity='0.7'/%3E%3Ccircle cx='160' cy='90' r='0.6' fill='white' opacity='0.45'/%3E%3Ccircle cx='215' cy='130' r='1.1' fill='white' opacity='0.8'/%3E%3Ccircle cx='15' cy='160' r='0.7' fill='white' opacity='0.5'/%3E%3Ccircle cx='65' cy='205' r='1.2' fill='white' opacity='0.85'/%3E%3Ccircle cx='120' cy='180' r='0.6' fill='white' opacity='0.4'/%3E%3Ccircle cx='175' cy='215' r='0.9' fill='white' opacity='0.65'/%3E%3Ccircle cx='230' cy='170' r='0.7' fill='white' opacity='0.5'/%3E%3Ccircle cx='240' cy='60' r='0.5' fill='white' opacity='0.35'/%3E%3Ccircle cx='5' cy='230' r='0.6' fill='white' opacity='0.4'/%3E%3Ccircle cx='245' cy='240' r='0.9' fill='white' opacity='0.6'/%3E%3C/svg%3E\")";
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.045'/%3E%3C/svg%3E\")";

const BRAND_MARK = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2Z"/></svg>`;

const ROLE_ICON: Record<Role, string> = {
  warehouse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5 12 4l9 4.5"/><path d="M3 8.5v10L12 22l9-3.5v-10"/><path d="M3 8.5 12 13l9-4.5"/><path d="M12 13v9"/></svg>`,
  quality: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6"/><path d="M10 3v5.5L4.8 18a2 2 0 0 0 1.75 3h10.9a2 2 0 0 0 1.75-3L14 8.5V3"/><path d="M7.5 14.5h9"/></svg>`,
};

const SHARED_HEAD = `
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; }
    :root {
      --bg-base: #0a0d1a; --surface: rgba(21,25,45,0.72); --surface-solid: #141830; --surface-2: rgba(30,35,60,0.55);
      --ink: #eef0fb; --ink-muted: #9aa2c7; --ink-faint: #666f99;
      --rule: rgba(150,160,255,0.16); --rule-strong: rgba(150,160,255,0.3);
      --accent: #7c6aff; --accent-hover: #9286ff; --accent-ink: #ffffff;
      --bad: #ff7aa0;
      --shadow-card: 0 1px 0 rgba(255,255,255,0.05) inset, 0 10px 30px -14px rgba(0,0,0,0.7);
      --shadow-card-hover: 0 1px 0 rgba(255,255,255,0.06) inset, 0 0 0 1px rgba(124,106,255,0.4), 0 20px 44px -14px rgba(0,0,0,0.75), 0 0 28px -6px rgba(124,106,255,0.5);
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg-base: #f4f5fb; --surface: rgba(255,255,255,0.88); --surface-solid: #ffffff; --surface-2: rgba(237,238,250,0.8);
        --ink: #171a2b; --ink-muted: #565b7a; --ink-faint: #8b90b0;
        --rule: rgba(80,70,160,0.14); --rule-strong: rgba(80,70,160,0.24);
        --accent: #6552e0; --accent-hover: #5a46d1; --accent-ink: #ffffff;
        --bad: #c22e5a;
        --shadow-card: 0 1px 2px rgba(20,20,40,0.04), 0 4px 12px -4px rgba(20,20,40,0.08);
        --shadow-card-hover: 0 2px 6px rgba(20,20,40,0.06), 0 10px 24px -8px rgba(20,20,40,0.14), 0 0 0 1px rgba(101,82,224,0.3);
      }
    }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background-color: var(--bg-base); color: var(--ink); font-family: 'IBM Plex Sans', system-ui, sans-serif;
      padding: 24px; -webkit-font-smoothing: antialiased;
      background-image:
        radial-gradient(ellipse 820px 520px at 15% -10%, rgba(124,106,255,0.34), transparent 60%),
        radial-gradient(ellipse 700px 600px at 100% 0%, rgba(82,216,255,0.2), transparent 55%),
        radial-gradient(ellipse 900px 700px at 50% 115%, rgba(124,106,255,0.14), transparent 60%),
        ${STARS}, ${GRAIN};
      background-repeat: no-repeat, no-repeat, no-repeat, repeat, repeat;
      background-attachment: fixed, fixed, fixed, fixed, fixed;
    }
    @media (prefers-color-scheme: light) {
      body {
        background-image:
          radial-gradient(ellipse 820px 520px at 15% -10%, rgba(124,106,255,0.1), transparent 60%),
          radial-gradient(ellipse 700px 600px at 100% 0%, rgba(82,216,255,0.08), transparent 55%),
          ${GRAIN};
        background-repeat: no-repeat, no-repeat, repeat;
      }
    }
    .brand { display: flex; align-items: center; justify-content: center; gap: 9px; margin-bottom: 30px; }
    .brand .mark { color: var(--accent); width: 22px; height: 22px; filter: drop-shadow(0 0 7px rgba(124,106,255,0.7)); }
    .brand .name { font-family: 'Space Grotesk', system-ui, sans-serif; font-weight: 600; font-size: 1.25rem; letter-spacing: -0.01em; }
    .brand .name em { color: var(--accent); font-style: normal; }
  </style>`;

export function landingPage(): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Warehouse · Quality</title>${SHARED_HEAD}
<style>
  .picker { display: flex; flex-direction: column; align-items: center; }
  .tagline { color: var(--ink-faint); font-size: 0.82rem; letter-spacing: 0.08em; text-transform: uppercase; margin: -20px 0 28px; }
  .cards { display: flex; gap: 20px; flex-wrap: wrap; justify-content: center; }
  a.card {
    width: 230px; padding: 34px 24px; background: var(--surface); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    border: 1px solid var(--rule); border-radius: 14px; box-shadow: var(--shadow-card);
    text-decoration: none; color: var(--ink); text-align: center; transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
  }
  a.card:hover, a.card:focus-visible { outline: none; transform: translateY(-3px); box-shadow: var(--shadow-card-hover); border-color: transparent; }
  a.card .icon {
    width: 44px; height: 44px; margin: 0 auto 16px; border-radius: 12px; color: var(--accent);
    background: var(--surface-2); border: 1px solid var(--rule); display: flex; align-items: center; justify-content: center;
  }
  a.card .icon svg { width: 22px; height: 22px; }
  a.card h2 { font-family: 'Space Grotesk', system-ui, sans-serif; font-weight: 600; font-size: 1.15rem; margin: 0 0 6px; }
  a.card p { margin: 0; color: var(--ink-muted); font-size: 0.85rem; line-height: 1.4; }
</style>
</head>
<body>
  <div class="picker">
    <div class="brand"><span class="mark">${BRAND_MARK}</span><span class="name">Warehouse <em>·</em> Quality</span></div>
    <p class="tagline">Select your station</p>
    <div class="cards">
      <a class="card" href="/login/warehouse">
        <div class="icon">${ROLE_ICON.warehouse}</div>
        <h2>Warehouse</h2>
        <p>Receive materials, track incoming batches</p>
      </a>
      <a class="card" href="/login/quality">
        <div class="icon">${ROLE_ICON.quality}</div>
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
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${label} sign in · Warehouse · Quality</title>${SHARED_HEAD}
<style>
  .card {
    width: 100%; max-width: 360px; background: var(--surface); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    border: 1px solid var(--rule); border-radius: 14px; padding: 32px; box-shadow: var(--shadow-card);
  }
  .wrap { display: flex; flex-direction: column; align-items: center; }
  .role-badge {
    width: 44px; height: 44px; margin: 0 auto 14px; border-radius: 12px; color: var(--accent);
    background: var(--surface-2); border: 1px solid var(--rule); display: flex; align-items: center; justify-content: center;
  }
  .role-badge svg { width: 22px; height: 22px; }
  h1 { font-family: 'Space Grotesk', system-ui, sans-serif; font-weight: 600; font-size: 1.2rem; text-align: center; margin: 0 0 24px; }
  label { display: block; font-size: 0.8rem; font-weight: 600; color: var(--ink-muted); margin: 14px 0 6px; }
  label:first-of-type { margin-top: 0; }
  input {
    width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--rule-strong); background: var(--surface-2); color: var(--ink);
    font-size: 0.95rem; font-family: inherit; transition: border-color 0.12s, box-shadow 0.12s;
  }
  input:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,106,255,0.3); }
  button {
    width: 100%; margin-top: 20px; padding: 12px; border-radius: 8px; border: none; font-size: 0.95rem;
    font-weight: 600; cursor: pointer; color: var(--accent-ink); background: var(--accent);
    transition: background 0.12s, box-shadow 0.12s;
  }
  button:hover:not(:disabled) { background: var(--accent-hover); box-shadow: 0 0 22px -4px rgba(124,106,255,0.65); }
  button:disabled { opacity: 0.6; cursor: default; }
  .msg { margin-top: 12px; font-size: 0.85rem; color: var(--bad); min-height: 1.2em; text-align: center; }
  .back { display: block; text-align: center; margin-top: 18px; font-size: 0.8rem; color: var(--ink-muted); text-decoration: none; }
  .back:hover { text-decoration: underline; color: var(--ink); }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand"><span class="mark">${BRAND_MARK}</span><span class="name">Warehouse <em>·</em> Quality</span></div>
    <div class="card">
      <div class="role-badge">${ROLE_ICON[role]}</div>
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
