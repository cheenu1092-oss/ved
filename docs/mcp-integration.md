# Ved — MCP Integration Spec

> Session 27 · PLAN (4 of 5) · 2026-03-05
> Covers: tool discovery, transport lifecycle, permission model, retry/timeout, error recovery, LLM tool formatting

---

## 1. Overview

Ved treats MCP servers as the **sole mechanism for tool execution**. There are no built-in tools — everything (filesystem, web search, memory operations exposed to the LLM) flows through MCP. This keeps Ved's core small and extensible.

**Design goals:**
- Lazy discovery — connect and discover tools only when first needed (not at startup)
- Graceful degradation — if an MCP server is unreachable, Ved still works (just without those tools)
- Trust-integrated — every tool call passes through the trust engine before execution
- Transport-agnostic — stdio and HTTP (SSE) transports share the same interface
- Zero vendor lock-in — MCP is an open standard

**What this doc covers:**
1. Server lifecycle (connect, discover, disconnect, reconnect)
2. Transport details (stdio, HTTP/SSE)
3. Tool discovery and caching
4. Permission model (trust × risk)
5. Tool execution flow
6. Retry, timeout, and error recovery
7. LLM tool formatting (how tools become LLM function definitions)
8. Built-in MCP servers (shipped with Ved)

---

## 2. Server Lifecycle

### 2.1 States

Each configured MCP server has a lifecycle state:

```
                ┌────────┐
                │  IDLE  │ ← initial state (configured but not connected)
                └───┬────┘
                    │ first tool request OR explicit connect
                    ▼
              ┌───────────┐
              │ CONNECTING │
              └─────┬─────┘
                    │
          ┌────────┼────────┐
          │success │        │ failure
          ▼        │        ▼
    ┌──────────┐   │  ┌──────────┐
    │  READY   │   │  │  FAILED  │
    └────┬─────┘   │  └────┬─────┘
         │         │       │ retry (with backoff)
         │         │       └──→ CONNECTING
         │         │
         │ transport error / process exit
         ▼
   ┌────────────┐
   │ RECONNECTING│ ── retry limit hit ──→ FAILED
   └──────┬─────┘
          │ success
          └──→ READY (re-discover tools)
```

### 2.2 Lazy Connection

Ved does NOT connect to MCP servers at startup. Connections happen on first need:

```typescript
// When LLM requests a tool call:
async executeTool(call: ToolCall): Promise<ToolResult> {
  const server = this.getServerForTool(call.tool);
  if (!server) throw new VedError('MCP_TOOL_NOT_FOUND', ...);
  
  // Lazy connect
  if (server.state === 'idle') {
    await this.connectServer(server.name);  // connect + discover
  }
  
  // Server might be failed from a previous attempt
  if (server.state === 'failed') {
    throw new VedError('MCP_SERVER_UNREACHABLE', ...);
  }
  
  return this.callTool(server, call);
}
```

**Exception:** `discoverTools()` during EventLoop init triggers connection to ALL enabled servers to populate the tool list for the LLM system prompt. This is the one eager connection point.

### 2.3 Startup Discovery

During `EventLoop.init()`:

```
1. Load MCP server configs from ved.yaml
2. For each enabled server:
   a. Connect transport (stdio: spawn process, http: handshake)
   b. Send `initialize` request (MCP protocol)
   c. Send `tools/list` request
   d. Map tool definitions → MCPToolDefinition[] (with risk levels)
   e. Cache tool list in memory
   f. Register tools in mcp_servers table (upsert)
3. Log: "Discovered {N} tools from {M} MCP servers"
4. If a server fails to connect: log warning, continue without it
```

### 2.4 Shutdown

During `EventLoop.shutdown()`:

```
1. For each connected server:
   a. Send no requests (MCP has no explicit "goodbye")
   b. Close transport:
      - stdio: close stdin, SIGTERM child, wait 3s, SIGKILL
      - http: close SSE connection
   c. Set state → IDLE
2. Clear tool cache
```

---

## 3. Transport Details

### 3.1 Stdio Transport

The most common MCP transport. Ved spawns a child process and communicates via JSON-RPC 2.0 over stdin/stdout.

```typescript
class StdioTransport implements MCPTransport {
  private process: ChildProcess | null = null;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private nextId: number = 1;
  private buffer: string = '';  // partial line buffer
  
  async connect(): Promise<void> {
    const { command, args, env } = this.config;
    
    this.process = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],  // stdin, stdout, stderr
      // No shell: true — direct execution for security
    });
    
    // Line-delimited JSON-RPC on stdout
    this.process.stdout.on('data', (chunk) => this.handleData(chunk));
    
    // stderr → log as debug (MCP servers may emit diagnostics)
    this.process.stderr.on('data', (chunk) => {
      this.logger.debug(`MCP server "${this.config.name}" stderr: ${chunk}`);
    });
    
    // Process exit → trigger reconnect
    this.process.on('exit', (code, signal) => {
      this.logger.warn(`MCP server "${this.config.name}" exited`, { code, signal });
      this.connected = false;
      this.rejectAllPending(new VedError('MCP_TRANSPORT_ERROR', 
        `Server process exited (code=${code}, signal=${signal})`));
      this.emit('disconnected', { code, signal });
    });
    
    // MCP initialize handshake
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},  // Ved requests no server capabilities
      clientInfo: { name: 'ved', version: VED_VERSION }
    });
    
    this.connected = true;
  }
  
  async disconnect(): Promise<void> {
    if (!this.process) return;
    
    this.process.stdin.end();       // close stdin gracefully
    
    // Wait for exit, then force kill
    const exited = await Promise.race([
      new Promise(r => this.process!.on('exit', r)),
      sleep(3000).then(() => 'timeout')
    ]);
    
    if (exited === 'timeout') {
      this.process.kill('SIGKILL');
    }
    
    this.process = null;
    this.connected = false;
  }
  
  async send(method: string, params?: unknown): Promise<unknown> {
    if (!this.process || !this.connected) {
      throw new VedError('MCP_TRANSPORT_ERROR', 'Not connected');
    }
    
    const id = this.nextId++;
    const request = { jsonrpc: '2.0', id, method, params };
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new VedError('MCP_SERVER_TIMEOUT', 
          `No response after ${this.config.timeout}ms`));
      }, this.config.timeout);
      
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.process!.stdin.write(JSON.stringify(request) + '\n');
    });
  }
  
  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop()!;  // keep incomplete line
    
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if ('id' in msg && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          
          if ('error' in msg) {
            pending.reject(new VedError('MCP_TOOL_EXECUTION_ERROR', 
              msg.error.message, undefined, msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
        // Notifications (no id) — log and ignore for now
        // Future: handle resource updates, progress, etc.
      } catch {
        this.logger.warn('Failed to parse MCP response line', { line });
      }
    }
  }
}
```

**Security constraints for stdio:**
- `shell: false` — always. No shell injection.
- `env` is merged, not replaced — server inherits PATH but can have additional vars.
- `command` must be a known binary path or bare command (no `&&`, `|`, `;`).
- Config validation rejects commands containing shell metacharacters.

### 3.2 HTTP/SSE Transport

For MCP servers running as standalone HTTP services.

```typescript
class HttpTransport implements MCPTransport {
  private eventSource: EventSource | null = null;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private nextId: number = 1;
  private sessionUrl: string | null = null;
  
  async connect(): Promise<void> {
    const { url } = this.config;
    
    // Step 1: Open SSE connection for server→client messages
    this.eventSource = new EventSource(`${url}/sse`);
    
    // The server sends an 'endpoint' event with the POST URL
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new VedError('MCP_SERVER_TIMEOUT', 'SSE handshake timeout'));
      }, this.config.timeout);
      
      this.eventSource!.addEventListener('endpoint', (e: MessageEvent) => {
        this.sessionUrl = new URL(e.data, url).toString();
        clearTimeout(timer);
        resolve();
      });
      
      this.eventSource!.addEventListener('message', (e: MessageEvent) => {
        this.handleMessage(JSON.parse(e.data));
      });
      
      this.eventSource!.onerror = () => {
        clearTimeout(timer);
        reject(new VedError('MCP_TRANSPORT_ERROR', 'SSE connection failed'));
      };
    });
    
    // Step 2: MCP initialize handshake
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ved', version: VED_VERSION }
    });
    
    this.connected = true;
  }
  
  async send(method: string, params?: unknown): Promise<unknown> {
    if (!this.sessionUrl) {
      throw new VedError('MCP_TRANSPORT_ERROR', 'No session URL');
    }
    
    const id = this.nextId++;
    const request = { jsonrpc: '2.0', id, method, params };
    
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new VedError('MCP_SERVER_TIMEOUT', 
          `No response after ${this.config.timeout}ms`));
      }, this.config.timeout);
      
      this.pendingRequests.set(id, { resolve, reject, timer });
      
      try {
        const res = await fetch(this.sessionUrl!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.config.timeout)
        });
        
        if (!res.ok) {
          this.pendingRequests.delete(id);
          clearTimeout(timer);
          reject(new VedError('MCP_TRANSPORT_ERROR', 
            `HTTP ${res.status}: ${res.statusText}`));
        }
        // Response comes via SSE, not HTTP response body
      } catch (err) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(new VedError('MCP_TRANSPORT_ERROR', String(err)));
      }
    });
  }
  
  async disconnect(): Promise<void> {
    this.eventSource?.close();
    this.eventSource = null;
    this.sessionUrl = null;
    this.connected = false;
  }
}
```

### 3.3 Transport Comparison

| Aspect | stdio | HTTP/SSE |
|--------|-------|----------|
| Lifecycle | Ved spawns & owns process | External process, Ved connects |
| Latency | Lower (IPC) | Higher (HTTP) |
| Crash recovery | Ved detects exit, respawns | Ved detects SSE drop, reconnects |
| Resource mgmt | Ved manages child process | External responsibility |
| Auth | Implicit (same machine) | Future: bearer tokens |
| Use case | Local tools, bundled servers | Remote tools, shared servers |

---

## 4. Tool Discovery

### 4.1 Discovery Flow

```
MCPClient.discoverTools()
    │
    ├── for each enabled server in config:
    │     ├── connect transport (if not already connected)
    │     ├── send "tools/list" request
    │     ├── receive tool definitions: { name, description, inputSchema }
    │     ├── apply risk level:
    │     │     ├── check server.toolOverrides[tool.name]?.riskLevel
    │     │     ├── else use server.riskLevel (default from config)
    │     │     └── else RiskLevel.MEDIUM (absolute default)
    │     ├── validate inputSchema is valid JSON Schema
    │     ├── prefix tool name: "{serverName}.{toolName}"
    │     └── add to tool registry
    │
    ├── deduplicate: if two servers expose same tool name, first wins + warn
    ├── cache in memory (this.toolCache: Map<string, CachedTool>)
    ├── upsert mcp_servers table
    └── return MCPToolDefinition[]
```

### 4.2 Tool Naming Convention

Tools are namespaced by server to avoid collisions:

```
{serverName}.{toolName}
```

Examples:
- `filesystem.read_file`
- `filesystem.write_file`
- `web.search`
- `memory.search_vault`

The LLM sees and calls tools by their full namespaced name. This is crucial — it lets Ved route the call to the correct server and prevents collisions between servers that might use the same tool name.

### 4.3 Tool Caching

```typescript
interface CachedTool {
  definition: MCPToolDefinition;     // name, description, schema, risk
  serverName: string;                // which server owns this tool
  discoveredAt: number;              // timestamp
  callCount: number;                 // lifetime calls (for analytics)
  lastCallAt: number | null;        // last execution time
  lastError: string | null;          // last error message (for diagnostics)
}

// Cache is invalidated on:
// 1. Server reconnection (re-discovers tools)
// 2. Manual `ved mcp refresh` CLI command
// 3. Server sends `notifications/tools/list_changed` (MCP spec)
```

### 4.4 Dynamic Tool Changes

MCP spec supports `notifications/tools/list_changed` — the server tells the client its tool list has changed. Ved handles this:

```typescript
// In transport message handler:
if (msg.method === 'notifications/tools/list_changed') {
  this.logger.info(`MCP server "${serverName}" tools changed, re-discovering`);
  await this.rediscoverServer(serverName);
  // No need to restart session — next LLM call will get updated tool list
}
```

---

## 5. Permission Model

### 5.1 Trust × Risk Matrix

Every tool has a `riskLevel`. Every user/session has a `trustTier`. The matrix determines execution behavior:

```
                    Risk Level
Trust Tier    LOW        MEDIUM       HIGH        CRITICAL
──────────────────────────────────────────────────────────
  FULL (4)    auto       auto         auto        approve
  HIGH (3)    auto       auto         approve     deny
  MED  (2)    auto       approve      deny        deny
  LOW  (1)    approve    deny         deny        deny
──────────────────────────────────────────────────────────

auto    = execute immediately, log to audit
approve = create WorkOrder, pause, wait for human approval
deny    = reject, inform LLM, log to audit
```

This is the same matrix from `ved-trust` (S24), applied here at tool execution time.

### 5.2 Risk Level Assignment

Risk levels come from three sources (in priority order):

1. **Per-tool override in config** — `server.toolOverrides.{toolName}.riskLevel`
2. **Server-level default** — `server.riskLevel`
3. **Absolute default** — `MEDIUM`

```yaml
# ved.yaml example
mcp:
  servers:
    - name: filesystem
      transport: stdio
      command: npx
      args: ["-y", "@anthropic/mcp-server-filesystem", "/home/user/docs"]
      riskLevel: medium            # default for all filesystem tools
      toolOverrides:
        write_file:
          riskLevel: high          # writing files is higher risk
        delete_file:
          riskLevel: critical      # deleting files needs explicit approval
```

### 5.3 Server-Level Trust Floor

Each MCP server has a `trustFloor` — the minimum trust tier required to use ANY tool from that server:

```yaml
mcp:
  servers:
    - name: dangerous-server
      trustFloor: 3    # only HIGH or FULL trust users can use any tool
```

If the session's trust tier is below the floor, ALL tools from that server are denied regardless of individual tool risk levels.

### 5.4 Permission Check Flow

```typescript
async checkToolPermission(call: ToolCall, session: Session): Promise<PermissionResult> {
  const tool = this.toolCache.get(call.tool);
  if (!tool) return { action: 'deny', reason: 'Tool not found' };
  
  const server = this.servers.get(tool.serverName);
  
  // 1. Server trust floor check
  if (session.trustTier < server.trustFloor) {
    return { 
      action: 'deny', 
      reason: `Server "${server.name}" requires trust tier ${server.trustFloor}` 
    };
  }
  
  // 2. Tool iteration limit check
  if (session.toolCallCount >= this.config.trust.maxToolCallsPerMessage) {
    return {
      action: 'deny',
      reason: `Tool call limit (${this.config.trust.maxToolCallsPerMessage}) reached`
    };
  }
  
  // 3. Risk × Trust matrix lookup
  const action = TRUST_RISK_MATRIX[session.trustTier][tool.definition.riskLevel];
  
  return {
    action,                    // 'auto' | 'approve' | 'deny'
    riskLevel: tool.definition.riskLevel,
    trustTier: session.trustTier,
    serverName: tool.serverName,
    toolName: call.tool
  };
}
```

---

## 6. Tool Execution Flow

### 6.1 Complete Flow

This is the detailed flow from LLM tool request to result:

```
LLM Response (finishReason: 'tool_use')
    │
    ├── Parse tool calls from LLM response
    │     └── [{tool: "filesystem.read_file", params: {path: "/doc.md"}}]
    │
    ├── For each tool call (sequential, not parallel):
    │     │
    │     ├── 1. VALIDATE
    │     │     ├── Tool exists in cache?
    │     │     ├── Params match inputSchema? (JSON Schema validation)
    │     │     └── If invalid → VedError, skip this call, inform LLM
    │     │
    │     ├── 2. PERMISSION CHECK
    │     │     ├── checkToolPermission(call, session)
    │     │     ├── If 'deny' → audit log, return error result to LLM
    │     │     ├── If 'approve' → create WorkOrder, PAUSE
    │     │     │     ├── Notify user: "Ved wants to {action}. Approve? [Y/n]"
    │     │     │     ├── Wait for response (timeout: trust.approvalTimeoutMs)
    │     │     │     ├── Approved → continue to step 3
    │     │     │     ├── Rejected → audit log, return rejection to LLM
    │     │     │     └── Timeout → auto-reject, audit log
    │     │     └── If 'auto' → continue to step 3
    │     │
    │     ├── 3. EXECUTE
    │     │     ├── Start timer
    │     │     ├── Send "tools/call" to MCP server via transport
    │     │     │     request: { method: "tools/call", 
    │     │     │                params: { name: toolName, arguments: params } }
    │     │     ├── Await response (subject to server timeout)
    │     │     ├── Parse result: { content: [{type: "text", text: "..."}] }
    │     │     └── Stop timer, record duration
    │     │
    │     ├── 4. AUDIT
    │     │     ├── Create audit entry (tool_call event)
    │     │     │     { eventType: 'tool_call', 
    │     │     │       data: { server, tool, params, result, durationMs, 
    │     │     │               permission: 'auto'|'approved', workOrderId? } }
    │     │     ├── Insert into tool_calls table
    │     │     └── Update tool cache stats (callCount, lastCallAt)
    │     │
    │     └── 5. RESULT
    │           ├── Format result as ToolResult
    │           └── Append to context for next LLM call
    │
    └── Return all ToolResult[] to EventLoop
          └── EventLoop appends results to messages, calls LLM again
```

### 6.2 Sequential Execution

Tool calls are executed **sequentially**, not in parallel. Reasons:

1. **Audit ordering** — hash chain requires deterministic order
2. **Simplicity** — no concurrent state management
3. **Safety** — one tool's result might change whether the next should execute
4. **Personal assistant** — latency isn't critical; correctness is

If the LLM requests 3 tool calls, they execute 1→2→3 with each result available before the next.

### 6.3 Result Formatting

MCP tool results are arrays of content blocks. Ved normalizes them:

```typescript
interface ToolResult {
  tool: string;           // namespaced tool name
  success: boolean;
  content: string;        // text content (concatenated from content blocks)
  error?: string;         // error message if !success
  durationMs: number;
  isError: boolean;       // from MCP isError field
}

function formatMCPResult(mcpResult: MCPCallResult): ToolResult {
  // MCP result: { content: [{type: "text", text: "..."}, ...], isError?: boolean }
  const textParts = mcpResult.content
    .filter(c => c.type === 'text')
    .map(c => c.text);
  
  // Image/resource content blocks: log a warning, skip
  // Ved v1 handles text only. Image tool results are a future feature.
  const nonText = mcpResult.content.filter(c => c.type !== 'text');
  if (nonText.length > 0) {
    logger.warn('Non-text content blocks in tool result ignored', {
      types: nonText.map(c => c.type)
    });
  }
  
  return {
    tool: call.tool,
    success: !mcpResult.isError,
    content: textParts.join('\n'),
    error: mcpResult.isError ? textParts.join('\n') : undefined,
    durationMs,
    isError: mcpResult.isError ?? false
  };
}
```

---

## 7. Retry, Timeout, and Error Recovery

### 7.1 Timeout Configuration

```yaml
mcp:
  servers:
    - name: filesystem
      timeout: 30000          # per-request timeout (ms)
      # No global override — each server sets its own

trust:
  approvalTimeoutMs: 300000   # 5 min for HITL approval
  maxToolCallsPerMessage: 10  # max tool iterations per user message
```

### 7.2 Timeout Behavior

| Scenario | Timeout | Behavior |
|----------|---------|----------|
| Tool execution | `server.timeout` (default 30s) | Cancel request, return error result to LLM |
| HITL approval | `trust.approvalTimeoutMs` (default 5min) | Auto-reject, audit log, inform LLM |
| Server connection | `server.timeout` (reused) | Mark server FAILED, log warning |
| SSE handshake | `server.timeout` | Mark server FAILED |

### 7.3 Retry Strategy

**Tool execution: NO automatic retries.**

Why: Retrying a tool call could mean executing it twice (non-idempotent operations like file writes, API calls). The LLM can decide to retry by requesting the same tool call again — that's safer because it's a conscious decision with full context.

**Server connection: Retry with exponential backoff.**

```typescript
const RECONNECT_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,         // 1s, 2s, 4s
  maxDelayMs: 10000,         // cap at 10s
  backoffMultiplier: 2
};

async reconnectServer(serverName: string): Promise<void> {
  const server = this.servers.get(serverName);
  server.state = 'reconnecting';
  
  for (let attempt = 0; attempt < RECONNECT_CONFIG.maxRetries; attempt++) {
    const delay = Math.min(
      RECONNECT_CONFIG.baseDelayMs * (RECONNECT_CONFIG.backoffMultiplier ** attempt),
      RECONNECT_CONFIG.maxDelayMs
    );
    
    await sleep(delay);
    
    try {
      await server.transport.connect();
      await this.rediscoverServer(serverName);
      server.state = 'ready';
      this.logger.info(`MCP server "${serverName}" reconnected after ${attempt + 1} attempts`);
      return;
    } catch (err) {
      this.logger.warn(`MCP server "${serverName}" reconnect attempt ${attempt + 1} failed`, { err });
    }
  }
  
  server.state = 'failed';
  this.logger.error(`MCP server "${serverName}" failed after ${RECONNECT_CONFIG.maxRetries} retries`);
}
```

### 7.4 Error Categories and Handling

| Error Code | Cause | Handling |
|------------|-------|----------|
| `MCP_SERVER_UNREACHABLE` | Can't connect | Log, mark FAILED, exclude tools from LLM |
| `MCP_SERVER_TIMEOUT` | No response in time | Cancel request, return error to LLM |
| `MCP_TOOL_NOT_FOUND` | LLM hallucinated a tool | Return error to LLM (it will self-correct) |
| `MCP_TOOL_EXECUTION_ERROR` | Tool returned error | Return error content to LLM |
| `MCP_TRANSPORT_ERROR` | Process crashed / SSE dropped | Trigger reconnect, return error |
| `MCP_SCHEMA_INVALID` | Tool params don't match schema | Return validation error to LLM |

**Error result to LLM format:**

```json
{
  "role": "tool",
  "tool_use_id": "call_abc123",
  "content": "Error: Tool 'filesystem.read_file' failed: ENOENT: no such file '/nonexistent.md'",
  "is_error": true
}
```

The LLM sees the error and can decide what to do (retry with different params, inform the user, try a different approach).

---

## 8. LLM Tool Formatting

### 8.1 Tool Definitions → LLM Format

Ved converts MCP tool definitions into the LLM provider's expected format. Each provider has a slightly different tool schema:

```typescript
// Anthropic Claude format
function toLLMTools(tools: MCPToolDefinition[]): AnthropicTool[] {
  return tools.map(t => ({
    name: t.name,                    // "filesystem.read_file"
    description: t.description,       // from MCP server
    input_schema: t.inputSchema       // JSON Schema, passed through
  }));
}

// OpenAI format (for future provider support)
function toLLMToolsOpenAI(tools: MCPToolDefinition[]): OpenAITool[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }
  }));
}
```

### 8.2 Tool Filtering

Not all discovered tools are sent to every LLM call. Ved filters:

```typescript
function getToolsForCall(
  allTools: MCPToolDefinition[],
  session: Session
): MCPToolDefinition[] {
  return allTools.filter(tool => {
    const server = this.servers.get(this.toolCache.get(tool.name)!.serverName);
    
    // Exclude tools from unreachable servers
    if (server.state !== 'ready') return false;
    
    // Exclude tools the user can't access (trust floor)
    if (session.trustTier < server.trustFloor) return false;
    
    // Exclude tools that would always be denied (no point showing them)
    const action = TRUST_RISK_MATRIX[session.trustTier][tool.riskLevel];
    if (action === 'deny') return false;
    
    return true;
  });
}
```

**Why filter?** Showing the LLM tools it can't use wastes tokens and causes confusing "tool denied" errors. Better to only show accessible tools.

### 8.3 Tool Call Parsing from LLM Response

```typescript
function parseToolCalls(response: LLMResponse): ToolCall[] {
  if (response.finishReason !== 'tool_use') return [];
  
  // Anthropic format: response.content contains tool_use blocks
  const toolBlocks = response.raw.content
    .filter((block: any) => block.type === 'tool_use');
  
  return toolBlocks.map((block: any) => ({
    id: block.id,            // "toolu_abc123" — used to correlate results
    tool: block.name,        // "filesystem.read_file"
    params: block.input      // { path: "/doc.md" }
  }));
}
```

---

## 9. Built-in MCP Servers

Ved ships with a small set of MCP servers for core functionality. These are stdio servers bundled in the Ved repository.

### 9.1 `@ved/mcp-memory`

Exposes Ved's own memory system as MCP tools the LLM can call:

| Tool | Risk | Description |
|------|------|-------------|
| `memory.search_vault` | LOW | Search Obsidian vault (FTS + vector) |
| `memory.read_file` | LOW | Read a specific vault file |
| `memory.create_entity` | MEDIUM | Create entity/concept/decision in vault |
| `memory.update_entity` | MEDIUM | Update existing vault file |
| `memory.delete_entity` | HIGH | Delete a vault file |
| `memory.add_working_fact` | LOW | Add fact to T1 working memory |
| `memory.list_entities` | LOW | List entities by type/tag |

**Why MCP?** The LLM needs to interact with memory. Rather than having special memory-calling code in the event loop, memory operations are just tool calls. This means:
- They go through the trust engine (deleting an entity file is HIGH risk)
- They're audited in the hash chain
- The LLM uses the same interface for everything

### 9.2 `@ved/mcp-vault-git`

Git operations on the Obsidian vault:

| Tool | Risk | Description |
|------|------|-------------|
| `vault-git.status` | LOW | Show git status of vault |
| `vault-git.log` | LOW | Recent git commits |
| `vault-git.diff` | LOW | Show changes since last commit |

Auto-commit is handled by VaultGit (not exposed as a tool). The LLM doesn't commit — Ved does automatically on session boundaries.

### 9.3 Third-Party MCP Servers (Recommended)

Ved doesn't bundle these but they're tested and documented:

| Server | Package | Use Case |
|--------|---------|----------|
| Filesystem | `@anthropic/mcp-server-filesystem` | Read/write/list host files |
| Web Search | `@anthropic/mcp-server-brave-search` | Web search |
| Git | `@anthropic/mcp-server-git` | Git operations |
| Fetch | `@anthropic/mcp-server-fetch` | HTTP fetch + extract |

---

## 10. MCPClient Implementation Summary

Pulling it all together — the MCPClient class structure:

```typescript
class MCPClient implements VedModule {
  readonly name = 'mcp';
  
  private config: MCPConfig;
  private servers: Map<string, ManagedServer> = new Map();
  private toolCache: Map<string, CachedTool> = new Map();
  private logger: Logger;
  private audit: AuditLog;
  private trust: TrustEngine;
  
  // --- Lifecycle ---
  async init(config: VedConfig): Promise<void>;     // load server configs
  async start(): Promise<void>;                       // discover tools from all servers
  async stop(): Promise<void>;                        // disconnect all
  async health(): Promise<HealthStatus>;             // check all server connections
  
  // --- Discovery ---
  async discoverTools(): Promise<MCPToolDefinition[]>;
  private async rediscoverServer(name: string): Promise<void>;
  
  // --- Execution ---
  async executeTool(call: ToolCall): Promise<ToolResult>;
  private async callTool(server: ManagedServer, call: ToolCall): Promise<ToolResult>;
  private validateParams(call: ToolCall, schema: Record<string, unknown>): void;
  
  // --- Query ---
  readonly tools: MCPToolDefinition[];               // getter from cache
  getTool(name: string): MCPToolDefinition | undefined;
  getToolsForSession(session: Session): MCPToolDefinition[];
  
  // --- Health ---
  async serverHealth(name: string): Promise<boolean>;
  private async reconnectServer(name: string): Promise<void>;
}

interface ManagedServer {
  config: MCPServerConfig;
  transport: MCPTransport;
  state: 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'failed';
  tools: MCPToolDefinition[];    // tools discovered from this server
  connectedAt: number | null;
  failureCount: number;
  lastError: string | null;
}
```

**Estimated size: ~600 lines** (matches S24 estimate)
- `client.ts` — ~250 lines (MCPClient class)
- `stdio-transport.ts` — ~200 lines
- `http-transport.ts` — ~150 lines

---

## 11. Open Questions Resolved

| # | Question | Resolution |
|---|----------|------------|
| 1 | Parallel vs sequential tool execution? | **Sequential.** Audit ordering, safety, simplicity. Personal assistant doesn't need parallel tool calls. |
| 2 | Should Ved retry failed tool calls? | **No.** Let the LLM decide. Automatic retries risk double-execution of non-idempotent operations. |
| 3 | How to handle MCP servers that change tools dynamically? | **Listen for `notifications/tools/list_changed`**, re-discover. Next LLM call gets updated list. |
| 4 | Should memory be a built-in or MCP tool? | **MCP tool (`@ved/mcp-memory`).** Unifies interface, gets trust + audit for free. |
| 5 | Tool name collisions between servers? | **Namespace: `{server}.{tool}`.** First server wins if same name, log warning. |
| 6 | Should denied tools be shown to LLM? | **No.** Filter them out. Reduces token waste and confusing errors. |

---

## 12. Relationship to Other Docs

| Doc | Relationship |
|-----|-------------|
| `event-loop.md` | MCP fits in Step 4 (ACT) of the pipeline. Agentic sub-loop calls MCPClient.executeTool(). |
| `module-interfaces.md` | MCPClient interface defined there. This doc fills in the implementation details. |
| `database-schema.md` | `tool_calls` and `mcp_servers` tables store execution logs and server registry. |
| `config-errors-logging.md` | MCP config section, 6 error codes, tool_call audit event type — all defined there. |
| `obsidian-memory.md` | `@ved/mcp-memory` server wraps VaultManager from this doc. |
| `rag-pipeline.md` | `memory.search_vault` tool uses RagPipeline for hybrid search. |

---

## 13. Next Session

**Session 28 — PLAN (5 of 5): End-to-end walkthrough.**
Trace a complete user message through ALL modules: inbox → session → working memory → RAG enrichment → LLM → tool call → HITL → MCP execution → audit → response → T1→T2 compression. Validate every interface connects. Final PLAN review before BUILD phase.
