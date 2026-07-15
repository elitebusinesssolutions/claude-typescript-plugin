// Shared helper for both hook scripts (format.js, stop-check.js): turns a
// spawned process's stdout/stderr into a single truncated string suitable
// for a failure message.
//
// stdout and stderr are joined with an explicit "\n" separator before being
// trimmed/split — without that separator, a stdout chunk that doesn't already
// end in its own trailing newline would have its last line silently merge
// with stderr's first line into one garbled line. Empty streams are dropped
// before joining so a missing stdout or stderr doesn't leave a stray blank
// line at the start/end/middle of the result.
//
// `head`/`tail` mirror Array.prototype.slice(0, n) / slice(-n) — pass
// whichever matches how the caller wants to truncate (head for output where
// the earliest lines matter most, e.g. tsc; tail for output where the most
// recent lines matter most, e.g. a test runner's final summary). Passing
// neither returns the full (trimmed, joined) output.
function truncatedOutput(stdout, stderr, { head, tail } = {}) {
  const combined = [stdout, stderr]
    // Strip any trailing newline(s) each stream already ends with, so joining
    // always inserts exactly one separator — never zero (the merge bug) and
    // never an extra blank line (when a stream already ended in "\n").
    .map((s) => (typeof s === "string" ? s.replace(/(\r?\n)+$/, "") : ""))
    .filter((s) => s.length > 0)
    .join("\n")
    .trim();

  const lines = combined.split(/\r?\n/);
  const sliced = head != null ? lines.slice(0, head) : tail != null ? lines.slice(-tail) : lines;

  return sliced.join("\n");
}

module.exports = { truncatedOutput };
