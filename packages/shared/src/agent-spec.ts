import { z } from "zod";
import { abilityRegistry, appRegistry, findRegistryItem, skillRegistry } from "./plugin-registry";

export const enabledAppSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  mode: z.literal("configuration-only")
});

export const enabledSkillSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean()
});

export const enabledAbilitySchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean()
});

export const agentSpecSchema = z.object({
  version: z.literal("0.1"),
  identity: z.object({
    name: z.string().min(1, "Agent name is required"),
    description: z.string().min(1, "Agent description is required")
  }),
  systemPrompt: z.string().min(1, "System prompt is required"),
  model: z.object({
    provider: z.enum(["openai", "openai-compatible"]),
    name: z.string().min(1, "Model name is required"),
    apiEndpoint: z.string().url("API endpoint must be a valid URL"),
    apiKey: z.string().optional(),
    apiKeyRef: z.literal("runtime-only").optional()
  }),
  apps: z.array(enabledAppSchema),
  skills: z.array(enabledSkillSchema),
  abilities: z.array(enabledAbilitySchema),
  output: z.object({
    format: z.literal("markdown")
  })
});

export type AgentSpec = z.infer<typeof agentSpecSchema>;

export const defaultAgentSpec: AgentSpec = {
  version: "0.1",
  identity: {
    name: "Research Agent",
    description: "Researches companies, products, or markets and writes concise Markdown reports."
  },
  systemPrompt:
    "You are a careful research agent. Use available web research capability. Do not fabricate facts. Produce a concise Markdown report.",
  model: {
    provider: "openai-compatible",
    name: "gpt-5",
    apiEndpoint: "https://api.openai.com/v1",
    apiKeyRef: "runtime-only"
  },
  apps: [
    { id: "mock-github", enabled: false, mode: "configuration-only" },
    { id: "mock-slack", enabled: false, mode: "configuration-only" },
    { id: "mock-notion", enabled: false, mode: "configuration-only" }
  ],
  skills: [
    { id: "research-synthesis", enabled: true },
    { id: "source-citation", enabled: true },
    { id: "executive-summary", enabled: true }
  ],
  abilities: [{ id: "web-research", enabled: true }],
  output: { format: "markdown" }
};

export type ValidationResult =
  | { success: true; data: AgentSpec }
  | { success: false; error: Error };

export function validateAgentSpec(input: unknown): ValidationResult {
  const parsed = agentSpecSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: new Error(parsed.error.message) };
  }

  for (const app of parsed.data.apps) {
    if (!findRegistryItem(appRegistry, app.id)) {
      return { success: false, error: new Error(`Unknown app id: ${app.id}`) };
    }
  }

  for (const skill of parsed.data.skills) {
    if (!findRegistryItem(skillRegistry, skill.id)) {
      return { success: false, error: new Error(`Unknown skill id: ${skill.id}`) };
    }
  }

  for (const ability of parsed.data.abilities) {
    if (!findRegistryItem(abilityRegistry, ability.id)) {
      return { success: false, error: new Error(`Unknown ability id: ${ability.id}`) };
    }
  }

  return { success: true, data: parsed.data };
}

export function exportAgentSpec(spec: AgentSpec): AgentSpec {
  const { apiKey: _apiKey, ...modelWithoutKey } = spec.model;
  return {
    ...spec,
    model: {
      ...modelWithoutKey,
      apiKeyRef: "runtime-only"
    }
  };
}
