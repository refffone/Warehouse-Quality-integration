import { t } from "./i18n.js";

const NAME_KEY = "wq_name";

export function getRememberedName() {
  return localStorage.getItem(NAME_KEY) || "";
}

export function rememberName(name) {
  if (name) localStorage.setItem(NAME_KEY, name);
}

async function request(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/";
    throw new Error(t("error.notSignedIn"));
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // no body
  }
  if (!res.ok) {
    throw new Error((data && data.error) || t("error.requestFailed", { status: res.status }));
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: "POST", body }),
  put: (path, body) => request(path, { method: "PUT", body }),
  patch: (path, body) => request(path, { method: "PATCH", body }),
  delete: (path) => request(path, { method: "DELETE" }),
};

/** Multipart upload (for file attachments) — bypasses the JSON encoding
 *  `request()` always applies, since a file body can't be JSON. */
export async function uploadFile(path, formData) {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", body: formData });
  if (res.status === 401) {
    location.href = "/";
    throw new Error(t("error.notSignedIn"));
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // no body
  }
  if (!res.ok) throw new Error((data && data.error) || t("error.uploadFailed", { status: res.status }));
  return data;
}
