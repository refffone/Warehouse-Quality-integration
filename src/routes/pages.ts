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

// Landing-card watermark icons — geometry lifted from chemerp-costing's
// AbstractIcons.jsx (AbstractCubes / AbstractLens), each role's own accent
// hue matched to that repo's actual module colors (wh_rm: #C084FC, quality:
// #34D399) rather than the app's generic violet, so the two "stations" read
// as visually distinct the way chemerp's module launcher does.
const MODULE_ICON: Record<Role, string> = {
  warehouse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" stroke-linejoin="round"/><path d="M12 21v-9"/><path d="M4 7.5l8 4.5"/><path d="M20 7.5l-8 4.5"/><path d="M12 12l4-2" opacity="0.5"/></svg>`,
  quality: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6-6" stroke-linecap="round"/><path d="M10 7a3 3 0 0 1 3 3" stroke-linecap="round"/></svg>`,
};
const MODULE_COLOR: Record<Role, string> = { warehouse: "192,132,252", quality: "52,211,153" };

// Login page: a split layout with a "reason to sign in" context panel
// (research on B2B auth UX consistently flags this as the safest default)
// — but grounded in what the role can actually do here, not marketing copy.
const ROLE_CAPABILITIES: Record<Role, string[]> = {
  warehouse: [
    "Log receipts the moment materials arrive",
    "Track pending imports and samples",
    "Review supplier and batch history",
  ],
  quality: [
    "Record test results and decide batches",
    "Manage specifications and material codes",
    "Review supplier and material history",
  ],
};
const CHECK_ICON = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 10.5l4 4 8-9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ALERT_ICON = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 6.5v4.5M10 13.5v.01" stroke-linecap="round"/></svg>`;
const EYE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;

const SHARED_HEAD = `
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; }
    :root {
      --bg-base: #0a0d1a; --surface: rgba(21,25,45,0.72); --surface-solid: #141830; --surface-2: rgba(30,35,60,0.55);
      --ink: #eef0fb; --ink-muted: #9aa2c7; --ink-faint: #666f99;
      --rule: rgba(150,160,255,0.16); --rule-strong: rgba(150,160,255,0.3);
      --accent: #7c6aff; --accent-hover: #9286ff; --accent-deep: #5d4ce0; --accent-ink: #ffffff;
      --accent-glow: 0 0 0 1px rgba(124,106,255,0.5), 0 0 22px -4px rgba(124,106,255,0.65);
      --bad: #ff7aa0; --bad-bg: rgba(255,122,160,0.14);
      --shadow-card: 0 1px 0 rgba(255,255,255,0.05) inset, 0 10px 34px -10px rgba(0,0,0,0.5);
      --shadow-card-hover: 0 1px 0 rgba(255,255,255,0.06) inset, 0 18px 44px -12px rgba(0,0,0,0.6), 0 0 0 1px rgba(124,106,255,0.4), 0 0 26px -6px rgba(124,106,255,0.5);
      --sheen: linear-gradient(135deg, rgba(124,106,255,0.10) 0%, transparent 55%);
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg-base: #f4f5fb; --surface: rgba(255,255,255,0.88); --surface-solid: #ffffff; --surface-2: rgba(237,238,250,0.8);
        --ink: #171a2b; --ink-muted: #565b7a; --ink-faint: #8b90b0;
        --rule: rgba(80,70,160,0.14); --rule-strong: rgba(80,70,160,0.24);
        --accent: #6552e0; --accent-hover: #5a46d1; --accent-deep: #4a3bb8; --accent-ink: #ffffff;
        --accent-glow: 0 0 0 1px rgba(101,82,224,0.35), 0 0 18px -6px rgba(101,82,224,0.4);
        --bad: #c22e5a; --bad-bg: #fce8ee;
        --shadow-card: 0 1px 2px rgba(20,20,40,0.05), 0 10px 30px -10px rgba(20,20,40,0.14);
        --shadow-card-hover: 0 2px 6px rgba(20,20,40,0.06), 0 14px 32px -10px rgba(20,20,40,0.18), 0 0 0 1px rgba(101,82,224,0.3);
        --sheen: linear-gradient(135deg, rgba(101,82,224,0.06) 0%, transparent 55%);
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
  /* "Home card" treatment lifted from chemerp-costing's module launcher
     (src/pages/home/index.jsx): a per-role tinted diagonal gradient, a
     large icon watermark bleeding off the bottom-right corner (faded via a
     radial-gradient mask instead of a hard edge — the "glossy fadeout"
     look), and a hover lift + glow in that same color. No separate icon
     chip — the watermark itself is the icon, matching the live reference. */
  a.card {
    position: relative;
    width: 230px; padding: 30px 24px; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    border: 1px solid var(--rule); border-radius: 16px; box-shadow: var(--shadow-card); overflow: hidden;
    text-decoration: none; color: var(--ink); text-align: left;
    transition: transform 0.22s cubic-bezier(0.16,1,0.3,1), box-shadow 0.22s cubic-bezier(0.16,1,0.3,1), border-color 0.22s;
  }
  a.card.role-warehouse { background: linear-gradient(135deg, var(--surface) 40%, rgba(${MODULE_COLOR.warehouse},0.13) 100%); border-color: rgba(${MODULE_COLOR.warehouse},0.18); }
  a.card.role-quality { background: linear-gradient(135deg, var(--surface) 40%, rgba(${MODULE_COLOR.quality},0.13) 100%); border-color: rgba(${MODULE_COLOR.quality},0.18); }
  a.card:hover, a.card:focus-visible { outline: none; transform: translateY(-4px); }
  a.card.role-warehouse:hover { box-shadow: 0 16px 40px -14px rgba(${MODULE_COLOR.warehouse},0.22), 0 0 0 1px rgba(${MODULE_COLOR.warehouse},0.22); border-color: rgba(${MODULE_COLOR.warehouse},0.3); }
  a.card.role-quality:hover { box-shadow: 0 16px 40px -14px rgba(${MODULE_COLOR.quality},0.22), 0 0 0 1px rgba(${MODULE_COLOR.quality},0.22); border-color: rgba(${MODULE_COLOR.quality},0.3); }
  a.card .watermark {
    position: absolute; right: -16px; bottom: -16px; width: 128px; height: 128px; pointer-events: none; z-index: 0;
    -webkit-mask-image: radial-gradient(circle at bottom right, black 15%, transparent 68%);
    mask-image: radial-gradient(circle at bottom right, black 15%, transparent 68%);
    transition: transform 0.3s cubic-bezier(0.16,1,0.3,1);
  }
  a.card .watermark svg { width: 100%; height: 100%; }
  a.card.role-warehouse .watermark { color: #C084FC; }
  a.card.role-quality .watermark { color: #34D399; }
  a.card:hover .watermark { transform: scale(1.05); }
  a.card h2 { position: relative; z-index: 1; font-family: 'Space Grotesk', system-ui, sans-serif; font-weight: 600; font-size: 1.15rem; margin: 0 0 6px; }
  a.card p { position: relative; z-index: 1; margin: 0; color: var(--ink-muted); font-size: 0.85rem; line-height: 1.4; max-width: 165px; }
</style>
</head>
<body>
  <div class="picker">
    <div class="brand"><span class="mark">${BRAND_MARK}</span><span class="name">Warehouse <em>·</em> Quality</span></div>
    <p class="tagline">Select your station</p>
    <div class="cards">
      <a class="card role-warehouse" href="/login/warehouse">
        <div class="watermark">${MODULE_ICON.warehouse}</div>
        <h2>Warehouse</h2>
        <p>Receive materials, track incoming batches</p>
      </a>
      <a class="card role-quality" href="/login/quality">
        <div class="watermark">${MODULE_ICON.quality}</div>
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
  .login-shell { display: flex; flex-direction: column; align-items: center; width: 100%; max-width: 640px; }
  /* Split layout: a "reason to sign in" context panel (what this role can
     actually do here — not marketing copy) beside the form, the pattern
     B2B/SaaS auth-UX research repeatedly flags as the safest default for a
     first-time-per-session visitor. Collapses to a single column with the
     panel as a compact header under 640px. */
  .split {
    position: relative; display: flex; width: 100%; border-radius: 18px; overflow: hidden;
    border: 1px solid var(--rule); box-shadow: var(--shadow-card);
  }
  .split::before {
    content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 0;
    background: var(--sheen);
  }
  /* Visual panel: a full-bleed role-tinted nebula + starfield hero instead
     of a flat gradient rectangle, with a large line-art version of the
     role's own icon as the "subject" — a photo substitute that stays
     inside the app's own space/observatory visual language rather than
     reaching for stock photography. Role info overlaid at the bottom on a
     dark scrim for legibility against the busy background. */
  .split-visual {
    position: relative; z-index: 1; flex: 1; min-width: 240px; overflow: hidden;
    display: flex; flex-direction: column; justify-content: flex-end; padding: 28px 28px 26px;
  }
  .split-visual.role-warehouse {
    background-color: #120a24;
    background-image:
      radial-gradient(ellipse 340px 300px at 30% 22%, rgba(${MODULE_COLOR.warehouse},0.55), transparent 65%),
      radial-gradient(ellipse 260px 260px at 78% 70%, rgba(124,106,255,0.28), transparent 60%),
      ${STARS}, ${GRAIN};
    background-repeat: no-repeat, no-repeat, repeat, repeat;
  }
  .split-visual.role-quality {
    background-color: #06180f;
    background-image:
      radial-gradient(ellipse 340px 300px at 30% 22%, rgba(${MODULE_COLOR.quality},0.5), transparent 65%),
      radial-gradient(ellipse 260px 260px at 78% 70%, rgba(82,216,255,0.22), transparent 60%),
      ${STARS}, ${GRAIN};
    background-repeat: no-repeat, no-repeat, repeat, repeat;
  }
  .visual-icon {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -58%); width: 230px; height: 230px; pointer-events: none;
  }
  .visual-icon svg { width: 100%; height: 100%; }
  .split-visual.role-warehouse .visual-icon { color: #C084FC; opacity: 0.4; }
  .split-visual.role-quality .visual-icon { color: #34D399; opacity: 0.4; }
  .visual-scrim { position: absolute; inset: 0; background: linear-gradient(to top, rgba(6,8,18,0.88) 0%, rgba(6,8,18,0.35) 48%, transparent 72%); }
  .visual-body { position: relative; z-index: 1; }
  .visual-body h1 { font-family: 'Space Grotesk', system-ui, sans-serif; font-weight: 600; font-size: 1.3rem; margin: 0 0 4px; color: #fff; }
  .visual-body .role-tag { color: rgba(255,255,255,0.6); font-size: 0.8rem; margin: 0 0 16px; }
  .visual-body ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
  .visual-body li { display: flex; align-items: flex-start; gap: 8px; font-size: 0.8rem; color: rgba(255,255,255,0.78); line-height: 1.4; }
  .visual-body li svg { width: 14px; height: 14px; flex-shrink: 0; margin-top: 2px; }
  .split-visual.role-warehouse .visual-body li svg { color: #C084FC; }
  .split-visual.role-quality .visual-body li svg { color: #34D399; }

  .split-form { position: relative; z-index: 1; flex: 1; min-width: 260px; padding: 32px 28px; background: var(--surface-solid); }
  label { display: block; font-size: 0.68rem; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-faint); margin: 14px 0 6px; }
  label:first-of-type { margin-top: 0; }
  input {
    width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--rule-strong); background: var(--surface-2); color: var(--ink);
    font-size: 0.95rem; font-family: inherit; transition: border-color 0.12s, box-shadow 0.12s;
  }
  input:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,106,255,0.3); }
  .pw-wrap { position: relative; }
  .pw-wrap input { padding-inline-end: 38px; }
  /* Higher specificity than the generic full-width button rule below —
     without it a bare .pw-toggle class inherits width:100%/margin-top from
     that rule and stretches into a second full-width bar under the field. */
  button.pw-toggle {
    position: absolute; inset-inline-end: 4px; top: 50%; transform: translateY(-50%);
    width: 30px; height: 30px; margin-top: 0; padding: 0; border-radius: 6px;
    background: none; border: none; color: var(--ink-faint); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  button.pw-toggle:hover { color: var(--ink); background: var(--surface-2); }
  button.pw-toggle svg { width: 16px; height: 16px; }
  button {
    width: 100%; margin-top: 20px; padding: 12px; border-radius: 8px; border: none; font-size: 0.95rem;
    font-weight: 600; cursor: pointer; color: var(--accent-ink);
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent-deep) 100%);
    box-shadow: 0 2px 10px -2px rgba(0,0,0,0.35);
    display: flex; align-items: center; justify-content: center; gap: 8px;
    transition: box-shadow 0.15s cubic-bezier(0.16,1,0.3,1), transform 0.15s cubic-bezier(0.16,1,0.3,1), filter 0.15s;
  }
  button:hover:not(:disabled) { box-shadow: var(--accent-glow); filter: brightness(1.08); transform: translateY(-1px); }
  button:active:not(:disabled) { transform: translateY(0); box-shadow: 0 2px 10px -2px rgba(0,0,0,0.35); filter: brightness(1); }
  button:disabled { opacity: 0.75; cursor: default; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .btn-spinner { width: 15px; height: 15px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff; animation: spin 0.6s linear infinite; }
  .msg {
    display: flex; align-items: flex-start; gap: 8px; font-size: 0.82rem; color: var(--bad); text-align: start;
  }
  .msg:empty { display: none; }
  .msg:not(:empty) { margin-top: 12px; background: var(--bad-bg); border-radius: 8px; padding: 9px 11px; }
  .msg svg { width: 15px; height: 15px; flex-shrink: 0; margin-top: 1px; }
  .back { display: block; text-align: center; margin-top: 18px; font-size: 0.8rem; color: var(--ink-muted); text-decoration: none; }
  .back:hover { text-decoration: underline; color: var(--ink); }

  @media (max-width: 640px) {
    .split { flex-direction: column; }
    .split-visual { min-height: 200px; padding: 20px; }
    .visual-body ul { display: none; }
    .visual-body h1 { font-size: 1.1rem; }
    .visual-icon { width: 160px; height: 160px; transform: translate(-50%, -70%); }
    .split-form { padding: 24px; }
  }
</style>
</head>
<body>
  <div class="login-shell">
    <div class="brand" style="margin-bottom:24px"><span class="mark">${BRAND_MARK}</span><span class="name">Warehouse <em>·</em> Quality</span></div>
    <div class="split">
      <div class="split-visual role-${role}">
        <div class="visual-icon">${MODULE_ICON[role]}</div>
        <div class="visual-scrim"></div>
        <div class="visual-body">
          <h1>${label}</h1>
          <p class="role-tag">${role === "warehouse" ? "Receive materials, track incoming batches" : "Test, decide, and manage master data"}</p>
          <ul>
            ${ROLE_CAPABILITIES[role].map((c) => `<li>${CHECK_ICON}<span>${c}</span></li>`).join("")}
          </ul>
        </div>
      </div>
      <div class="split-form">
        <form id="login-form">
          <label for="username">Username</label>
          <input type="text" id="username" autocomplete="username" autofocus required />
          <label for="password">Password</label>
          <div class="pw-wrap">
            <input type="password" id="password" autocomplete="current-password" required />
            <button type="button" class="pw-toggle" id="pw-toggle" aria-label="Show password">${EYE_ICON}</button>
          </div>
          <button id="submit-btn" type="submit"><span id="submit-label">Sign in</span></button>
          <div class="msg" id="msg"></div>
        </form>
        <a class="back" href="/">← Choose a different portal</a>
      </div>
    </div>
  </div>
  <script>
    const form = document.getElementById('login-form');
    const msg = document.getElementById('msg');
    const btn = document.getElementById('submit-btn');
    const submitLabel = document.getElementById('submit-label');
    const pwInput = document.getElementById('password');
    const pwToggle = document.getElementById('pw-toggle');
    const alertIcon = ${JSON.stringify(ALERT_ICON)};

    pwToggle.addEventListener('click', () => {
      const shown = pwInput.type === 'text';
      pwInput.type = shown ? 'password' : 'text';
      pwToggle.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      submitLabel.innerHTML = '<span class="btn-spinner"></span>Signing in…';
      msg.innerHTML = '';
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: pwInput.value,
            role: ${JSON.stringify(role)},
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Sign in failed');
        location.href = '/app';
      } catch (err) {
        const span = document.createElement('span');
        span.textContent = err.message;
        msg.innerHTML = alertIcon;
        msg.appendChild(span);
        submitLabel.textContent = 'Sign in';
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
