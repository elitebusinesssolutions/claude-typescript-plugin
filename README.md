# claude-typescript-plugin

Shared Claude Code lint/format hooks and formatting-setup/verification skills for TypeScript/JavaScript projects. Framework-agnostic — no Next.js or .NET assumptions.

## Install

This is the personal, one-machine install path. It works the same way whether or not the repo you're in has a committed `.claude/settings.json` — it's an explicit command, not something that depends on trust-dialog auto-detection (see [Consumer project setup](#consumer-project-setup-recommended) below for why that distinction matters). Run it once per machine per person; it doesn't reach anyone else's setup.

Add the marketplace:

```bash
claude plugin marketplace add elitebusinesssolutions/claude-typescript-plugin
```

Then install the plugin:

```bash
claude plugin install elite-ts@elite-ts-marketplace
```

This plugin can also be used with [copilot](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing) by replacing `claude` with `copilot`. E.g.

```bash
copilot plugin marketplace add elitebusinesssolutions/claude-typescript-plugin
copilot plugin install elite-ts@elite-ts-marketplace
```

## Update

```bash
claude plugin marketplace update elite-ts-marketplace
```

This refreshes the marketplace catalog only — follow it with `claude plugin update elite-ts@elite-ts-marketplace` to actually pull the new version. This manual pair always works regardless of whether `autoUpdate` is set anywhere; use it any time you don't want to wait for the next automatic startup check, or to confirm an update actually landed.

## Consumer project setup (recommended)

Running `claude plugin install` locally only configures your own machine — it doesn't reach any of your teammates', and each person has to repeat it themselves. For a team project, commit this to the project's own `.claude/settings.json` instead, so the plugin is declared for everyone who opens the repo:

```json
{
  "extraKnownMarketplaces": {
    "elite-ts-marketplace": {
      "source": {
        "source": "github",
        "repo": "elitebusinesssolutions/claude-typescript-plugin"
      },
      "autoUpdate": true
    }
  },
  "enabledPlugins": {
    "elite-ts@elite-ts-marketplace": true
  }
}
```

If the project doesn't have a `.claude/settings.json` yet, create it with just this content. If it already has one — for anything, not just this plugin's own hooks — merge `extraKnownMarketplaces` and `enabledPlugins` in as additional top-level keys; don't replace the file. This repo's own [`.claude/settings.json`](.claude/settings.json) is a working example of `enabledPlugins` sitting alongside an unrelated `hooks` block.

This does **not** reliably auto-install the plugin — declaring it in `settings.json` only makes Claude Code aware the project wants it. Trusting the folder is only evaluated through the interactive trust dialog, and does nothing in headless/print mode (`-p`), including in CI. Once installed, `autoUpdate: true` keeps that installation current without anyone manually running `claude plugin marketplace update` — third-party marketplaces default to auto-update off.

## Developing this plugin

To try a skill from this repo before it's released, load it unreleased with:

```bash
claude --plugin-dir .
```

then invoke it as `/elite-ts:<skill-name>` and run `/reload-plugins` after edits to pick up changes without restarting.

**This only works from a plain terminal, not the VS Code extension.** The VS Code extension launches its own managed `claude` process and has no setting to pass `--plugin-dir` (or any extra CLI flag) to it. If you're working in the VS Code extension, open a separate integrated or external terminal and run the command above there — it starts an independent CLI session, not the extension's chat panel. Hooks don't have this limitation: `.claude/settings.json` wires this repo's own hooks up directly via `${CLAUDE_PROJECT_DIR}`, so they run in any session (including the VS Code extension) without needing `--plugin-dir`.

## Skills

| Skill              | Invoke                       | Purpose                                                                    |
| ------------------ | ---------------------------- | -------------------------------------------------------------------------- |
| `setup-formatting` | `/elite-ts:setup-formatting` | Set up Prettier, ESLint auto-fix, EditorConfig, and VS Code format-on-save |
| `verify`           | `/elite-ts:verify`           | Type-check, lint, format-check, and run tests before declaring work done   |

## Hooks

Automatically wired when the plugin is enabled:

| Hook        | Trigger                | What it does                                       |
| ----------- | ---------------------- | -------------------------------------------------- |
| `format.js` | PostToolUse Write/Edit | Runs ESLint `--fix` + Prettier on every saved file |

## Testing skills (evals)

Skills are natural-language instructions, not deterministic code — you can't unit-test them the way `tests/*.test.js` tests the hooks. Instead, this repo uses the `skill-creator` plugin to run **evals**: give the skill a few realistic prompts, run Claude with and without the skill, and grade the responses against a checklist.

### Setup

`skill-creator@claude-plugins-official` is enabled at project scope (see `.claude/settings.json`), so it's available to everyone working in this repo. If it's ever missing:

```bash
claude plugin install skill-creator@claude-plugins-official --scope project
```

### Creating evals for a skill

Add `evals/evals.json` inside the skill's own directory (sibling to `SKILL.md`), e.g. `skills/<skill-name>/evals/evals.json`:

```json
{
  "skill_name": "<skill-name>",
  "evals": [
    {
      "id": 1,
      "prompt": "A realistic user prompt that should exercise the skill",
      "expected_output": "One-sentence description of what a good response looks like",
      "files": [],
      "expectations": [
        "An objectively checkable statement about the response",
        "Another one — these become the grading checklist"
      ]
    }
  ]
}
```

Write 2-3 prompts per skill covering the common case plus at least one edge case. Keep `expectations` objectively verifiable — "mentions running `npx eslint .`" grades cleanly, "sounds helpful" doesn't.

### Running the eval

Ask Claude to "run the eval harness for `<skill-name>`" and it will spawn with-skill/without-skill agent pairs, grade each response against `expectations`, and generate a review page. `<skill-name>-workspace/` is scratch output from that run — regenerate it locally rather than committing it; it's gitignored.

### CI

PR checks (`.github/workflows/ci.yml`) run **structural validation only** for any skill whose files changed in the PR: `evals/evals.json`, if present, must be valid JSON matching the schema above (non-empty `prompt` and `expectations` per eval). CI does not spawn real `claude -p` calls or grade responses — that requires an Anthropic API key and real token spend, so the qualitative with-skill/without-skill run above stays a manual (Claude-assisted) step, not an automated gate.

## Project-local skills/hooks

Anything specific to a single client project's own conventions (a project-specific lint rule, a project-specific hook) belongs in that project's own `.claude/` directory, not here — this repo stays generic across every project that installs it, TypeScript or plain JavaScript, Next.js or otherwise.
