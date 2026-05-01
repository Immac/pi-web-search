declare module "@mariozechner/pi-coding-agent" {
  export interface ExtensionUIContext {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    confirm(title: string, message: string): Promise<boolean>;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContext;
    hasUI: boolean;
  }

  export interface ExtensionAPI {
    on(
      event: "session_start",
      handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
    ): void;
    registerTool(definition: {
      name: string;
      label: string;
      description: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: any,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: ExtensionContext,
      ) => Promise<unknown>;
    }): void;
  }
}
