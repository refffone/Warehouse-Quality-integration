import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { PID_FILE } from "./constants";

export default async function globalTeardown() {
  const pidFilePath = path.join(__dirname, "../..", PID_FILE);
  if (existsSync(pidFilePath)) {
    const pid = Number(readFileSync(pidFilePath, "utf8"));
    try {
      // `detached: true` in global-setup made this pid its own process
      // group leader — killing the negative pid kills the whole group
      // (npx's wrapper *and* the wrangler/workerd processes it spawned),
      // not just the top-level npx process.
      process.kill(-pid);
    } catch {
      // already gone
    }
    rmSync(pidFilePath, { force: true });
  }
  // Belt-and-suspenders: a stray wrangler dev from an interrupted
  // previous run (Ctrl-C mid-suite) won't have a matching pid file.
  try {
    execFileSync("pkill", ["-f", "wrangler dev"]);
  } catch {
    // nothing matched, or pkill isn't on PATH — either way, nothing to do
  }
}
