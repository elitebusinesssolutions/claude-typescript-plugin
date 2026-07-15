// Stop hook: run tsc + tests after every session, surface failures to the user
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { truncatedOutput } = require("./lib/output");

let sessionId;
try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (typeof input?.session_id === "string" && input.session_id) sessionId = input.session_id;
} catch {}

// Overridable so tests can exercise the timeout/signal-kill path without waiting 60s.
const HOOK_TIMEOUT_MS = Number(process.env.ELITE_TS_HOOK_TIMEOUT_MS) || 60000;

// Blocking the Stop event re-invokes this same hook on Claude's next response
// — if the same failure (a tsc/test failure, or this script crashing outright)
// keeps recurring for a reason this turn can't or won't fix (a pre-existing
// failure, or a question unrelated to code), the reported reason never
// changes and the hook would block forever with no way out short of the user
// manually interrupting. Fall back to a cwd hash (not session-scoped, but at
// least project-scoped) if session_id is missing so this degrades safely
// instead of dedup never kicking in.
const cwd = process.cwd();
const stateKey = sessionId || `cwd:${cwd}`;
const stateFile = path.join(
  os.tmpdir(),
  `elite-ts-stop-check-${crypto.createHash("sha256").update(stateKey).digest("hex")}.json`
);

// Blocks the first time `reason` is seen this session; on a repeat of the
// exact same reason, reports it as non-blocking context instead so the
// session can actually end.
function reportFailure(reason) {
  const reasonHash = crypto.createHash("sha256").update(reason).digest("hex");

  let prevHash;
  try {
    prevHash = JSON.parse(fs.readFileSync(stateFile, "utf8")).reasonHash;
  } catch {}

  if (prevHash === reasonHash) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: `This check is still failing from a prior check this session (not blocking again to avoid a repeat loop):\n\n${reason}`
        }
      })
    );
    return;
  }

  try {
    fs.writeFileSync(stateFile, JSON.stringify({ reasonHash }));
  } catch {}
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

try {
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
    reportFailure(parts.join("\n\n"));
  } else {
    try {
      fs.unlinkSync(stateFile);
    } catch {}
  }
} catch (err) {
  // A crash here would silently let the session stop without ever reporting
  // that tsc/test couldn't even be attempted (e.g. npx/npm missing in this project).
  reportFailure(`stop-check.js crashed before it could run tsc/tests: ${err.message}`);
}
