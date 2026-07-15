const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runHook, pathWithoutStubs } = require("./helpers/run-hook");

// stop-check.js only runs tsc if tsconfig.json exists, and only runs the test
// script if package.json declares one — this fixture provides both so tests
// can exercise the actual spawnSync/stub-bin invocation paths. `testScript`/
// `git`/`gitDirty`/`untrackedFile` let tests exercise the --changed-appending
// logic, which only kicks in for a vitest test script, in an actual git
// repo, that also has a real diff vs HEAD to scope the run to — a clean
// working tree must fall back to the full suite (see the regression test
// below for why: an empty --changed run exits 0 as a false pass). `lockfile`
// lets tests exercise package-manager detection (yarn.lock/pnpm-lock.yaml
// instead of the npm default).
function withProject(
  fn,
  {
    testScript = "echo test",
    git = false,
    gitDirty = false,
    untrackedFile = false,
    lockfile = null
  } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elite-ts-hook-test-"));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: testScript } })
  );
  if (lockfile) {
    fs.writeFileSync(path.join(dir, lockfile), "");
  }
  if (git) {
    const gitOpts = { cwd: dir, stdio: "ignore" };
    execFileSync("git", ["init", "--quiet"], gitOpts);
    execFileSync("git", ["config", "user.email", "test@example.com"], gitOpts);
    execFileSync("git", ["config", "user.name", "Test"], gitOpts);
    execFileSync("git", ["add", "-A"], gitOpts);
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], gitOpts);
    if (gitDirty) {
      // Modify a tracked file so `git status --porcelain` actually reports
      // something — this is what makes --changed meaningful.
      fs.appendFileSync(path.join(dir, "package.json"), "\n");
    }
    if (untrackedFile) {
      // A brand-new file that's never been `git add`-ed. Regression coverage
      // for the fact that a plain `git diff` can't see this at all, but
      // `git status --porcelain` (what the hook actually probes with) can.
      fs.writeFileSync(path.join(dir, "new-file.txt"), "new\n");
    }
  }
  try {
    return fn(dir);
  } finally {
    // maxRetries/retryDelay: spawnSync's timeout only kills the immediate
    // shell child (cmd.exe); the stub-npx.js grandchild it launched keeps
    // running until its own sleep finishes and can hold this directory as
    // its cwd on Windows in the meantime, turning an immediate rmSync into
    // EPERM/EBUSY. Retry budget comfortably exceeds the longest stub sleep
    // used in these tests.
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 150
    });
  }
}

function run(env, cwd) {
  return runHook("stop-check.js", {}, { env, cwd });
}

test("tsc and tests both pass -> silent (no stdout)", () => {
  withProject((cwd) => {
    const r = run({ STUB_TSC_STATUS: "0", STUB_NPM_TEST_STATUS: "0" }, cwd);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });
});

test("tsc failure blocks with the tsc output", () => {
  withProject((cwd) => {
    const r = run(
      {
        STUB_TSC_STATUS: "1",
        STUB_TSC_STDOUT: "src/foo.ts(1,1): error TS2304: Cannot find name 'x'.",
        STUB_NPM_TEST_STATUS: "0"
      },
      cwd
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /TypeScript errors/);
    assert.match(out.reason, /TS2304/);
  });
});

test("test failure blocks with the test output", () => {
  withProject((cwd) => {
    const r = run(
      {
        STUB_TSC_STATUS: "0",
        STUB_NPM_TEST_STATUS: "1",
        STUB_NPM_TEST_STDOUT: "1 failing\n  1) foo should bar"
      },
      cwd
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /Test failures/);
    assert.match(out.reason, /1 failing/);
  });
});

test("both tsc and tests failing combines both reasons", () => {
  withProject((cwd) => {
    const r = run(
      {
        STUB_TSC_STATUS: "1",
        STUB_TSC_STDOUT: "TS error",
        STUB_NPM_TEST_STATUS: "1",
        STUB_NPM_TEST_STDOUT: "test error"
      },
      cwd
    );
    const out = JSON.parse(r.stdout);
    assert.match(out.reason, /TypeScript errors/);
    assert.match(out.reason, /Test failures/);
  });
});

test("tsc timing out is reported as a block, not silence", () => {
  // spawnSync's timeout only kills the immediate shell child (cmd.exe); the
  // stub-npx.js grandchild it launched keeps sleeping until its own timer
  // fires and can hold `cwd` locked as its own cwd on Windows in the
  // meantime. Wait out the full stub sleep before cleanup so rmSync doesn't
  // race an orphaned process that's still exiting.
  const sleepMs = 300;
  withProject((cwd) => {
    const r = run(
      {
        STUB_TSC_SLEEP_MS: String(sleepMs),
        STUB_TSC_STATUS: "0",
        STUB_NPM_TEST_STATUS: "0",
        ELITE_TS_HOOK_TIMEOUT_MS: "100"
      },
      cwd
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /TypeScript check timed out/);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs + 200);
  });
});

// tsc and `npm test` are independent (tsc --noEmit produces no artifact that
// `npm test` could depend on), so they should run concurrently rather than
// tsc_time + test_time sequentially. Sleep both stubs the same amount and
// assert the hook's wall-clock time is close to one sleep, not the sum of
// both — a generous threshold keeps this from flaking on a loaded CI box.
test("tsc and npm test run concurrently, not sequentially", () => {
  withProject((cwd) => {
    // A larger sleepMs gives proportionally more headroom above fixed
    // process-spawn overhead than a smaller one would — a loaded Windows CI
    // runner previously tripped a 300ms-sleep/500ms-threshold version of this
    // assertion (took 544ms) purely from spawn overhead, not from actually
    // running sequentially.
    const sleepMs = 500;
    const start = Date.now();
    const r = run(
      {
        STUB_TSC_SLEEP_MS: String(sleepMs),
        STUB_TSC_STATUS: "0",
        STUB_NPM_TEST_SLEEP_MS: String(sleepMs),
        STUB_NPM_TEST_STATUS: "0"
      },
      cwd
    );
    const elapsed = Date.now() - start;
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    // Sequential would take ~2 * sleepMs (1000ms+); concurrent should land
    // close to a single sleepMs. 900ms gives generous headroom above 500ms
    // for process spawn overhead while staying well under the 1000ms floor
    // sequential execution would hit.
    assert.ok(
      elapsed < sleepMs * 2 - 100,
      `expected concurrent execution (~${sleepMs}ms), took ${elapsed}ms`
    );
  });
});

// --changed scopes the test run to files affected by what's actually different
// from git, instead of the whole suite — but only when the test runner is
// vitest (Jest's equivalent flag is spelled differently, and other runners
// don't have one), there's a real git repo to diff against, and that diff is
// non-empty (see the regression test below for why the last part matters).
// `recordEnvVar` picks which stub binary's args get captured — defaults to
// npm, but yarn/pnpm-detection tests point it at the matching stub instead.
function argsUsedFor(cwd, extraEnv, { recordEnvVar = "STUB_NPM_RECORD_ARGS_TO" } = {}) {
  const argsFile = path.join(cwd, "npm-args.txt");
  run(
    {
      STUB_TSC_STATUS: "0",
      STUB_NPM_TEST_STATUS: "0",
      [recordEnvVar]: argsFile,
      ...extraEnv
    },
    cwd
  );
  return fs.readFileSync(argsFile, "utf8");
}

test("vitest test script in a git repo with a real diff -> npm test is invoked with -- --changed", () => {
  withProject((cwd) => assert.equal(argsUsedFor(cwd), "test -- --changed"), {
    testScript: "vitest",
    git: true,
    gitDirty: true
  });
});

test("vitest test script without a git repo -> falls back to the full suite", () => {
  withProject((cwd) => assert.equal(argsUsedFor(cwd), "test"), {
    testScript: "vitest",
    git: false
  });
});

test("non-vitest test runner -> --changed is not appended even in a git repo", () => {
  withProject((cwd) => assert.equal(argsUsedFor(cwd), "test"), {
    testScript: "jest",
    git: true,
    gitDirty: true
  });
});

// Regression test for the bug this fix addresses: if the working tree is
// clean vs HEAD (e.g. code was already committed earlier in the same
// session before this Stop hook fired), `vitest --changed` has nothing to
// diff against and matches zero test files — vitest exits 0 with "No test
// files found", which would previously read as a false "Tests ✓" pass
// without a single test actually running. --changed must not be appended in
// this case; the full suite must run instead.
test("vitest test script in a git repo with a clean working tree -> falls back to the full suite", () => {
  withProject((cwd) => assert.equal(argsUsedFor(cwd), "test"), {
    testScript: "vitest",
    git: true,
    gitDirty: false
  });
});

// Regression test: a plain `git diff` can't see untracked (never `git add`-ed)
// files, so gating --changed on it would miss a session that only adds new
// files. The hook probes with `git status --porcelain` instead, which does
// see untracked files.
test("vitest test script with only an untracked new file -> --changed is still appended", () => {
  withProject((cwd) => assert.equal(argsUsedFor(cwd), "test -- --changed"), {
    testScript: "vitest",
    git: true,
    untrackedFile: true
  });
});

// Regression test: npm's `-- extra args` forwarding appends to the end of the
// whole script string, not to a specific command within it — so a chained
// script would have --changed land on the wrong command. usesVitestAsSoleCommand
// excludes chained scripts entirely rather than guessing which segment is vitest.
test("chained vitest script -> --changed is not appended even with a real diff", () => {
  withProject((cwd) => assert.equal(argsUsedFor(cwd), "test"), {
    testScript: "vitest run && npm run lint",
    git: true,
    gitDirty: true
  });
});

// Regression test: a single `&` (background/sequence execution, valid in
// both POSIX shells and cmd.exe) is the same class of bug as `&&` above —
// CHAINED_SCRIPT_RE must catch it too, not just the two-character operators.
test("vitest script chained with a single & -> --changed is not appended", () => {
  withProject((cwd) => assert.equal(argsUsedFor(cwd), "test"), {
    testScript: "vitest & npm run lint",
    git: true,
    gitDirty: true
  });
});

// Regression test: a bare substring match on "vitest" would also fire for a
// script that merely mentions vitest without vitest being the command
// actually invoked, appending a flag that script doesn't understand.
test("script that only mentions vitest as a substring -> --changed is not appended", () => {
  withProject((cwd) => assert.equal(argsUsedFor(cwd), "test"), {
    testScript: "node scripts/vitest-config-check.mjs",
    git: true,
    gitDirty: true
  });
});

// Positive control for the two regression tests above: a legitimate
// env-var-prefixed vitest invocation should still be detected and scoped.
test("vitest script with a cross-env/env-var prefix -> --changed is still appended", () => {
  withProject((cwd) => assert.equal(argsUsedFor(cwd), "test -- --changed"), {
    testScript: "cross-env CI=true vitest run",
    git: true,
    gitDirty: true
  });
});

// Regression tests for the hardcoded-`npm` gap: the test script should run
// through whichever package manager the project actually uses, detected via
// lockfile, with the correct arg-forwarding syntax for each (npm/pnpm need a
// literal `--`; yarn forwards extra args directly and would pass a literal
// "--" through to vitest as an argument if given one).
test("yarn.lock present -> test runs via yarn, --changed forwarded without --", () => {
  withProject(
    (cwd) =>
      assert.equal(
        argsUsedFor(cwd, {}, { recordEnvVar: "STUB_YARN_RECORD_ARGS_TO" }),
        "test --changed"
      ),
    { testScript: "vitest", git: true, gitDirty: true, lockfile: "yarn.lock" }
  );
});

test("pnpm-lock.yaml present -> test runs via pnpm, --changed forwarded with --", () => {
  withProject(
    (cwd) =>
      assert.equal(
        argsUsedFor(cwd, {}, { recordEnvVar: "STUB_PNPM_RECORD_ARGS_TO" }),
        "test -- --changed"
      ),
    { testScript: "vitest", git: true, gitDirty: true, lockfile: "pnpm-lock.yaml" }
  );
});

// Regression tests for the bugs this suite was written to catch: without
// these guards, a plain-JS project (no tsconfig.json) or a project that
// hasn't set up tests yet (no "test" script) would get a spurious block on
// every single session, since `npx tsc` falls back to an unrelated decoy
// package and `npm test` errors with "Missing script" — both exit nonzero.
test("no tsconfig.json -> tsc is skipped, not falsely reported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elite-ts-hook-test-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "echo test" } })
  );
  try {
    const r = run({ STUB_NPM_TEST_STATUS: "0" }, dir);
    assert.equal(r.stdout, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no test script in package.json -> npm test is skipped, not falsely reported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elite-ts-hook-test-"));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: {} }));
  try {
    const r = run({ STUB_TSC_STATUS: "0" }, dir);
    assert.equal(r.stdout, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no package.json at all -> both checks are skipped silently", () => {
  const r = runHook("stop-check.js", {}, { path: pathWithoutStubs() });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("malformed stdin does not crash the hook", () => {
  const r = runHook("stop-check.js", "{ not json", {
    env: { STUB_TSC_STATUS: "0", STUB_NPM_TEST_STATUS: "0" }
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
