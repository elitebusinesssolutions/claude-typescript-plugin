// Shared behavior for the fake eslint/prettier binaries used by tests to
// control format.js's direct-bin-spawn behavior without depending on real
// installs. Each per-tool stub script (stub-eslint.js, stub-prettier.js) IS
// the resolved binary format.js spawns directly (no `npx` layer, so no
// argv[2] tool name to dispatch on) — this just wires up STUB_<prefix>_*
// env vars into stdout/stderr/exit-status/sleep behavior. See
// tests/helpers/run-hook.js and tests/format.test.js for the env-var contract.
function envInt(name, def) {
  return process.env[name] !== undefined ? parseInt(process.env[name], 10) : def;
}

function runStub(prefix) {
  const status = envInt(`STUB_${prefix}_STATUS`, 0);
  const stdout = process.env[`STUB_${prefix}_STDOUT`] || "";
  const stderr = process.env[`STUB_${prefix}_STDERR`] || "";
  const sleepMs = envInt(`STUB_${prefix}_SLEEP_MS`, 0);

  function finish() {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(status);
  }

  if (sleepMs > 0) {
    setTimeout(finish, sleepMs);
  } else {
    finish();
  }
}

module.exports = { runStub };
