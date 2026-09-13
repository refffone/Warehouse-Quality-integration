/** Test accounts created fresh by global-setup on every run — not real
 *  credentials, just fixed values both the setup script and the specs
 *  agree on. */
export const WAREHOUSE_USER = { username: "e2e_warehouse", password: "E2eTestPass!1", displayName: "E2E Warehouse" };
export const QUALITY_USER = { username: "e2e_quality", password: "E2eTestPass!2", displayName: "E2E Quality" };

export const PORT = 8787;
export const BASE_URL = `http://localhost:${PORT}`;
export const PID_FILE = ".e2e-wrangler.pid";
