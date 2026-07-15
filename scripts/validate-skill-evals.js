#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");

function changedSkillNames(baseRef) {
  let diff;
  try {
    diff = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    });
  } catch (err) {
    throw new Error(
      `could not diff against base ref "${baseRef}" (unfetched ref, typo, or a shallow clone missing the base commit): ${err.message}`,
      { cause: err }
    );
  }

  const names = new Set();
  for (const line of diff.split("\n")) {
    const match = /^skills\/([^/]+)\//.exec(line.trim());
    if (match && !match[1].endsWith("-workspace")) {
      names.add(match[1]);
    }
  }
  return [...names];
}

function validateEvalsJson(data, skillName) {
  const errors = [];

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return ["evals.json must contain a single JSON object"];
  }

  if (typeof data.skill_name !== "string" || data.skill_name.length === 0) {
    errors.push("skill_name must be a non-empty string");
  } else if (data.skill_name !== skillName) {
    errors.push(`skill_name "${data.skill_name}" does not match its directory name "${skillName}"`);
  }

  if (!Array.isArray(data.evals) || data.evals.length === 0) {
    errors.push("evals must be a non-empty array");
    return errors;
  }

  const seenIds = new Set();
  data.evals.forEach((evalCase, index) => {
    const label = `evals[${index}]`;

    if (typeof evalCase.id !== "number") {
      errors.push(`${label}.id must be a number`);
    } else if (seenIds.has(evalCase.id)) {
      errors.push(`${label}.id ${evalCase.id} is duplicated`);
    } else {
      seenIds.add(evalCase.id);
    }

    if (typeof evalCase.prompt !== "string" || evalCase.prompt.trim().length === 0) {
      errors.push(`${label}.prompt must be a non-empty string`);
    }

    if (evalCase.expectations !== undefined) {
      if (!Array.isArray(evalCase.expectations) || evalCase.expectations.length === 0) {
        errors.push(`${label}.expectations, if present, must be a non-empty array`);
      } else if (
        evalCase.expectations.some((e) => typeof e !== "string" || e.trim().length === 0)
      ) {
        errors.push(`${label}.expectations must contain only non-empty strings`);
      }
    }
  });

  return errors;
}

function main() {
  const baseRef = process.argv[2];
  if (!baseRef) {
    console.error("Usage: node validate-skill-evals.js <base-ref>");
    process.exit(1);
  }

  let skillNames;
  try {
    skillNames = changedSkillNames(baseRef);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (skillNames.length === 0) {
    console.log("No changed files under skills/ — nothing to validate.");
    return;
  }

  let hadFailure = false;

  for (const skillName of skillNames) {
    const evalsPath = path.join(REPO_ROOT, "skills", skillName, "evals", "evals.json");
    if (!fs.existsSync(evalsPath)) {
      console.log(`- ${skillName}: no evals/evals.json (not all skills need one) — skipped`);
      continue;
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(evalsPath, "utf8"));
    } catch (err) {
      console.error(`- ${skillName}: evals/evals.json is not valid JSON (${err.message})`);
      hadFailure = true;
      continue;
    }

    const errors = validateEvalsJson(data, skillName);
    if (errors.length === 0) {
      console.log(`- ${skillName}: evals/evals.json OK (${data.evals.length} eval case(s))`);
    } else {
      console.error(`- ${skillName}: evals/evals.json is invalid:`);
      for (const error of errors) {
        console.error(`    - ${error}`);
      }
      hadFailure = true;
    }
  }

  if (hadFailure) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { validateEvalsJson, changedSkillNames };
