const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { runHook, pathWithoutStubs } = require("./helpers/run-hook");

// Mirrors stop-check.js's own stateFile derivation (session_id, falling back
// to `cwd:${cwd}` when absent — these tests never pass a session_id) so
// tests can clean up the dedup state the hook writes to os.tmpdir(), which
// lives outside the per-test project dir and wouldn't otherwise get swept up
// by withProject's cleanup.
function stateFileFor(cwd) {
  const stateKey = `cwd:${cwd}`;
  return path.join(
    os.tmpdir(),
    `elite-ts-stop-check-${crypto.createHash("sha256").update(stateKey).digest("hex")}.json`
  );
}

// stop-check.js only runs tsc if tsconfig.json exists, and only runs `npm
// test` if package.json declares a test script — this fixture provides both
// so tests can exercise the actual spawnSync/stub-bin invocation paths.
function withProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elite-ts-hook-test-"));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "echo test" } })
  );
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

// Regression tests for the infinite-loop bug this hook shipped with: blocking
// a Stop event re-invokes the hook on Claude's next response, and if the
// same tsc/test failure recurs (e.g. a pre-existing failure unrelated to the
// conversation), the hook would block again with the identical reason —
// forever, since nothing about the failure ever changes.
test("identical failure on a second consecutive Stop does not block again", () => {
  withProject((cwd) => {
    try {
      const env = {
        STUB_TSC_STATUS: "1",
        STUB_TSC_STDOUT: "src/foo.ts(1,1): error TS2304: Cannot find name 'x'.",
        STUB_NPM_TEST_STATUS: "0"
      };
      const first = run(env, cwd);
      assert.equal(JSON.parse(first.stdout).decision, "block");

      const second = run(env, cwd);
      const secondOut = JSON.parse(second.stdout);
      assert.equal(secondOut.decision, undefined);
      assert.match(secondOut.hookSpecificOutput.additionalContext, /not blocking again/);
      assert.match(secondOut.hookSpecificOutput.additionalContext, /TS2304/);
    } finally {
      fs.rmSync(stateFileFor(cwd), { force: true });
    }
  });
});

test("a different failure on the second Stop blocks again", () => {
  withProject((cwd) => {
    try {
      const first = run(
        { STUB_TSC_STATUS: "1", STUB_TSC_STDOUT: "TS error A", STUB_NPM_TEST_STATUS: "0" },
        cwd
      );
      assert.equal(JSON.parse(first.stdout).decision, "block");

      const second = run(
        { STUB_TSC_STATUS: "1", STUB_TSC_STDOUT: "TS error B", STUB_NPM_TEST_STATUS: "0" },
        cwd
      );
      const secondOut = JSON.parse(second.stdout);
      assert.equal(secondOut.decision, "block");
      assert.match(secondOut.reason, /TS error B/);
    } finally {
      fs.rmSync(stateFileFor(cwd), { force: true });
    }
  });
});

test("a passing check clears state, so a later identical failure blocks again", () => {
  withProject((cwd) => {
    try {
      const failEnv = {
        STUB_TSC_STATUS: "1",
        STUB_TSC_STDOUT: "TS error",
        STUB_NPM_TEST_STATUS: "0"
      };
      const first = run(failEnv, cwd);
      assert.equal(JSON.parse(first.stdout).decision, "block");

      const passing = run({ STUB_TSC_STATUS: "0", STUB_NPM_TEST_STATUS: "0" }, cwd);
      assert.equal(passing.stdout, "");

      const third = run(failEnv, cwd);
      assert.equal(JSON.parse(third.stdout).decision, "block");
    } finally {
      fs.rmSync(stateFileFor(cwd), { force: true });
    }
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
