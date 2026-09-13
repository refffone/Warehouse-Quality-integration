import { spawn, execFileSync } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BASE_URL, PID_FILE, PORT, QUALITY_USER, WAREHOUSE_USER } from "./constants";

const ROOT = path.resolve(__dirname, "../..");

function readAdminPassword(): string {
  const devVars = readFileSync(path.join(ROOT, ".dev.vars"), "utf8");
  const line = devVars.split("\n").find((l) => l.startsWith("ADMIN_PASSWORD="));
  if (!line) throw new Error(".dev.vars is missing ADMIN_PASSWORD — needed to create the E2E test accounts");
  return line.slice("ADMIN_PASSWORD=".length).trim();
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE_URL + "/");
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server never became ready at ${BASE_URL}`);
}

async function createAccount(adminPassword: string, user: typeof WAREHOUSE_USER, role: "warehouse" | "quality") {
  const res = await fetch(`${BASE_URL}/admin/api/users`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Basic " + Buffer.from(`admin:${adminPassword}`).toString("base64"),
    },
    body: JSON.stringify({ username: user.username, password: user.password, role, display_name: user.displayName }),
  });
  // 201 = created, 400 = already exists (re-running the suite without a
  // fresh D1 wipe) — both are fine, anything else is a real failure.
  if (!res.ok && res.status !== 400) {
    throw new Error(`Failed to create ${role} test account: ${res.status} ${await res.text()}`);
  }
}

export default async function globalSetup() {
  // Fresh local D1 every run, so tests never depend on leftover state
  // from a previous run (or collide with data a developer seeded by hand
  // while poking at `wrangler dev` themselves).
  rmSync(path.join(ROOT, ".wrangler", "state"), { recursive: true, force: true });
  execFileSync("npm", ["run", "db:migrate:local"], { cwd: ROOT, stdio: "inherit" });

  const pidFilePath = path.join(ROOT, PID_FILE);
  if (existsSync(pidFilePath)) {
    // A previous run's global-teardown didn't get to run (crashed suite,
    // Ctrl-C) — clean up its server before starting a new one on the
    // same port. Negative pid kills the whole detached process group
    // (npx's wrapper and the wrangler/workerd processes under it).
    try {
      process.kill(-Number(readFileSync(pidFilePath, "utf8")));
    } catch {
      // already gone
    }
  }
  try {
    execFileSync("pkill", ["-f", "wrangler dev"]);
  } catch {
    // nothing matched — fine
  }

  const logFd = openSync(path.join(ROOT, ".e2e-wrangler.log"), "w");
  const child = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  writeFileSync(pidFilePath, String(child.pid));

  await waitForServer();

  const adminPassword = readAdminPassword();
  await createAccount(adminPassword, WAREHOUSE_USER, "warehouse");
  await createAccount(adminPassword, QUALITY_USER, "quality");
}
