// Stop hook: run tsc + tests after every session, surface failures to the user
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { truncatedOutput } = require("./lib/output");

try {
  fs.readFileSync(0, "utf8");
} catch {}

// Overridable so tests can exercise the timeout/signal-kill path without waiting 60s.
const HOOK_TIMEOUT_MS = Number(process.env.ELITE_TS_HOOK_TIMEOUT_MS) || 60000;

try {
  const cwd = process.cwd();
  const parts = [];
  let failed = false;

  // Only run tsc if this project actually uses TypeScript. Without a
  // tsconfig.json, `npx tsc` falls back to installing/running the unrelated
  // "tsc" npm package (a decoy that just prints a pointer to `typescript`),
  // which always exits 1 — that would block every session in a plain-JS
  // project with a "TypeScript error" that isn't real.
  if (fs.existsSync(path.join(cwd, "tsconfig.json"))) {
    const tsc = spawnSync("npx", ["tsc", "--noEmit"], {
      cwd,
      encoding: "utf8",
      shell: true,
      timeout: HOOK_TIMEOUT_MS
    });
    if (tsc.signal) {
      failed = true;
      parts.push(`TypeScript check timed out (killed by ${tsc.signal}) — result unknown`);
    } else if (tsc.status === 0) {
      parts.push("TypeScript ✓");
    } else {
      failed = true;
      const out = truncatedOutput(tsc.stdout, tsc.stderr, { head: 25 });
      parts.push(`TypeScript errors:\n${out}`);
    }
  }

  // Only run `npm test` if the project actually defines a test script.
  // Otherwise npm exits 1 with "Missing script: test", which would block
  // every session in a project that simply hasn't set up tests yet.
  let hasTestScript = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    hasTestScript = Boolean(pkg?.scripts?.test);
  } catch {
    hasTestScript = false;
  }

  if (hasTestScript) {
    const test = spawnSync("npm", ["test"], {
      cwd,
      encoding: "utf8",
      shell: true,
      timeout: HOOK_TIMEOUT_MS
    });
    if (test.signal) {
      failed = true;
      parts.push(`Tests timed out (killed by ${test.signal}) — result unknown`);
    } else if (test.status === 0) {
      parts.push("Tests ✓");
    } else {
      failed = true;
      const out = truncatedOutput(test.stdout, test.stderr, { tail: 30 });
      parts.push(`Test failures:\n${out}`);
    }
  }

  if (failed) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: parts.join("\n\n") }));
  }
} catch (err) {
  // A crash here would silently let the session stop without ever reporting
  // that tsc/test couldn't even be attempted (e.g. npx/npm missing in this project).
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `stop-check.js crashed before it could run tsc/tests: ${err.message}`
    })
  );
}
