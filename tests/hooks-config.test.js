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
      assert.ok(Array.isArray(hook.args), `Expected args array for node hook on ${eventName}`);
      assert.ok(hook.args.length >= 1, `Expected script path arg for node hook on ${eventName}`);
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

// CLAUDE.md requires hooks/hooks.json (${CLAUDE_PLUGIN_ROOT}) and
// .claude/settings.json (${CLAUDE_PROJECT_DIR}) to stay structurally
// identical: same events, same matchers, same hook count/order, same
// timeout/statusMessage/type/command, and the same script path once the
// path-variable prefix is normalized away. Nothing else enforces this, so
// this test diffs the two trees field-by-field to catch silent drift.
function normalizeHookArgs(args) {
  return (Array.isArray(args) ? args : []).map((arg) =>
    typeof arg === "string"
      ? arg.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, "").replace(/^\$\{CLAUDE_PROJECT_DIR\}\//, "")
      : arg
  );
}

test("hooks/hooks.json and .claude/settings.json stay structurally in sync", () => {
  const pluginHooks = readJson("hooks/hooks.json");
  const settings = readJson(".claude/settings.json");

  const pluginEvents = Object.keys(pluginHooks.hooks ?? {});
  const settingsEvents = Object.keys(settings.hooks ?? {});

  assert.deepStrictEqual(
    settingsEvents,
    pluginEvents,
    "hooks/hooks.json and .claude/settings.json must declare the same hook events, in the same order"
  );

  for (const eventName of pluginEvents) {
    const pluginGroups = pluginHooks.hooks[eventName] ?? [];
    const settingsGroups = settings.hooks[eventName] ?? [];

    assert.ok(Array.isArray(pluginGroups), `Expected hooks/hooks.json groups array for event "${eventName}"`);
    assert.ok(
      Array.isArray(settingsGroups),
      `Expected .claude/settings.json groups array for event "${eventName}"`
    );

    assert.strictEqual(
      settingsGroups.length,
      pluginGroups.length,
      `Mismatched number of hook groups for event "${eventName}"`
    );

    pluginGroups.forEach((pluginGroup, groupIndex) => {
      const settingsGroup = settingsGroups[groupIndex] ?? {};

      assert.strictEqual(
        settingsGroup.matcher,
        pluginGroup.matcher,
        `Mismatched matcher for event "${eventName}" group ${groupIndex}`
      );

      const pluginGroupHooks = pluginGroup.hooks ?? [];
      const settingsGroupHooks = settingsGroup.hooks ?? [];

      assert.strictEqual(
        settingsGroupHooks.length,
        pluginGroupHooks.length,
        `Mismatched number of hooks for event "${eventName}" group ${groupIndex}`
      );

      pluginGroupHooks.forEach((pluginHook, hookIndex) => {
        const settingsHook = settingsGroupHooks[hookIndex] ?? {};
        const label = `event "${eventName}" group ${groupIndex} hook ${hookIndex}`;

        assert.strictEqual(settingsHook.type, pluginHook.type, `Mismatched type for ${label}`);
        assert.strictEqual(
          settingsHook.command,
          pluginHook.command,
          `Mismatched command for ${label}`
        );
        assert.strictEqual(
          settingsHook.timeout,
          pluginHook.timeout,
          `Mismatched timeout for ${label}`
        );
        assert.strictEqual(
          settingsHook.statusMessage,
          pluginHook.statusMessage,
          `Mismatched statusMessage for ${label}`
        );
        assert.deepStrictEqual(
          normalizeHookArgs(settingsHook.args),
          normalizeHookArgs(pluginHook.args),
          `Mismatched args (ignoring \${CLAUDE_PLUGIN_ROOT}/\${CLAUDE_PROJECT_DIR} prefix) for ${label}`
        );
      });
    });
  }
});
