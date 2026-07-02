/**
 * Shared identity constants.
 *
 * TOOL_ID must stay literally identical across four places:
 *   1. manifest.json → required_executas[].tool_id
 *   2. manifest.json → ui.host_api.tools ("required:<TOOL_ID>")
 *   3. executas/notes-summarizer/executa.json → tool_id
 *   4. this constant (used by anna.tools.invoke from the bundle)
 *
 * For local `anna-app dev` a dev-style id is fine; after minting a real
 * id on /executa, replace it in all four places.
 */
export const TOOL_ID = "tool-dev-mini-notes-summarizer";

/** Plugin-side method (the `tools[].name` in the Executa manifest). */
export const TOOL_METHOD = "summarize";

/** Single APS KV key holding all notes state. */
export const STORAGE_KEY = "mini-notes/v1";
