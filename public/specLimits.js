// Spec limit rules shared by the Worker (src/) and the browser (app.js), so
// the limit a spec sheet prints and the pass/fail the app suggests can
// never disagree. Plain ES module, no dependencies.

/** Every way a spec parameter can express its limit. Ranges, max, min,
 *  time ranges and targets with a tolerance are judged automatically from a
 *  measured value; the rest are a person's call. */
export const LIMIT_TYPES = [
  "numeric_range", // min – max            e.g. 1.00 – 1.04
  "max", //           ≤ max                e.g. Max 0.05 %
  "min", //           ≥ min                e.g. Min 99.8 %
  "target", //        a single value       e.g. 110 °C, or 110 ± 2 °C once a tolerance is known
  "time_range", //    min – max seconds    e.g. 1:30 – 1:50 (Cup #8 ISO)
  "appearance", //    expected look        e.g. Clear transparent liquid
  "vs_standard", //   compared with the reference sample
  "pass_fail", //     plain pass/fail
  "text_value", //    free-text record (older specs)
];

/** Judged from the measured value (a target only once it has a tolerance). */
export const AUTO_JUDGED_TYPES = ["numeric_range", "max", "min", "time_range", "target"];

const NEEDS_MIN = new Set(["numeric_range", "min", "time_range"]);
const NEEDS_MAX = new Set(["numeric_range", "max", "time_range"]);

/** Checks one parameter's shape. Returns an error message, or null. */
export function validateLimit(p) {
  if (!p.parameter_name || !String(p.parameter_name).trim()) return "Each parameter needs a name";
  if (!LIMIT_TYPES.includes(p.param_type)) return `${p.parameter_name}: unknown limit type "${p.param_type}"`;
  const hasMin = p.min_value != null && p.min_value !== "";
  const hasMax = p.max_value != null && p.max_value !== "";
  if (NEEDS_MIN.has(p.param_type) !== hasMin) {
    return NEEDS_MIN.has(p.param_type)
      ? `${p.parameter_name}: this limit needs a minimum`
      : `${p.parameter_name}: this limit can't have a minimum`;
  }
  if (NEEDS_MAX.has(p.param_type) !== hasMax) {
    return NEEDS_MAX.has(p.param_type)
      ? `${p.parameter_name}: this limit needs a maximum`
      : `${p.parameter_name}: this limit can't have a maximum`;
  }
  if (hasMin && hasMax && Number(p.min_value) > Number(p.max_value)) {
    return `${p.parameter_name}: minimum is above maximum`;
  }
  const hasTarget = p.target_value != null && p.target_value !== "";
  const hasTolerance = p.tolerance != null && p.tolerance !== "";
  if ((p.param_type === "target") !== hasTarget) {
    return p.param_type === "target"
      ? `${p.parameter_name}: this limit needs a target value`
      : `${p.parameter_name}: only a target limit has a target value`;
  }
  if (hasTolerance && p.param_type !== "target") return `${p.parameter_name}: only a target limit has a tolerance`;
  if (hasTolerance && Number(p.tolerance) < 0) return `${p.parameter_name}: tolerance can't be negative`;
  if (p.param_type === "appearance" && !(p.expected_text && String(p.expected_text).trim())) {
    return `${p.parameter_name}: describe the expected appearance`;
  }
  return null;
}

/** Time limits are stored in seconds — unless the parameter's unit says
 *  minutes (older specs), in which case the stored numbers are minutes. */
function timeFactor(p) {
  return /^min/i.test(p.unit || "") ? 60 : 1;
}

/** "95" -> "1:35", "3725" -> "1:02:05" */
export function formatSeconds(total) {
  if (total == null || Number.isNaN(Number(total))) return "";
  const t = Math.round(Number(total));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** "1:35" -> 95, "00:1:05" -> 65, "1:02:05" -> 3725. Needs a colon. */
export function parseClock(text) {
  const m = /(\d+):(\d{1,2})(?::(\d{1,2}))?/.exec(String(text ?? ""));
  if (!m) return null;
  return m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

/** First number in a measured value: "68.5 %" -> 68.5, "1,02" -> 1.02.
 *  A comma is a decimal point unless `thousands` is set (the limit itself is
 *  in the thousands), in which case "214,500" -> 214500. */
export function parseNumber(text, thousands = false) {
  const str = String(text ?? "");
  if (thousands) {
    const g = /[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?/.exec(str);
    if (g) return Number(g[0].replace(/,/g, ""));
  }
  const m = /[-+]?\d+(?:[.,]\d+)?/.exec(str);
  return m ? Number(m[0].replace(",", ".")) : null;
}

function fmtNum(n) {
  if (n == null) return "";
  const v = Number(n);
  // 216000 -> "216,000"; values under 1000 stay as typed (1.07, 0.05)
  return Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 6 }) : String(v);
}

const DEFAULT_LABELS = { max: "Max", min: "Min", target: "Target", asStandard: "As reference sample", passFail: "Pass/Fail" };

/** The limit as a person reads it on a spec sheet or COA. */
export function formatLimit(p, labels = DEFAULT_LABELS) {
  const unit = p.unit && p.param_type !== "time_range" ? ` ${p.unit}` : "";
  switch (p.param_type) {
    case "numeric_range":
      return `${fmtNum(p.min_value)} – ${fmtNum(p.max_value)}${unit}`;
    case "max":
      return `${labels.max} ${fmtNum(p.max_value)}${unit}`;
    case "min":
      return `${labels.min} ${fmtNum(p.min_value)}${unit}`;
    case "target":
      return p.tolerance != null
        ? `${fmtNum(p.target_value)} ± ${fmtNum(p.tolerance)}${unit}`
        : `${labels.target} ${fmtNum(p.target_value)}${unit}`;
    case "time_range": {
      const f = timeFactor(p);
      return `${formatSeconds(p.min_value * f)} – ${formatSeconds(p.max_value * f)}`;
    }
    case "appearance":
      return p.expected_text || "";
    case "vs_standard":
      return p.expected_text ? `${labels.asStandard} — ${p.expected_text}` : labels.asStandard;
    case "pass_fail":
      return labels.passFail;
    default:
      return p.expected_text || p.unit || "";
  }
}

/** "pass" / "fail" when the limit can be judged from the measured value,
 *  otherwise null (a person decides). */
export function autoJudge(p, measured) {
  if (measured == null || String(measured).trim() === "") return null;
  if (p.param_type === "time_range") {
    const secs = parseClock(measured);
    if (secs == null) return null;
    const f = timeFactor(p);
    return secs >= p.min_value * f && secs <= p.max_value * f ? "pass" : "fail";
  }
  if (!AUTO_JUDGED_TYPES.includes(p.param_type)) return null;
  const scale = Math.max(...[p.min_value, p.max_value, p.target_value].map((x) => Math.abs(Number(x) || 0)));
  const v = parseNumber(measured, scale >= 1000);
  if (v == null) return null;
  if (p.param_type === "target") {
    if (p.tolerance == null) return null; // no tolerance yet: a person decides
    return Math.abs(v - p.target_value) <= p.tolerance + 1e-9 ? "pass" : "fail";
  }
  if (p.param_type === "max") return v <= p.max_value ? "pass" : "fail";
  if (p.param_type === "min") return v >= p.min_value ? "pass" : "fail";
  return v >= p.min_value && v <= p.max_value ? "pass" : "fail";
}
