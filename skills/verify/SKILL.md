---
name: verify
description: Type-check with tsc, lint with ESLint, check formatting with Prettier, and run the test suite for a TypeScript/JavaScript project. Use after finishing a coding task and before declaring it complete, or whenever asked to check that the project builds, lints, and passes its tests.
---

Verify that recent changes to this project are actually correct — don't just assume they are. Run each check below that applies to this project's actual setup, in order, and only declare the work done once every applicable check is clean.

## 1. Determine what applies

Skipping a check below because its precondition isn't met is correct behavior, not a failure to report — a plain-JS project with no `tsconfig.json` is not "failing" type-checking, it simply doesn't have any.

- `tsconfig.json` in the project root → type-check applies
- An ESLint config (`eslint.config.*`, `.eslintrc.*`, or an `eslintConfig` key in `package.json`) → lint applies
- `prettier` present as a devDependency (or a `.prettierrc*` / `prettier` key in `package.json`) → format applies
- A `test` script in `package.json`'s `scripts` → tests apply

If none of the four apply, say so plainly and stop — there is nothing to verify.

## 2. Lint

If lint applies, run `npx eslint --fix .`. This auto-fixes what it can; report any remaining errors verbatim (file, line, rule) — don't summarize a list of errors down to "a few lint issues."

## 3. Format

If format applies, run the project's `format` script if one exists (`npm run format`), otherwise `npx prettier --write --ignore-unknown .`. Report any file Prettier could not parse.

## 4. Type-check

If type-check applies, run `npx tsc --noEmit`. Report every error with its file and line — do not truncate the list or paraphrase it away.

## 5. Test

If tests apply, run `npm test`. Report the names of any failing tests along with their assertion output, not just a pass/fail count.

## 6. Report a verdict

State plainly which of the four checks ran, which were skipped and why, and whether the project is clean. If any applicable check still fails after steps 2–3's auto-fixes, do not declare the task complete: fix the actual issue (a type error, a failing test, an unfixable lint rule) yourself, then re-run this skill before finishing.
