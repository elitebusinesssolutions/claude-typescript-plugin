// Test harness for the plugin's hook scripts. Spawns a hook as a real child
// process (matching how Claude Code actually invokes it: JSON on stdin, exit
// code + stdout as the contract) so tests exercise the real crash/exit
// behavior instead of calling internal functions that don't exist.
const { spawnSync } = require("child_process");
const path = require("path");
const os = require("os");

const HOOKS_DIR = path.join(__dirname, "..", "..", "hooks");
const STUB_BIN = path.join(__dirname, "stub-bin");

// Stub `npx`/`npm` on PATH ahead of anything real, so tests never depend on
// what's actually installed on the machine running them.
function runHook(hookFile, input, opts = {}) {
  const scriptPath = path.join(HOOKS_DIR, hookFile);
  const PATH =
    opts.path !== undefined
      ? opts.path
      : STUB_BIN + path.delimiter + (process.env.PATH || "");

  return spawnSync(process.execPath, [scriptPath], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    cwd: opts.cwd || os.tmpdir(),
    env: { ...process.env, ...opts.env, PATH },
    encoding: "utf8",
    timeout: opts.timeout ?? 10000,
  });
}

// A PATH with no npx/npm on it at all — simulates those tools being entirely
// unavailable in the host project (e.g. a bare Node script repo with no
// package.json), which is the scenario most likely to fail silently.
function pathWithoutStubs() {
  return os.tmpdir();
}

module.exports = { runHook, pathWithoutStubs, STUB_BIN };
