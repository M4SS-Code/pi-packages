import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Redirect the agent dir before any call — getAgentDir reads the environment
// at call time, so each test gets a fresh directory via beforeEach.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(
  join(tmpdir(), "delegator-test-"),
);

const { searcherPath, syncSearcherTemplate } =
  await import("./searcher-template");
const { DEFAULT_CONFIG, configPath, loadConfig } = await import("./config");

function freshAgentDir(): void {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(
    join(tmpdir(), "delegator-test-"),
  );
}

describe("syncSearcherTemplate", () => {
  beforeEach(freshAgentDir);

  it("writes the template on first run", () => {
    const config = { ...DEFAULT_CONFIG };
    assert.equal(syncSearcherTemplate(config), "written");
    const content = readFileSync(
      searcherPath(config.searcher_subagent_name),
      "utf8",
    );
    assert.match(content, /^name: searcher$/m);
    assert.match(content, /^tools: staan_search, web_fetch, llms_txt$/m);
  });

  it("is a no-op when nothing changed", () => {
    const config = { ...DEFAULT_CONFIG };
    syncSearcherTemplate(config);
    assert.equal(syncSearcherTemplate(config), "unchanged");
  });

  it("rewrites its own file when the config changes", () => {
    syncSearcherTemplate({ ...DEFAULT_CONFIG });
    const changed = { ...DEFAULT_CONFIG, searcher_model: "anthropic/claude-x" };
    assert.equal(syncSearcherTemplate(changed), "written");
    const content = readFileSync(
      searcherPath(changed.searcher_subagent_name),
      "utf8",
    );
    assert.match(content, /^model: anthropic\/claude-x$/m);
  });

  it("grants the searcher the configured blocked tools", () => {
    const config = {
      ...DEFAULT_CONFIG,
      blocked_tools: ["web_search", "my_fetch"],
    };
    syncSearcherTemplate(config);
    const content = readFileSync(
      searcherPath(config.searcher_subagent_name),
      "utf8",
    );
    assert.match(content, /^tools: web_search, my_fetch$/m);
  });

  it("falls back to the default grant when the block list is empty", () => {
    const config = { ...DEFAULT_CONFIG, blocked_tools: [] };
    syncSearcherTemplate(config);
    const content = readFileSync(
      searcherPath(config.searcher_subagent_name),
      "utf8",
    );
    assert.match(content, /^tools: staan_search, web_fetch, llms_txt$/m);
  });

  it("reports a hand edit once, then keeps quiet", () => {
    const config = { ...DEFAULT_CONFIG };
    syncSearcherTemplate(config);
    const path = searcherPath(config.searcher_subagent_name);
    writeFileSync(path, "# my custom searcher\n");

    assert.equal(syncSearcherTemplate(config), "user-modified");
    assert.equal(syncSearcherTemplate(config), "user-kept");
    assert.equal(readFileSync(path, "utf8"), "# my custom searcher\n");

    // a new distinct edit warns again
    writeFileSync(path, "# my other searcher\n");
    assert.equal(syncSearcherTemplate(config), "user-modified");
  });

  it("re-adopts the file when the user restores our content", () => {
    const config = { ...DEFAULT_CONFIG };
    syncSearcherTemplate(config);
    const path = searcherPath(config.searcher_subagent_name);
    const ours = readFileSync(path, "utf8");
    writeFileSync(path, "# custom\n");
    assert.equal(syncSearcherTemplate(config), "user-modified");
    writeFileSync(path, ours);
    assert.equal(syncSearcherTemplate(config), "unchanged");
  });
});

describe("loadConfig", () => {
  beforeEach(freshAgentDir);

  function writeConfig(value: unknown): void {
    writeFileSync(configPath(), JSON.stringify(value));
  }

  it("returns defaults when the file is missing or corrupt", () => {
    assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
    writeFileSync(configPath(), "{ not json");
    assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
  });

  it("merges valid fields", () => {
    writeConfig({
      blocked_tools: ["web_search"],
      searcher_model: "openai/gpt-x",
    });
    const config = loadConfig();
    assert.deepEqual(config.blocked_tools, ["web_search"]);
    assert.equal(config.searcher_model, "openai/gpt-x");
    assert.equal(config.searcher_subagent_name, "searcher");
  });

  it("falls back per field on wrong shapes", () => {
    writeConfig({
      blocked_tools: "web_fetch",
      searcher_subagent_name: "../evil",
      searcher_model: "model\ntools: bash",
      orchestrator_prompt: 42,
    });
    assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
  });

  it("rejects non-string entries in blocked_tools", () => {
    writeConfig({ blocked_tools: ["ok", 42] });
    assert.deepEqual(loadConfig().blocked_tools, DEFAULT_CONFIG.blocked_tools);
  });
});
