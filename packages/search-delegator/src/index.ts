/**
 * pi-search-delegator
 *
 * Removes the web tools (staan_search, web_fetch, llms_txt) from the main interactive
 * model and instructs it to delegate web work to a "searcher" subagent
 * (powered by pi-subagents). Keeps the orchestrator focused and keeps raw
 * search/fetch payloads out of its context.
 *
 * Activation is guarded by ctx.hasUI, so the headless searcher child — which
 * loads this same extension — is never stripped of its web tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import {
  searcherPath,
  syncSearcherTemplate,
  type SyncResult,
} from "./searcher-template";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tools that must never be removed, or the orchestrator could not delegate. */
const FORCE_KEEP = new Set(["subagent"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeActiveTools(pi: ExtensionAPI, blocked: string[]): string[] {
  const blockedSet = new Set(blocked);
  // Start from the tools that are active right now — starting from all
  // configured tools would resurrect anything the user or another extension
  // deliberately deactivated.
  const active = pi
    .getActiveTools()
    .filter((name) => FORCE_KEEP.has(name) || !blockedSet.has(name));
  // The delegation target must stay available even if something deactivated it
  for (const name of FORCE_KEEP) {
    if (
      !active.includes(name) &&
      pi.getAllTools().some((tool) => tool.name === name)
    ) {
      active.push(name);
    }
  }
  return active;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  let templateSync: SyncResult | undefined;

  const applyBlocking = () =>
    pi.setActiveTools(computeActiveTools(pi, config.blocked_tools));

  const statusText = () =>
    [
      `Blocked tools: ${config.blocked_tools.join(", ") || "(none)"}`,
      `Searcher subagent: ${config.searcher_subagent_name}`,
      `Searcher template: ${templateSync ?? "not synced"} (${searcherPath(config.searcher_subagent_name)})`,
    ].join("\n");

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  // Sync the searcher template, strip web tools, and inject guidance once at
  // session start. Never in headless children (the searcher), which run with
  // hasUI === false — running the sync there would race concurrent children.
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Without the subagent tool there is nothing to delegate to — blocking
    // the web tools would leave the session with no web capability at all.
    if (!pi.getAllTools().some((tool) => tool.name === "subagent")) {
      ctx.ui.notify(
        "search-delegator: no subagent tool found (is pi-subagents installed?) — leaving web tools unblocked",
        "warning",
      );
      return;
    }

    templateSync = syncSearcherTemplate(config);
    if (templateSync === "user-modified") {
      ctx.ui.notify(
        `search-delegator: ${searcherPath(config.searcher_subagent_name)} was edited by hand — leaving it as is`,
        "warning",
      );
    }

    applyBlocking();
    pi.sendMessage({
      customType: "search-delegator-guidance",
      content: config.orchestrator_prompt,
      display: false,
    });
  });

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  pi.registerCommand("search-delegator", {
    description: "Show pi-search-delegator status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(statusText(), "info");
    },
  });
}
