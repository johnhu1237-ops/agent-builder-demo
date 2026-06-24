export type RegistryItem = {
  id: string;
  label: string;
  description: string;
};

export type AppRegistryItem = RegistryItem & {
  mode: "configuration-only";
};

export type SkillRegistryItem = RegistryItem & {
  instructions: string;
};

export type AbilityRegistryItem = RegistryItem & {
  realCapability: boolean;
};

export const appRegistry: AppRegistryItem[] = [
  {
    id: "mock-github",
    label: "GitHub",
    description: "Mock repository context for future MCP integration.",
    mode: "configuration-only"
  },
  {
    id: "mock-slack",
    label: "Slack",
    description: "Mock team notification app for future MCP integration.",
    mode: "configuration-only"
  },
  {
    id: "mock-notion",
    label: "Notion",
    description: "Mock knowledge base app for future MCP integration.",
    mode: "configuration-only"
  }
];

export const skillRegistry: SkillRegistryItem[] = [
  {
    id: "research-synthesis",
    label: "Research synthesis",
    description: "Combine findings into a clear, concise research narrative.",
    instructions: "Synthesize findings into a concise report with clear sections and no unsupported claims."
  },
  {
    id: "source-citation",
    label: "Source citation",
    description: "Prefer cited facts and note uncertainty.",
    instructions: "Cite sources when available. If a fact cannot be verified, mark it as unknown or uncertain."
  },
  {
    id: "executive-summary",
    label: "Executive summary",
    description: "Start with the most useful conclusion.",
    instructions: "Begin the final report with a short executive summary and then provide supporting details."
  }
];

export const abilityRegistry: AbilityRegistryItem[] = [
  {
    id: "web-research",
    label: "Web Research",
    description: "Allows the runner to use web search for current information.",
    realCapability: true
  }
];

export function findRegistryItem<T extends RegistryItem>(items: T[], id: string): T | undefined {
  return items.find((item) => item.id === id);
}
