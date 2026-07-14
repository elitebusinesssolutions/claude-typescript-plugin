const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function readJson(relPath) {
  const abs = path.resolve(__dirname, "..", relPath);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function collectCommandHooks(configObj) {
  const out = [];
  const hooksRoot = configObj?.hooks ?? {};
  for (const eventName of Object.keys(hooksRoot)) {
    const groups = hooksRoot[eventName] ?? [];
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (hook?.type === "command") {
          out.push({ eventName, hook });
        }
      }
    }
  }
  return out;
}

function assertNodeHooksUseExecForm(commandHooks) {
  for (const { eventName, hook } of commandHooks) {
    if (hook.command === "node") {
      assert.ok(
        Array.isArray(hook.args),
        `Expected args array for node hook on ${eventName}`,
      );
      assert.ok(
        hook.args.length >= 1,
        `Expected script path arg for node hook on ${eventName}`,
      );
    }
  }
}

test("plugin hooks use documented node exec form", () => {
  const pluginHooks = readJson("hooks/hooks.json");
  const commandHooks = collectCommandHooks(pluginHooks);
  assertNodeHooksUseExecForm(commandHooks);
});

test("project settings template uses documented node exec form", () => {
  const settings = readJson(".claude/settings.json");
  const commandHooks = collectCommandHooks(settings);
  assertNodeHooksUseExecForm(commandHooks);
});
