/**
 * Minimal type surface for the Anna App runtime SDK, which the host
 * serves at /static/anna-apps/_sdk/latest/index.js (external import —
 * see vite.config.ts).
 */
declare module "/static/anna-apps/_sdk/latest/index.js" {
  export interface AnnaStorageGetResult {
    value: unknown;
    etag?: string;
    generation?: number;
    exists?: boolean;
  }

  export interface AnnaRuntime {
    windowUuid: string;
    runtimeState?: Record<string, unknown>;
    storage: {
      get(args: { key: string }): Promise<AnnaStorageGetResult>;
      set(args: { key: string; value: unknown }): Promise<unknown>;
      delete(args: { key: string }): Promise<unknown>;
    };
    tools: {
      list(): Promise<{ tools: Array<{ tool_id: string }> }>;
      invoke(args: {
        tool_id: string;
        method?: string;
        args?: Record<string, unknown>;
        timeoutMs?: number;
      }): Promise<Record<string, unknown>>;
    };
    window: {
      set_title(args: { title: string }): Promise<unknown>;
    };
    on(event: string, handler: (payload: unknown) => void): () => void;
  }

  export const AnnaAppRuntime: {
    connect(): Promise<AnnaRuntime>;
  };
}
