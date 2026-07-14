// PostToolUse: eslint --fix + prettier --write on every Write/Edit
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

try {
  const d = JSON.parse(fs.readFileSync(0, "utf8"));
  const f = d?.tool_input?.file_path;
  if (!f) process.exit(0);

  const cwd = process.cwd();
  const messages = [];

  // ESLint only understands JS/TS source files — running it on README.md,
  // package.json, etc. produces noisy "fatal" errors for unsupported file types.
  //
  // Only invoke it if this project actually has eslint installed. Without this
  // gate, `npx eslint` in a project with no eslint devDependency falls back to
  // npx's package-resolution/prompt behavior, which commonly exits 1 — the same
  // code ESLint itself uses for "ran fine, found lint issues" — so a project
  // that simply doesn't use ESLint would get misreported as having lint errors
  // (or, before this fix, have that failure silently swallowed).
  const eslintBin = path.join(
    cwd,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "eslint.cmd" : "eslint",
  );
  if (/\.(ts|tsx|js|jsx|cjs|mjs)$/.test(f) && fs.existsSync(eslintBin)) {
    const eslint = spawnSync("npx", ["eslint", "--fix", f], {
      cwd,
      encoding: "utf8",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Exit 1 = unfixable lint warnings (expected — ESLint ran fine and found issues).
    // Anything else (2 = fatal config/parse error, non-standard codes, null = killed)
    // means linting silently never happened even though eslint is installed — report it.
    if (eslint.status !== 0 && eslint.status !== 1) {
      const detail = ((eslint.stdout || "") + (eslint.stderr || ""))
        .trim()
        .split("\n")
        .slice(0, 10)
        .join("\n");
      messages.push(
        `ESLint did not run on ${path.basename(f)} (exit ${eslint.status ?? `signal ${eslint.signal}`}) — linting was not applied:\n${detail}`,
      );
    }
  }

  const prettier = spawnSync(
    "npx",
    ["prettier", "--write", "--ignore-unknown", f],
    {
      cwd,
      encoding: "utf8",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (prettier.status !== 0) {
    const detail = ((prettier.stdout || "") + (prettier.stderr || ""))
      .trim()
      .split("\n")
      .slice(0, 10)
      .join("\n");
    messages.push(
      `Prettier error on ${path.basename(f)} (exit ${prettier.status ?? `signal ${prettier.signal}`}) — formatting was not applied:\n${detail}`,
    );
  }

  // Emit a single JSON payload — concatenated JSON objects are invalid and may be ignored.
  if (messages.length) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: messages.join("\n\n"),
        },
      }),
    );
  }
} catch (err) {
  // Never let an unexpected input shape (e.g. a different harness's event schema)
  // crash the hook uncaught — that's a non-blocking error, but it's silent and
  // gives no signal that formatting was skipped. Log to stderr and exit clean.
  process.stderr.write(`format.js: skipping — ${err.message}\n`);
  process.exit(0);
}
