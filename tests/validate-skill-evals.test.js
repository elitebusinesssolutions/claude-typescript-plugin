const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { validateEvalsJson, changedSkillNames } = require("../scripts/validate-skill-evals");

const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "validate-skill-evals.js");

function validEvals() {
  return {
    skill_name: "example-skill",
    evals: [
      {
        id: 1,
        prompt: "Do the thing",
        expected_output: "It does the thing",
        expectations: ["Response mentions the thing"]
      }
    ]
  };
}

test("a well-formed evals.json passes with no errors", () => {
  const errors = validateEvalsJson(validEvals(), "example-skill");
  assert.deepEqual(errors, []);
});

test("expectations field is optional", () => {
  const data = validEvals();
  delete data.evals[0].expectations;
  const errors = validateEvalsJson(data, "example-skill");
  assert.deepEqual(errors, []);
});

test("top-level non-object is rejected", () => {
  const errors = validateEvalsJson([1, 2, 3], "example-skill");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /single JSON object/);
});

test("missing skill_name is flagged", () => {
  const data = validEvals();
  delete data.skill_name;
  const errors = validateEvalsJson(data, "example-skill");
  assert.ok(errors.some((e) => /skill_name must be a non-empty string/.test(e)));
});

test("skill_name mismatch with directory name is flagged", () => {
  const data = validEvals();
  data.skill_name = "wrong-name";
  const errors = validateEvalsJson(data, "example-skill");
  assert.ok(errors.some((e) => /does not match its directory name/.test(e)));
});

test("empty evals array is flagged", () => {
  const data = validEvals();
  data.evals = [];
  const errors = validateEvalsJson(data, "example-skill");
  assert.ok(errors.some((e) => /non-empty array/.test(e)));
});

test("eval missing prompt is flagged", () => {
  const data = validEvals();
  delete data.evals[0].prompt;
  const errors = validateEvalsJson(data, "example-skill");
  assert.ok(errors.some((e) => /prompt must be a non-empty string/.test(e)));
});

test("eval with blank prompt is flagged", () => {
  const data = validEvals();
  data.evals[0].prompt = "   ";
  const errors = validateEvalsJson(data, "example-skill");
  assert.ok(errors.some((e) => /prompt must be a non-empty string/.test(e)));
});

test("duplicate eval ids are flagged", () => {
  const data = validEvals();
  data.evals.push({ id: 1, prompt: "Another prompt" });
  const errors = validateEvalsJson(data, "example-skill");
  assert.ok(errors.some((e) => /is duplicated/.test(e)));
});

test("non-array expectations is flagged", () => {
  const data = validEvals();
  data.evals[0].expectations = "not an array";
  const errors = validateEvalsJson(data, "example-skill");
  assert.ok(errors.some((e) => /non-empty array/.test(e)));
});

test("expectations with a blank entry is flagged", () => {
  const data = validEvals();
  data.evals[0].expectations = ["fine", "  "];
  const errors = validateEvalsJson(data, "example-skill");
  assert.ok(errors.some((e) => /non-empty strings/.test(e)));
});

test("changedSkillNames throws a clean error for an unresolvable base ref", () => {
  assert.throws(
    () => changedSkillNames("totally-bogus-ref-does-not-exist"),
    (err) =>
      err instanceof Error &&
      /could not diff against base ref "totally-bogus-ref-does-not-exist"/.test(err.message)
  );
});

test("CLI exits cleanly (no uncaught stack trace) for an unresolvable base ref", () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, "totally-bogus-ref-does-not-exist"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not diff against base ref "totally-bogus-ref-does-not-exist"/);
  // A raw uncaught exception would print a Node stack trace naming the
  // throwing function/file — make sure we get the clean message instead.
  assert.ok(!/^Error:/m.test(result.stderr));
  assert.ok(!/at changedSkillNames/.test(result.stderr));
  assert.ok(!/at main/.test(result.stderr));
});
