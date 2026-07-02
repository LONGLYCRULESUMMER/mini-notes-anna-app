import {
  AnnaAppRuntime,
  type AnnaRuntime,
} from "/static/anna-apps/_sdk/latest/index.js";

let runtime: AnnaRuntime | null = null;

/**
 * Connect to the Anna host through the runtime SDK.
 *
 * Requires the iframe to be opened by the host (anna-app dev harness or
 * production) with ?wid=…&t=… params. Throws when running standalone.
 */
export async function connect(): Promise<AnnaRuntime> {
  if (runtime) return runtime;
  runtime = await AnnaAppRuntime.connect();
  return runtime;
}

export function getRuntime(): AnnaRuntime {
  if (!runtime) throw new Error("Anna runtime not connected");
  return runtime;
}
