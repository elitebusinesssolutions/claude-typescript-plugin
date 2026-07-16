// Test harness for the plugin's hook scripts. Spawns a hook as a real child
// process (matching how Claude Code actually invokes it: JSON on stdin, exit
// code + stdout as the contract) so tests exercise the real crash/exit
// behavior instead of calling internal functions that don't exist.
const { spawnSync } = require("child_process");
const path = require("path");
const os = require("os");

const HOOKS_DIR = path.join(__dirname, "..", "..", "hooks");

function runHook(hookFile, input, opts = {}) {
  const scriptPath = path.join(HOOKS_DIR, hookFile);

  return spawnSync(process.execPath, [scriptPath], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    cwd: opts.cwd || os.tmpdir(),
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    timeout: 10000
  });
}

module.exports = { runHook };
