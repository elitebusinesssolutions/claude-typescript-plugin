const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateEvalsJson } = require("../scripts/validate-skill-evals");

function validEvals() {
  return {
    skill_name: "example-skill",
    evals: [
      {
        id: 1,
        prompt: "Do the thing",
        expected_output: "It does the thing",
        expectations: ["Response mentions the thing"],
      },
    ],
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
  assert.ok(
    errors.some((e) => /skill_name must be a non-empty string/.test(e)),
  );
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
