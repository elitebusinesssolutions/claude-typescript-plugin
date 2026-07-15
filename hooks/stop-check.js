// Stop hook: run tsc + tests after every session, surface failures to the user
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { truncatedOutput } = require("./lib/output");

// Claude Code sends the full Stop event payload as JSON on stdin. The only
// field we need out of it is session_id, which we use below to scope the
// dedup state file to this conversation. If stdin is missing/malformed
// (e.g. a manual test invocation), sessionId just stays undefined and the
// cwd-based fallback a few lines down takes over.
let sessionId;
try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (typeof input?.session_id === "string" && input.session_id) sessionId = input.session_id;
} catch {}

// Overridable so tests can exercise the timeout/signal-kill path without waiting 60s.
const HOOK_TIMEOUT_MS = Number(process.env.ELITE_TS_HOOK_TIMEOUT_MS) || 60000;

// --- Loop-prevention state -------------------------------------------------
//
// Returning {"decision": "block"} from a Stop hook makes Claude Code force
// Claude to produce another response, which immediately ends in another Stop
// event — re-invoking this exact script again. If tsc/tests are still
// failing for a reason this turn can't or won't fix (a pre-existing failure,
// a question unrelated to code, or this script crashing the same way every
// time), the reported failure never changes, so the hook would block again,
// and again, forever — the only escape being the user manually interrupting
// the session (which is exactly the bug this file was rewritten to fix).
//
// The fix: remember the last failure we reported for this session in a tiny
// JSON file under the OS temp dir. The first time a given failure shows up,
// still block (that's the hook doing its job — give Claude a chance to see
// and react to it). If the *exact same* failure shows up again on the very
// next Stop, don't block again; report it as non-blocking context instead so
// the turn is actually allowed to end. If the failure text is different
// (a new tsc error, a different test broke), that's new information, so we
// block again — the dedup only suppresses an unchanged repeat, not every
// future failure in the session.
//
// The state file's *name* is derived from a hash of the session id (falling
// back to the project directory if session_id wasn't available) purely so
// an arbitrary string — cwd on Windows contains ":" and "\", which aren't
// safe filename characters — can be turned into a safe, fixed-shape
// filename. The *contents* of the file are just the plain failure text, not
// hashed — a hash would only make the file harder to inspect by hand for no
// benefit, since we're only ever comparing it to itself with ===.
const cwd = process.cwd();
const stateKey = sessionId || `cwd:${cwd}`;
const stateFile = path.join(
  os.tmpdir(),
  `elite-ts-stop-check-${crypto.createHash("sha256").update(stateKey).digest("hex")}.json`
);

// Called with the full failure text (tsc errors, test failures, or a crash
// message). Decides whether to block or to fall back to non-blocking
// context, per the dedup rule described above, and writes stdout accordingly.
function reportFailure(reason) {
  // Read whatever we reported last time in this session, if anything. Any
  // failure to read/parse (first run, file deleted, corrupted) just means
  // "no prior failure recorded" — treat it as a fresh failure and block.
  let prevReason;
  try {
    prevReason = JSON.parse(fs.readFileSync(stateFile, "utf8")).reason;
  } catch {}

  if (prevReason === reason) {
    // Same failure we already blocked on earlier this session — blocking
    // again would just repeat verbatim and loop forever since nothing
    // changed. Surface it as context instead so the turn can end.
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

  // New or changed failure: remember it (so a repeat of *this* one is
  // suppressed next time) and block as normal. Ignore write errors (e.g. a
  // read-only temp dir) — worst case we just lose the dedup for this run and
  // fall back to always blocking, which is the older (safe, if noisy) behavior.
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ reason }));
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
    // shell: true so `npx` (a .cmd shim on Windows) resolves correctly.
    // timeout is enforced by Node itself killing the child — no separate
    // process-tree/kill-signal handling needed for the common case.
    const tsc = spawnSync("npx", ["tsc", "--noEmit"], {
      cwd,
      encoding: "utf8",
      shell: true,
      timeout: HOOK_TIMEOUT_MS
    });
    if (tsc.signal) {
      // spawnSync sets `signal` (not `status`) when Node had to kill the
      // child itself after HOOK_TIMEOUT_MS elapsed — tsc's actual pass/fail
      // result is unknown in that case, so say so rather than guessing.
      failed = true;
      parts.push(`TypeScript check timed out (killed by ${tsc.signal}) — result unknown`);
    } else if (tsc.status === 0) {
      parts.push("TypeScript ✓");
    } else {
      failed = true;
      // head: 25 — tsc's earliest errors are usually the root cause; later
      // ones are often just cascading noise from the first, so keep the
      // start of the output rather than the end.
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
    // No package.json, or it's not valid JSON — either way, there's no test
    // script to run, so treat it the same as "not present".
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
      // tail: 30 — most test runners print a per-test list followed by a
      // summary of just the failures at the very end, so the tail is the
      // useful part; the head is often setup/passing-test noise.
      const out = truncatedOutput(test.stdout, test.stderr, { tail: 30 });
      parts.push(`Test failures:\n${out}`);
    }
  }

  if (failed) {
    reportFailure(parts.join("\n\n"));
  } else {
    // Checks are passing again — clear any remembered failure so that if
    // one recurs later in the session (even one identical to an earlier,
    // already-fixed failure), it's treated as new and blocks fresh instead
    // of being silently deduped against stale state.
    try {
      fs.unlinkSync(stateFile);
    } catch {}
  }
} catch (err) {
  // A crash here (e.g. npx/npm entirely missing from PATH, an unexpected
  // filesystem error) would otherwise silently let the session stop without
  // ever reporting that tsc/test couldn't even be attempted. Route it through
  // the same reportFailure dedup as a normal check failure, since a crash
  // that happens once will typically happen identically on every retry too —
  // it deserves the same one-block-then-context treatment, not an
  // unconditional block that can loop forever.
  reportFailure(`stop-check.js crashed before it could run tsc/tests: ${err.message}`);
}
