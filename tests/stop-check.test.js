const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runHook, pathWithoutStubs } = require("./helpers/run-hook");

// stop-check.js only runs tsc if tsconfig.json exists, and only runs `npm
// test` if package.json declares a test script — this fixture provides both
// so tests can exercise the actual spawnSync/stub-bin invocation paths.
// `testScript`/`git` let tests exercise the --changed-appending logic, which
// only kicks in for a vitest test script in an actual git repo.
function withProject(fn, { testScript = "echo test", git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elite-ts-hook-test-"));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: testScript } })
  );
  if (git) {
    fs.mkdirSync(path.join(dir, ".git"));
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
    const sleepMs = 300;
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
    // Sequential would take ~2 * sleepMs (600ms+); concurrent should land
    // close to a single sleepMs. 500ms gives generous headroom above 300ms
    // for process spawn overhead while staying well under the 600ms floor
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
// don't have one) and there's a real git repo to diff against.
function argsUsedFor(cwd, extraEnv) {
  const argsFile = path.join(cwd, "npm-args.txt");
  run(
    {
      STUB_TSC_STATUS: "0",
      STUB_NPM_TEST_STATUS: "0",
      STUB_NPM_RECORD_ARGS_TO: argsFile,
      ...extraEnv
    },
    cwd
  );
  return fs.readFileSync(argsFile, "utf8");
}

test("vitest test script in a git repo -> npm test is invoked with -- --changed", () => {
  withProject((cwd) => assert.equal(argsUsedFor(cwd), "test -- --changed"), {
    testScript: "vitest",
    git: true
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
    git: true
  });
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
