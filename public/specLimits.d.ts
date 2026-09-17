// Types for specLimits.js, which the Worker imports directly.

export type LimitType =
  | "numeric_range"
  | "max"
  | "min"
  | "target"
  | "time_range"
  | "appearance"
  | "vs_standard"
  | "pass_fail"
  | "text_value";

export interface LimitShape {
  parameter_name?: string | null;
  param_type: string;
  min_value?: number | null;
  max_value?: number | null;
  unit?: string | null;
  expected_text?: string | null;
  target_value?: number | null;
  tolerance?: number | null;
}

export declare const LIMIT_TYPES: LimitType[];
export declare const AUTO_JUDGED_TYPES: LimitType[];
export declare function validateLimit(p: LimitShape): string | null;
export declare function formatSeconds(total: number | null | undefined): string;
export declare function parseClock(text: string | null | undefined): number | null;
export declare function parseNumber(text: string | null | undefined, thousands?: boolean): number | null;
export declare function formatLimit(
  p: LimitShape,
  labels?: { max: string; min: string; target: string; asStandard: string; passFail: string }
): string;
export declare function autoJudge(p: LimitShape, measured: string | null | undefined): "pass" | "fail" | null;
