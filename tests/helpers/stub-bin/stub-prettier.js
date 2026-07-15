// Fake `prettier` binary used by tests to control format.js's direct-bin-spawn
// behavior without depending on a real prettier install. Unlike stub-npx.js,
// this script IS the resolved binary format.js spawns directly (no `npx`
// layer, so no argv[2] tool name to dispatch on) — its own argv is just
// prettier's own args (e.g. ["--write", "--ignore-unknown", "src/foo.ts"]).
// Controlled entirely via STUB_PRETTIER_* env vars — see
// tests/helpers/run-hook.js and tests/format.test.js.
function envInt(name, def) {
  return process.env[name] !== undefined ? parseInt(process.env[name], 10) : def;
}

const status = envInt("STUB_PRETTIER_STATUS", 0);
const stdout = process.env.STUB_PRETTIER_STDOUT || "";
const stderr = process.env.STUB_PRETTIER_STDERR || "";
const sleepMs = envInt("STUB_PRETTIER_SLEEP_MS", 0);

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
