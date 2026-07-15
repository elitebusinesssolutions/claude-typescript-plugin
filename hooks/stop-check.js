// Stop hook: run tsc + tests after every session, surface failures to the user
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { truncatedOutput } = require("./lib/output");

try {
  fs.readFileSync(0, "utf8");
} catch {}

// Overridable so tests can exercise the timeout/signal-kill path without waiting 60s.
const HOOK_TIMEOUT_MS = Number(process.env.ELITE_TS_HOOK_TIMEOUT_MS) || 60000;

// The git-status probe below (see `hasGitDiff`) is a cheap, local, near-instant
// command — it doesn't need anywhere near the budget tsc/npm test get. Giving
// it its own short timeout, instead of reusing HOOK_TIMEOUT_MS, keeps the
// worst case for a vitest+git project (probe, then npm test — sequential,
// since the test args depend on the probe's result) safely under the outer
// Stop-hook timeout (120s in hooks/hooks.json and .claude/settings.json)
// instead of the two potentially summing to it.
const GIT_PROBE_TIMEOUT_MS = Number(process.env.ELITE_TS_GIT_PROBE_TIMEOUT_MS) || 5000;

// Kills `child` and, as best-effort as each platform allows, its descendants —
// not just the immediate shell process `spawn(..., { shell: true })` hands
// back. On Windows that shell is cmd.exe; `child.kill()` alone only signals
// cmd.exe, leaving whatever it launched (npm -> node -> vitest's worker pool,
// tsc, etc.) running as orphans. `taskkill /T` walks and kills the whole tree
// by pid lineage. On POSIX, `detached: true` (set in runChild) makes the
// child the leader of its own process group, so signaling the negated pid
// reaches the whole group instead of just the shell.
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill();
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill();
    }
  }
}

// Async equivalent of spawnSync's `timeout` option: runs `command args` to
// completion, collecting stdout/stderr, and kills the child (and its
// descendants, via killTree) if it runs past `timeoutMs`. Needed because tsc
// and `npm test` now run concurrently — spawnSync is blocking and can't have
// two of these in flight at once.
//
// `timedOut` (not the child's own status/signal) is what callers should treat
// as the source of truth for "did we kill this ourselves": killTree may
// terminate the process via an external `taskkill` on Windows rather than
// Node's own kill(), and in that case the close event's `signal` isn't
// reliably populated — only Node-initiated kills get to encode a signal name
// into the exit it reports.
function runChild(command, args, opts, timeoutMs = HOOK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...opts,
      shell: true,
      // Only meaningful on POSIX (see killTree) — Windows tree-killing goes
      // through taskkill instead, which doesn't need a process group.
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

// Only treat a test script as "vitest" for the purposes of the --changed
// fast-path below if vitest is unambiguously the sole command being run:
// anchored to the start of the script (after stripping leading env-var
// assignments / `cross-env` / `npx`), and not part of a `&&`/`||`/`;`/`|`
// chain. A plain substring test doesn't work: "turbo run test" doesn't
// contain "vitest" at all even though vitest may run underneath it (silently
// disables the optimization — acceptable, since there's nothing here to
// safely detect that with), while "node scripts/vitest-check.mjs" does
// contain "vitest" without vitest being the command actually invoked
// (appending --changed to it would hand an unrecognized flag to that
// script). Chained scripts are excluded entirely rather than guessed at:
// npm's `-- extra args` forwarding appends to the end of the WHOLE script
// string, so `"vitest run && npm run lint"` would have --changed land on
// `lint`, not vitest.
const VITEST_SOLE_COMMAND_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:cross-env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:npx\s+)?vitest\b/;
const CHAINED_SCRIPT_RE = /&&|\|\||;|\|/;

function usesVitestAsSoleCommand(testScript) {
  return !CHAINED_SCRIPT_RE.test(testScript) && VITEST_SOLE_COMMAND_RE.test(testScript.trim());
}

// Picks the package-manager binary to run the "test" script with, matching
// whichever lockfile is present so a yarn/pnpm-only project isn't forced
// through an `npm` that may not even be installed there — and the argv shape
// for forwarding `--changed` through it. npm and pnpm both require a literal
// `--` marker to forward trailing args to the underlying script; yarn
// forwards them directly and would pass a literal "--" through to vitest as
// an argument if given one.
function testCommandFor(cwd, appendChanged) {
  const packageManager = fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))
    ? "pnpm"
    : fs.existsSync(path.join(cwd, "yarn.lock"))
      ? "yarn"
      : "npm";

  if (!appendChanged) return { command: packageManager, args: ["test"] };
  const args = packageManager === "yarn" ? ["test", "--changed"] : ["test", "--", "--changed"];
  return { command: packageManager, args };
}

async function main() {
  try {
    const cwd = process.cwd();
    const parts = [];
    let failed = false;

    // Only run tsc if this project actually uses TypeScript. Without a
    // tsconfig.json, `npx tsc` falls back to installing/running the unrelated
    // "tsc" npm package (a decoy that just prints a pointer to `typescript`),
    // which always exits 1 — that would block every session in a plain-JS
    // project with a "TypeScript error" that isn't real.
    const hasTsConfig = fs.existsSync(path.join(cwd, "tsconfig.json"));

    // Only run the test script if the project actually defines one.
    // Otherwise the package manager exits nonzero with "Missing script:
    // test", which would block every session in a project that simply
    // hasn't set up tests yet.
    let hasTestScript = false;
    let testScript = "";
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
      testScript = pkg?.scripts?.test ?? "";
      hasTestScript = Boolean(testScript);
    } catch {
      hasTestScript = false;
    }

    // Vitest's `--changed` scopes the run to tests affected by files that
    // differ from git, instead of the whole suite. This is a Vitest-specific
    // flag (Jest's equivalent is `--onlyChanged`, and other runners don't have
    // one), so only add it when the test script actually invokes vitest as
    // its sole command and a .git directory exists for it to diff against —
    // otherwise fall back to running the full suite, exactly as before.
    const usesVitest = usesVitestAsSoleCommand(testScript);
    const isGitRepo = fs.existsSync(path.join(cwd, ".git"));

    // Kick off tsc concurrently with the git-status probe below — tsc
    // (--noEmit) produces no build artifact that the test run could depend
    // on, so there's no reason for one to wait on the other.
    const tscPromise = hasTsConfig ? runChild("npx", ["tsc", "--noEmit"], { cwd }) : null;

    // Even with vitest + a git repo, `--changed` is only trustworthy if there
    // is actually something to diff against. If the working tree is clean —
    // e.g. code was committed earlier in the same session, before this Stop
    // hook fired — `vitest --changed` matches zero test files and exits 0
    // with "No test files found", which reads as a pass even though no tests
    // ran at all, silently hiding real regressions in the code that was just
    // committed. Only use `--changed` when `git status --porcelain` proves
    // there's a real diff to scope the run to — this covers untracked new
    // files too, unlike a plain `git diff`, which only ever compares
    // already-tracked content and would silently miss brand-new files added
    // this session — otherwise fall back to the full suite. Run through the
    // same `runChild` helper as tsc/tests so a hung or slow `git` is bounded
    // (by GIT_PROBE_TIMEOUT_MS, not HOOK_TIMEOUT_MS — a local status check
    // should resolve in milliseconds, not compete with tsc/tests for the same
    // 60s budget), and treat a timed-out or failed probe as "no diff" rather
    // than trusting --changed when we couldn't actually determine what
    // changed.
    let hasGitDiff = false;
    if (usesVitest && isGitRepo) {
      const status = await runChild(
        "git",
        ["status", "--porcelain"],
        { cwd },
        GIT_PROBE_TIMEOUT_MS
      );
      hasGitDiff = !status.timedOut && status.status === 0 && status.stdout.trim().length > 0;
    }
    const { command: testCommand, args: testArgs } = testCommandFor(
      cwd,
      usesVitest && isGitRepo && hasGitDiff
    );
    const testPromise = hasTestScript ? runChild(testCommand, testArgs, { cwd }) : null;

    if (tscPromise) {
      const tsc = await tscPromise;
      if (tsc.timedOut) {
        failed = true;
        parts.push(`TypeScript check timed out after ${HOOK_TIMEOUT_MS}ms — result unknown`);
      } else if (tsc.status === 0) {
        parts.push("TypeScript ✓");
      } else {
        failed = true;
        const out = truncatedOutput(tsc.stdout, tsc.stderr, { head: 25 });
        parts.push(`TypeScript errors:\n${out}`);
      }
    }

    if (testPromise) {
      const test = await testPromise;
      if (test.timedOut) {
        failed = true;
        parts.push(`Tests timed out after ${HOOK_TIMEOUT_MS}ms — result unknown`);
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
}

main();
