import type { AgentSpec } from "./agent-spec";
import { abilityRegistry, appRegistry, findRegistryItem, skillRegistry } from "./plugin-registry";

export type MaterializePromptInput = {
  agentSpec: AgentSpec;
  task: string;
};

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
    enabledApps.length
      ? enabledApps
          .map((app) => `- ${app!.label}: ${app!.description} (${app!.mode})`)
          .join("\n")
      : "- None",
    "",
    "## Output Contract",
    "Return only the final answer as a Markdown report. Do not include JSON. Do not mention the internal runner.",
    "",
    "## User Task",
    task
  ].join("\n");
}
