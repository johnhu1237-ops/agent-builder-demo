# Configurable Code Agent Builder Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Railway-ready v0.1 configurable code-agent builder with one Research Agent, runtime-only model credentials, mock app/skill configuration, a hidden Codex CLI runner, and Markdown final output.

**Architecture:** Create a small TypeScript workspace with three packages: shared domain contracts, an Express API/runner orchestrator, and a Vite React UI. The v0.1 API uses in-memory persistence to keep the skeleton fast, while the runner boundary is explicit so Railway/Postgres and stronger isolation can be added later without rewriting the UI.

**Tech Stack:** TypeScript, Vite, React, Express, Vitest, Zod, React Markdown, Node child process APIs, Docker, Railway.

---

## Scope Check

This plan implements the approved v0.1 skeleton only:

- Single editable Research Agent.
- No multi-agent CRUD.
- No real MCP app integration.
- No permissions UI.
- No artifact browser.
- No API key persistence.
- Hidden Codex CLI runtime.

Railway Postgres is intentionally deferred. The first deployable skeleton uses process memory for default agent config and run records. This keeps the first version testable and deployable while preserving a clean `RunStore` boundary for later persistence.

## File Structure

Create this application structure:

```text
package.json
pnpm-workspace.yaml
tsconfig.base.json
vitest.config.ts
.gitignore
.env.example
railway.json
Dockerfile.web
Dockerfile.runner
packages/shared/package.json
packages/shared/src/index.ts
packages/shared/src/agent-spec.ts
packages/shared/src/plugin-registry.ts
packages/shared/src/prompt.ts
packages/shared/src/run.ts
packages/shared/src/__tests__/agent-spec.test.ts
packages/shared/src/__tests__/prompt.test.ts
apps/api/package.json
apps/api/src/index.ts
apps/api/src/default-agent.ts
apps/api/src/run-store.ts
apps/api/src/runner-client.ts
apps/api/src/sse.ts
apps/api/src/__tests__/api.test.ts
apps/runner/package.json
apps/runner/src/index.ts
apps/runner/src/codex-runner.ts
apps/runner/src/fake-runner.ts
apps/runner/src/materialize.ts
apps/runner/src/__tests__/runner.test.ts
apps/web/package.json
apps/web/index.html
apps/web/src/main.tsx
apps/web/src/App.tsx
apps/web/src/api.ts
apps/web/src/defaults.ts
apps/web/src/styles.css
apps/web/src/__tests__/app.test.tsx
```

Responsibilities:

- `packages/shared`: owns Agent Spec, Run types, plugin registry validation, and prompt materialization. No Express, React, or child process imports.
- `apps/api`: owns HTTP API, in-memory agent/run state, SSE event streaming, and calls to the runner service.
- `apps/runner`: owns Codex CLI execution and fake runner behavior for local tests.
- `apps/web`: owns the RunwayML-inspired builder UI, form state, API calls, SSE/polling, and Markdown rendering.

## Task 1: Workspace Scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Initialize git for frequent commits**

Run:

```bash
git init
```

Expected: `Initialized empty Git repository`.

- [ ] **Step 2: Create workspace files**

Create `package.json`:

```json
{
  "name": "agent-builder-demo",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "pnpm --parallel --filter @agent-builder/api --filter @agent-builder/runner --filter @agent-builder/web dev",
    "dev:api": "pnpm --filter @agent-builder/api dev",
    "dev:runner": "pnpm --filter @agent-builder/runner dev",
    "dev:web": "pnpm --filter @agent-builder/web dev",
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.8",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@types/node": "^22.10.2",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.2",
    "vite": "^6.0.3",
    "vitest": "^2.1.8"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["node"]
  }
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["apps/**/*.test.ts", "apps/**/*.test.tsx", "packages/**/*.test.ts"],
    exclude: ["node_modules", "dist"]
  }
});
```

Create `.gitignore`:

```gitignore
node_modules
dist
.env
.env.local
.DS_Store
.superpowers
coverage
*.log
apps/runner/workspaces
```

Create `.env.example`:

```dotenv
API_PORT=4001
RUNNER_PORT=4101
VITE_API_BASE_URL=http://localhost:4001
RUNNER_BASE_URL=http://localhost:4101
RUNNER_MODE=fake
RUN_TIMEOUT_MS=120000
```

- [ ] **Step 3: Install dependencies**

Run:

```bash
pnpm install
```

Expected: dependencies install and `pnpm-lock.yaml` is created.

- [ ] **Step 4: Run baseline tests**

Run:

```bash
pnpm test
```

Expected: Vitest starts and reports no tests found or passes once later tests exist.

- [ ] **Step 5: Commit**

Run:

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts .gitignore .env.example pnpm-lock.yaml
git commit -m "chore: scaffold TypeScript workspace"
```

Expected: commit succeeds.

## Task 2: Shared Agent Spec, Registry, and Prompt Contract

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/agent-spec.ts`
- Create: `packages/shared/src/plugin-registry.ts`
- Create: `packages/shared/src/prompt.ts`
- Create: `packages/shared/src/run.ts`
- Create: `packages/shared/src/__tests__/agent-spec.test.ts`
- Create: `packages/shared/src/__tests__/prompt.test.ts`

- [ ] **Step 1: Write failing Agent Spec tests**

Create `packages/shared/package.json`:

```json
{
  "name": "@agent-builder/shared",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run src"
  },
  "dependencies": {
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

Create `packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src"]
}
```

Create `packages/shared/src/__tests__/agent-spec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultAgentSpec, exportAgentSpec, validateAgentSpec } from "../agent-spec";

describe("Agent Spec validation", () => {
  it("accepts the default Research Agent spec", () => {
    const result = validateAgentSpec(defaultAgentSpec);
    expect(result.success).toBe(true);
  });

  it("rejects unknown plugin ids", () => {
    const result = validateAgentSpec({
      ...defaultAgentSpec,
      apps: [{ id: "unknown-app", enabled: true, mode: "configuration-only" }]
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("Unknown app id: unknown-app");
    }
  });

  it("exports specs without API keys", () => {
    const exported = exportAgentSpec({
      ...defaultAgentSpec,
      model: {
        ...defaultAgentSpec.model,
        apiKey: "sk-secret"
      }
    });
    expect(JSON.stringify(exported)).not.toContain("sk-secret");
    expect(exported.model.apiKeyRef).toBe("runtime-only");
  });
});
```

- [ ] **Step 2: Run Agent Spec tests to verify failure**

Run:

```bash
pnpm --filter @agent-builder/shared test -- src/__tests__/agent-spec.test.ts
```

Expected: FAIL because `agent-spec` does not exist.

- [ ] **Step 3: Implement Agent Spec and plugin registry**

Create `packages/shared/src/plugin-registry.ts`:

```ts
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
```

Create `packages/shared/src/agent-spec.ts`:

```ts
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
    description: z.string().min(1, "Agent description is required"),
    persona: z.string().min(1, "Agent persona is required")
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
    description: "Researches companies, products, or markets and writes concise Markdown reports.",
    persona: "Careful research analyst"
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
```

Create `packages/shared/src/index.ts`:

```ts
export * from "./agent-spec";
export * from "./plugin-registry";
export * from "./prompt";
export * from "./run";
```

- [ ] **Step 4: Run Agent Spec tests to verify pass**

Run:

```bash
pnpm --filter @agent-builder/shared test -- src/__tests__/agent-spec.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing prompt materialization tests**

Create `packages/shared/src/__tests__/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultAgentSpec } from "../agent-spec";
import { materializePrompt } from "../prompt";

describe("prompt materialization", () => {
  it("includes identity, system prompt, enabled skills, enabled abilities, mock app context, and task", () => {
    const prompt = materializePrompt({
      agentSpec: {
        ...defaultAgentSpec,
        apps: defaultAgentSpec.apps.map((app) =>
          app.id === "mock-github" ? { ...app, enabled: true } : app
        )
      },
      task: "Research Acme Corp."
    });

    expect(prompt).toContain("Research Agent");
    expect(prompt).toContain(defaultAgentSpec.systemPrompt);
    expect(prompt).toContain("Research synthesis");
    expect(prompt).toContain("Web Research");
    expect(prompt).toContain("GitHub");
    expect(prompt).toContain("configuration-only");
    expect(prompt).toContain("Research Acme Corp.");
    expect(prompt).toContain("Markdown");
  });

  it("excludes disabled skills and apps", () => {
    const prompt = materializePrompt({
      agentSpec: {
        ...defaultAgentSpec,
        apps: defaultAgentSpec.apps.map((app) => ({ ...app, enabled: false })),
        skills: defaultAgentSpec.skills.map((skill) =>
          skill.id === "executive-summary" ? { ...skill, enabled: false } : skill
        )
      },
      task: "Research Globex."
    });

    expect(prompt).not.toContain("GitHub");
    expect(prompt).not.toContain("Executive summary");
  });
});
```

- [ ] **Step 6: Run prompt tests to verify failure**

Run:

```bash
pnpm --filter @agent-builder/shared test -- src/__tests__/prompt.test.ts
```

Expected: FAIL because `materializePrompt` does not exist.

- [ ] **Step 7: Implement prompt and run types**

Create `packages/shared/src/prompt.ts`:

```ts
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
```

Create `packages/shared/src/run.ts`:

```ts
import type { AgentSpec } from "./agent-spec";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "canceled";

export type RunEventType = "queued" | "starting" | "researching" | "generating_report" | "completed" | "failed";

export type RunEvent = {
  id: string;
  runId: string;
  type: RunEventType;
  message: string;
  createdAt: string;
};

export type RunRecord = {
  id: string;
  task: string;
  status: RunStatus;
  agentSpecSnapshot: AgentSpec;
  traceEvents: RunEvent[];
  finalMarkdown: string | null;
  rawOutput: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type CreateRunRequest = {
  agentSpec: AgentSpec;
  runtimeSecrets: {
    apiKey: string;
  };
  task: string;
};

export type RunnerResponse = {
  finalMarkdown: string;
  rawOutput: string;
  events: Omit<RunEvent, "id" | "runId" | "createdAt">[];
};
```

- [ ] **Step 8: Run shared tests and typecheck**

Run:

```bash
pnpm --filter @agent-builder/shared test
pnpm --filter @agent-builder/shared typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add packages/shared
git commit -m "feat: add agent spec and prompt contracts"
```

Expected: commit succeeds.

## Task 3: Runner Worker With Fake and Codex Adapters

**Files:**
- Create: `apps/runner/package.json`
- Create: `apps/runner/tsconfig.json`
- Create: `apps/runner/src/fake-runner.ts`
- Create: `apps/runner/src/codex-runner.ts`
- Create: `apps/runner/src/materialize.ts`
- Create: `apps/runner/src/index.ts`
- Create: `apps/runner/src/__tests__/runner.test.ts`

- [ ] **Step 1: Write failing runner tests**

Create `apps/runner/package.json`:

```json
{
  "name": "@agent-builder/runner",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run src"
  },
  "dependencies": {
    "@agent-builder/shared": "workspace:*",
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "tsx": "^4.19.2",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

Create `apps/runner/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Create `apps/runner/src/__tests__/runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import { runFakeAgent } from "../fake-runner";
import { createCodexCommand } from "../codex-runner";

describe("runner adapters", () => {
  it("fake runner returns deterministic Markdown and events", async () => {
    const result = await runFakeAgent({
      agentSpec: defaultAgentSpec,
      runtimeSecrets: { apiKey: "sk-test" },
      task: "Research Acme Corp."
    });

    expect(result.finalMarkdown).toContain("# Research Report");
    expect(result.finalMarkdown).toContain("Research Acme Corp.");
    expect(result.rawOutput).toContain("fake runner");
    expect(result.events.map((event) => event.type)).toEqual([
      "starting",
      "researching",
      "generating_report",
      "completed"
    ]);
  });

  it("Codex command hides runtime details from the materialized prompt but includes required CLI flags", () => {
    const command = createCodexCommand({
      modelName: "gpt-5",
      workspacePath: "/tmp/run-1",
      finalPath: "/tmp/run-1/final.md",
      prompt: "Return Markdown."
    });

    expect(command.command).toBe("codex");
    expect(command.args).toContain("--search");
    expect(command.args).toContain("--ask-for-approval");
    expect(command.args).toContain("never");
    expect(command.args).toContain("exec");
    expect(command.args).toContain("--json");
    expect(command.args).toContain("--model");
    expect(command.args).toContain("gpt-5");
    expect(command.args).toContain("--sandbox");
    expect(command.args).toContain("danger-full-access");
    expect(command.args).toContain("--output-last-message");
  });
});
```

- [ ] **Step 2: Run runner tests to verify failure**

Run:

```bash
pnpm --filter @agent-builder/runner test
```

Expected: FAIL because runner modules do not exist.

- [ ] **Step 3: Implement fake runner and Codex command builder**

Create `apps/runner/src/fake-runner.ts`:

```ts
import type { CreateRunRequest, RunnerResponse } from "@agent-builder/shared";

export async function runFakeAgent(request: CreateRunRequest): Promise<RunnerResponse> {
  const finalMarkdown = [
    "# Research Report",
    "",
    "## Executive Summary",
    `This is a deterministic demo report for: ${request.task}`,
    "",
    "## Findings",
    "- The configured Research Agent received the task.",
    "- Web Research is enabled as the real v0.1 ability.",
    "- Mock apps remain configuration-only.",
    "",
    "## Recommendation",
    "Use the Codex runner smoke path after deployment credentials are configured."
  ].join("\n");

  return {
    finalMarkdown,
    rawOutput: "fake runner completed successfully",
    events: [
      { type: "starting", message: "Starting runner" },
      { type: "researching", message: "Researching task context" },
      { type: "generating_report", message: "Generating Markdown report" },
      { type: "completed", message: "Run completed" }
    ]
  };
}
```

Create `apps/runner/src/codex-runner.ts`:

```ts
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CreateRunRequest, RunnerResponse } from "@agent-builder/shared";
import { materializePrompt } from "@agent-builder/shared";

export type CodexCommandInput = {
  modelName: string;
  workspacePath: string;
  finalPath: string;
  prompt: string;
};

export type CodexCommand = {
  command: "codex";
  args: string[];
};

export function createCodexCommand(input: CodexCommandInput): CodexCommand {
  return {
    command: "codex",
    args: [
      "--search",
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--model",
      input.modelName,
      "--sandbox",
      "danger-full-access",
      "--skip-git-repo-check",
      "--output-last-message",
      input.finalPath,
      "-C",
      input.workspacePath,
      input.prompt
    ]
  };
}

export async function runCodexAgent(request: CreateRunRequest, timeoutMs: number): Promise<RunnerResponse> {
  const workspacePath = await mkdir(join(tmpdir(), `agent-run-${Date.now()}-${Math.random().toString(16).slice(2)}`), {
    recursive: true
  }).then((path) => path);

  if (!workspacePath) {
    throw new Error("Failed to create runner workspace");
  }

  const finalPath = join(workspacePath, "final.md");
  const prompt = materializePrompt({ agentSpec: request.agentSpec, task: request.task });
  await writeFile(join(workspacePath, "prompt.md"), prompt, "utf8");

  const command = createCodexCommand({
    modelName: request.agentSpec.model.name,
    workspacePath,
    finalPath,
    prompt
  });

  const rawChunks: string[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.command, command.args, {
        cwd: workspacePath,
        env: {
          ...process.env,
          OPENAI_API_KEY: request.runtimeSecrets.apiKey,
          OPENAI_BASE_URL: request.agentSpec.model.apiEndpoint
        },
        stdio: ["ignore", "pipe", "pipe"]
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Run timed out"));
      }, timeoutMs);

      child.stdout.on("data", (chunk) => rawChunks.push(chunk.toString()));
      child.stderr.on("data", (chunk) => rawChunks.push(chunk.toString()));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Codex exited with code ${code}`));
        }
      });
    });

    const finalMarkdown = await readFile(finalPath, "utf8").catch(() => "");
    if (!finalMarkdown.trim()) {
      throw new Error("Codex completed without final Markdown output");
    }

    return {
      finalMarkdown,
      rawOutput: rawChunks.join(""),
      events: [
        { type: "starting", message: "Starting runner" },
        { type: "researching", message: "Researching task context" },
        { type: "generating_report", message: "Generating Markdown report" },
        { type: "completed", message: "Run completed" }
      ]
    };
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
}
```

Create `apps/runner/src/materialize.ts`:

```ts
export { materializePrompt } from "@agent-builder/shared";
```

- [ ] **Step 4: Implement runner HTTP service**

Create `apps/runner/src/index.ts`:

```ts
import cors from "cors";
import express from "express";
import { validateAgentSpec, type CreateRunRequest } from "@agent-builder/shared";
import { runCodexAgent } from "./codex-runner";
import { runFakeAgent } from "./fake-runner";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = Number(process.env.RUNNER_PORT ?? 4101);
const runnerMode = process.env.RUNNER_MODE ?? "fake";
const timeoutMs = Number(process.env.RUN_TIMEOUT_MS ?? 120000);

app.get("/health", (_req, res) => {
  res.json({ ok: true, runnerMode });
});

app.post("/run", async (req, res) => {
  const body = req.body as CreateRunRequest;
  const validation = validateAgentSpec(body.agentSpec);

  if (!validation.success) {
    res.status(400).json({ error: validation.error.message });
    return;
  }

  if (!body.task?.trim()) {
    res.status(400).json({ error: "Task prompt is required" });
    return;
  }

  if (!body.runtimeSecrets?.apiKey?.trim()) {
    res.status(400).json({ error: "API key is required" });
    return;
  }

  try {
    const result =
      runnerMode === "codex"
        ? await runCodexAgent({ ...body, agentSpec: validation.data }, timeoutMs)
        : await runFakeAgent({ ...body, agentSpec: validation.data });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Runner failed" });
  }
});

app.listen(port, () => {
  console.log(`runner listening on ${port}`);
});
```

- [ ] **Step 5: Run runner tests and typecheck**

Run:

```bash
pnpm --filter @agent-builder/runner test
pnpm --filter @agent-builder/runner typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/runner packages/shared
git commit -m "feat: add runner worker adapters"
```

Expected: commit succeeds.

## Task 4: API Orchestrator and In-Memory Run Store

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/default-agent.ts`
- Create: `apps/api/src/run-store.ts`
- Create: `apps/api/src/runner-client.ts`
- Create: `apps/api/src/sse.ts`
- Create: `apps/api/src/index.ts`
- Create: `apps/api/src/__tests__/api.test.ts`

- [ ] **Step 1: Write failing API tests**

Create `apps/api/package.json`:

```json
{
  "name": "@agent-builder/api",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run src"
  },
  "dependencies": {
    "@agent-builder/shared": "workspace:*",
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "nanoid": "^5.0.9",
    "tsx": "^4.19.2"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^5.0.0",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

Create `apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Create `apps/api/src/__tests__/api.test.ts`:

```ts
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import { createApiApp } from "../index";

describe("API orchestrator", () => {
  it("returns the default agent without an API key", async () => {
    const app = createApiApp();
    const response = await request(app).get("/api/agent/default").expect(200);

    expect(response.body.identity.name).toBe("Research Agent");
    expect(JSON.stringify(response.body)).not.toContain("apiKey");
  });

  it("rejects run creation without an API key", async () => {
    const app = createApiApp();
    const response = await request(app)
      .post("/api/runs")
      .send({ agentSpec: defaultAgentSpec, runtimeSecrets: { apiKey: "" }, task: "Research Acme." })
      .expect(400);

    expect(response.body.error).toBe("API key is required");
  });

  it("creates a run and stores final Markdown from the runner", async () => {
    const app = createApiApp({
      runAgent: vi.fn().mockResolvedValue({
        finalMarkdown: "# Research Report\n\nDone.",
        rawOutput: "raw fake output",
        events: [{ type: "completed", message: "Run completed" }]
      })
    });

    const createResponse = await request(app)
      .post("/api/runs")
      .send({ agentSpec: defaultAgentSpec, runtimeSecrets: { apiKey: "sk-test" }, task: "Research Acme." })
      .expect(201);

    expect(createResponse.body.status).toBe("succeeded");
    expect(createResponse.body.finalMarkdown).toContain("# Research Report");
    expect(JSON.stringify(createResponse.body.agentSpecSnapshot)).not.toContain("sk-test");

    const getResponse = await request(app).get(`/api/runs/${createResponse.body.id}`).expect(200);
    expect(getResponse.body.finalMarkdown).toContain("Done.");
  });
});
```

- [ ] **Step 2: Run API tests to verify failure**

Run:

```bash
pnpm --filter @agent-builder/api test
```

Expected: FAIL because API modules do not exist.

- [ ] **Step 3: Implement run store**

Create `apps/api/src/run-store.ts`:

```ts
import { nanoid } from "nanoid";
import type { AgentSpec, RunEvent, RunRecord, RunStatus } from "@agent-builder/shared";
import { exportAgentSpec } from "@agent-builder/shared";

export class RunStore {
  private runs = new Map<string, RunRecord>();

  createQueuedRun(input: { task: string; agentSpec: AgentSpec }): RunRecord {
    const now = new Date().toISOString();
    const run: RunRecord = {
      id: nanoid(),
      task: input.task,
      status: "queued",
      agentSpecSnapshot: exportAgentSpec(input.agentSpec),
      traceEvents: [],
      finalMarkdown: null,
      rawOutput: null,
      error: null,
      startedAt: now,
      completedAt: null
    };
    this.runs.set(run.id, run);
    return run;
  }

  addEvent(runId: string, event: Omit<RunEvent, "id" | "runId" | "createdAt">): RunRecord {
    const run = this.requireRun(runId);
    const nextEvent: RunEvent = {
      id: nanoid(),
      runId,
      createdAt: new Date().toISOString(),
      ...event
    };
    const updated = { ...run, traceEvents: [...run.traceEvents, nextEvent] };
    this.runs.set(runId, updated);
    return updated;
  }

  updateRun(
    runId: string,
    patch: Partial<Pick<RunRecord, "status" | "finalMarkdown" | "rawOutput" | "error" | "completedAt">>
  ): RunRecord {
    const run = this.requireRun(runId);
    const updated = { ...run, ...patch };
    this.runs.set(runId, updated);
    return updated;
  }

  getRun(runId: string): RunRecord | null {
    return this.runs.get(runId) ?? null;
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }
}

export function statusFromError(message: string): RunStatus {
  return message.toLowerCase().includes("timed out") ? "timed_out" : "failed";
}
```

- [ ] **Step 4: Implement runner client and SSE helper**

Create `apps/api/src/runner-client.ts`:

```ts
import type { CreateRunRequest, RunnerResponse } from "@agent-builder/shared";

export type RunnerClient = {
  runAgent(request: CreateRunRequest): Promise<RunnerResponse>;
};

export function createHttpRunnerClient(baseUrl: string): RunnerClient {
  return {
    async runAgent(request) {
      const response = await fetch(`${baseUrl}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Runner request failed with ${response.status}`);
      }

      return (await response.json()) as RunnerResponse;
    }
  };
}
```

Create `apps/api/src/sse.ts`:

```ts
import type { Response } from "express";

export function sendSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
```

- [ ] **Step 5: Implement API app**

Create `apps/api/src/default-agent.ts`:

```ts
export { defaultAgentSpec } from "@agent-builder/shared";
```

Create `apps/api/src/index.ts`:

```ts
import cors from "cors";
import express from "express";
import { defaultAgentSpec, exportAgentSpec, validateAgentSpec, type AgentSpec } from "@agent-builder/shared";
import { createHttpRunnerClient, type RunnerClient } from "./runner-client";
import { RunStore, statusFromError } from "./run-store";
import { sendSse } from "./sse";

export type ApiDependencies = Partial<RunnerClient> & {
  runStore?: RunStore;
};

let currentAgentSpec: AgentSpec = defaultAgentSpec;

export function createApiApp(deps: ApiDependencies = {}) {
  const app = express();
  const runStore = deps.runStore ?? new RunStore();
  const runnerClient: RunnerClient = {
    runAgent:
      deps.runAgent ??
      createHttpRunnerClient(process.env.RUNNER_BASE_URL ?? "http://localhost:4101").runAgent
  };

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/agent/default", (_req, res) => {
    res.json(exportAgentSpec(currentAgentSpec));
  });

  app.put("/api/agent/default", (req, res) => {
    const validation = validateAgentSpec(req.body);
    if (!validation.success) {
      res.status(400).json({ error: validation.error.message });
      return;
    }
    currentAgentSpec = exportAgentSpec(validation.data);
    res.json(currentAgentSpec);
  });

  app.post("/api/runs", async (req, res) => {
    const validation = validateAgentSpec(req.body.agentSpec);
    if (!validation.success) {
      res.status(400).json({ error: validation.error.message });
      return;
    }

    const task = String(req.body.task ?? "").trim();
    const apiKey = String(req.body.runtimeSecrets?.apiKey ?? "").trim();

    if (!task) {
      res.status(400).json({ error: "Task prompt is required" });
      return;
    }

    if (!apiKey) {
      res.status(400).json({ error: "API key is required" });
      return;
    }

    const run = runStore.createQueuedRun({ task, agentSpec: validation.data });

    try {
      runStore.updateRun(run.id, { status: "running" });
      runStore.addEvent(run.id, { type: "starting", message: "Starting runner" });
      const result = await runnerClient.runAgent({
        agentSpec: validation.data,
        runtimeSecrets: { apiKey },
        task
      });
      for (const event of result.events) {
        runStore.addEvent(run.id, event);
      }
      const completed = runStore.updateRun(run.id, {
        status: "succeeded",
        finalMarkdown: result.finalMarkdown,
        rawOutput: result.rawOutput,
        completedAt: new Date().toISOString()
      });
      res.status(201).json(completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Run failed";
      runStore.addEvent(run.id, { type: "failed", message });
      const failed = runStore.updateRun(run.id, {
        status: statusFromError(message),
        error: message,
        completedAt: new Date().toISOString()
      });
      res.status(500).json(failed);
    }
  });

  app.get("/api/runs/:id", (req, res) => {
    const run = runStore.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(run);
  });

  app.get("/api/runs/:id/events", (req, res) => {
    const run = runStore.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    sendSse(res, "snapshot", run.traceEvents);
    res.end();
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.API_PORT ?? 4001);
  createApiApp().listen(port, () => {
    console.log(`api listening on ${port}`);
  });
}
```

- [ ] **Step 6: Run API tests and typecheck**

Run:

```bash
pnpm --filter @agent-builder/api test
pnpm --filter @agent-builder/api typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add apps/api
git commit -m "feat: add API orchestrator"
```

Expected: commit succeeds.

## Task 5: React UI Data Client and Builder State

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/index.html`
- Create: `apps/web/src/api.ts`
- Create: `apps/web/src/defaults.ts`
- Create: `apps/web/src/__tests__/app.test.tsx`

- [ ] **Step 1: Write failing UI client tests**

Create `apps/web/package.json`:

```json
{
  "name": "@agent-builder/web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite --host 0.0.0.0",
    "build": "tsc -p tsconfig.json && vite build",
    "preview": "vite preview --host 0.0.0.0",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run src"
  },
  "dependencies": {
    "@agent-builder/shared": "workspace:*",
    "@vitejs/plugin-react": "^4.3.4",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-markdown": "^9.0.1",
    "vite": "^6.0.3"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.8",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^19.0.1",
    "@types/react-dom": "^19.0.2",
    "jsdom": "^25.0.1",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

Create `apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "outDir": "dist",
    "types": ["vite/client", "vitest/globals"]
  },
  "include": ["src", "index.html"]
}
```

Create `apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Agent Builder</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `apps/web/src/__tests__/app.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { defaultUiAgentSpec, createExportPayload } from "../defaults";

describe("web defaults", () => {
  it("uses a single Research Agent without a goal field", () => {
    expect(defaultUiAgentSpec.identity.name).toBe("Research Agent");
    expect("goal" in defaultUiAgentSpec.identity).toBe(false);
  });

  it("exports Agent Spec without runtime API key", () => {
    const payload = createExportPayload({
      agentSpec: {
        ...defaultUiAgentSpec,
        model: { ...defaultUiAgentSpec.model, apiKey: "sk-test" }
      }
    });
    expect(JSON.stringify(payload)).not.toContain("sk-test");
    expect(payload.model.apiKeyRef).toBe("runtime-only");
  });
});
```

- [ ] **Step 2: Run UI tests to verify failure**

Run:

```bash
pnpm --filter @agent-builder/web test
```

Expected: FAIL because `defaults` does not exist.

- [ ] **Step 3: Implement UI defaults and API client**

Create `apps/web/src/defaults.ts`:

```ts
import { defaultAgentSpec, exportAgentSpec, type AgentSpec } from "@agent-builder/shared";

export const defaultUiAgentSpec: AgentSpec = defaultAgentSpec;

export function createExportPayload(input: { agentSpec: AgentSpec }): AgentSpec {
  return exportAgentSpec(input.agentSpec);
}
```

Create `apps/web/src/api.ts`:

```ts
import type { AgentSpec, RunRecord } from "@agent-builder/shared";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4001";

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options?.headers ?? {})
    }
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed with ${response.status}`);
  }

  return body as T;
}

export function getDefaultAgent(): Promise<AgentSpec> {
  return requestJson<AgentSpec>("/api/agent/default");
}

export function saveDefaultAgent(agentSpec: AgentSpec): Promise<AgentSpec> {
  return requestJson<AgentSpec>("/api/agent/default", {
    method: "PUT",
    body: JSON.stringify(agentSpec)
  });
}

export function createRun(input: {
  agentSpec: AgentSpec;
  apiKey: string;
  task: string;
}): Promise<RunRecord> {
  return requestJson<RunRecord>("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      agentSpec: input.agentSpec,
      runtimeSecrets: { apiKey: input.apiKey },
      task: input.task
    })
  });
}
```

- [ ] **Step 4: Run UI tests and typecheck**

Run:

```bash
pnpm --filter @agent-builder/web test
pnpm --filter @agent-builder/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/web
git commit -m "feat: add web client contracts"
```

Expected: commit succeeds.

## Task 6: Builder UI and Markdown Output

**Files:**
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/styles.css`
- Modify: `apps/web/src/__tests__/app.test.tsx`

- [ ] **Step 1: Add failing UI behavior tests**

Append these tests to `apps/web/src/__tests__/app.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import App from "../App";

describe("App", () => {
  it("renders the builder workspace, not a landing page", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Agent Builder" })).toBeInTheDocument();
    expect(screen.getByLabelText("Agent name")).toHaveValue("Research Agent");
    expect(screen.getByText("Web Research")).toBeInTheDocument();
  });

  it("validates missing API key before running", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Run agent" }));
    expect(await screen.findByText("API key is required")).toBeInTheDocument();
  });

  it("renders Markdown final output after a run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "run-1",
          task: "Research Acme.",
          status: "succeeded",
          agentSpecSnapshot: defaultUiAgentSpec,
          traceEvents: [],
          finalMarkdown: "# Research Report\n\nAcme is interesting.",
          rawOutput: null,
          error: null,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        })
      })
    );

    render(<App />);
    await userEvent.type(screen.getByLabelText("API key"), "sk-test");
    await userEvent.click(screen.getByRole("button", { name: "Run agent" }));

    expect(await screen.findByRole("heading", { name: "Research Report" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run UI tests to verify failure**

Run:

```bash
pnpm --filter @agent-builder/web test
```

Expected: FAIL because `App` does not exist.

- [ ] **Step 3: Implement React entrypoint**

Create `apps/web/src/main.tsx`:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 4: Implement builder UI**

Create `apps/web/src/App.tsx`:

```tsx
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  abilityRegistry,
  appRegistry,
  skillRegistry,
  type AgentSpec,
  type RunRecord
} from "@agent-builder/shared";
import { createRun } from "./api";
import { createExportPayload, defaultUiAgentSpec } from "./defaults";

type RunState = "idle" | "running" | "succeeded" | "failed";

export default function App() {
  const [agentSpec, setAgentSpec] = useState<AgentSpec>(defaultUiAgentSpec);
  const [apiKey, setApiKey] = useState("");
  const [task, setTask] = useState("Research RunwayML and produce a concise company profile.");
  const [runState, setRunState] = useState<RunState>("idle");
  const [runRecord, setRunRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enabledAppCount = useMemo(
    () => agentSpec.apps.filter((app) => app.enabled).length,
    [agentSpec.apps]
  );

  function updateAgent(patch: Partial<AgentSpec>) {
    setAgentSpec((current) => ({ ...current, ...patch }));
  }

  function updateIdentity(field: keyof AgentSpec["identity"], value: string) {
    setAgentSpec((current) => ({
      ...current,
      identity: { ...current.identity, [field]: value }
    }));
  }

  function toggleApp(id: string) {
    setAgentSpec((current) => ({
      ...current,
      apps: current.apps.map((app) => (app.id === id ? { ...app, enabled: !app.enabled } : app))
    }));
  }

  function toggleSkill(id: string) {
    setAgentSpec((current) => ({
      ...current,
      skills: current.skills.map((skill) =>
        skill.id === id ? { ...skill, enabled: !skill.enabled } : skill
      )
    }));
  }

  async function runAgent() {
    setError(null);
    setRunRecord(null);

    if (!apiKey.trim()) {
      setError("API key is required");
      return;
    }

    if (!task.trim()) {
      setError("Task prompt is required");
      return;
    }

    setRunState("running");
    try {
      const run = await createRun({ agentSpec, apiKey, task });
      setRunRecord(run);
      setRunState("succeeded");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Run failed");
      setRunState("failed");
    }
  }

  function exportSpec() {
    const payload = JSON.stringify(createExportPayload({ agentSpec }), null, 2);
    navigator.clipboard?.writeText(payload).catch(() => undefined);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Agent navigation">
        <div className="brand-mark">AB</div>
        <div>
          <p className="eyebrow">Agent Builder</p>
          <h1>Research Agent</h1>
        </div>
        <div className="agent-pill">Single agent skeleton</div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Workspace</p>
            <h2>Agent Builder</h2>
          </div>
          <button className="button ghost" type="button" onClick={exportSpec}>
            Export Agent Spec
          </button>
        </header>

        <div className="content-grid">
          <section className="config-surface" aria-label="Agent configuration">
            <div className="section-block">
              <p className="eyebrow">Profile</p>
              <label>
                Agent name
                <input
                  value={agentSpec.identity.name}
                  onChange={(event) => updateIdentity("name", event.target.value)}
                />
              </label>
              <label>
                Description
                <input
                  value={agentSpec.identity.description}
                  onChange={(event) => updateIdentity("description", event.target.value)}
                />
              </label>
              <label>
                Persona
                <input
                  value={agentSpec.identity.persona}
                  onChange={(event) => updateIdentity("persona", event.target.value)}
                />
              </label>
              <label>
                System prompt
                <textarea
                  rows={5}
                  value={agentSpec.systemPrompt}
                  onChange={(event) => updateAgent({ systemPrompt: event.target.value })}
                />
              </label>
            </div>

            <div className="section-block">
              <p className="eyebrow">Model</p>
              <label>
                Provider
                <select
                  value={agentSpec.model.provider}
                  onChange={(event) =>
                    updateAgent({
                      model: {
                        ...agentSpec.model,
                        provider: event.target.value as AgentSpec["model"]["provider"]
                      }
                    })
                  }
                >
                  <option value="openai-compatible">OpenAI-compatible</option>
                  <option value="openai">OpenAI</option>
                </select>
              </label>
              <label>
                Model name
                <input
                  value={agentSpec.model.name}
                  onChange={(event) =>
                    updateAgent({ model: { ...agentSpec.model, name: event.target.value } })
                  }
                />
              </label>
              <label>
                API endpoint
                <input
                  value={agentSpec.model.apiEndpoint}
                  onChange={(event) =>
                    updateAgent({ model: { ...agentSpec.model, apiEndpoint: event.target.value } })
                  }
                />
              </label>
              <label>
                API key
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Used for this run only"
                />
              </label>
              <p className="hint">API keys are runtime-only in v0.1 and are not exported.</p>
            </div>

            <div className="section-block">
              <p className="eyebrow">Apps, Skills, Abilities</p>
              <div className="mini-stat">{enabledAppCount} mock apps enabled</div>
              {appRegistry.map((app) => {
                const selected = agentSpec.apps.find((item) => item.id === app.id);
                return (
                  <label className="toggle-row" key={app.id}>
                    <span>
                      <strong>{app.label}</strong>
                      <small>{app.description} Configuration-only.</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={Boolean(selected?.enabled)}
                      onChange={() => toggleApp(app.id)}
                    />
                  </label>
                );
              })}
              {skillRegistry.map((skill) => {
                const selected = agentSpec.skills.find((item) => item.id === skill.id);
                return (
                  <label className="toggle-row" key={skill.id}>
                    <span>
                      <strong>{skill.label}</strong>
                      <small>{skill.description}</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={Boolean(selected?.enabled)}
                      onChange={() => toggleSkill(skill.id)}
                    />
                  </label>
                );
              })}
              {abilityRegistry.map((ability) => (
                <div className="ability-row" key={ability.id}>
                  <span>
                    <strong>{ability.label}</strong>
                    <small>{ability.description}</small>
                  </span>
                  <span className="status-dot">Enabled</span>
                </div>
              ))}
            </div>
          </section>

          <section className="run-surface" aria-label="Run console">
            <p className="eyebrow">Run Console</p>
            <label>
              Task prompt
              <textarea rows={5} value={task} onChange={(event) => setTask(event.target.value)} />
            </label>
            <button className="button primary" type="button" onClick={runAgent} disabled={runState === "running"}>
              {runState === "running" ? "Running..." : "Run agent"}
            </button>
            {error ? <div className="error-banner">{error}</div> : null}
            <div className="trace">
              <p className="eyebrow">Trace</p>
              {(runRecord?.traceEvents.length ? runRecord.traceEvents : []).map((event) => (
                <div className="trace-item" key={event.id}>
                  <strong>{event.type.replaceAll("_", " ")}</strong>
                  <span>{event.message}</span>
                </div>
              ))}
              {runState === "idle" ? <p className="hint">Run a task to see status events.</p> : null}
            </div>
            <article className="markdown-output">
              {runRecord?.finalMarkdown ? (
                <ReactMarkdown>{runRecord.finalMarkdown}</ReactMarkdown>
              ) : (
                <p className="hint">Final Markdown output will appear here.</p>
              )}
            </article>
          </section>
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Add RunwayML-inspired styles**

Create `apps/web/src/styles.css`:

```css
*,
*::before,
*::after {
  box-sizing: border-box;
}

:root {
  color: #030303;
  background: #ffffff;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 16px;
  line-height: 1.5;
}

body {
  margin: 0;
  background: #ffffff;
}

button,
input,
select,
textarea {
  font: inherit;
}

.app-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  background: #ffffff;
}

.sidebar {
  border-right: 1px solid #e7eaf0;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.brand-mark {
  width: 40px;
  height: 40px;
  border-radius: 9999px;
  background: #000000;
  color: #ffffff;
  display: grid;
  place-items: center;
  font-weight: 700;
}

.sidebar h1,
.topbar h2 {
  margin: 0;
  font-size: 32px;
  line-height: 1;
  font-weight: 400;
  letter-spacing: -0.8px;
}

.eyebrow {
  margin: 0 0 8px;
  text-transform: uppercase;
  letter-spacing: 0.35px;
  font-size: 12px;
  color: #676f7b;
  font-weight: 600;
}

.agent-pill,
.mini-stat,
.status-dot {
  width: fit-content;
  border: 1px solid #e7eaf0;
  border-radius: 9999px;
  padding: 6px 10px;
  color: #404040;
  font-size: 13px;
}

.workspace {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.topbar {
  height: 88px;
  border-bottom: 1px solid #e7eaf0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 32px;
}

.content-grid {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(420px, 1fr) minmax(380px, 520px);
  gap: 0;
}

.config-surface,
.run-surface {
  padding: 32px;
}

.run-surface {
  border-left: 1px solid #e7eaf0;
  background: #fefefe;
}

.section-block {
  border-bottom: 1px solid #e7eaf0;
  padding-bottom: 28px;
  margin-bottom: 28px;
}

label {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
  color: #1a1a1a;
  font-size: 14px;
  font-weight: 600;
}

input,
select,
textarea {
  width: 100%;
  border: 1px solid #c9ccd1;
  border-radius: 0;
  padding: 12px;
  color: #030303;
  background: #ffffff;
  font-size: 15px;
  font-weight: 400;
}

textarea {
  resize: vertical;
}

input:focus,
select:focus,
textarea:focus {
  outline: 2px solid #030303;
  outline-offset: 1px;
}

.button {
  min-height: 40px;
  border: 1px solid #000000;
  border-radius: 9999px;
  padding: 0 16px;
  cursor: pointer;
  font-weight: 700;
}

.button.primary {
  width: 100%;
  background: #000000;
  color: #ffffff;
}

.button.ghost {
  background: #ffffff;
  color: #000000;
}

.button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.toggle-row,
.ability-row {
  border-top: 1px solid #e7eaf0;
  padding: 14px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.toggle-row small,
.ability-row small,
.hint {
  display: block;
  color: #676f7b;
  font-size: 13px;
  font-weight: 400;
}

.error-banner {
  margin-top: 16px;
  border: 1px solid #030303;
  padding: 12px;
  color: #030303;
  background: #ffffff;
  font-weight: 700;
}

.trace {
  margin-top: 24px;
  border-top: 1px solid #e7eaf0;
  padding-top: 20px;
}

.trace-item {
  display: grid;
  gap: 2px;
  border-bottom: 1px solid #e7eaf0;
  padding: 10px 0;
}

.trace-item strong {
  text-transform: capitalize;
}

.markdown-output {
  margin-top: 24px;
  border-top: 1px solid #030303;
  padding-top: 24px;
}

.markdown-output h1,
.markdown-output h2,
.markdown-output h3 {
  font-weight: 400;
  letter-spacing: -0.4px;
}

@media (max-width: 920px) {
  .app-shell {
    grid-template-columns: 1fr;
  }

  .sidebar {
    border-right: 0;
    border-bottom: 1px solid #e7eaf0;
  }

  .content-grid {
    grid-template-columns: 1fr;
  }

  .run-surface {
    border-left: 0;
    border-top: 1px solid #e7eaf0;
  }
}
```

- [ ] **Step 6: Run UI tests, typecheck, and build**

Run:

```bash
pnpm --filter @agent-builder/web test
pnpm --filter @agent-builder/web typecheck
pnpm --filter @agent-builder/web build
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add apps/web
git commit -m "feat: build single agent UI"
```

Expected: commit succeeds.

## Task 7: Local End-to-End Smoke Path

**Files:**
- Modify: `package.json`
- Create: `docs/local-smoke-test.md`

- [ ] **Step 1: Add local smoke scripts**

Modify root `package.json` scripts to include:

```json
{
  "scripts": {
    "dev": "pnpm --parallel --filter @agent-builder/api --filter @agent-builder/runner --filter @agent-builder/web dev",
    "dev:api": "pnpm --filter @agent-builder/api dev",
    "dev:runner": "pnpm --filter @agent-builder/runner dev",
    "dev:web": "pnpm --filter @agent-builder/web dev",
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r typecheck",
    "smoke:health": "curl -sS http://localhost:4001/health && curl -sS http://localhost:4101/health"
  }
}
```

- [ ] **Step 2: Document local smoke test**

Create `docs/local-smoke-test.md`:

```md
# Local Smoke Test

## Start services

```bash
RUNNER_MODE=fake pnpm dev
```

Expected ports:

- Web: http://localhost:5173
- API: http://localhost:4001
- Runner: http://localhost:4101

## Check health

```bash
pnpm smoke:health
```

Expected:

```json
{"ok":true}{"ok":true,"runnerMode":"fake"}
```

## UI path

1. Open http://localhost:5173.
2. Confirm the workspace opens directly to Agent Builder.
3. Enter any API key value, such as `sk-local-fake`.
4. Keep `Research RunwayML and produce a concise company profile.` as the task.
5. Click `Run agent`.
6. Confirm a Markdown report appears.
7. Click `Export Agent Spec`.
8. Confirm the copied JSON does not contain the API key.
```

- [ ] **Step 3: Run full test suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```bash
git add package.json docs/local-smoke-test.md
git commit -m "docs: add local smoke path"
```

Expected: commit succeeds.

## Task 8: Docker and Railway Deployment Files

**Files:**
- Create: `Dockerfile.web`
- Create: `Dockerfile.runner`
- Create: `railway.json`
- Modify: `.env.example`
- Create: `docs/railway-deployment.md`

- [ ] **Step 1: Add Dockerfiles**

Create `Dockerfile.web`:

```dockerfile
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json vitest.config.ts ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web ./apps/web

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agent-builder/shared build
RUN pnpm --filter @agent-builder/api build
RUN pnpm --filter @agent-builder/web build

EXPOSE 4001
CMD ["pnpm", "--filter", "@agent-builder/api", "start"]
```

Create `Dockerfile.runner`:

```dockerfile
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable
RUN npm install -g @openai/codex

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json vitest.config.ts ./
COPY packages ./packages
COPY apps/runner ./apps/runner

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agent-builder/shared build
RUN pnpm --filter @agent-builder/runner build

EXPOSE 4101
CMD ["pnpm", "--filter", "@agent-builder/runner", "start"]
```

- [ ] **Step 2: Add Railway config**

Create `railway.json`:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE"
  },
  "deploy": {
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

Append to `.env.example`:

```dotenv
# Railway production example
# Web/API service
API_PORT=4001
RUNNER_BASE_URL=http://agent-builder-runner.railway.internal:4101

# Runner service
RUNNER_PORT=4101
RUNNER_MODE=codex
RUN_TIMEOUT_MS=120000
```

- [ ] **Step 3: Document Railway deployment**

Create `docs/railway-deployment.md`:

```md
# Railway Deployment

## Services

Create two Railway services from the same repository.

### Web/API service

- Dockerfile: `Dockerfile.web`
- Start command: default Docker CMD
- Variables:
  - `API_PORT=4001`
  - `RUNNER_BASE_URL=http://<runner-private-domain>:4101`

### Runner service

- Dockerfile: `Dockerfile.runner`
- Start command: default Docker CMD
- Variables:
  - `RUNNER_PORT=4101`
  - `RUNNER_MODE=codex`
  - `RUN_TIMEOUT_MS=120000`

## First deployment smoke test

1. Open the public Web/API service URL.
2. Confirm the Agent Builder workspace loads.
3. Enter model provider, model name, API endpoint, and API key.
4. Run a company research task.
5. Confirm final Markdown output renders.
6. Export Agent Spec and confirm it excludes the API key.

## Fallback deployment mode

Set `RUNNER_MODE=fake` on the runner service if Codex credentials or endpoint mapping need debugging. This keeps the UI/API demo usable while the real runner is repaired.
```

- [ ] **Step 4: Build Docker images locally**

Run:

```bash
docker build -f Dockerfile.web -t agent-builder-web .
docker build -f Dockerfile.runner -t agent-builder-runner .
```

Expected: both images build successfully.

- [ ] **Step 5: Commit**

Run:

```bash
git add Dockerfile.web Dockerfile.runner railway.json .env.example docs/railway-deployment.md
git commit -m "chore: add Railway deployment files"
```

Expected: commit succeeds.

## Task 9: Final Verification and Demo Readiness

**Files:**
- Create: `docs/demo-script.md`
- Modify: `README.md`

- [ ] **Step 1: Create demo script**

Create `docs/demo-script.md`:

```md
# Demo Script

## Opening

This is a configurable code-agent builder. The user configures an agent, model settings, mock app access, reusable skills, and a task. The UI does not expose the underlying runner implementation.

## Flow

1. Show the Research Agent profile.
2. Show model fields: provider, model name, API endpoint, API key.
3. Explain that API key is runtime-only and not exported.
4. Toggle one mock app and explain future MCP app integration.
5. Show Web Research as the real v0.1 ability.
6. Enter: `Research RunwayML and produce a concise company profile.`
7. Click `Run agent`.
8. Show the trace.
9. Show the Markdown final output.
10. Export Agent Spec and point out the API key is absent.

## Talking points

- Apps are future MCP-style tool providers.
- Skills are reusable instructions, not tools.
- Abilities are native runner capabilities.
- The runner is a Railway worker hidden behind the product abstraction.
- v0.1 starts with one agent and evolves later into multi-agent CRUD.
```

- [ ] **Step 2: Create README**

Create `README.md`:

```md
# Agent Builder Demo

Railway-ready v0.1 demo for a configurable code-agent builder.

## What it proves

- Configure one Research Agent.
- Configure model provider, model name, API endpoint, and runtime-only API key.
- Toggle mock apps and skills.
- Run a task through a hidden runner boundary.
- Render final Markdown output.

## Local development

```bash
pnpm install
RUNNER_MODE=fake pnpm dev
```

Open http://localhost:5173.

## Tests

```bash
pnpm test
pnpm typecheck
pnpm build
```

## Deployment

See `docs/railway-deployment.md`.
```

- [ ] **Step 3: Run final verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Run health smoke**

Start services:

```bash
RUNNER_MODE=fake pnpm dev
```

In a second terminal, run:

```bash
pnpm smoke:health
```

Expected:

```json
{"ok":true}{"ok":true,"runnerMode":"fake"}
```

- [ ] **Step 5: Commit**

Run:

```bash
git add README.md docs/demo-script.md
git commit -m "docs: add demo readiness guide"
```

Expected: commit succeeds.

## Self-Review

Spec coverage:

- Single Research Agent: Tasks 2, 5, 6.
- Railway deployment: Task 8.
- Hidden Codex runner: Tasks 3, 4, 6.
- Model provider/name/endpoint/API key: Tasks 2, 4, 6.
- API key not persisted/exported: Tasks 2, 4, 5, 6.
- Mock apps/skills/abilities: Tasks 2, 6.
- Markdown final output: Tasks 3, 4, 6.
- No permissions UI: Task 6 omits it; Task 3 documents broad runner mode.
- RunwayML-inspired UI: Task 6 styles.
- Local and deployment verification: Tasks 7, 8, 9.

Known intentional deferrals:

- Postgres persistence is deferred behind the `RunStore` boundary.
- Real MCP apps are deferred behind the static plugin registry.
- SSE is minimal snapshot-only in v0.1; the first run path returns the completed run response directly.
