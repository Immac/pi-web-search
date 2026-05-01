declare module "playwright" {
  export const chromium: {
    launchPersistentContext(
      userDataDir: string,
      options?: {
        executablePath?: string;
        headless?: boolean;
        viewport?: { width: number; height: number };
        locale?: string;
        timezoneId?: string;
        userAgent?: string;
        colorScheme?: string;
        args?: string[];
        extraHTTPHeaders?: Record<string, string>;
      },
    ): Promise<{
      pages(): Array<{
        goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
        waitForLoadState(state?: string, options?: { timeout?: number }): Promise<unknown>;
        locator(selector: string): {
          innerText(options?: { timeout?: number }): Promise<string>;
        };
        content(): Promise<string>;
        close(): Promise<void>;
      }>;
      newPage(): Promise<{
        goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
        waitForLoadState(state?: string, options?: { timeout?: number }): Promise<unknown>;
        locator(selector: string): {
          innerText(options?: { timeout?: number }): Promise<string>;
        };
        content(): Promise<string>;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }>;
  };
}
