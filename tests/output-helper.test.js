const test = require("node:test");
const assert = require("node:assert/strict");
const { truncatedOutput } = require("../hooks/lib/output");

test("joins stdout and stderr with an explicit newline separator", () => {
  // Regression test for the bug this helper was extracted to fix: without an
  // explicit "\n" between stdout and stderr, a stdout chunk that doesn't
  // already end in its own trailing newline gets its last line silently
  // merged with stderr's first line into one garbled line.
  const stdout = "last stdout line"; // deliberately no trailing "\n"
  const stderr = "first stderr line\nsecond stderr line";
  const out = truncatedOutput(stdout, stderr);
  const lines = out.split("\n");
  assert.deepEqual(lines, ["last stdout line", "first stderr line", "second stderr line"]);
  // The specific garbled-merge bug this guards against:
  assert.ok(!lines.includes("last stdout linefirst stderr line"));
});

test("stdout already ending in a newline still separates cleanly (no blank line)", () => {
  const out = truncatedOutput("stdout line\n", "stderr line");
  assert.equal(out, "stdout line\nstderr line");
});

test("empty stderr does not introduce a trailing blank line", () => {
  const out = truncatedOutput("only stdout\nsecond line", "");
  assert.equal(out, "only stdout\nsecond line");
});

test("empty stdout does not introduce a leading blank line", () => {
  const out = truncatedOutput("", "only stderr\nsecond line");
  assert.equal(out, "only stderr\nsecond line");
});

test("undefined stdout/stderr are treated the same as empty strings", () => {
  const out = truncatedOutput(undefined, "only stderr");
  assert.equal(out, "only stderr");
});

test("both empty -> empty string", () => {
  assert.equal(truncatedOutput("", ""), "");
});

test("head truncates to the first N lines", () => {
  const stdout = Array.from({ length: 5 }, (_, i) => `line${i}`).join("\n");
  const out = truncatedOutput(stdout, "", { head: 3 });
  assert.equal(out, "line0\nline1\nline2");
});

test("no head/tail option returns the full trimmed, joined output", () => {
  const out = truncatedOutput("  stdout  \n", "  stderr  ");
  // Overall trim() only strips leading/trailing whitespace on the combined
  // string, not around the internal separator — only the outer 2 spaces on
  // each end are removed.
  assert.equal(out, "stdout  \n  stderr");
});
