const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runHook, pathWithoutStubs } = require("./helpers/run-hook");

// format.js only invokes eslint if node_modules/.bin/eslint exists in cwd —
// this fixture simulates "eslint is a project devDependency".
function withEslintProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elite-ts-hook-test-"));
  const binDir = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const eslintBin = path.join(
    binDir,
    process.platform === "win32" ? "eslint.cmd" : "eslint",
  );
  fs.writeFileSync(eslintBin, "");
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(input, env, cwd) {
  return runHook("format.js", input, { env, cwd });
}

test("no file_path -> silent pass-through", () => {
  const r = run({ tool_input: {} });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("clean eslint (0) + clean prettier (0) on a .ts file -> no output", () => {
  withEslintProject((cwd) => {
    const r = run(
      { tool_name: "Write", tool_input: { file_path: "src/foo.ts" } },
      { STUB_ESLINT_STATUS: "0", STUB_PRETTIER_STATUS: "0" },
      cwd,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });
});

test("eslint exit 1 (unfixable lint warnings) is expected and not reported", () => {
  withEslintProject((cwd) => {
    const r = run(
      { tool_name: "Write", tool_input: { file_path: "src/foo.ts" } },
      {
        STUB_ESLINT_STATUS: "1",
        STUB_ESLINT_STDOUT: "1 warning",
        STUB_PRETTIER_STATUS: "0",
      },
      cwd,
    );
    assert.equal(r.stdout, "");
  });
});

test("eslint exit 2 (fatal config error) is reported", () => {
  withEslintProject((cwd) => {
    const r = run(
      { tool_name: "Write", tool_input: { file_path: "src/foo.ts" } },
      {
        STUB_ESLINT_STATUS: "2",
        STUB_ESLINT_STDERR: "ESLint couldn't find a configuration file",
        STUB_PRETTIER_STATUS: "0",
      },
      cwd,
    );
    const out = JSON.parse(r.stdout);
    assert.match(
      out.hookSpecificOutput.additionalContext,
      /ESLint did not run on foo\.ts/,
    );
    assert.match(
      out.hookSpecificOutput.additionalContext,
      /couldn't find a configuration/,
    );
  });
});

test("non-JS/TS files skip eslint entirely but still run prettier", () => {
  withEslintProject((cwd) => {
    const r = run(
      { tool_name: "Write", tool_input: { file_path: "README.md" } },
      { STUB_ESLINT_STATUS: "2", STUB_PRETTIER_STATUS: "0" },
      cwd,
    );
    // eslint would have "failed" (status 2) if it had been invoked at all — since
    // it wasn't (README.md isn't JS/TS), there must be no eslint message.
    assert.equal(r.stdout, "");
  });
});

test("project without eslint installed skips eslint silently (no false failure)", () => {
  // No node_modules/.bin/eslint fixture here — simulates a project that just
  // doesn't use ESLint. Even though the stub is configured to "fail", it must
  // never be invoked, so there must be no eslint message.
  const r = run(
    { tool_name: "Write", tool_input: { file_path: "src/foo.ts" } },
    { STUB_ESLINT_STATUS: "2", STUB_PRETTIER_STATUS: "0" },
  );
  assert.equal(r.stdout, "");
});

test("prettier failure is reported", () => {
  const r = run(
    { tool_name: "Write", tool_input: { file_path: "src/foo.ts" } },
    {
      STUB_ESLINT_STATUS: "0",
      STUB_PRETTIER_STATUS: "1",
      STUB_PRETTIER_STDERR: "[error] src/foo.ts: SyntaxError",
    },
  );
  const out = JSON.parse(r.stdout);
  assert.match(
    out.hookSpecificOutput.additionalContext,
    /Prettier error on foo\.ts/,
  );
});

test("both eslint and prettier failures are combined into one JSON payload", () => {
  withEslintProject((cwd) => {
    const r = run(
      { tool_name: "Write", tool_input: { file_path: "src/foo.ts" } },
      { STUB_ESLINT_STATUS: "2", STUB_PRETTIER_STATUS: "1" },
      cwd,
    );
    // Must be exactly one parseable JSON object, not two concatenated ones.
    const out = JSON.parse(r.stdout);
    assert.match(
      out.hookSpecificOutput.additionalContext,
      /ESLint did not run/,
    );
    assert.match(out.hookSpecificOutput.additionalContext, /Prettier error/);
  });
});

// Regression test for the bug this suite was written to catch: when eslint IS
// a project dependency but the underlying invocation breaks for a reason that
// isn't ESLint's own "0 clean / 1 found issues / 2 fatal" contract (e.g. npx
// resolving to a broken/incompatible binary), the old `status === 2` check
// silently ignored any other exit code, so the failure was never surfaced.
test("eslint failing with a non-standard exit code is still reported", () => {
  withEslintProject((cwd) => {
    const r = run(
      { tool_name: "Write", tool_input: { file_path: "src/foo.ts" } },
      {
        STUB_ESLINT_STATUS: "127",
        STUB_ESLINT_STDERR: "eslint: command not found",
        STUB_PRETTIER_STATUS: "0",
      },
      cwd,
    );
    const out = JSON.parse(r.stdout);
    assert.match(
      out.hookSpecificOutput.additionalContext,
      /ESLint did not run on foo\.ts \(exit 127\)/,
    );
  });
});

test("npx entirely missing from PATH still surfaces a prettier failure", () => {
  const result = runHook(
    "format.js",
    { tool_name: "Write", tool_input: { file_path: "src/foo.ts" } },
    { path: pathWithoutStubs() },
  );
  assert.notEqual(result.stdout, "", "expected a failure to be reported");
  const out = JSON.parse(result.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /Prettier error/);
});

test("malformed JSON on stdin does not crash the hook", () => {
  const r = run("{ not json");
  assert.notEqual(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /format\.js: skipping/);
});
