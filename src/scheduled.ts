import type { Env } from "./types";

interface ExpiringBatchRow {
  id: number;
  expiry_date: string;
  supplier_batch_no: string;
  internal_batch_no: string | null;
  days_until_expiry: number;
}

/** Daily job: notify warehouse the first time an approved batch's expiry
 *  date falls within each configured lead time. Already-fired (batch,
 *  lead_time) pairs are recorded in expiry_alerts_sent so this never
 *  re-notifies for the same threshold. */
export async function runExpiryCheck(env: Env): Promise<void> {
  const leadTimes = env.EXPIRY_ALERT_LEAD_DAYS.split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);

  if (leadTimes.length === 0) return;

  const maxLeadTime = leadTimes[leadTimes.length - 1];

  const { results } = await env.DB.prepare(
    `SELECT id, expiry_date, supplier_batch_no, internal_batch_no,
            CAST(julianday(expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
     FROM receipt_batches
     WHERE status IN ('approved', 'partial')
       AND expiry_date IS NOT NULL
       AND julianday(expiry_date) - julianday('now') <= ?`
  )
    .bind(maxLeadTime)
    .all<ExpiringBatchRow>();

  for (const batch of results ?? []) {
    if (batch.days_until_expiry < 0) continue; // already expired — out of scope here

    const crossedLeadTime = leadTimes.find((lt) => batch.days_until_expiry <= lt);
    if (crossedLeadTime === undefined) continue;

    const alreadySent = await env.DB.prepare(
      "SELECT 1 FROM expiry_alerts_sent WHERE batch_id = ? AND lead_time_days = ?"
    )
      .bind(batch.id, crossedLeadTime)
      .first();
    if (alreadySent) continue;

    await env.DB.prepare(
      `INSERT INTO notification_events (target_role, batch_id, kind, message)
       VALUES ('warehouse', ?, 'expiry_alert', ?)`
    )
      .bind(
        batch.id,
        `Batch ${batch.internal_batch_no ?? batch.supplier_batch_no} expires in ${batch.days_until_expiry} day(s) (${batch.expiry_date})`
      )
      .run();

    await env.DB.prepare(
      "INSERT INTO expiry_alerts_sent (batch_id, lead_time_days) VALUES (?, ?)"
    )
      .bind(batch.id, crossedLeadTime)
      .run();
  }
}
