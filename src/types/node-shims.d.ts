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
  export function spawnSync(command: string, args?: readonly string[], options?: SpawnOptions & { encoding?: string; stdio?: string }): { status: number | null; stdout: string; stderr: string };
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function writeFileSync(path: string, data: string, encoding?: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
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
declare function clearTimeout(id: unknown): void;

declare class AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

declare interface Error {
  code?: string;
}

declare function require(name: string): unknown;
