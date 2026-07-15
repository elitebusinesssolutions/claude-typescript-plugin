const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Regression guard for the bug this test was added to catch: these wrapper
// scripts were committed without the executable bit, so on a fresh checkout
// the shell couldn't exec them and silently fell through PATH resolution to
// the real system npx/npm — making every hook test that depends on the stub
// exercise real tsc/eslint/prettier instead.
const STUB_BIN = path.join(__dirname, "helpers", "stub-bin");
const EXECUTABLE_SCRIPTS = ["npx", "npm"];

test(
  "stub-bin POSIX wrapper scripts are executable",
  { skip: process.platform === "win32" },
  () => {
    for (const name of EXECUTABLE_SCRIPTS) {
      const scriptPath = path.join(STUB_BIN, name);
      const mode = fs.statSync(scriptPath).mode;
      assert.ok(
        mode & fs.constants.S_IXUSR,
        `${scriptPath} is not executable (mode ${(mode & 0o777).toString(8)}) — the shell will fall through to the real system binary instead of this stub`
      );
    }
  }
);
