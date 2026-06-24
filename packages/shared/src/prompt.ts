import type { AgentSpec } from "./agent-spec";
import type { AppRegistryItem } from "./plugin-registry";
import { abilityRegistry, appRegistry, findRegistryItem, skillRegistry } from "./plugin-registry";

export type MaterializePromptInput = {
  agentSpec: AgentSpec;
  task: string;
};

function formatAppRegistryItem(app: AppRegistryItem) {
  return `- ${app.label}: ${app.description} (${app.mode})`;
}

function formatRegistryList<T extends { id: string; label: string; description: string }>(
  items: Array<T | undefined>
): string[] {
  const resolved = items.filter((item): item is T => Boolean(item));
  return resolved.length ? resolved.map((item) => `- ${item.label}: ${item.description}`) : ["- None"];
}

function formatSkillRegistryList(items: Array<(typeof skillRegistry)[number] | undefined>): string[] {
  const resolved = items.filter((item): item is (typeof skillRegistry)[number] => Boolean(item));
  return resolved.length ? resolved.map((item) => `- ${item.label}: ${item.instructions}`) : ["- None"];
}

export function materializePrompt({ agentSpec, task }: MaterializePromptInput): string {
  const enabledApps = agentSpec.apps
    .filter((app) => app.enabled)
    .map((app) => findRegistryItem(appRegistry, app.id))
    .filter(Boolean);

  const enabledSkills = agentSpec.skills
    .filter((skill) => skill.enabled)
    .map((skill) => findRegistryItem(skillRegistry, skill.id))
    .filter(Boolean);

  const enabledAbilities = agentSpec.abilities
    .filter((ability) => ability.enabled)
    .map((ability) => findRegistryItem(abilityRegistry, ability.id))
    .filter(Boolean);

  return [
    `# Agent: ${agentSpec.identity.name}`,
    "",
    `Persona: ${agentSpec.identity.persona}`,
    `Description: ${agentSpec.identity.description}`,
    "",
    "## System Instructions",
    agentSpec.systemPrompt,
    "",
    "## Enabled Abilities",
    enabledAbilities.length
      ? enabledAbilities.map((ability) => `- ${ability!.label}: ${ability!.description}`).join("\n")
      : "- None",
    "",
    "## Enabled Skills",
    enabledSkills.length
      ? enabledSkills.map((skill) => `- ${skill!.label}: ${skill!.instructions}`).join("\n")
      : "- None",
    "",
    "## Enabled Apps",
    enabledApps.length ? enabledApps.map((app) => formatAppRegistryItem(app!)).join("\n") : "- None",
    "",
    "## Output Contract",
    "Return only the final answer as a Markdown report. Do not include JSON. Do not mention the internal runner.",
    "",
    "## User Task",
    task
  ].join("\n");
}

export function materializeChatPrompt(input: {
  agentSpec: AgentSpec;
  message: string;
  isResume: boolean;
}): string {
  const enabledApps = input.agentSpec.apps
    .filter((app) => app.enabled)
    .map((app) => findRegistryItem(appRegistry, app.id));

  const enabledSkills = input.agentSpec.skills
    .filter((skill) => skill.enabled)
    .map((skill) => findRegistryItem(skillRegistry, skill.id));

  const enabledAbilities = input.agentSpec.abilities
    .filter((ability) => ability.enabled)
    .map((ability) => findRegistryItem(abilityRegistry, ability.id));

  const sessionInstruction = input.isResume
    ? `You are continuing an existing ${input.agentSpec.identity.name} chat session.`
    : `You are starting a new ${input.agentSpec.identity.name} chat session.`;

  return [
    `# ${input.agentSpec.identity.name}`,
    "",
    input.agentSpec.identity.description,
    "",
    `Persona: ${input.agentSpec.identity.persona}`,
    "",
    "## System Instructions",
    input.agentSpec.systemPrompt,
    "",
    "## Session Instruction",
    sessionInstruction,
    "Do not expose internal runner details, Codex CLI commands, session ids, workspace paths, raw logs, or secret handling in the final user-visible response.",
    "Return the final answer as Markdown.",
    "",
    "## Enabled Apps",
    enabledApps.length ? enabledApps.map((app) => formatAppRegistryItem(app!)).join("\n") : "- None",
    "",
    "## Enabled Skills",
    ...formatSkillRegistryList(enabledSkills),
    "",
    "## Enabled Abilities",
    ...formatRegistryList(enabledAbilities),
    "",
    "## Current User Message",
    input.message
  ].join("\n");
}
