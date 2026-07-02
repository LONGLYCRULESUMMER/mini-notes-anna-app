#!/usr/bin/env node
/**
 * Manual protocol smoke test for the Executa tool — no anna-app CLI, no
 * harness. It spawns the plugin (`go run .` by default, or a built
 * binary via RPC_SMOKE_BIN), then acts as a minimal fake host:
 *
 *   1. sends `initialize` (v2) → asserts sampling capability declared
 *   2. sends `describe`       → asserts manifest shape (name, tools[],
 *                               parameters[], host_capabilities)
 *   3. sends `health`
 *   4. sends `invoke summarize` and, when the plugin emits the reverse
 *      `sampling/createMessage` request, answers it like the host would
 *      → asserts the invoke result contains exactly the summary text we
 *      injected (proving the summary comes from sampling, not from any
 *      local rule in the tool)
 *
 * Exit code 0 = all assertions passed.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = resolve(root, "executas/notes-summarizer");

const MOCK_SUMMARY =
  "[rpc-smoke fake-host] summary injected through sampling/createMessage";

const cmd = process.env.RPC_SMOKE_BIN
  ? { bin: process.env.RPC_SMOKE_BIN, args: [], cwd: root }
  : { bin: "go", args: ["run", "."], cwd: pluginDir };

console.log(`[rpc-smoke] spawning: ${cmd.bin} ${cmd.args.join(" ")}`);
const child = spawn(cmd.bin, cmd.args, {
  cwd: cmd.cwd,
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = createInterface({ input: child.stdout });
const inbox = [];
const waiters = [];
let sawSamplingRequest = false;

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    fail(`plugin wrote non-JSON to stdout: ${line}`);
  }

  // Reverse RPC from the plugin → answer like the host would.
  if (msg.method === "sampling/createMessage") {
    sawSamplingRequest = true;
    const meta = msg.params?.metadata ?? {};
    console.log(
      `[rpc-smoke] ← reverse RPC sampling/createMessage (invoke_id=${meta.executa_invoke_id})`,
    );
    assert(
      Array.isArray(msg.params?.messages) && msg.params.messages.length > 0,
      "sampling request carries messages[]",
    );
    assert(
      typeof msg.params.messages[0]?.content?.text === "string" &&
        msg.params.messages[0].content.text.includes("修复登录 bug"),
      "sampling prompt contains the note content",
    );
    assert(
      typeof meta.executa_invoke_id === "string" && meta.executa_invoke_id.length > 0,
      "sampling metadata carries executa_invoke_id",
    );
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        role: "assistant",
        content: { type: "text", text: MOCK_SUMMARY },
        model: "rpc-smoke-fake-model",
        stopReason: "endTurn",
        usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
      },
    });
    return;
  }

  // Response to one of our requests.
  const w = waiters.shift();
  if (w) w(msg);
  else inbox.push(msg);
});

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function nextResponse(timeoutMs = 60_000) {
  const queued = inbox.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timed out waiting for response")), timeoutMs);
    waiters.push((msg) => {
      clearTimeout(t);
      res(msg);
    });
  });
}

let failed = false;
function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed = true;
    console.error(`  ✗ ${label}`);
  }
}
function fail(msg) {
  console.error(`[rpc-smoke] FATAL: ${msg}`);
  process.exitCode = 1;
  child.kill();
  process.exit(1);
}

try {
  // 1. initialize
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2.0",
      clientInfo: { name: "rpc-smoke", version: "1.0" },
      capabilities: { sampling: { maxTokensPerCall: 8192 } },
    },
  });
  const init = await nextResponse();
  console.log("[rpc-smoke] initialize →", JSON.stringify(init.result));
  assert(init.result?.protocolVersion === "2.0", "negotiated protocol v2");
  assert(
    !!(init.result?.capabilities?.sampling && init.result?.client_capabilities?.sampling),
    "plugin declared sampling capability (capabilities + client_capabilities)",
  );

  // 2. describe
  send({ jsonrpc: "2.0", id: 2, method: "describe" });
  const desc = await nextResponse();
  const m = desc.result ?? {};
  assert(m.name === "tool-dev-mini-notes-summarizer", "manifest.name = tool_id");
  assert(typeof m.display_name === "string" && !!m.display_name, "manifest.display_name present");
  assert(typeof m.version === "string" && !!m.version, "manifest.version present");
  assert(typeof m.description === "string" && !!m.description, "manifest.description present");
  assert(
    Array.isArray(m.host_capabilities) && m.host_capabilities.includes("llm.sample"),
    'manifest.host_capabilities includes "llm.sample"',
  );
  assert(m.runtime?.type === "binary", "manifest.runtime declared");
  const summarize = (m.tools ?? []).find((t) => t.name === "summarize");
  assert(!!summarize, "manifest.tools[] contains summarize");
  assert(
    Array.isArray(summarize?.parameters) &&
      summarize.parameters.some((p) => p.name === "notes" && p.required === true),
    "summarize uses Executa parameters[] schema (not MCP input_schema)",
  );

  // 3. health
  send({ jsonrpc: "2.0", id: 3, method: "health" });
  const health = await nextResponse();
  assert(health.result?.status === "ready", "health → ready");

  // 4. invoke summarize (the fake host answers the reverse sampling RPC)
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "invoke",
    params: {
      tool: "summarize",
      arguments: {
        notes: ["1. 明天跟客户 follow up", "2. 修复登录 bug", "3. Workshop 内容想法"],
        max_words: 60,
      },
      context: { invoke_id: "rpc-smoke-invoke-0001" },
    },
  });
  const inv = await nextResponse();
  console.log("[rpc-smoke] invoke →", JSON.stringify(inv.result ?? inv.error));
  assert(sawSamplingRequest, "plugin emitted reverse sampling/createMessage");
  assert(inv.result?.success === true, "invoke returned success envelope");
  assert(
    inv.result?.data?.summary === MOCK_SUMMARY,
    "summary equals the text injected via sampling (no local fabrication)",
  );
  assert(inv.result?.data?.invoke_id === "rpc-smoke-invoke-0001", "invoke_id echoed for audit");

  // 5. shutdown + EOF
  send({ jsonrpc: "2.0", id: 5, method: "shutdown" });
  await nextResponse();
  child.stdin.end();

  console.log(failed ? "\n[rpc-smoke] FAILED" : "\n[rpc-smoke] all checks passed ✅");
  process.exit(failed ? 1 : 0);
} catch (e) {
  fail(e.message);
}
