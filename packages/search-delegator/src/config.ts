/**
 * Config load/save for pi-search-delegator.
 *
 * Stored as JSON at <agentDir>/search-delegator.json. Missing fields fall back
 * to DEFAULT_CONFIG so the file can be partial.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface Config {
  /** Tools to block on the main model. Defaults to search tools. */
  blocked_tools: string[];
  /** Name of the subagent the orchestrator must delegate to (matches the .md). */
  searcher_subagent_name: string;
  /** Model for the searcher agent (`provider/model`). Empty = inherit parent default. */
  searcher_model: string;
  /** Text sent to the orchestrator session at session start. */
  orchestrator_prompt: string;
}

const DEFAULT_ORCHESTRATOR_PROMPT = [
  "## Web Research",
  "",
  "You can search the web, fetch pages, and explore documentation sites via the",
  "searcher subagent:",
  "",
  '    subagent({ agent: "searcher", task: "<concrete request>" })',
  "",
  'Write specific tasks — e.g. "Find latest stable Diesel version; return version,',
  'date, source URL." The searcher returns compact findings with URLs. Cite those',
  "URLs. Batch related lookups into one delegation.",
].join("\n");

export const DEFAULT_CONFIG: Config = {
  blocked_tools: ["staan_search", "web_fetch", "llms_txt"],
  searcher_subagent_name: "searcher",
  searcher_model: "",
  orchestrator_prompt: DEFAULT_ORCHESTRATOR_PROMPT,
};

export function configPath(): string {
  return join(getAgentDir(), "search-delegator.json");
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    return sanitizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Field-by-field validation: a field of the wrong shape falls back to its
 * default instead of producing confusing failures downstream (a string
 * blocked_tools has no .join; a name with path separators would escape the
 * agents directory; a model with newlines would break the YAML frontmatter).
 */
function sanitizeConfig(raw: unknown): Config {
  const config = { ...DEFAULT_CONFIG };
  if (typeof raw !== "object" || raw === null) return config;
  const r = raw as Record<string, unknown>;
  if (
    Array.isArray(r.blocked_tools) &&
    r.blocked_tools.every((tool) => typeof tool === "string")
  ) {
    config.blocked_tools = r.blocked_tools as string[];
  }
  if (
    typeof r.searcher_subagent_name === "string" &&
    /^[\w-]+$/.test(r.searcher_subagent_name)
  ) {
    config.searcher_subagent_name = r.searcher_subagent_name;
  }
  if (
    typeof r.searcher_model === "string" &&
    !/[\r\n]/.test(r.searcher_model)
  ) {
    config.searcher_model = r.searcher_model;
  }
  if (typeof r.orchestrator_prompt === "string") {
    config.orchestrator_prompt = r.orchestrator_prompt;
  }
  return config;
}
