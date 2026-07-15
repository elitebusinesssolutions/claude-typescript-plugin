// Stop hook: run tsc + tests after every session, surface failures to the user
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { truncatedOutput } = require("./lib/output");

try {
  fs.readFileSync(0, "utf8");
} catch {}

// Overridable so tests can exercise the timeout/signal-kill path without waiting 60s.
const HOOK_TIMEOUT_MS = Number(process.env.ELITE_TS_HOOK_TIMEOUT_MS) || 60000;

// The git probes below (see `hasGitDiff`) are cheap, local, near-instant
// commands — they don't need anywhere near the budget tsc/npm test get. Giving
// them their own short timeout, instead of reusing HOOK_TIMEOUT_MS, keeps the
// worst case for a vitest+git project (probes, then npm test — sequential,
// since the test args depend on the probes' result) safely under the outer
// Stop-hook timeout (120s in hooks/hooks.json and .claude/settings.json)
// instead of the two potentially summing to it.
const GIT_PROBE_TIMEOUT_MS = Number(process.env.ELITE_TS_GIT_PROBE_TIMEOUT_MS) || 5000;

// Bounds taskkill itself (see killTree) so a wedged tree-kill can't block
// indefinitely.
const KILLER_TIMEOUT_MS = Number(process.env.ELITE_TS_KILLER_TIMEOUT_MS) || 2000;

// How long runChild waits, after attempting killTree, before giving up on a
// clean 'close' event and force-resolving anyway (see runChild).
const FORCE_RESOLVE_GRACE_MS = Number(process.env.ELITE_TS_FORCE_RESOLVE_GRACE_MS) || 3000;

// Kills `child` and, as best-effort as each platform allows, its descendants —
// not just the immediate shell process `spawn(..., { shell: true })` hands
// back. On Windows that shell is cmd.exe; `child.kill()` alone only signals
// cmd.exe, leaving whatever it launched (npm -> node -> vitest's worker pool,
// tsc, etc.) running as orphans. `taskkill /T` walks and kills the whole tree
// by pid lineage.
//
// taskkill is run via async `spawn`, not `spawnSync`: a synchronous call
// would block the entire event loop for its duration — including the
// concurrently-running sibling child's own I/O and timeout timer — and
// `spawnSync` doesn't throw for the failure modes that actually matter here
// (a missing/failing taskkill surfaces via a non-zero exit or an 'error'
// event, never an exception), so a try/catch around it would never trigger.
// Falling back to `child.kill()` when taskkill fails (or hangs past
// KILLER_TIMEOUT_MS) at least terminates the immediate shell process even
// when full tree cleanup isn't possible.
//
// On POSIX, `detached: true` (set in runChild) makes the child the leader of
// its own process group, so signaling the negated pid reaches the whole
// group instead of just the shell.
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    const bail = () => child.kill();
    const killerTimer = setTimeout(() => {
      killer.kill();
      bail();
    }, KILLER_TIMEOUT_MS);
    killer.on("close", (status) => {
      clearTimeout(killerTimer);
      if (status !== 0) bail();
    });
    killer.on("error", () => {
      clearTimeout(killerTimer);
      bail();
    });
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
// `timedOut` (not the child's own status/signal) is the source of truth for
// "we killed this because it ran too long". A separate `signal` field is
// still surfaced for the case where something OTHER than this timeout killed
// the child (an external SIGTERM/SIGKILL, an OOM kill, a manual kill) — main()
// reports that case too, just with different wording.
//
// killTree's tree-kill is best-effort and can fail to actually terminate a
// wedged process. Without a backstop, a failed kill would leave this promise
// (and the whole Stop hook) waiting on a 'close' event that never fires.
// FORCE_RESOLVE_GRACE_MS bounds that: once the timeout fires and killTree has
// had a chance to run, this promise resolves regardless of whether 'close'
// ever arrives.
//
// A ChildProcess's 'error' event (e.g. the shell itself can't be spawned) has
// no default handler — Node treats an unhandled 'error' event as an uncaught
// exception and crashes the whole process. Resolving from it here, like any
// other non-zero outcome, keeps a spawn failure inside the normal
// failed/timed-out reporting path instead.
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
    let settled = false;
    let timer;
    let forceTimer;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve(result);
    }

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      forceTimer = setTimeout(
        () => finish({ status: null, signal: null, stdout, stderr, timedOut: true }),
        FORCE_RESOLVE_GRACE_MS
      );
    }, timeoutMs);

    child.on("error", (err) => {
      finish({ status: null, signal: null, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });

    child.on("close", (status, signal) => {
      finish({ status, signal, stdout, stderr, timedOut });
    });
  });
}

// Only treat a test script as "vitest" for the purposes of the --changed
// fast-path below if vitest is unambiguously the sole command being run:
// anchored to the start of the script (after stripping leading env-var
// assignments / `cross-env` / `npx`), immediately followed by whitespace or
// end-of-string (not just any non-word character — "vitest-ui run" and
// "vitest:related" would otherwise satisfy a bare `\b`), and not part of a
// `&&`/`||`/`;`/`|`/`&` chain. A plain substring test doesn't work:
// "turbo run test" doesn't contain "vitest" at all even though vitest may run
// underneath it (silently disables the optimization — acceptable, since
// there's nothing here to safely detect that with), while "node
// scripts/vitest-check.mjs" does contain "vitest" without vitest being the
// command actually invoked (appending --changed to it would hand an
// unrecognized flag to that script). Chained scripts are excluded entirely
// rather than guessed at: npm's `-- extra args` forwarding appends to the end
// of the WHOLE script string, so `"vitest run && npm run lint"` would have
// --changed land on `lint`, not vitest — and the same is true of a single `&`
// (background/sequence execution, valid in both POSIX shells and cmd.exe),
// not just the `&&`/`||` two-character operators. Matching on the bare
// `&`/`;`/`|` characters catches all of these at once. Quoted spans are
// stripped before that chain check (but not before the vitest-anchor check)
// so a legitimate argument like `-t 'renders|updates'` isn't mistaken for a
// pipe chain.
const VITEST_SOLE_COMMAND_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:cross-env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:npx\s+)?vitest(?=\s|$)/;
const CHAINED_SCRIPT_RE = /[&;|]/;
const QUOTED_SPAN_RE = /'[^']*'|"[^"]*"/g;

function usesVitestAsSoleCommand(testScript) {
  const withoutQuotedSpans = testScript.replace(QUOTED_SPAN_RE, "");
  return (
    !CHAINED_SCRIPT_RE.test(withoutQuotedSpans) && VITEST_SOLE_COMMAND_RE.test(testScript.trim())
  );
}

// Picks the package-manager binary to run the "test" script with, matching
// whichever lockfile is present so a yarn/pnpm-only project isn't forced
// through an `npm` that may not even be installed there — and the argv shape
// for forwarding `--changed` through it. npm requires a literal `--` marker
// to forward trailing args to the underlying script; yarn and pnpm both
// forward extra args directly and would pass a literal "--" through to
// vitest as an argument if given one (verified against pnpm 10: `pnpm test --
// --changed` forwards `["--", "--changed"]` to the script, while `pnpm test
// --changed` correctly forwards just `["--changed"]`).
function testCommandFor(cwd, appendChanged) {
  const packageManager = fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))
    ? "pnpm"
    : fs.existsSync(path.join(cwd, "yarn.lock"))
      ? "yarn"
      : "npm";

  if (!appendChanged) return { command: packageManager, args: ["test"] };
  const args = packageManager === "npm" ? ["test", "--", "--changed"] : ["test", "--changed"];
  return { command: packageManager, args };
}

// Shared result -> message mapping for both tsc and the test run: they only
// differ in wording and which end of the output truncatedOutput keeps (see
// hooks/lib/output.js's head/tail doc comment).
function reportResult(
  result,
  { timeoutLabel, killedLabel, failureLabel, truncateOpts, timeoutMs }
) {
  if (result.timedOut) {
    return {
      failed: true,
      message: `${timeoutLabel} timed out after ${timeoutMs}ms — result unknown`
    };
  }
  if (result.signal) {
    return {
      failed: true,
      message: `${killedLabel} was killed by ${result.signal} — result unknown`
    };
  }
  if (result.status === 0) {
    return { failed: false, message: null };
  }
  const out = truncatedOutput(result.stdout, result.stderr, truncateOpts);
  return { failed: true, message: `${failureLabel}:\n${out}` };
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

    // Kick off tsc concurrently with the git probes below — tsc (--noEmit)
    // produces no build artifact that the test run could depend on, so
    // there's no reason for one to wait on the other.
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
    // this session. `git status --porcelain` alone isn't enough, though: it
    // also reports dirty/untracked git submodules and nested repos, which can
    // be non-empty for reasons unrelated to any real source change, and it
    // exits 0 even with zero commits (an "unborn HEAD"), where a plain `git
    // diff --name-only HEAD` would fail loudly instead. So a HEAD-existence
    // check gates the status probe: no commits yet means there's nothing for
    // vitest's own --changed to diff against, so fall back to the full suite
    // exactly as a non-git or diff-probe-failure case would. Run both probes
    // through the same `runChild` helper as tsc/tests so a hung or slow `git`
    // is bounded (by GIT_PROBE_TIMEOUT_MS, not HOOK_TIMEOUT_MS — a local
    // check should resolve in milliseconds, not compete with tsc/tests for
    // the same 60s budget), and treat a timed-out or failed probe as "no
    // diff" rather than trusting --changed when we couldn't actually
    // determine what changed.
    let hasGitDiff = false;
    if (usesVitest && isGitRepo) {
      const headExists = await runChild(
        "git",
        ["rev-parse", "--verify", "--quiet", "HEAD"],
        { cwd },
        GIT_PROBE_TIMEOUT_MS
      );
      if (!headExists.timedOut && headExists.status === 0) {
        const status = await runChild(
          "git",
          ["status", "--porcelain"],
          { cwd },
          GIT_PROBE_TIMEOUT_MS
        );
        hasGitDiff = !status.timedOut && status.status === 0 && status.stdout.trim().length > 0;
      }
    }
    const { command: testCommand, args: testArgs } = testCommandFor(
      cwd,
      usesVitest && isGitRepo && hasGitDiff
    );
    const testPromise = hasTestScript ? runChild(testCommand, testArgs, { cwd }) : null;

    if (tscPromise) {
      const tsc = await tscPromise;
      const result = reportResult(tsc, {
        timeoutLabel: "TypeScript check",
        killedLabel: "TypeScript check",
        failureLabel: "TypeScript errors",
        truncateOpts: { head: 25 },
        timeoutMs: HOOK_TIMEOUT_MS
      });
      if (result.failed) failed = true;
      parts.push(result.message ?? "TypeScript ✓");
    }

    if (testPromise) {
      const test = await testPromise;
      const result = reportResult(test, {
        timeoutLabel: "Tests",
        killedLabel: "Tests",
        failureLabel: "Test failures",
        truncateOpts: { tail: 30 },
        timeoutMs: HOOK_TIMEOUT_MS
      });
      if (result.failed) failed = true;
      parts.push(result.message ?? "Tests ✓");
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
