const ROLE_KEY = "wq_role";
const NAME_KEY = "wq_name";

export function getRole() {
  return localStorage.getItem(ROLE_KEY) || "warehouse";
}

export function setRole(role) {
  localStorage.setItem(ROLE_KEY, role);
}

export function getRememberedName() {
  return localStorage.getItem(NAME_KEY) || "";
}

export function rememberName(name) {
  if (name) localStorage.setItem(NAME_KEY, name);
}

async function request(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-role": getRole() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // no body
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: "POST", body }),
  put: (path, body) => request(path, { method: "PUT", body }),
  patch: (path, body) => request(path, { method: "PATCH", body }),
};
