export type E2BCommandResult = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

export type E2BSandboxLike = {
  sandboxId: string;
  commands: {
    run: (
      command: string,
      opts?: {
        cwd?: string;
        timeoutMs?: number;
        envs?: Record<string, string>;
        onStdout?: (data: string) => void | Promise<void>;
        onStderr?: (data: string) => void | Promise<void>;
      }
    ) => Promise<E2BCommandResult>;
  };
  files: {
    write: (path: string, data: string) => Promise<void>;
    read: (path: string) => Promise<string>;
  };
  pause: () => Promise<void>;
  kill: () => Promise<void>;
};

export type E2BSandboxFactory = {
  create: (templateId: string) => Promise<E2BSandboxLike>;
  connect: (sandboxId: string) => Promise<E2BSandboxLike>;
};
