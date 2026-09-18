// Material-code rules shared by the Worker (src/) and the browser (app.js).
//
// A sample of a material Quality doesn't know yet is given a temporary
// stand-in material whose code is its own RMS record number (as Access did),
// so it can be spec'd, tested, decided and printed. A stand-in is not a real
// material: it's hidden from material lists and pickers, and disappears when
// the sample is matched to a real material. Real material codes are always
// typed by Quality, and may never look like a record number.

const RECORD_CODE_RE = /^RM[SFP]\d{4,}$/i;

/** True for RMS/RMF/RMP-style record numbers (and so for stand-in codes). */
export function isRecordStyleCode(code) {
  return typeof code === "string" && RECORD_CODE_RE.test(code.trim());
}

/** True when a line's material code is a stand-in, i.e. the line still
 *  needs matching to a real material. */
export function isStandInCode(code) {
  return isRecordStyleCode(code);
}
