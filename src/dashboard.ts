/**
 * Ved Dashboard — self-contained HTML dashboard.
 *
 * Single-page app served as a string. No external dependencies.
 * Connects to Ved HTTP API for stats, search, history, doctor, and SSE events.
 */

export function getDashboardHtml(baseUrl: string = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ved — Dashboard</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --purple: #bc8cff;
    --orange: #f0883e;
    --radius: 8px;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    --mono: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    min-height: 100vh;
  }

  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  header h1 {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--accent);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  header h1 span { font-size: 1.5rem; }

  .header-status {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 0.85rem;
    color: var(--text-dim);
  }

  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--green);
    display: inline-block;
    animation: pulse 2s infinite;
  }

  .status-dot.disconnected { background: var(--red); animation: none; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  nav {
    display: flex;
    gap: 4px;
    padding: 8px 24px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }

  nav button {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-dim);
    padding: 8px 16px;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 0.85rem;
    font-family: var(--font);
    transition: all 0.15s;
    white-space: nowrap;
  }

  nav button:hover { color: var(--text); background: rgba(255,255,255,0.05); }
  nav button.active {
    color: var(--accent);
    background: rgba(88,166,255,0.1);
    border-color: var(--accent);
  }

  main { padding: 24px; max-width: 1200px; margin: 0 auto; }

  .panel { display: none; }
  .panel.active { display: block; }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    margin-bottom: 16px;
  }

  .card h2 {
    font-size: 0.9rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 12px;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
  }

  .stat-item {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
  }

  .stat-label {
    font-size: 0.75rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .stat-value {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text);
    margin-top: 4px;
    font-family: var(--mono);
  }

  .event-stream {
    max-height: 500px;
    overflow-y: auto;
    font-family: var(--mono);
    font-size: 0.8rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
  }

  .event-entry {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    display: grid;
    grid-template-columns: 140px 160px 1fr;
    gap: 12px;
    align-items: start;
  }

  .event-entry:last-child { border-bottom: none; }

  .event-time { color: var(--text-dim); }
  .event-type {
    color: var(--accent);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .event-detail { color: var(--text); word-break: break-word; }

  .search-bar {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }

  input[type="text"], input[type="number"], select {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    padding: 8px 12px;
    font-family: var(--font);
    font-size: 0.9rem;
    outline: none;
    transition: border-color 0.15s;
  }

  input[type="text"]:focus, select:focus {
    border-color: var(--accent);
  }

  input[type="text"] { flex: 1; }

  button.btn {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius);
    padding: 8px 20px;
    cursor: pointer;
    font-family: var(--font);
    font-size: 0.9rem;
    font-weight: 500;
    transition: opacity 0.15s;
  }

  button.btn:hover { opacity: 0.85; }
  button.btn:disabled { opacity: 0.5; cursor: not-allowed; }

  button.btn-sm {
    padding: 4px 12px;
    font-size: 0.8rem;
  }

  button.btn-danger {
    background: var(--red);
  }

  button.btn-success {
    background: var(--green);
  }

  .results-list { margin-top: 12px; }

  .result-item {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 16px;
    margin-bottom: 8px;
  }

  .result-path {
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--accent);
  }

  .result-score {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--yellow);
    float: right;
  }

  .result-snippet {
    margin-top: 6px;
    font-size: 0.85rem;
    color: var(--text-dim);
    white-space: pre-wrap;
    max-height: 100px;
    overflow: hidden;
  }

  .history-filters {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    flex-wrap: wrap;
    align-items: center;
  }

  .history-filters label {
    font-size: 0.85rem;
    color: var(--text-dim);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  th {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 2px solid var(--border);
    color: var(--text-dim);
    font-weight: 500;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }

  td.mono {
    font-family: var(--mono);
    font-size: 0.8rem;
  }

  .doctor-checks { list-style: none; }

  .doctor-check {
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .doctor-check:last-child { border-bottom: none; }

  .check-icon { font-size: 1.1rem; }
  .check-name { font-weight: 500; }
  .check-detail { color: var(--text-dim); font-size: 0.85rem; margin-left: auto; }

  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .badge-pass { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-warn { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .badge-fail { background: rgba(248,81,73,0.15); color: var(--red); }
  .badge-low { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-medium { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .badge-high { background: rgba(248,81,73,0.15); color: var(--red); }
  .badge-critical { background: rgba(188,140,255,0.2); color: var(--purple); }
  .badge-pending { background: rgba(88,166,255,0.15); color: var(--accent); }
  .badge-enabled { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-disabled { background: rgba(139,148,158,0.15); color: var(--text-dim); }

  .empty-state {
    text-align: center;
    padding: 40px;
    color: var(--text-dim);
    font-size: 0.9rem;
  }

  .event-count-badge {
    background: rgba(88,166,255,0.15);
    color: var(--accent);
    padding: 2px 8px;
    border-radius: 10px;
    font-family: var(--mono);
    font-size: 0.75rem;
    font-weight: 600;
  }

  /* Work order card */
  .wo-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    margin-bottom: 12px;
  }

  .wo-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  .wo-id {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--text-dim);
  }

  .wo-actions {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }

  .wo-description {
    font-size: 0.9rem;
    color: var(--text);
    margin-bottom: 6px;
  }

  .wo-meta {
    font-size: 0.8rem;
    color: var(--text-dim);
  }

  /* Trust tiers */
  .trust-tier {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }

  .trust-tier:last-child { border-bottom: none; }

  .trust-tier-name {
    font-weight: 600;
    min-width: 120px;
  }

  .trust-ids {
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--text-dim);
    flex: 1;
  }

  /* Cron job row */
  .cron-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }

  .cron-row:last-child { border-bottom: none; }

  .cron-name {
    font-weight: 500;
    min-width: 160px;
  }

  .cron-schedule {
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--text-dim);
    flex: 1;
  }

  .cron-actions {
    display: flex;
    gap: 6px;
  }

  /* Config tree */
  .config-tree {
    font-family: var(--mono);
    font-size: 0.82rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    overflow-x: auto;
  }

  .config-key { color: var(--accent); }
  .config-value { color: var(--text); }
  .config-string { color: var(--green); }
  .config-number { color: var(--yellow); }
  .config-bool { color: var(--purple); }
  .config-null { color: var(--text-dim); }
  .config-redacted { color: var(--red); }
  .config-indent { padding-left: 20px; }

  /* Sessions list */
  .session-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
  }

  .session-item:last-child { border-bottom: none; }

  .session-id {
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--accent);
    min-width: 120px;
  }

  .session-meta { color: var(--text-dim); }

  /* Graph panel */
  .graph-container { position: relative; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .graph-canvas { display: block; cursor: grab; }
  .graph-canvas:active { cursor: grabbing; }
  .graph-tooltip {
    position: absolute; background: var(--surface); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 10px; font-size: 0.8rem; pointer-events: none;
    z-index: 10; display: none; white-space: nowrap;
  }
  .graph-controls { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .graph-stats { font-size: 0.8rem; color: var(--text-dim); margin-left: auto; }

  /* Memory browser */
  .memory-layout { display: flex; gap: 16px; min-height: 400px; }
  .memory-sidebar { width: 240px; min-width: 180px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); overflow-y: auto; max-height: 600px; }
  .memory-content { flex: 1; min-width: 0; }
  .memory-type-header { padding: 6px 12px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); background: rgba(255,255,255,0.03); border-bottom: 1px solid var(--border); }
  .memory-entity-item { padding: 6px 12px 6px 16px; font-size: 0.85rem; cursor: pointer; border-bottom: 1px solid rgba(48,54,61,0.5); color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .memory-entity-item:hover { background: rgba(255,255,255,0.03); color: var(--text); }
  .memory-entity-item.active { background: rgba(88,166,255,0.1); color: var(--accent); }

  /* MCP panel */
  .mcp-server-card { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 12px; }
  .mcp-server-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; font-weight: 600; }
  .mcp-tool-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }
  .mcp-tool-item { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; }
  .mcp-tool-name { font-family: var(--mono); font-size: 0.82rem; color: var(--accent); font-weight: 500; }
  .mcp-tool-desc { font-size: 0.78rem; color: var(--text-dim); margin-top: 2px; }
  .badge-connected { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-disconnected { background: rgba(139,148,158,0.15); color: var(--text-dim); }

  /* Config editor */
  .config-editor-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  #config-editor-area {
    width: 100%; min-height: 300px; background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: var(--radius);
    font-family: var(--mono); font-size: 0.82rem; padding: 12px; resize: vertical;
    display: none;
  }
  .env-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
  .env-selector-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  #env-selector { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; font-size: 0.85rem; }

  /* Session detail modal */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    z-index: 1000; display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .modal {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    width: 100%; max-width: 800px; max-height: 80vh;
    display: flex; flex-direction: column;
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px; border-bottom: 1px solid var(--border);
  }
  .modal-header h2 { font-size: 1rem; font-weight: 600; }
  .modal-close { background: transparent; border: none; color: var(--text-dim); font-size: 1.4rem; cursor: pointer; line-height: 1; }
  .modal-close:hover { color: var(--text); }
  .modal-meta { display: flex; gap: 16px; padding: 12px 20px; background: var(--bg); border-bottom: 1px solid var(--border); flex-wrap: wrap; font-size: 0.82rem; color: var(--text-dim); }
  .modal-meta span strong { color: var(--text); }
  .modal-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
  .session-message { padding: 8px 12px; border-radius: 6px; margin-bottom: 8px; font-size: 0.85rem; }
  .session-message.user { background: rgba(88,166,255,0.08); border-left: 3px solid var(--accent); }
  .session-message.assistant { background: rgba(63,185,80,0.08); border-left: 3px solid var(--green); }
  .session-message.tool { background: rgba(188,140,255,0.08); border-left: 3px solid var(--purple); }
  .session-message .msg-role { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; color: var(--text-dim); }
  .session-message .msg-content { white-space: pre-wrap; word-break: break-word; }
  .session-item { cursor: pointer; }
  .session-item:hover { background: rgba(255,255,255,0.03); border-radius: 4px; }

  @media (max-width: 768px) {
    .event-entry { grid-template-columns: 1fr; gap: 2px; }
    .stats-grid { grid-template-columns: 1fr 1fr; }
    nav { overflow-x: auto; }
    .history-filters { flex-direction: column; }
    .wo-actions { flex-direction: column; }
    .cron-row { flex-wrap: wrap; }
    .memory-layout { flex-direction: column; }
    .memory-sidebar { width: 100%; max-height: 200px; }
    .mcp-tool-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<header>
  <h1><span>📿</span> Ved Dashboard</h1>
  <div class="header-status">
    <span class="status-dot" id="sse-dot"></span>
    <span id="sse-status">Connecting...</span>
    <span id="uptime"></span>
  </div>
</header>

<nav>
  <button class="active" data-panel="overview">Overview</button>
  <button data-panel="events">Events <span class="event-count-badge" id="event-count">0</span></button>
  <button data-panel="search">Search</button>
  <button data-panel="history">History</button>
  <button data-panel="vault">Vault</button>
  <button data-panel="graph">Graph</button>
  <button data-panel="memory">Memory</button>
  <button data-panel="doctor">Doctor</button>
  <button data-panel="trust">Trust &amp; Approvals</button>
  <button data-panel="cron">Cron</button>
  <button data-panel="config">Config</button>
  <button data-panel="mcp">MCP</button>
</nav>

<main>
  <!-- Overview Panel -->
  <div class="panel active" id="panel-overview">
    <div class="card">
      <h2>System Stats</h2>
      <div class="stats-grid" id="stats-grid">
        <div class="empty-state">Loading...</div>
      </div>
    </div>
    <div class="card">
      <h2>Recent Sessions</h2>
      <div id="sessions-list">
        <div class="empty-state">Loading...</div>
      </div>
    </div>
    <div class="card">
      <h2>Knowledge Graph Preview</h2>
      <canvas id="mini-graph-canvas" style="width:100%; border-radius:var(--radius); background:var(--bg); border:1px solid var(--border); display:block;"></canvas>
    </div>
  </div>

  <!-- Events Panel -->
  <div class="panel" id="panel-events">
    <div class="card">
      <h2>Live Event Stream</h2>
      <div style="margin-bottom: 12px; display: flex; gap: 8px; align-items: center;">
        <label style="font-size:0.85rem; color:var(--text-dim);">Filter:</label>
        <select id="event-type-filter" style="min-width:200px;">
          <option value="">All events</option>
          <option value="message_received">message_received</option>
          <option value="llm_call">llm_call</option>
          <option value="llm_response">llm_response</option>
          <option value="tool_call">tool_call</option>
          <option value="tool_result">tool_result</option>
          <option value="memory_write">memory_write</option>
          <option value="memory_compress">memory_compress</option>
          <option value="trust_change">trust_change</option>
          <option value="work_order_created">work_order_created</option>
          <option value="work_order_approved">work_order_approved</option>
          <option value="work_order_denied">work_order_denied</option>
          <option value="cron_executed">cron_executed</option>
          <option value="startup">startup</option>
          <option value="shutdown">shutdown</option>
          <option value="error">error</option>
        </select>
        <input type="text" id="event-filter" placeholder="Or type to search..." style="flex:1;">
      </div>
      <div class="event-stream" id="event-stream">
        <div class="empty-state">Waiting for events...</div>
      </div>
    </div>
  </div>

  <!-- Search Panel -->
  <div class="panel" id="panel-search">
    <div class="card">
      <h2>Knowledge Search</h2>
      <div class="search-bar">
        <input type="text" id="search-input" placeholder="Search the vault...">
        <input type="number" id="search-limit" value="5" min="1" max="50" style="width: 80px;">
        <button class="btn" id="search-btn">Search</button>
      </div>
      <div class="results-list" id="search-results">
        <div class="empty-state">Enter a query to search Ved's knowledge vault.</div>
      </div>
    </div>
  </div>

  <!-- History Panel -->
  <div class="panel" id="panel-history">
    <div class="card">
      <h2>Audit History</h2>
      <div class="history-filters">
        <label>Type:</label>
        <select id="history-type">
          <option value="">All</option>
          <option value="message_received">message_received</option>
          <option value="llm_call">llm_call</option>
          <option value="tool_call">tool_call</option>
          <option value="memory_write">memory_write</option>
          <option value="memory_compress">memory_compress</option>
          <option value="trust_change">trust_change</option>
          <option value="work_order_created">work_order_created</option>
          <option value="work_order_approved">work_order_approved</option>
          <option value="work_order_denied">work_order_denied</option>
          <option value="startup">startup</option>
          <option value="shutdown">shutdown</option>
        </select>
        <label>Limit:</label>
        <input type="number" id="history-limit" value="50" min="1" max="500" style="width: 80px;">
        <button class="btn" id="history-btn">Load</button>
        <button class="btn" id="history-verify-btn" style="background: var(--purple);">Verify Chain</button>
      </div>
      <div id="history-results">
        <div class="empty-state">Click Load to fetch audit history.</div>
      </div>
    </div>
  </div>

  <!-- Vault Panel -->
  <div class="panel" id="panel-vault">
    <div class="card">
      <h2>Vault Files</h2>
      <div id="vault-list">
        <div class="empty-state">Loading...</div>
      </div>
    </div>
    <div class="card" id="vault-content-card" style="display: none;">
      <h2 id="vault-content-title">File</h2>
      <pre style="background: var(--bg); padding: 16px; border-radius: var(--radius); border: 1px solid var(--border); overflow-x: auto; font-family: var(--mono); font-size: 0.8rem; white-space: pre-wrap; max-height: 600px; overflow-y: auto;" id="vault-content"></pre>
    </div>
  </div>

  <!-- Graph Panel -->
  <div class="panel" id="panel-graph">
    <div class="card">
      <h2>Knowledge Graph</h2>
      <div class="graph-controls">
        <button class="btn btn-sm" id="graph-reset-btn">Reset View</button>
        <span id="graph-stats" class="graph-stats">Loading...</span>
      </div>
      <div class="graph-container" id="graph-container" style="height:560px;">
        <canvas id="graph-canvas" class="graph-canvas"></canvas>
        <div class="graph-tooltip" id="graph-tooltip"></div>
      </div>
    </div>
  </div>

  <!-- Memory Browser Panel -->
  <div class="panel" id="panel-memory">
    <div class="card">
      <h2>Memory Browser</h2>
      <div style="margin-bottom:12px;">
        <input type="text" id="memory-search" placeholder="Filter entities..." style="max-width:400px;">
      </div>
      <div class="memory-layout">
        <div class="memory-sidebar" id="memory-sidebar">
          <div class="empty-state">Loading...</div>
        </div>
        <div class="memory-content" id="memory-content">
          <div class="empty-state">Select an entity from the sidebar.</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Doctor Panel -->
  <div class="panel" id="panel-doctor">
    <div class="card">
      <h2>Diagnostics</h2>
      <button class="btn" id="doctor-btn" style="margin-bottom: 16px;">Run Doctor</button>
      <div id="doctor-results">
        <div class="empty-state">Click Run Doctor to check system health.</div>
      </div>
    </div>
  </div>

  <!-- Trust & Approvals Panel -->
  <div class="panel" id="panel-trust">
    <div class="card">
      <h2>Pending Work Orders</h2>
      <div style="margin-bottom: 12px;">
        <button class="btn btn-sm" id="wo-refresh-btn">Refresh</button>
      </div>
      <div id="work-orders-list">
        <div class="empty-state">Loading...</div>
      </div>
    </div>
    <div class="card">
      <h2>Trust Configuration</h2>
      <div id="trust-config">
        <div class="empty-state">Loading...</div>
      </div>
    </div>
  </div>

  <!-- Cron Panel -->
  <div class="panel" id="panel-cron">
    <div class="card">
      <h2>Cron Jobs</h2>
      <div style="margin-bottom: 12px;">
        <button class="btn btn-sm" id="cron-refresh-btn">Refresh</button>
      </div>
      <div id="cron-jobs-list">
        <div class="empty-state">Loading...</div>
      </div>
    </div>
    <div class="card">
      <h2>Execution History</h2>
      <div style="margin-bottom: 12px; display: flex; gap: 8px; align-items: center;">
        <input type="text" id="cron-history-job" placeholder="Filter by job name..." style="max-width: 250px;">
        <input type="number" id="cron-history-limit" value="20" min="1" max="200" style="width: 80px;">
        <button class="btn btn-sm" id="cron-history-btn">Load</button>
      </div>
      <div id="cron-history-list">
        <div class="empty-state">Click Load to fetch execution history.</div>
      </div>
    </div>
  </div>

  <!-- Config Panel -->
  <div class="panel" id="panel-config">
    <div class="card">
      <h2>Configuration</h2>
      <p style="font-size:0.85rem; color:var(--text-dim); margin-bottom:12px;">Sensitive fields (apiKey, secret, token, password) are redacted.</p>
      <div class="config-editor-toolbar">
        <button class="btn" id="config-edit-btn">Edit Config</button>
        <button class="btn btn-success" id="config-save-btn" style="display:none;">Save</button>
        <button class="btn" id="config-cancel-btn" style="display:none;">Cancel</button>
        <span id="config-save-status" style="font-size:0.82rem; color:var(--text-dim);"></span>
      </div>
      <textarea id="config-editor-area" spellcheck="false"></textarea>
      <div id="config-tree">
        <div class="empty-state">Loading...</div>
      </div>
      <div class="env-section">
        <h3 style="font-size:0.95rem; font-weight:600; margin-bottom:12px;">Environments</h3>
        <div class="env-selector-row">
          <select id="env-selector"><option value="">Loading...</option></select>
          <button class="btn" id="env-use-btn">Use</button>
          <button class="btn" id="env-reset-btn">Reset</button>
          <span id="env-status" style="font-size:0.82rem; color:var(--text-dim);"></span>
        </div>
      </div>
    </div>
  </div>

  <!-- MCP Panel -->
  <div class="panel" id="panel-mcp">
    <div class="card">
      <h2>MCP Servers &amp; Tools</h2>
      <div id="mcp-content">
        <div class="empty-state">Loading...</div>
      </div>
    </div>
  </div>
</main>

<!-- Session Detail Modal -->
<div class="modal-overlay" id="session-modal" style="display:none;" role="dialog" aria-modal="true">
  <div class="modal">
    <div class="modal-header">
      <h2>Session Detail</h2>
      <button class="modal-close" id="session-modal-close" aria-label="Close">&times;</button>
    </div>
    <div class="modal-meta" id="session-modal-meta"></div>
    <div class="modal-body" id="session-modal-body">
      <div class="empty-state">Loading...</div>
    </div>
  </div>
</div>

<script>
(function() {
  const BASE = ${JSON.stringify(baseUrl)};

  // ── Navigation ──
  document.querySelectorAll('nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.panel).classList.add('active');
      // Lazy-load panel data on first visit
      if (btn.dataset.panel === 'trust') loadTrustPanel();
      if (btn.dataset.panel === 'cron') loadCronPanel();
      if (btn.dataset.panel === 'config') loadConfig();
      if (btn.dataset.panel === 'graph') loadGraph();
      if (btn.dataset.panel === 'memory') loadMemoryPanel();
      if (btn.dataset.panel === 'mcp') loadMcpPanel();
    });
  });

  // ── API helpers ──
  const token = new URLSearchParams(window.location.search).get('token');
  function headers() {
    const h = { 'Accept': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  async function api(path) {
    const res = await fetch(BASE + path, { headers: headers() });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return res.json();
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function fmtTime(ts) {
    const d = new Date(typeof ts === 'number' ? ts : ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDate(ts) {
    const d = new Date(typeof ts === 'number' ? ts : ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  }

  function riskBadge(risk) {
    if (!risk) return '';
    const cls = { low: 'badge-low', medium: 'badge-medium', high: 'badge-high', critical: 'badge-critical' }[risk.toLowerCase()] || 'badge-medium';
    return '<span class="badge ' + cls + '">' + esc(risk) + '</span>';
  }

  // ── Stats ──
  async function loadStats() {
    try {
      const data = await api('/api/stats');
      const grid = document.getElementById('stats-grid');
      const items = [];

      if (data.vault) {
        items.push({ label: 'Vault Files', value: data.vault.totalFiles ?? data.vault.fileCount ?? '—' });
        items.push({ label: 'Vault Size', value: fmtBytes(data.vault.totalBytes ?? 0) });
      }
      if (data.rag) {
        items.push({ label: 'RAG Indexed', value: data.rag.indexedFiles ?? data.rag.filesIndexed ?? '—' });
        items.push({ label: 'RAG Vectors', value: data.rag.vectorCount ?? data.rag.chunksStored ?? '—' });
      }
      if (data.audit) {
        items.push({ label: 'Audit Entries', value: data.audit.totalEntries ?? data.audit.chainLength ?? '—' });
        items.push({ label: 'Chain Head', value: '#' + (data.audit.chainHead?.count ?? data.audit.chainLength ?? '—') });
      }
      if (data.sessions) {
        items.push({ label: 'Active Sessions', value: data.sessions.active ?? '—' });
        items.push({ label: 'Total Sessions', value: data.sessions.total ?? '—' });
      }
      if (data.sse) {
        items.push({ label: 'SSE Connections', value: data.sse.activeConnections ?? 0 });
        items.push({ label: 'Bus Subscribers', value: data.sse.busSubscribers ?? 0 });
      }
      if (data.cron) {
        items.push({ label: 'Cron Jobs', value: data.cron.totalJobs ?? '—' });
        items.push({ label: 'Cron Enabled', value: data.cron.enabledJobs ?? '—' });
      }

      if (items.length === 0) {
        items.push({ label: 'Status', value: 'OK' });
      }

      grid.innerHTML = items.map(i =>
        '<div class="stat-item"><div class="stat-label">' + esc(i.label) +
        '</div><div class="stat-value">' + esc(i.value) + '</div></div>'
      ).join('');
    } catch (err) {
      document.getElementById('stats-grid').innerHTML =
        '<div class="empty-state">Failed to load stats: ' + esc(err.message) + '</div>';
    }
  }

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ── Sessions (Overview) ──
  async function loadSessions() {
    const list = document.getElementById('sessions-list');
    try {
      const data = await api('/api/sessions?limit=10');
      const sessions = data.sessions || [];
      if (sessions.length === 0) {
        list.innerHTML = '<div class="empty-state">No sessions found.</div>';
        return;
      }
      list.innerHTML = sessions.map(s =>
        '<div class="session-item" data-session-id="' + esc(s.id ?? s.sessionId ?? '') + '">' +
        '<span class="session-id">' + esc((s.id ?? s.sessionId ?? '').substring(0, 12)) + '…</span>' +
        '<span class="session-meta">' + esc(s.persona ?? s.model ?? '—') + '</span>' +
        '<span class="session-meta" style="margin-left:auto;">' + esc(fmtDate(s.createdAt ?? s.startedAt ?? s.ts ?? 0)) + '</span>' +
        '</div>'
      ).join('');
      list.querySelectorAll('.session-item[data-session-id]').forEach(function(item) {
        item.addEventListener('click', function() {
          openSessionModal(item.dataset.sessionId);
        });
      });
    } catch (err) {
      list.innerHTML = '<div class="empty-state">Failed to load sessions: ' + esc(err.message) + '</div>';
    }
  }

  // Refresh stats every 10s
  loadStats();
  loadSessions();
  loadMiniGraph();
  setInterval(loadStats, 10000);

  // ── SSE Events ──
  let eventCount = 0;
  const maxEvents = 200;

  function connectSSE() {
    const dot = document.getElementById('sse-dot');
    const status = document.getElementById('sse-status');

    let url = BASE + '/api/events';
    if (token) url += '?token=' + encodeURIComponent(token);

    const es = new EventSource(url);

    es.onopen = () => {
      dot.className = 'status-dot';
      status.textContent = 'Connected';
    };

    es.onerror = () => {
      dot.className = 'status-dot disconnected';
      status.textContent = 'Reconnecting...';
    };

    // Listen for all event types
    es.onmessage = (e) => {
      addEvent('message', e.data, e.lastEventId);
    };

    // Named events from Ved's SSE
    const eventTypes = [
      'message_received', 'llm_call', 'llm_response', 'tool_call', 'tool_result',
      'memory_write', 'memory_read', 'memory_compress', 'memory_forget',
      'trust_change', 'work_order_created', 'work_order_approved', 'work_order_denied',
      'work_order_executed', 'startup', 'shutdown', 'error',
      'backup_created', 'backup_restored', 'cron_executed', 'migration_applied',
      'vault_change', 'rag_reindex',
    ];

    eventTypes.forEach(type => {
      es.addEventListener(type, (e) => {
        addEvent(type, e.data, e.lastEventId);
      });
    });

    return es;
  }

  function addEvent(type, dataStr, id) {
    const stream = document.getElementById('event-stream');
    const typeFilter = document.getElementById('event-type-filter').value.trim().toLowerCase();
    const textFilter = document.getElementById('event-filter').value.trim().toLowerCase();

    // Check dropdown filter (exact match or empty)
    if (typeFilter && type.toLowerCase() !== typeFilter) return;
    // Check text filter (substring match)
    if (textFilter && !type.toLowerCase().includes(textFilter)) return;

    eventCount++;
    document.getElementById('event-count').textContent = eventCount;

    // Remove empty state
    const emptyState = stream.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    // Parse detail
    let detail = '';
    try {
      const parsed = JSON.parse(dataStr);
      if (parsed.detail) {
        detail = typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail);
      } else {
        detail = dataStr.substring(0, 200);
      }
    } catch {
      detail = dataStr.substring(0, 200);
    }

    const entry = document.createElement('div');
    entry.className = 'event-entry';
    entry.innerHTML =
      '<span class="event-time">' + esc(fmtTime(Date.now())) + '</span>' +
      '<span class="event-type">' + esc(type) + '</span>' +
      '<span class="event-detail">' + esc(detail) + '</span>';

    stream.prepend(entry);

    // Trim old entries
    while (stream.children.length > maxEvents) {
      stream.removeChild(stream.lastChild);
    }
  }

  connectSSE();

  // ── Search ──
  document.getElementById('search-btn').addEventListener('click', doSearch);
  document.getElementById('search-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  async function doSearch() {
    const q = document.getElementById('search-input').value.trim();
    const n = document.getElementById('search-limit').value;
    const results = document.getElementById('search-results');

    if (!q) return;

    results.innerHTML = '<div class="empty-state">Searching...</div>';

    try {
      const data = await api('/api/search?q=' + encodeURIComponent(q) + '&n=' + n);
      const items = data.results || [];

      if (items.length === 0) {
        results.innerHTML = '<div class="empty-state">No results found.</div>';
        return;
      }

      results.innerHTML = items.map(r =>
        '<div class="result-item">' +
        '<span class="result-score">score: ' + esc((r.score ?? r.rrfScore ?? r.fusedScore ?? 0).toFixed(3)) + '</span>' +
        '<div class="result-path">' + esc(r.path ?? r.filePath ?? r.file ?? '—') + '</div>' +
        '<div class="result-snippet">' + esc(r.snippet ?? r.content ?? '—') + '</div>' +
        '</div>'
      ).join('');
    } catch (err) {
      results.innerHTML = '<div class="empty-state">Search failed: ' + esc(err.message) + '</div>';
    }
  }

  // ── History ──
  document.getElementById('history-btn').addEventListener('click', loadHistory);
  document.getElementById('history-verify-btn').addEventListener('click', verifyChain);

  async function loadHistory() {
    const type = document.getElementById('history-type').value;
    const limit = document.getElementById('history-limit').value;
    const results = document.getElementById('history-results');

    results.innerHTML = '<div class="empty-state">Loading...</div>';

    try {
      let url = '/api/history?limit=' + limit;
      if (type) url += '&type=' + encodeURIComponent(type);

      const data = await api(url);
      const entries = data.entries || [];

      if (entries.length === 0) {
        results.innerHTML = '<div class="empty-state">No audit entries found.</div>';
        return;
      }

      let html = '<table><thead><tr><th>Time</th><th>Type</th><th>Actor</th><th>Session</th><th>Detail</th></tr></thead><tbody>';

      entries.forEach(e => {
        const detail = typeof e.detail === 'string'
          ? e.detail.substring(0, 100)
          : JSON.stringify(e.detail ?? {}).substring(0, 100);

        html += '<tr>' +
          '<td class="mono">' + esc(fmtDate(e.timestamp ?? e.ts)) + '</td>' +
          '<td class="mono" style="color:var(--accent);">' + esc(e.eventType ?? e.event_type) + '</td>' +
          '<td class="mono">' + esc(e.actor ?? '—') + '</td>' +
          '<td class="mono" style="color:var(--text-dim);">' + esc((e.sessionId ?? e.session_id ?? '').substring(0, 8)) + '</td>' +
          '<td>' + esc(detail) + '</td>' +
          '</tr>';
      });

      html += '</tbody></table>';
      results.innerHTML = html;
    } catch (err) {
      results.innerHTML = '<div class="empty-state">Failed: ' + esc(err.message) + '</div>';
    }
  }

  async function verifyChain() {
    const results = document.getElementById('history-results');
    results.innerHTML = '<div class="empty-state">Verifying hash chain...</div>';

    try {
      const data = await api('/api/history?verify=true&limit=1');
      if (data.chainValid === true || data.intact === true) {
        results.innerHTML = '<div class="empty-state" style="color:var(--green);">✅ Hash chain verified — ' + (data.chainLength ?? data.total ?? '?') + ' entries, all intact.</div>';
      } else {
        results.innerHTML = '<div class="empty-state" style="color:var(--red);">❌ Chain verification failed at entry ' + (data.brokenAt ?? '?') + '</div>';
      }
    } catch (err) {
      results.innerHTML = '<div class="empty-state">Verification failed: ' + esc(err.message) + '</div>';
    }
  }

  // ── Vault ──
  async function loadVault() {
    const list = document.getElementById('vault-list');

    try {
      const data = await api('/api/vault/files');
      const files = data.files || [];

      if (files.length === 0) {
        list.innerHTML = '<div class="empty-state">No vault files found.</div>';
        return;
      }

      // Group by directory
      const groups = {};
      files.forEach(f => {
        const path = f.path ?? f;
        const parts = path.split('/');
        const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
        if (!groups[dir]) groups[dir] = [];
        groups[dir].push(path);
      });

      let html = '';
      Object.keys(groups).sort().forEach(dir => {
        html += '<div style="margin-bottom: 12px;">';
        html += '<div style="color:var(--text-dim); font-size:0.8rem; margin-bottom:4px;">📁 ' + esc(dir) + '/</div>';
        groups[dir].sort().forEach(path => {
          const name = path.split('/').pop();
          const nodeName = name.replace(/\.md$/, '');
          html += '<div style="padding:4px 0 4px 16px; display:flex; align-items:center; gap:4px;">' +
            '<a href="#" style="color:var(--accent); text-decoration:none; font-family:var(--mono); font-size:0.85rem; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" ' +
            'data-path="' + esc(path) + '" data-name="' + esc(nodeName) + '" class="vault-file-link">📄 ' + esc(name) + '</a>' +
            '<button class="btn btn-sm" style="padding:1px 7px; font-size:0.7rem; background:transparent; border:1px solid var(--border); color:var(--text-dim); white-space:nowrap;" ' +
            'onclick="viewInGraph(\'' + esc(nodeName) + '\')" title="View in graph">⬡ Graph</button></div>';
        });
        html += '</div>';
      });

      list.innerHTML = html;

      // Attach click handlers
      list.querySelectorAll('.vault-file-link').forEach(link => {
        link.addEventListener('click', async (e) => {
          e.preventDefault();
          const path = link.dataset.path;
          await loadVaultFile(path);
        });
      });
    } catch (err) {
      list.innerHTML = '<div class="empty-state">Failed: ' + esc(err.message) + '</div>';
    }
  }

  async function loadVaultFile(path) {
    const card = document.getElementById('vault-content-card');
    const title = document.getElementById('vault-content-title');
    const content = document.getElementById('vault-content');

    card.style.display = 'block';
    title.textContent = path;
    content.textContent = 'Loading...';

    try {
      const data = await api('/api/vault/file?path=' + encodeURIComponent(path));
      content.textContent = data.body ?? data.content ?? '(empty)';
    } catch (err) {
      content.textContent = 'Error: ' + err.message;
    }
  }

  loadVault();

  // ── Doctor ──
  document.getElementById('doctor-btn').addEventListener('click', async () => {
    const results = document.getElementById('doctor-results');
    const btn = document.getElementById('doctor-btn');

    btn.disabled = true;
    btn.textContent = 'Running...';
    results.innerHTML = '<div class="empty-state">Running diagnostics...</div>';

    try {
      const data = await api('/api/doctor');
      const checks = data.checks || [];

      if (checks.length === 0) {
        results.innerHTML = '<div class="empty-state">No diagnostics returned.</div>';
        return;
      }

      let html = '<ul class="doctor-checks">';
      checks.forEach(c => {
        const icon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : '❌';
        const badgeClass = c.status === 'pass' ? 'badge-pass' : c.status === 'warn' ? 'badge-warn' : 'badge-fail';

        html += '<li class="doctor-check">' +
          '<span class="check-icon">' + icon + '</span>' +
          '<span class="check-name">' + esc(c.name) + '</span>' +
          '<span class="badge ' + badgeClass + '">' + esc(c.status) + '</span>' +
          '<span class="check-detail">' + esc(c.detail ?? c.message ?? '') + '</span>' +
          '</li>';
      });
      html += '</ul>';

      // Summary
      const passed = checks.filter(c => c.status === 'pass').length;
      const warns = checks.filter(c => c.status === 'warn').length;
      const fails = checks.filter(c => c.status === 'fail').length;
      html += '<div style="margin-top: 12px; font-size: 0.85rem; color: var(--text-dim);">' +
        passed + ' passed, ' + warns + ' warnings, ' + fails + ' failures</div>';

      results.innerHTML = html;
    } catch (err) {
      results.innerHTML = '<div class="empty-state">Doctor failed: ' + esc(err.message) + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run Doctor';
    }
  });

  // ── Trust & Approvals ──
  let trustPanelLoaded = false;

  document.getElementById('wo-refresh-btn').addEventListener('click', loadTrustPanel);

  async function loadTrustPanel() {
    await Promise.all([loadWorkOrders(), loadTrustConfig()]);
    trustPanelLoaded = true;
  }

  async function loadWorkOrders() {
    const list = document.getElementById('work-orders-list');
    list.innerHTML = '<div class="empty-state">Loading...</div>';
    try {
      const data = await api('/api/work-orders');
      const orders = data.workOrders || [];
      if (orders.length === 0) {
        list.innerHTML = '<div class="empty-state">No pending work orders.</div>';
        return;
      }
      list.innerHTML = orders.map(wo =>
        '<div class="wo-card">' +
        '<div class="wo-header">' +
        riskBadge(wo.riskLevel ?? wo.risk) +
        '<span class="wo-id">' + esc((wo.id ?? '').substring(0, 16)) + '…</span>' +
        '<div class="wo-actions">' +
        '<button class="btn btn-sm btn-success" onclick="approveOrder(\'' + esc(wo.id) + '\', this)">Approve</button>' +
        '<button class="btn btn-sm btn-danger" onclick="denyOrder(\'' + esc(wo.id) + '\', this)">Deny</button>' +
        '</div></div>' +
        '<div class="wo-description">' + esc(wo.description ?? wo.action ?? wo.command ?? '—') + '</div>' +
        '<div class="wo-meta">Session: ' + esc((wo.sessionId ?? '').substring(0, 8)) + ' · ' +
        'Created: ' + esc(fmtDate(wo.createdAt ?? wo.ts ?? 0)) + '</div>' +
        '</div>'
      ).join('');
    } catch (err) {
      list.innerHTML = '<div class="empty-state">Failed: ' + esc(err.message) + '</div>';
    }
  }

  async function approveOrder(id, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await apiPost('/api/approve/' + encodeURIComponent(id), {});
      await loadWorkOrders();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Approve';
      alert('Failed to approve: ' + err.message);
    }
  }

  async function denyOrder(id, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await apiPost('/api/deny/' + encodeURIComponent(id), { reason: 'Denied via dashboard' });
      await loadWorkOrders();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Deny';
      alert('Failed to deny: ' + err.message);
    }
  }

  // Expose to onclick handlers
  window.approveOrder = approveOrder;
  window.denyOrder = denyOrder;

  async function loadTrustConfig() {
    const el = document.getElementById('trust-config');
    try {
      const trust = await api('/api/trust');
      const tiers = [
        { name: 'Owner IDs', ids: trust.ownerIds ?? [], color: 'var(--red)' },
        { name: 'Tribe IDs', ids: trust.tribeIds ?? [], color: 'var(--yellow)' },
        { name: 'Known IDs', ids: trust.knownIds ?? [], color: 'var(--green)' },
      ];
      let html = '';
      tiers.forEach(t => {
        html += '<div class="trust-tier">' +
          '<span class="trust-tier-name" style="color:' + t.color + ';">' + esc(t.name) + '</span>' +
          '<span class="trust-ids">' + (t.ids.length > 0 ? t.ids.map(id => esc(id)).join(', ') : '<em style="color:var(--text-dim)">none</em>') + '</span>' +
          '</div>';
      });
      if (trust.defaultTier !== undefined) {
        html += '<div style="margin-top:12px; font-size:0.85rem; color:var(--text-dim);">Default tier: ' + esc(trust.defaultTier) +
          (trust.approvalTimeoutMs ? ' · Approval timeout: ' + esc(Math.round(trust.approvalTimeoutMs / 60000)) + 'm' : '') +
          (trust.maxAgenticLoops ? ' · Max agentic loops: ' + esc(trust.maxAgenticLoops) : '') +
          '</div>';
      }
      el.innerHTML = html;
    } catch (err) {
      el.innerHTML = '<div class="empty-state">Failed: ' + esc(err.message) + '</div>';
    }
  }

  // ── Cron ──
  let cronPanelLoaded = false;

  document.getElementById('cron-refresh-btn').addEventListener('click', loadCronPanel);
  document.getElementById('cron-history-btn').addEventListener('click', loadCronHistory);

  async function loadCronPanel() {
    await loadCronJobs();
    cronPanelLoaded = true;
  }

  async function loadCronJobs() {
    const list = document.getElementById('cron-jobs-list');
    list.innerHTML = '<div class="empty-state">Loading...</div>';
    try {
      const data = await api('/api/cron');
      const jobs = data.jobs || [];
      if (jobs.length === 0) {
        list.innerHTML = '<div class="empty-state">No cron jobs configured.</div>';
        return;
      }
      list.innerHTML = jobs.map(job => {
        const enabled = job.enabled !== false;
        return '<div class="cron-row">' +
          '<span class="cron-name">' + esc(job.name ?? job.id ?? '—') + '</span>' +
          '<span class="cron-schedule">' + esc(job.schedule ?? job.cron ?? '—') + '</span>' +
          '<span class="badge ' + (enabled ? 'badge-enabled' : 'badge-disabled') + '">' + (enabled ? 'enabled' : 'disabled') + '</span>' +
          '<div class="cron-actions">' +
          '<button class="btn btn-sm" onclick="runCronJob(\'' + esc(job.id ?? job.name) + '\', this)">Run</button>' +
          '<button class="btn btn-sm" style="background:' + (enabled ? 'var(--yellow)' : 'var(--green)') + ';" ' +
          'onclick="toggleCronJob(\'' + esc(job.id ?? job.name) + '\', ' + (!enabled) + ', this)">' +
          (enabled ? 'Disable' : 'Enable') + '</button>' +
          '</div></div>';
      }).join('');
    } catch (err) {
      list.innerHTML = '<div class="empty-state">Failed: ' + esc(err.message) + '</div>';
    }
  }

  async function runCronJob(id, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const result = await apiPost('/api/cron/' + encodeURIComponent(id) + '/run', {});
      btn.textContent = result.success ? '✓ Done' : '✗ Failed';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Run'; }, 2000);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Run';
      alert('Failed: ' + err.message);
    }
  }

  async function toggleCronJob(id, enabled, btn) {
    btn.disabled = true;
    try {
      await apiPost('/api/cron/' + encodeURIComponent(id) + '/toggle', { enabled });
      await loadCronJobs();
    } catch (err) {
      btn.disabled = false;
      alert('Failed: ' + err.message);
    }
  }

  // Expose to onclick handlers
  window.runCronJob = runCronJob;
  window.toggleCronJob = toggleCronJob;

  async function loadCronHistory() {
    const list = document.getElementById('cron-history-list');
    const job = document.getElementById('cron-history-job').value.trim();
    const limit = document.getElementById('cron-history-limit').value;
    list.innerHTML = '<div class="empty-state">Loading...</div>';
    try {
      let url = '/api/cron/history?limit=' + limit;
      if (job) url += '&job=' + encodeURIComponent(job);
      const data = await api(url);
      const history = data.history || [];
      if (history.length === 0) {
        list.innerHTML = '<div class="empty-state">No execution history.</div>';
        return;
      }
      let html = '<table><thead><tr><th>Time</th><th>Job</th><th>Status</th><th>Duration</th><th>Output</th></tr></thead><tbody>';
      history.forEach(h => {
        const ok = h.exitCode === 0 || h.success === true || h.status === 'success';
        html += '<tr>' +
          '<td class="mono">' + esc(fmtDate(h.executedAt ?? h.ts ?? h.createdAt ?? 0)) + '</td>' +
          '<td class="mono">' + esc(h.jobName ?? h.name ?? '—') + '</td>' +
          '<td><span class="badge ' + (ok ? 'badge-pass' : 'badge-fail') + '">' + (ok ? 'ok' : 'fail') + '</span></td>' +
          '<td class="mono">' + esc(h.durationMs !== undefined ? h.durationMs + 'ms' : '—') + '</td>' +
          '<td style="max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc((h.output ?? h.stderr ?? '').substring(0, 120)) + '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
      list.innerHTML = html;
    } catch (err) {
      list.innerHTML = '<div class="empty-state">Failed: ' + esc(err.message) + '</div>';
    }
  }

  // ── Config ──
  let configLoaded = false;
  let configData = null;

  async function loadConfig() {
    if (configLoaded) return;
    const el = document.getElementById('config-tree');
    try {
      const data = await api('/api/config');
      configData = data;
      el.innerHTML = '<div class="config-tree">' + renderConfigTree(data, 0) + '</div>';
      configLoaded = true;
    } catch (err) {
      el.innerHTML = '<div class="empty-state">Failed: ' + esc(err.message) + '</div>';
    }
    loadEnvs();
  }

  // Config edit toolbar
  const configEditBtn = document.getElementById('config-edit-btn');
  const configSaveBtn = document.getElementById('config-save-btn');
  const configCancelBtn = document.getElementById('config-cancel-btn');
  const configEditorArea = document.getElementById('config-editor-area');
  const configSaveStatus = document.getElementById('config-save-status');

  configEditBtn.addEventListener('click', function() {
    configEditorArea.value = JSON.stringify(configData || {}, null, 2);
    configEditorArea.style.display = 'block';
    configSaveBtn.style.display = '';
    configCancelBtn.style.display = '';
    configEditBtn.style.display = 'none';
  });

  configCancelBtn.addEventListener('click', function() {
    configEditorArea.style.display = 'none';
    configSaveBtn.style.display = 'none';
    configCancelBtn.style.display = 'none';
    configEditBtn.style.display = '';
    configSaveStatus.textContent = '';
  });

  configSaveBtn.addEventListener('click', async function() {
    let parsed;
    try {
      parsed = JSON.parse(configEditorArea.value);
    } catch (e) {
      configSaveStatus.textContent = 'Invalid JSON: ' + e.message;
      configSaveStatus.style.color = 'var(--red)';
      return;
    }
    configSaveStatus.textContent = 'Saving...';
    configSaveStatus.style.color = 'var(--text-dim)';
    try {
      const result = await apiPost('/api/config', parsed);
      configData = result.config;
      const el = document.getElementById('config-tree');
      el.innerHTML = '<div class="config-tree">' + renderConfigTree(result.config, 0) + '</div>';
      configEditorArea.style.display = 'none';
      configSaveBtn.style.display = 'none';
      configCancelBtn.style.display = 'none';
      configEditBtn.style.display = '';
      configSaveStatus.textContent = 'Saved.';
      configSaveStatus.style.color = 'var(--green)';
      setTimeout(function() { configSaveStatus.textContent = ''; }, 3000);
    } catch (err) {
      configSaveStatus.textContent = 'Error: ' + err.message;
      configSaveStatus.style.color = 'var(--red)';
    }
  });

  // ── Environments ──
  async function loadEnvs() {
    const sel = document.getElementById('env-selector');
    const statusEl = document.getElementById('env-status');
    try {
      const [envsData, currentData] = await Promise.all([
        api('/api/envs'),
        api('/api/envs/current'),
      ]);
      const envs = envsData.envs || [];
      const active = currentData.active;
      if (envs.length === 0) {
        sel.innerHTML = '<option value="">No environments</option>';
      } else {
        sel.innerHTML = '<option value="">(none)</option>' +
          envs.map(function(e) {
            return '<option value="' + esc(e.name) + '"' + (e.name === active ? ' selected' : '') + '>' + esc(e.name) + (e.active ? ' ✓' : '') + '</option>';
          }).join('');
      }
      statusEl.textContent = active ? 'Active: ' + active : 'No active environment';
    } catch (err) {
      sel.innerHTML = '<option value="">Error loading</option>';
      statusEl.textContent = err.message;
    }
  }

  document.getElementById('env-use-btn').addEventListener('click', async function() {
    const sel = document.getElementById('env-selector');
    const name = sel.value;
    const statusEl = document.getElementById('env-status');
    if (!name) { statusEl.textContent = 'Select an environment first.'; return; }
    try {
      await apiPost('/api/envs/use', { name });
      statusEl.textContent = 'Switched to: ' + name;
      statusEl.style.color = 'var(--green)';
      loadEnvs();
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.style.color = 'var(--red)';
    }
  });

  document.getElementById('env-reset-btn').addEventListener('click', async function() {
    const statusEl = document.getElementById('env-status');
    try {
      await apiPost('/api/envs/reset', {});
      statusEl.textContent = 'Environment deactivated.';
      statusEl.style.color = 'var(--text-dim)';
      loadEnvs();
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.style.color = 'var(--red)';
    }
  });

  function renderConfigTree(obj, depth) {
    if (obj === null) return '<span class="config-null">null</span>';
    if (typeof obj === 'boolean') return '<span class="config-bool">' + obj + '</span>';
    if (typeof obj === 'number') return '<span class="config-number">' + obj + '</span>';
    if (typeof obj === 'string') {
      if (obj === '[REDACTED]') return '<span class="config-redacted">[REDACTED]</span>';
      return '<span class="config-string">"' + esc(obj) + '"</span>';
    }
    if (Array.isArray(obj)) {
      if (obj.length === 0) return '<span style="color:var(--text-dim)">[]</span>';
      return '[' + obj.map(v => renderConfigTree(v, depth)).join(', ') + ']';
    }
    if (typeof obj === 'object') {
      const entries = Object.entries(obj);
      if (entries.length === 0) return '<span style="color:var(--text-dim)">{}</span>';
      const indent = '<div class="config-indent">';
      const lines = entries.map(([k, v]) =>
        indent + '<span class="config-key">' + esc(k) + '</span>: ' + renderConfigTree(v, depth + 1) + '</div>'
      ).join('');
      return '{' + lines + '}';
    }
    return esc(String(obj));
  }

  // ── Graph Panel ──
  let graphLoaded = false;
  let graphSimNodes = [];
  let graphSimEdges = [];
  let graphZoom = 1;
  let graphOffX = 0, graphOffY = 0;
  let graphDragging = false;
  let graphDragStartX = 0, graphDragStartY = 0;
  let graphAnimFrame = null;
  let graphFocusNodeId = null;

  const GRAPH_COLORS = {
    entities: '#58a6ff', people: '#58a6ff', orgs: '#f0883e',
    concepts: '#bc8cff', decisions: '#3fb950', daily: '#8b949e', projects: '#d29922',
  };

  function graphNodeColor(type) {
    if (!type) return '#555566';
    const t = (type || '').toLowerCase();
    for (const k of Object.keys(GRAPH_COLORS)) {
      if (t.includes(k)) return GRAPH_COLORS[k];
    }
    return '#555566';
  }

  function graphNodeRadius(bl, maxBL) {
    return 4 + (maxBL > 0 ? 16 * Math.sqrt(Math.min(bl, maxBL) / maxBL) : 0);
  }

  async function loadGraph() {
    if (graphLoaded) return;
    const statsEl = document.getElementById('graph-stats');
    statsEl.textContent = 'Loading...';
    try {
      const data = await api('/api/vault/graph');
      const nc = (data.nodes || []).length;
      const ec = (data.edges || []).length;
      const dens = nc > 1 ? (2 * ec / (nc * (nc - 1))).toFixed(4) : '0.0000';
      statsEl.textContent = nc + ' nodes \u00b7 ' + ec + ' edges \u00b7 density ' + dens;
      startGraphSim(data, 'graph-canvas', 'graph-container');
      graphLoaded = true;
    } catch (err) {
      statsEl.textContent = 'Error: ' + esc(err.message);
    }
  }

  function startGraphSim(apiData, canvasId, containerId) {
    const canvas = document.getElementById(canvasId);
    const container = document.getElementById(containerId);
    if (!canvas || !container) return;

    const W = Math.max(container.clientWidth || 800, 400);
    const H = 560;
    canvas.width = W;
    canvas.height = H;

    const nodes = apiData.nodes || [];
    const maxBL = Math.max.apply(null, nodes.map(function(n) { return n.backlinks || 0; }).concat([1]));

    graphSimNodes = nodes.map(function(n) {
      return {
        id: n.id, type: n.type, backlinks: n.backlinks || 0,
        x: W * 0.1 + Math.random() * W * 0.8,
        y: H * 0.1 + Math.random() * H * 0.8,
        vx: 0, vy: 0,
        r: graphNodeRadius(n.backlinks || 0, maxBL),
        color: graphNodeColor(n.type),
      };
    });

    const idx = {};
    graphSimNodes.forEach(function(n, i) { idx[n.id] = i; });
    graphSimEdges = (apiData.edges || [])
      .map(function(e) { return { s: idx[e.source], t: idx[e.target] }; })
      .filter(function(e) { return e.s !== undefined && e.t !== undefined; });

    graphZoom = 1; graphOffX = 0; graphOffY = 0;
    if (graphAnimFrame) cancelAnimationFrame(graphAnimFrame);

    const ctx = canvas.getContext('2d');
    let step = 0;

    function gTick() {
      step++;
      const alpha = Math.max(0.003, 0.7 / (1 + step * 0.025));
      const N = graphSimNodes.length;

      for (let ei = 0; ei < graphSimEdges.length; ei++) {
        const e = graphSimEdges[ei];
        const a = graphSimNodes[e.s], b = graphSimNodes[e.t];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx*dx + dy*dy) || 1;
        const f = (d - 80) * 0.04 * alpha;
        const fx = dx/d*f, fy = dy/d*f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }

      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const a = graphSimNodes[i], b = graphSimNodes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d2 = Math.max(dx*dx + dy*dy, 1);
          const d = Math.sqrt(d2);
          const f = 700 / d2 * alpha;
          const fx = dx/d*f, fy = dy/d*f;
          a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        }
      }

      for (let i = 0; i < N; i++) {
        const n = graphSimNodes[i];
        n.vx += (W/2 - n.x) * 0.008 * alpha;
        n.vy += (H/2 - n.y) * 0.008 * alpha;
        n.vx *= 0.88; n.vy *= 0.88;
        n.x += n.vx; n.y += n.vy;
      }

      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(W/2 + graphOffX, H/2 + graphOffY);
      ctx.scale(graphZoom, graphZoom);
      ctx.translate(-W/2, -H/2);

      ctx.strokeStyle = 'rgba(48,54,61,0.8)';
      ctx.lineWidth = 1 / graphZoom;
      for (let ei = 0; ei < graphSimEdges.length; ei++) {
        const e = graphSimEdges[ei];
        const a = graphSimNodes[e.s], b = graphSimNodes[e.t];
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }

      for (let i = 0; i < N; i++) {
        const n = graphSimNodes[i];
        const isFocus = graphFocusNodeId && n.id === graphFocusNodeId;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = isFocus ? '#ffffff' : n.color;
        ctx.fill();
        if (isFocus) {
          ctx.strokeStyle = n.color;
          ctx.lineWidth = 2.5 / graphZoom;
          ctx.stroke();
        }
      }

      ctx.restore();
      graphAnimFrame = requestAnimationFrame(gTick);
    }

    gTick();
    setupGraphInteraction(canvas, W, H);
  }

  function setupGraphInteraction(canvas, W, H) {
    const tooltip = document.getElementById('graph-tooltip');

    function worldPt(cx, cy) {
      return {
        x: (cx - W/2 - graphOffX) / graphZoom + W/2,
        y: (cy - H/2 - graphOffY) / graphZoom + H/2,
      };
    }

    function hitNode(cx, cy) {
      const p = worldPt(cx, cy);
      for (let i = graphSimNodes.length - 1; i >= 0; i--) {
        const n = graphSimNodes[i];
        const dx = n.x - p.x, dy = n.y - p.y;
        if (dx*dx + dy*dy <= (n.r + 3) * (n.r + 3)) return n;
      }
      return null;
    }

    canvas.addEventListener('mousemove', function(e) {
      const r = canvas.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      if (graphDragging) {
        graphOffX = cx - graphDragStartX;
        graphOffY = cy - graphDragStartY;
        return;
      }
      const n = hitNode(cx, cy);
      if (n) {
        canvas.style.cursor = 'pointer';
        tooltip.textContent = n.id;
        tooltip.style.display = 'block';
        tooltip.style.left = (cx + 14) + 'px';
        tooltip.style.top = (cy - 10) + 'px';
      } else {
        canvas.style.cursor = 'grab';
        tooltip.style.display = 'none';
      }
    });

    canvas.addEventListener('mousedown', function(e) {
      const r = canvas.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const n = hitNode(cx, cy);
      if (!n) {
        graphDragging = true;
        graphDragStartX = cx - graphOffX;
        graphDragStartY = cy - graphOffY;
        canvas.style.cursor = 'grabbing';
      }
    });

    canvas.addEventListener('mouseup', function() { graphDragging = false; canvas.style.cursor = 'grab'; });
    canvas.addEventListener('mouseleave', function() { graphDragging = false; tooltip.style.display = 'none'; });

    canvas.addEventListener('click', function(e) {
      const r = canvas.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const n = hitNode(cx, cy);
      if (n) {
        const vBtn = document.querySelector('[data-panel="vault"]');
        if (vBtn) vBtn.click();
        setTimeout(function() {
          const link = document.querySelector('.vault-file-link[data-name="' + n.id + '"]');
          if (link) link.click();
        }, 200);
      }
    });

    canvas.addEventListener('wheel', function(e) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.85 : 1.15;
      graphZoom = Math.max(0.1, Math.min(8, graphZoom * delta));
    }, { passive: false });

    document.getElementById('graph-reset-btn').addEventListener('click', function() {
      graphZoom = 1; graphOffX = 0; graphOffY = 0;
    });
  }

  function viewInGraph(nodeName) {
    graphFocusNodeId = nodeName;
    const btn = document.querySelector('[data-panel="graph"]');
    if (btn) btn.click();
  }
  window.viewInGraph = viewInGraph;

  // ── Mini Graph (Overview) ──
  async function loadMiniGraph() {
    const canvas = document.getElementById('mini-graph-canvas');
    if (!canvas) return;
    try {
      const data = await api('/api/vault/graph');
      const allNodes = (data.nodes || []).slice().sort(function(a, b) { return (b.backlinks||0) - (a.backlinks||0); }).slice(0, 30);
      const nodeIds = {};
      allNodes.forEach(function(n) { nodeIds[n.id] = true; });
      const edges = (data.edges || []).filter(function(e) { return nodeIds[e.source] && nodeIds[e.target]; });
      startMiniGraph({ nodes: allNodes, edges: edges }, canvas);
    } catch(e) { /* silently fail */ }
  }

  function startMiniGraph(data, canvas) {
    const parent = canvas.parentElement;
    const W = parent ? Math.max(parent.clientWidth - 40, 300) : 500;
    const H = 160;
    canvas.width = W;
    canvas.height = H;

    const maxBL = Math.max.apply(null, data.nodes.map(function(n) { return n.backlinks||0; }).concat([1]));
    const sim = data.nodes.map(function(n) {
      return {
        id: n.id, x: 20 + Math.random() * (W-40), y: 20 + Math.random() * (H-40),
        vx: 0, vy: 0, r: Math.max(2, 2 + 6 * Math.sqrt((n.backlinks||0)/maxBL)),
        color: graphNodeColor(n.type),
      };
    });
    const idx = {};
    sim.forEach(function(n,i) { idx[n.id] = i; });
    const simEdges = data.edges.map(function(e) { return { s: idx[e.source], t: idx[e.target] }; }).filter(function(e) { return e.s !== undefined && e.t !== undefined; });

    const ctx = canvas.getContext('2d');
    let step = 0;

    function mTick() {
      step++;
      if (step > 250) { drawMini(ctx, sim, simEdges, W, H); return; }
      const alpha = Math.max(0.01, 1 - step / 250);
      const N = sim.length;

      for (let ei = 0; ei < simEdges.length; ei++) {
        const e = simEdges[ei];
        const a = sim[e.s], b = sim[e.t];
        const dx = b.x-a.x, dy = b.y-a.y;
        const d = Math.sqrt(dx*dx+dy*dy)||1;
        const f = (d-50)*0.05*alpha;
        a.vx+=dx/d*f; a.vy+=dy/d*f; b.vx-=dx/d*f; b.vy-=dy/d*f;
      }

      for (let i = 0; i < N; i++) {
        for (let j = i+1; j < N; j++) {
          const a=sim[i], b=sim[j];
          const dx=b.x-a.x, dy=b.y-a.y;
          const d2=Math.max(dx*dx+dy*dy,1), d=Math.sqrt(d2);
          const f=200/d2*alpha;
          a.vx-=dx/d*f; a.vy-=dy/d*f; b.vx+=dx/d*f; b.vy+=dy/d*f;
        }
      }

      for (let i = 0; i < N; i++) {
        const n = sim[i];
        n.vx+=(W/2-n.x)*0.01*alpha; n.vy+=(H/2-n.y)*0.01*alpha;
        n.vx*=0.9; n.vy*=0.9;
        n.x+=n.vx; n.y+=n.vy;
        n.x=Math.max(n.r, Math.min(W-n.r, n.x));
        n.y=Math.max(n.r, Math.min(H-n.r, n.y));
      }

      drawMini(ctx, sim, simEdges, W, H);
      requestAnimationFrame(mTick);
    }

    mTick();
  }

  function drawMini(ctx, nodes, edges, W, H) {
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(48,54,61,0.6)';
    ctx.lineWidth = 0.5;
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const a = nodes[e.s], b = nodes[e.t];
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI*2);
      ctx.fillStyle = n.color; ctx.fill();
    }
  }

  // ── Memory Browser ──
  let memoryPanelLoaded = false;
  let memoryAllFiles = [];
  let memoryGraphEdges = [];
  let memoryCurrentPath = null;

  async function loadMemoryPanel() {
    if (memoryPanelLoaded) return;
    memoryPanelLoaded = true;
    const sidebar = document.getElementById('memory-sidebar');
    sidebar.innerHTML = '<div class="empty-state">Loading...</div>';
    try {
      const filesData = await api('/api/vault/files');
      memoryAllFiles = filesData.files || [];
      try {
        const gd = await api('/api/vault/graph');
        memoryGraphEdges = gd.edges || [];
      } catch(e) { memoryGraphEdges = []; }
      renderMemorySidebar(memoryAllFiles, '');
    } catch (err) {
      sidebar.innerHTML = '<div class="empty-state">Failed: ' + esc(err.message) + '</div>';
    }
  }

  function renderMemorySidebar(files, filterText) {
    const sidebar = document.getElementById('memory-sidebar');
    const q = (filterText || '').toLowerCase();
    const TYPE_ICONS = { entities:'🧑', people:'🧑', orgs:'🏢', concepts:'💡', decisions:'⚖️', daily:'📅', projects:'📁' };
    const groups = {};

    files.forEach(function(f) {
      const path = f.path || f;
      const parts = path.split('/');
      const dir = parts.length > 1 ? parts[0] : 'root';
      const name = parts[parts.length - 1].replace(/\.md$/, '');
      if (!q || name.toLowerCase().includes(q) || path.toLowerCase().includes(q)) {
        if (!groups[dir]) groups[dir] = [];
        groups[dir].push({ path: path, name: name });
      }
    });

    const dirs = Object.keys(groups).sort();
    let html = '';
    dirs.forEach(function(dir) {
      const items = groups[dir];
      if (!items || items.length === 0) return;
      const icon = TYPE_ICONS[dir.toLowerCase()] || '📁';
      html += '<div class="memory-type-header">' + icon + ' ' + esc(dir) + ' <span style="opacity:0.6">(' + items.length + ')</span></div>';
      items.sort(function(a,b) { return a.name.localeCompare(b.name); }).forEach(function(item) {
        const isActive = item.path === memoryCurrentPath;
        html += '<div class="memory-entity-item' + (isActive ? ' active' : '') + '" data-path="' + esc(item.path) + '">' + esc(item.name) + '</div>';
      });
    });

    if (!html) html = '<div class="empty-state">No entities found.</div>';
    sidebar.innerHTML = html;

    sidebar.querySelectorAll('.memory-entity-item').forEach(function(el) {
      el.addEventListener('click', function() {
        sidebar.querySelectorAll('.memory-entity-item').forEach(function(e) { e.classList.remove('active'); });
        el.classList.add('active');
        loadMemoryEntity(el.dataset.path);
      });
    });
  }

  async function loadMemoryEntity(path) {
    memoryCurrentPath = path;
    const content = document.getElementById('memory-content');
    content.innerHTML = '<div class="empty-state">Loading...</div>';
    try {
      const data = await api('/api/vault/file?path=' + encodeURIComponent(path));
      const name = path.split('/').pop().replace(/\.md$/, '');
      const nodeName = name.toLowerCase();

      const backlinks = memoryGraphEdges.filter(function(e) { return (e.target||'').toLowerCase() === nodeName; }).map(function(e) { return e.source; });
      const outLinks = memoryGraphEdges.filter(function(e) { return (e.source||'').toLowerCase() === nodeName; }).map(function(e) { return e.target; });

      const fmData = data.frontmatter || {};
      const fmKeys = Object.keys(fmData);
      let fm = '';
      if (fmKeys.length > 0) {
        fm = '<div style="display:flex; flex-wrap:wrap; gap:12px; margin-bottom:12px; font-size:0.82rem;">';
        fmKeys.forEach(function(k) {
          const v = fmData[k];
          const vStr = Array.isArray(v) ? v.join(', ') : String(v !== null && v !== undefined ? v : '');
          fm += '<span><strong style="color:var(--accent)">' + esc(k) + '</strong>: ' + esc(vStr) + '</span>';
        });
        fm += '</div>';
      }

      let linksHtml = '';
      if (backlinks.length > 0 || outLinks.length > 0) {
        linksHtml = '<div style="margin-top:16px;">';
        if (backlinks.length > 0) {
          linksHtml += '<div style="margin-bottom:10px;"><div style="color:var(--text-dim); font-size:0.75rem; text-transform:uppercase; margin-bottom:4px;">Backlinks (' + backlinks.length + ')</div><div style="display:flex; flex-wrap:wrap; gap:4px;">';
          backlinks.forEach(function(bl) {
            linksHtml += '<span style="background:rgba(88,166,255,0.1);color:var(--accent);padding:2px 8px;border-radius:10px;font-size:0.78rem;font-family:var(--mono);">' + esc(bl) + '</span>';
          });
          linksHtml += '</div></div>';
        }
        if (outLinks.length > 0) {
          linksHtml += '<div><div style="color:var(--text-dim); font-size:0.75rem; text-transform:uppercase; margin-bottom:4px;">Links To (' + outLinks.length + ')</div><div style="display:flex; flex-wrap:wrap; gap:4px;">';
          outLinks.forEach(function(ol) {
            linksHtml += '<span style="background:rgba(63,185,80,0.1);color:var(--green);padding:2px 8px;border-radius:10px;font-size:0.78rem;font-family:var(--mono);">' + esc(ol) + '</span>';
          });
          linksHtml += '</div></div>';
        }
        linksHtml += '</div>';
      }

      content.innerHTML =
        '<div class="card" style="margin-bottom:0;">' +
        '<h2 style="text-transform:none; font-size:1.05rem; color:var(--text); margin-bottom:4px;">' + esc(name) + '</h2>' +
        '<div style="font-size:0.75rem; font-family:var(--mono); color:var(--text-dim); margin-bottom:12px;">' + esc(path) + '</div>' +
        fm + linksHtml +
        (data.body ? '<hr style="border:none;border-top:1px solid var(--border);margin:16px 0;">' +
          '<pre style="white-space:pre-wrap;font-family:var(--mono);font-size:0.8rem;max-height:400px;overflow-y:auto;color:var(--text);">' + esc(data.body) + '</pre>' : '') +
        '</div>';
    } catch (err) {
      content.innerHTML = '<div class="empty-state">Failed: ' + esc(err.message) + '</div>';
    }
  }

  document.getElementById('memory-search').addEventListener('input', function(e) {
    renderMemorySidebar(memoryAllFiles, e.target.value);
  });

  // ── MCP Panel ──
  let mcpPanelLoaded = false;

  async function loadMcpPanel() {
    if (mcpPanelLoaded) return;
    mcpPanelLoaded = true;
    const el = document.getElementById('mcp-content');
    el.innerHTML = '<div class="empty-state">Loading...</div>';
    try {
      const serversData = await api('/api/mcp/servers');
      const toolsData = await api('/api/mcp/tools');
      const servers = serversData.servers || [];
      const tools = toolsData.tools || [];

      if (servers.length === 0 && tools.length === 0) {
        el.innerHTML = '<div class="empty-state">No MCP servers or tools registered.</div>';
        return;
      }

      const toolsByServer = {};
      tools.forEach(function(t) {
        const srv = t.server || t.serverName || '__other__';
        if (!toolsByServer[srv]) toolsByServer[srv] = [];
        toolsByServer[srv].push(t);
      });

      let html = '';

      servers.forEach(function(srv) {
        const name = srv.name || srv.id || 'Unknown';
        const status = srv.status || (srv.connected ? 'connected' : 'disconnected');
        const badgeCls = status === 'connected' ? 'badge-connected' : 'badge-disconnected';
        const srvTools = toolsByServer[name] || [];

        html += '<div class="mcp-server-card">';
        html += '<div class="mcp-server-header">';
        html += '<span>\uD83D\uDD0C ' + esc(name) + '</span>';
        html += '<span class="badge ' + badgeCls + '">' + esc(status) + '</span>';
        html += '<span style="margin-left:auto; font-size:0.8rem; color:var(--text-dim);">' + srvTools.length + ' tools</span>';
        html += '</div>';

        if (srvTools.length > 0) {
          html += '<div class="mcp-tool-grid">';
          srvTools.forEach(function(t) {
            html += '<div class="mcp-tool-item">';
            html += '<div class="mcp-tool-name">' + esc(t.name || t.toolName || '—') + '</div>';
            if (t.description) html += '<div class="mcp-tool-desc">' + esc(t.description) + '</div>';
            html += '</div>';
          });
          html += '</div>';
        } else {
          html += '<div style="font-size:0.85rem;color:var(--text-dim);">No tools loaded.</div>';
        }
        html += '</div>';
      });

      const listedNames = {};
      servers.forEach(function(s) { listedNames[s.name || s.id || 'Unknown'] = true; });
      const orphans = tools.filter(function(t) { return !listedNames[t.server || t.serverName || '__other__']; });

      if (orphans.length > 0) {
        html += '<div class="mcp-server-card"><div class="mcp-server-header"><span>\uD83D\uDD27 Other Tools</span></div><div class="mcp-tool-grid">';
        orphans.forEach(function(t) {
          html += '<div class="mcp-tool-item"><div class="mcp-tool-name">' + esc(t.name || t.toolName || '—') + '</div>';
          if (t.description) html += '<div class="mcp-tool-desc">' + esc(t.description) + '</div>';
          html += '</div>';
        });
        html += '</div></div>';
      }

      el.innerHTML = html || '<div class="empty-state">No MCP data available.</div>';
    } catch (err) {
      el.innerHTML = '<div class="empty-state">Failed: ' + esc(err.message) + '</div>';
    }
  }

  // ── Session Detail Modal ──
  const sessionModal = document.getElementById('session-modal');
  const sessionModalClose = document.getElementById('session-modal-close');
  const sessionModalBody = document.getElementById('session-modal-body');
  const sessionModalMeta = document.getElementById('session-modal-meta');

  sessionModalClose.addEventListener('click', function() {
    sessionModal.style.display = 'none';
  });
  sessionModal.addEventListener('click', function(e) {
    if (e.target === sessionModal) sessionModal.style.display = 'none';
  });

  async function openSessionModal(sessionId) {
    if (!sessionId) return;
    sessionModal.style.display = 'flex';
    sessionModalMeta.innerHTML = '';
    sessionModalBody.innerHTML = '<div class="empty-state">Loading...</div>';
    try {
      const data = await api('/api/sessions/' + encodeURIComponent(sessionId));
      sessionModalMeta.innerHTML =
        '<span><strong>ID:</strong> ' + esc(data.id ?? sessionId) + '</span>' +
        '<span><strong>Channel:</strong> ' + esc(data.channel ?? '—') + '</span>' +
        '<span><strong>Trust:</strong> ' + esc(data.trustTier ?? '—') + '</span>' +
        '<span><strong>Status:</strong> ' + esc(data.status ?? '—') + '</span>' +
        '<span><strong>Messages:</strong> ' + esc(data.messageCount ?? 0) + '</span>' +
        (data.startedAt ? '<span><strong>Started:</strong> ' + esc(fmtDate(data.startedAt)) + '</span>' : '');
      const messages = data.messages || [];
      if (messages.length === 0) {
        sessionModalBody.innerHTML = '<div class="empty-state">No messages in this session.</div>';
        return;
      }
      sessionModalBody.innerHTML = messages.map(function(m) {
        const roleClass = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'tool';
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
        return '<div class="session-message ' + roleClass + '">' +
          '<div class="msg-role">' + esc(m.role) + (m.name ? ' (' + esc(m.name) + ')' : '') + '</div>' +
          '<div class="msg-content">' + esc(content) + '</div>' +
          '</div>';
      }).join('');
    } catch (err) {
      sessionModalBody.innerHTML = '<div class="empty-state">Failed to load session: ' + esc(err.message) + '</div>';
    }
  }
})();
</script>
</body>
</html>`;
}
