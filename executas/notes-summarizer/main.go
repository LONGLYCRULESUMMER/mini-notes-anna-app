// mini-notes-summarizer — Anna Executa tool (Go).
//
// Speaks Executa JSON-RPC 2.0 over stdio:
//   - one JSON-RPC request per stdin line, one response per stdout line
//   - stdout carries ONLY JSON-RPC frames; all logging goes to stderr
//   - the process keeps reading stdin until EOF (never exits after one
//     request — the Agent would mark it Stopped)
//
// The `summarize` tool does NOT build the summary itself: it issues a
// reverse JSON-RPC `sampling/createMessage` to the host and returns
// whatever the host LLM (or a --mock-sampling fixture) produced. The
// same stdin reader therefore receives both agent-initiated requests
// (which carry a `method`) and host responses to our reverse RPCs
// (which carry only `id` + `result`/`error`).
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	toolID          = "tool-dev-mini-notes-summarizer"
	toolVersion     = "1.0.0"
	protocolV2      = "2.0"
	samplingTimeout = 90 * time.Second
)

// ─── Manifest (returned bare by `describe`) ─────────────────────────

var manifest = map[string]any{
	"name":              toolID,
	"display_name":      "Mini Notes Summarizer",
	"version":           toolVersion,
	"description":       "Summarizes the user's mini notes by borrowing the host LLM via reverse sampling/createMessage.",
	"author":            "mini-notes-anna-app",
	"host_capabilities": []string{"llm.sample"},
	"tools": []any{
		map[string]any{
			"name":        "summarize",
			"description": "Summarize the supplied notes into one short paragraph plus action points.",
			"parameters": []any{
				map[string]any{
					"name":        "notes",
					"type":        "array",
					"description": "The notes to summarize, one string per note (already ordered).",
					"required":    true,
				},
				map[string]any{
					"name":        "max_words",
					"type":        "integer",
					"description": "Approximate maximum words in the summary.",
					"required":    false,
					"default":     80,
				},
			},
			"timeout": 90,
		},
	},
	"runtime": map[string]any{"type": "binary"},
}

// ─── stdout / reverse-RPC plumbing ──────────────────────────────────

var (
	stdout   = bufio.NewWriter(os.Stdout)
	stdoutMu sync.Mutex

	pending   = map[string]chan rpcFrame{}
	pendingMu sync.Mutex

	// Set to a non-empty reason when v2 was not negotiated.
	samplingDisabled   string
	samplingDisabledMu sync.Mutex
)

type rpcFrame struct {
	Jsonrpc string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[mini-notes-summarizer] "+format+"\n", args...)
}

// writeFrame marshals one JSON-RPC frame to stdout and flushes
// immediately — the Agent reads line-buffered.
func writeFrame(v any) {
	buf, err := json.Marshal(v)
	if err != nil {
		logf("marshal error: %v", err)
		return
	}
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	stdout.Write(buf)
	stdout.WriteByte('\n')
	stdout.Flush()
}

func respond(id json.RawMessage, result any) {
	writeFrame(map[string]any{"jsonrpc": "2.0", "id": rawOrNull(id), "result": result})
}

func respondErr(id json.RawMessage, code int, msg string, data any) {
	e := map[string]any{"code": code, "message": msg}
	if data != nil {
		e["data"] = data
	}
	writeFrame(map[string]any{"jsonrpc": "2.0", "id": rawOrNull(id), "error": e})
}

func rawOrNull(id json.RawMessage) any {
	if len(id) == 0 {
		return nil
	}
	return json.RawMessage(id)
}

func newRequestID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ─── Reverse RPC: sampling/createMessage ────────────────────────────

type samplingResult struct {
	Role       string         `json:"role"`
	Content    contentBlock   `json:"content"`
	Model      string         `json:"model"`
	StopReason string         `json:"stopReason"`
	Usage      map[string]any `json:"usage"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// createMessage sends a reverse `sampling/createMessage` request on
// stdout and blocks until the host writes the matching response to our
// stdin (routed here via the pending map).
func createMessage(params map[string]any) (*samplingResult, *rpcError) {
	samplingDisabledMu.Lock()
	disabled := samplingDisabled
	samplingDisabledMu.Unlock()
	if disabled != "" {
		return nil, &rpcError{Code: -32008, Message: "sampling not negotiated: " + disabled}
	}

	rid := newRequestID()
	ch := make(chan rpcFrame, 1)
	pendingMu.Lock()
	pending[rid] = ch
	pendingMu.Unlock()
	defer func() {
		pendingMu.Lock()
		delete(pending, rid)
		pendingMu.Unlock()
	}()

	logf("→ reverse RPC sampling/createMessage id=%s", rid)
	writeFrame(map[string]any{
		"jsonrpc": "2.0",
		"id":      rid,
		"method":  "sampling/createMessage",
		"params":  params,
	})

	select {
	case resp := <-ch:
		if resp.Error != nil {
			logf("← sampling error id=%s code=%d: %s", rid, resp.Error.Code, resp.Error.Message)
			return nil, resp.Error
		}
		var res samplingResult
		if err := json.Unmarshal(resp.Result, &res); err != nil {
			return nil, &rpcError{Code: -32603, Message: "bad sampling result: " + err.Error()}
		}
		logf("← sampling result id=%s model=%s stopReason=%s", rid, res.Model, res.StopReason)
		return &res, nil
	case <-time.After(samplingTimeout):
		return nil, &rpcError{Code: -32005, Message: "sampling/createMessage timed out"}
	}
}

// ─── Tool: summarize ────────────────────────────────────────────────

func handleSummarize(args map[string]any, invokeID string) (map[string]any, *rpcError) {
	notes := toStringSlice(args["notes"])
	if len(notes) == 0 {
		return nil, &rpcError{Code: -32602, Message: "argument 'notes' must be a non-empty array of strings"}
	}
	maxWords := 80
	if v, ok := args["max_words"].(float64); ok && v >= 10 && v <= 400 {
		maxWords = int(v)
	}

	prompt := fmt.Sprintf(
		"Summarize the following notes in at most %d words. "+
			"Group related items, keep concrete action points, and reply in the "+
			"dominant language of the notes. Return only the summary, no preamble.\n\nNotes:\n%s",
		maxWords, strings.Join(notes, "\n"),
	)

	res, rerr := createMessage(map[string]any{
		"messages": []any{
			map[string]any{
				"role":    "user",
				"content": map[string]any{"type": "text", "text": prompt},
			},
		},
		"maxTokens":      clamp(maxWords*5, 128, 1024),
		"systemPrompt":   "You are a concise assistant that summarizes short personal notes.",
		"includeContext": "none",
		// invoke_id in metadata → nexus can attribute usage and the
		// reviewer can correlate the invoke with the sampling call.
		"metadata": map[string]any{
			"executa_invoke_id": invokeID,
			"tool":              "summarize",
			"note_count":        len(notes),
		},
	})
	if rerr != nil {
		return nil, rerr
	}
	return map[string]any{
		"summary":    strings.TrimSpace(res.Content.Text),
		"model":      res.Model,
		"stopReason": res.StopReason,
		"usage":      res.Usage,
		"note_count": len(notes),
		"invoke_id":  invokeID,
	}, nil
}

func toStringSlice(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ─── Method dispatch ────────────────────────────────────────────────

func handleInitialize(id json.RawMessage, params map[string]any) {
	proto, _ := params["protocolVersion"].(string)
	if proto != protocolV2 {
		if proto == "" {
			proto = "1.1"
		}
		samplingDisabledMu.Lock()
		samplingDisabled = fmt.Sprintf("host offered protocolVersion=%q; sampling requires v2", proto)
		samplingDisabledMu.Unlock()
		logf("initialize: negotiated v1 (%s) — sampling disabled", proto)
		respond(id, map[string]any{
			"protocolVersion": "1.1",
			"server_info":     map[string]any{"name": toolID, "version": toolVersion},
			"serverInfo":      map[string]any{"name": toolID, "version": toolVersion},
			"capabilities":    map[string]any{},
		})
		return
	}
	logf("initialize: negotiated protocol v2, declaring sampling capability")
	sampling := map[string]any{"sampling": map[string]any{}}
	respond(id, map[string]any{
		"protocolVersion": protocolV2,
		"server_info":     map[string]any{"name": toolID, "version": toolVersion},
		"serverInfo":      map[string]any{"name": toolID, "version": toolVersion},
		// Declared under both keys for compatibility: the lifecycle doc
		// uses `capabilities`, older harnesses read `client_capabilities`.
		"capabilities":        sampling,
		"client_capabilities": sampling,
	})
}

func handleInvoke(id json.RawMessage, params map[string]any) {
	tool, _ := params["tool"].(string)
	args, _ := params["arguments"].(map[string]any)
	if args == nil {
		args = map[string]any{}
	}

	invokeID := ""
	if ctx, ok := params["context"].(map[string]any); ok {
		invokeID, _ = ctx["invoke_id"].(string)
	}
	if invokeID == "" {
		invokeID, _ = params["invoke_id"].(string)
	}
	if invokeID == "" {
		invokeID = "local-" + newRequestID()
	}

	logf("invoke tool=%q invoke_id=%s", tool, invokeID)
	if tool != "summarize" {
		respondErr(id, -32601, "unknown tool: "+tool, nil)
		return
	}

	data, rerr := handleSummarize(args, invokeID)
	if rerr != nil {
		respondErr(id, rerr.Code, rerr.Message, rerr.Data)
		return
	}
	respond(id, map[string]any{"success": true, "tool": tool, "data": data})
}

func dispatch(frame rpcFrame) {
	var params map[string]any
	if len(frame.Params) > 0 {
		_ = json.Unmarshal(frame.Params, &params)
	}
	if params == nil {
		params = map[string]any{}
	}

	switch frame.Method {
	case "initialize":
		handleInitialize(frame.ID, params)
	case "describe":
		respond(frame.ID, manifest)
	case "invoke":
		handleInvoke(frame.ID, params)
	case "health":
		respond(frame.ID, map[string]any{"status": "ready", "version": toolVersion})
	case "shutdown":
		logf("shutdown requested")
		respond(frame.ID, map[string]any{"ok": true})
	default:
		if len(frame.ID) > 0 {
			respondErr(frame.ID, -32601, "method not found: "+frame.Method, nil)
		}
	}
}

// ─── Main loop ──────────────────────────────────────────────────────

func main() {
	logf("started pid=%d (%s v%s)", os.Getpid(), toolID, toolVersion)

	// Tracks in-flight handlers so an immediate stdin EOF (e.g.
	// `echo '{"method":"describe",...}' | ./tool`) still flushes the
	// response before the process exits.
	var inflight sync.WaitGroup

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}

		var frame rpcFrame
		if err := json.Unmarshal(line, &frame); err != nil {
			logf("parse error: %v", err)
			respondErr(nil, -32700, "parse error", nil)
			continue
		}

		// No method + an id → this is the host's response to one of our
		// reverse RPCs (sampling). Route it to the waiting goroutine.
		if frame.Method == "" && len(frame.ID) > 0 {
			var key string
			if err := json.Unmarshal(frame.ID, &key); err != nil {
				logf("unmatched response with non-string id: %s", string(frame.ID))
				continue
			}
			pendingMu.Lock()
			ch, ok := pending[key]
			pendingMu.Unlock()
			if ok {
				ch <- frame
			} else {
				logf("unmatched response id=%s", key)
			}
			continue
		}

		// Copy the frame (scanner reuses its buffer) and handle
		// concurrently so a long sampling round-trip does not block
		// health checks or further requests.
		f := frame
		f.ID = append(json.RawMessage(nil), frame.ID...)
		f.Params = append(json.RawMessage(nil), frame.Params...)
		inflight.Add(1)
		go func() {
			defer inflight.Done()
			dispatch(f)
		}()
	}

	if err := scanner.Err(); err != nil {
		logf("stdin error: %v", err)
	}
	inflight.Wait()
	logf("stdin closed (EOF) — exiting")
}
