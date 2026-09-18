// Request rate limits, using Cloudflare's Workers rate-limiting binding
// (configured in wrangler.toml). Counters live at the edge, per location
// and per key, so nothing extra is written to D1 on a request. These sit
// in front of the finer, per-account login lockout in src/auth.ts:
//
//   AUTH_LIMITER  — sign-in and the admin/backup endpoints, per IP. Stops
//                   one address from guessing across many usernames (and
//                   from locking every account out) and caps the PBKDF2
//                   work an unauthenticated caller can cause.
//   API_LIMITER   — the rest of the API, per signed-in user (per IP when
//                   signed out).
//   HEAVY_LIMITER — PDF/Excel exports, COAs and Excel imports, which cost
//                   far more CPU than a normal request.

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The window every limit is counted over (the binding's period). */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** True when this request goes over the limit. A missing binding (or a
 *  failing one) never blocks anyone: the limits protect the service, they
 *  must not take it down. */
export async function isRateLimited(binding: RateLimitBinding | undefined, key: string): Promise<boolean> {
  if (!binding) return false;
  try {
    const { success } = await binding.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

export function tooManyRequests(message = "Too many requests — wait a minute and try again"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": String(RATE_LIMIT_PERIOD_SECONDS) },
  });
}

/** Requests that are expensive enough to count against HEAVY_LIMITER too. */
export function isHeavyRequest(pathname: string, method: string): boolean {
  return (
    pathname.startsWith("/api/reports/") ||
    /^\/api\/batches\/\d+\/coa$/.test(pathname) ||
    /\/import$/.test(pathname) ||
    (method === "GET" && /\/import-template$/.test(pathname)) ||
    /\/dossier$/.test(pathname)
  );
}
