/**
 * Writes the searcher subagent definition consumed by pi-subagents.
 *
 * Restricts the agent to exactly the tools blocked on the main model
 * (default: staan_search, web_fetch, llms_txt) so the two lists can never
 * drift apart — whatever the orchestrator loses, the searcher gains, and
 * nothing else. The main model is restricted by the search-delegator
 * extension (hasUI guard); the child is restricted inline.
 *
 * A hash of the last template we wrote is kept in
 * <agentDir>/search-delegator.state.json; when the file on disk no longer
 * matches it, the user edited the template by hand and we leave it alone.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Config, DEFAULT_CONFIG } from "./config";
import { atomicFileWrite } from "./utils";

export type SyncResult =
  "written" | "unchanged" | "user-modified" | "user-kept";

interface SyncState {
  /** Hash of the last template this extension wrote. */
  templateHash?: string;
  /** Hash of a user-edited searcher.md the user was already warned about. */
  userEditHash?: string;
}

export function searcherPath(name: string): string {
  return join(getAgentDir(), "agents", `${name}.md`);
}

function statePath(): string {
  return join(getAgentDir(), "search-delegator.state.json");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function loadState(): SyncState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as SyncState;
  } catch {
    return {};
  }
}

function saveState(state: SyncState): void {
  atomicFileWrite(statePath(), `${JSON.stringify(state, null, 2)}\n`);
}

function renderTemplate(config: Config): string {
  // Grant the searcher exactly what the orchestrator loses. An empty block
  // list would grant nothing, which makes the searcher useless — fall back to
  // the default web tools in that case.
  const grantedTools = config.blocked_tools.length
    ? config.blocked_tools
    : DEFAULT_CONFIG.blocked_tools;
  const front = [
    "---",
    `name: ${config.searcher_subagent_name}`,
    "description: Web research specialist: searches the web, fetches pages, and explores docs sites; returns compact findings with source URLs",
    `tools: ${grantedTools.join(", ")}`,
  ];
  if (config.searcher_model.trim()) {
    front.push(`model: ${config.searcher_model.trim()}`);
  }
  front.push("---", "");

  const body = [
    "You are a focused web research agent. Return compact, sourced answers.",
    "",
    "## Tools",
    "- `staan_search`: discover information, find URLs. Use `site:domain` or `-domain` to narrow. For known URLs, use `web_fetch` directly.",
    "- `web_fetch`: retrieve a known URL's content as Markdown. Prefer raw/API endpoints over HTML. To discover URLs, use `staan_search` first.",
    "- `llms_txt`: map a docs site's structure before fetching individual pages. Skip for blogs/news.",
    "",
    "## Rules",
    "- Prefer official docs, registries, and primary sources.",
    "- Verify claims against fetched content, not search snippets.",
    "- If you cannot find something, state what you tried.",
    "",
    "## Output",
    "Lead with the direct answer. Follow with `Sources:` listing URLs used.",
  ].join("\n");

  return `${front.join("\n")}${body}\n`;
}

/**
 * Write the searcher template, preserving user edits:
 *
 * - missing file → write
 * - file matches the current template → nothing to do
 * - file matches the last template we wrote → overwrite (config changed)
 * - anything else → the user edited it by hand; leave it alone
 *
 * A hand-edited file is reported as "user-modified" only the first time a
 * given edit is seen (so the caller warns once); afterwards it is
 * "user-kept" until the edit changes again or the file goes back to ours.
 *
 * Installs that predate the state file are treated as ours (the old code
 * rewrote unconditionally, so grandfathering keeps their behavior unchanged).
 */
export function syncSearcherTemplate(config: Config): SyncResult {
  const path = searcherPath(config.searcher_subagent_name);
  const next = renderTemplate(config);
  const state = loadState();

  let current: string | undefined;
  if (existsSync(path)) {
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = undefined;
    }
  }

  if (current === next) {
    if (state.templateHash !== sha256(next) || state.userEditHash) {
      saveState({ templateHash: sha256(next) });
    }
    return "unchanged";
  }

  if (
    current !== undefined &&
    state.templateHash !== undefined &&
    sha256(current) !== state.templateHash
  ) {
    const editHash = sha256(current);
    if (state.userEditHash === editHash) return "user-kept";
    saveState({ ...state, userEditHash: editHash });
    return "user-modified";
  }

  atomicFileWrite(path, next);
  saveState({ templateHash: sha256(next) });
  return "written";
}
