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

// Async equivalent of spawnSync's `timeout` option: runs `command args` to
// completion, collecting stdout/stderr, and kills the child if it runs past
// HOOK_TIMEOUT_MS. Needed because tsc and `npm test` now run concurrently —
// spawnSync is blocking and can't have two of these in flight at once.
function runChild(command, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...opts, shell: true });
    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill();
    }, HOOK_TIMEOUT_MS);

    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
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

    // Only run `npm test` if the project actually defines a test script.
    // Otherwise npm exits 1 with "Missing script: test", which would block
    // every session in a project that simply hasn't set up tests yet.
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
    // one), so only add it when the test script actually invokes vitest and a
    // .git directory exists for it to diff against — otherwise fall back to
    // running the full suite, exactly as before.
    const usesVitest = /vitest/.test(testScript);
    const isGitRepo = fs.existsSync(path.join(cwd, ".git"));

    // Kick off tsc concurrently with the git-diff probe below — tsc (--noEmit)
    // produces no build artifact that `npm test` could depend on, so there's
    // no reason for one to wait on the other.
    const tscPromise = hasTsConfig ? runChild("npx", ["tsc", "--noEmit"], { cwd }) : null;

    // Even with vitest + a git repo, `--changed` is only trustworthy if there
    // is actually something to diff against. If the working tree is clean vs
    // HEAD — e.g. code was committed earlier in the same session, before this
    // Stop hook fired — `vitest --changed` matches zero test files and exits
    // 0 with "No test files found", which reads as a pass even though no
    // tests ran at all, silently hiding real regressions in the code that was
    // just committed. Only use `--changed` when `git diff --name-only HEAD`
    // proves there's a real diff to scope the run to; otherwise fall back to
    // the full suite. Run through the same `runChild` helper as tsc/npm so a
    // hung or slow `git` is bounded by HOOK_TIMEOUT_MS too, and treat a
    // timed-out or failed probe as "no diff" rather than trusting --changed
    // when we couldn't actually determine what changed.
    let hasGitDiff = false;
    if (usesVitest && isGitRepo) {
      const diff = await runChild("git", ["diff", "--name-only", "HEAD"], { cwd });
      hasGitDiff = !diff.signal && diff.status === 0 && diff.stdout.trim().length > 0;
    }
    const testArgs = usesVitest && isGitRepo && hasGitDiff ? ["test", "--", "--changed"] : ["test"];
    const testPromise = hasTestScript ? runChild("npm", testArgs, { cwd }) : null;

    if (tscPromise) {
      const tsc = await tscPromise;
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

    if (testPromise) {
      const test = await testPromise;
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
}

main();
