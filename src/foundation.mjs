import { Text } from "@earendil-works/pi-tui";

/** @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi */
export default function foundation(pi) {
  pi.on("before_agent_start", (event) => {
    // Change only the default persona; retain skills, context and explicit user prompts.
    event.systemPromptOptions.customPrompt ??= "You are Siftory, a general-purpose AI assistant. Help users answer questions, analyze information, write, and complete tasks using the available tools. Be concise and clear about uncertainty.";
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((_tui, theme) => new Text(theme.fg("accent", theme.bold("Siftory")), 0, 0));
  });
}
