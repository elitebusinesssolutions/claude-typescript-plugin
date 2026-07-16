// Fake `eslint` binary used by tests to control format.js's direct-bin-spawn
// behavior without depending on a real eslint install. This script IS the
// resolved binary format.js spawns directly (no `npx` layer, so no argv[2]
// tool name to dispatch on) — its own argv is just eslint's own args (e.g.
// ["--fix", "src/foo.ts"]). Controlled entirely via STUB_ESLINT_* env vars —
// see tests/helpers/run-hook.js and tests/format.test.js.
require("./stub-tool-runner").runStub("ESLINT");
