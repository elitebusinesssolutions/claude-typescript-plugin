// Fake `npx` used by tests to control eslint/prettier/tsc behavior without
// depending on what's actually installed on the machine running the tests.
// Controlled entirely via env vars — see tests/helpers/run-hook.js.
function envInt(name, def) {
  return process.env[name] !== undefined
    ? parseInt(process.env[name], 10)
    : def;
}

const tool = process.argv[2];
const cfg = {
  eslint: {
    status: envInt("STUB_ESLINT_STATUS", 0),
    stdout: process.env.STUB_ESLINT_STDOUT || "",
    stderr: process.env.STUB_ESLINT_STDERR || "",
    sleepMs: envInt("STUB_ESLINT_SLEEP_MS", 0),
  },
  prettier: {
    status: envInt("STUB_PRETTIER_STATUS", 0),
    stdout: process.env.STUB_PRETTIER_STDOUT || "",
    stderr: process.env.STUB_PRETTIER_STDERR || "",
    sleepMs: envInt("STUB_PRETTIER_SLEEP_MS", 0),
  },
  tsc: {
    status: envInt("STUB_TSC_STATUS", 0),
    stdout: process.env.STUB_TSC_STDOUT || "",
    stderr: process.env.STUB_TSC_STDERR || "",
    sleepMs: envInt("STUB_TSC_SLEEP_MS", 0),
  },
};

const c = cfg[tool];
if (!c) {
  process.stderr.write(`stub-npx: no stub configured for "${tool}"\n`);
  process.exit(1);
}

function finish() {
  if (c.stdout) process.stdout.write(c.stdout);
  if (c.stderr) process.stderr.write(c.stderr);
  process.exit(c.status);
}

if (c.sleepMs > 0) {
  setTimeout(finish, c.sleepMs);
} else {
  finish();
}
