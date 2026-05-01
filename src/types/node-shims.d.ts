declare module "node:child_process" {
  export interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio?: unknown;
    detached?: boolean;
  }

  export interface ChildProcess {
    stdout?: {
      setEncoding(encoding: string): void;
      on(event: string, listener: (...args: unknown[]) => void): void;
    };
    stderr?: {
      setEncoding(encoding: string): void;
      on(event: string, listener: (...args: unknown[]) => void): void;
    };
    on(event: string, listener: (...args: unknown[]) => void): void;
    kill(signal?: string): boolean;
    unref?(): void;
  }

  export function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function resolve(...pathSegments: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  platform: string;
  arch: string;
  cwd(): string;
};

declare const URL: {
  new (url: string, base?: string): {
    protocol: string;
    toString(): string;
  };
};

declare const WebSocket: {
  new (url: string): {
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onclose: ((event: unknown) => void) | null;
    send(data: string): void;
    close(): void;
  };
};

declare interface ImportMeta {
  url: string;
}

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): unknown;

declare function require(name: string): unknown;
