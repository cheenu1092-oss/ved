/**
 * `ved trust` — CLI for managing trust tiers, the trust matrix, and work orders.
 *
 * Subcommands:
 *   matrix                                   — Display the trust×risk decision matrix
 *   resolve <channel> <userId>               — Resolve trust tier for a user
 *   assess <toolName> [--params <json>]       — Assess risk level of a tool call
 *   grant <channel> <userId> <tier> --as <ownerId> [--reason <text>]
 *                                             — Grant a trust tier to a user
 *   revoke <channel> <userId> --as <ownerId> [--reason <text>]
 *                                             — Revoke trust grant for a user
 *   ledger [--channel <ch>] [--user <id>] [--active] [--limit N]
 *                                             — Show trust ledger entries
 *   pending [--session <id>]                  — List pending work orders
 *   history [--status <status>] [--tool <name>] [--limit N]
 *                                             — Show work order history
 *   show <workOrderId>                        — Show work order details
 *   config                                    — Show trust configuration
 */

import type { VedApp } from './app.js';
import type { TrustTier, RiskLevel, TrustDecision } from './types/index.js';
import { TRUST_RISK_MATRIX } from './types/index.js';

// === Helpers ===

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { positional, flags };
}

const TIER_NAMES: Record<TrustTier, string> = {
  1: 'Stranger',
  2: 'Known',
  3: 'Tribe',
  4: 'Owner',
};

const RISK_COLORS: Record<RiskLevel, string> = {
  low: '\x1b[32m',      // green
  medium: '\x1b[33m',   // yellow
  high: '\x1b[31m',     // red
  critical: '\x1b[35m', // magenta
};

const DECISION_SYMBOLS: Record<TrustDecision, string> = {
  auto: '✅ auto',
  approve: '🔒 approve',
  deny: '❌ deny',
};

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// === Trust Ledger Row ===

interface TrustLedgerRow {
  id: string;
  channel: string;
  user_id: string;
  user_name: string;
  trust_tier: number;
  granted_by: string;
  granted_at: number;
  revoked_at: number | null;
  reason: string;
}

// === Work Order Row ===

interface WorkOrderRow {
  id: string;
  session_id: string;
  message_id: string;
  tool_name: string;
  tool_server: string;
  params: string;
  risk_level: string;
  risk_reasons: string;
  trust_tier: number;
  status: string;
  result: string | null;
  error: string | null;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  audit_id: string | null;
}

// === Subcommands ===

function showMatrix(): void {
  console.log(`\n${BOLD}Ved Trust × Risk Matrix${RESET}\n`);
  const risks: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  const tiers: TrustTier[] = [4, 3, 2, 1];

  // Header
  const colWidth = 14;
  const tierColWidth = 20;
  const header = ''.padEnd(tierColWidth) + risks.map(r =>
    `${RISK_COLORS[r]}${r.padEnd(colWidth)}${RESET}`
  ).join('');
  console.log(header);
  console.log('─'.repeat(tierColWidth + colWidth * risks.length));

  // Rows
  for (const tier of tiers) {
    const label = `Tier ${tier} (${TIER_NAMES[tier]})`.padEnd(tierColWidth);
    const cells = risks.map(risk => {
      const decision = TRUST_RISK_MATRIX[tier][risk];
      return DECISION_SYMBOLS[decision].padEnd(colWidth + 2); // +2 for emoji width
    }).join('');
    console.log(`${label}${cells}`);
  }

  console.log(`\n${DIM}Legend: auto=execute immediately, approve=needs HITL, deny=blocked${RESET}\n`);
}

function resolveTier(app: VedApp, args: string[]): void {
  const { positional } = parseArgs(args);
  if (positional.length < 2) {
    console.error('Usage: ved trust resolve <channel> <userId>');
    process.exit(1);
  }

  const [channel, userId] = positional;
  const tier = app.trustResolve(channel, userId);

  console.log(`\n${BOLD}Trust Resolution${RESET}`);
  console.log(`  Channel:  ${channel}`);
  console.log(`  User:     ${userId}`);
  console.log(`  Tier:     ${tier} (${TIER_NAMES[tier as TrustTier]})`);

  // Show what this tier allows
  const risks: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  console.log(`\n  ${DIM}Permissions:${RESET}`);
  for (const risk of risks) {
    const decision = TRUST_RISK_MATRIX[tier as TrustTier][risk];
    console.log(`    ${risk.padEnd(10)} → ${DECISION_SYMBOLS[decision]}`);
  }
  console.log();
}

function assessRisk(app: VedApp, args: string[]): void {
  const { positional, flags } = parseArgs(args);
  if (positional.length < 1) {
    console.error('Usage: ved trust assess <toolName> [--params <json>]');
    process.exit(1);
  }

  const toolName = positional[0];
  let params: Record<string, unknown> = {};
  if (flags['params']) {
    try {
      params = JSON.parse(flags['params']) as Record<string, unknown>;
    } catch {
      console.error('Error: --params must be valid JSON');
      process.exit(1);
    }
  }

  const assessment = app.trustAssess(toolName, params);

  console.log(`\n${BOLD}Risk Assessment${RESET}`);
  console.log(`  Tool:    ${toolName}`);
  if (Object.keys(params).length > 0) {
    console.log(`  Params:  ${JSON.stringify(params)}`);
  }
  const riskLevel = assessment.level as RiskLevel;
  console.log(`  Risk:    ${RISK_COLORS[riskLevel]}${riskLevel}${RESET}`);
  console.log(`  Reasons:`);
  for (const reason of assessment.reasons) {
    console.log(`    • ${reason}`);
  }

  // Show what each tier would decide
  console.log(`\n  ${DIM}Tier decisions for ${riskLevel} risk:${RESET}`);
  const tiers: TrustTier[] = [4, 3, 2, 1];
  for (const tier of tiers) {
    const decision = TRUST_RISK_MATRIX[tier][riskLevel];
    console.log(`    Tier ${tier} (${TIER_NAMES[tier]}) → ${DECISION_SYMBOLS[decision]}`);
  }
  console.log();
}

function grantTrust(app: VedApp, args: string[]): void {
  const { positional, flags } = parseArgs(args);
  if (positional.length < 3 || !flags['as']) {
    console.error('Usage: ved trust grant <channel> <userId> <tier> --as <ownerId> [--reason <text>]');
    process.exit(1);
  }

  const [channel, userId, tierStr] = positional;
  const tier = parseInt(tierStr, 10) as TrustTier;
  if (![1, 2, 3, 4].includes(tier)) {
    console.error('Error: tier must be 1, 2, 3, or 4');
    process.exit(1);
  }

  const grantedBy = flags['as'];
  const reason = flags['reason'] ?? '';

  try {
    app.trustGrant(channel, userId, tier, grantedBy, reason);
    console.log(`\n${BOLD}Trust Granted${RESET}`);
    console.log(`  Channel:    ${channel}`);
    console.log(`  User:       ${userId}`);
    console.log(`  Tier:       ${tier} (${TIER_NAMES[tier]})`);
    console.log(`  Granted by: ${grantedBy}`);
    if (reason) console.log(`  Reason:     ${reason}`);
    console.log();
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

function revokeTrust(app: VedApp, args: string[]): void {
  const { positional, flags } = parseArgs(args);
  if (positional.length < 2 || !flags['as']) {
    console.error('Usage: ved trust revoke <channel> <userId> --as <ownerId> [--reason <text>]');
    process.exit(1);
  }

  const [channel, userId] = positional;
  const revokedBy = flags['as'];
  const reason = flags['reason'] ?? '';

  app.trustRevoke(channel, userId, revokedBy, reason);
  console.log(`\n${BOLD}Trust Revoked${RESET}`);
  console.log(`  Channel:    ${channel}`);
  console.log(`  User:       ${userId}`);
  console.log(`  Revoked by: ${revokedBy}`);
  if (reason) console.log(`  Reason:     ${reason}`);
  console.log();
}

function showLedger(app: VedApp, args: string[]): void {
  const { flags } = parseArgs(args);
  const limit = parseInt(flags['limit'] ?? '50', 10);
  const filterChannel = flags['channel'] ?? null;
  const filterUser = flags['user'] ?? null;
  const activeOnly = flags['active'] === 'true';

  // Query trust ledger via app's DB accessor
  let sql = 'SELECT * FROM trust_ledger';
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (activeOnly) {
    conditions.push('revoked_at IS NULL');
  }
  if (filterChannel) {
    conditions.push('channel = @channel');
    params['channel'] = filterChannel;
  }
  if (filterUser) {
    conditions.push('user_id = @user');
    params['user'] = filterUser;
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY granted_at DESC LIMIT @limit';
  params['limit'] = limit;

  const rows = app.queryDb(sql, params) as TrustLedgerRow[];

  if (rows.length === 0) {
    console.log('\nNo trust ledger entries found.\n');
    return;
  }

  console.log(`\n${BOLD}Trust Ledger${RESET} (${rows.length} entries)\n`);

  for (const row of rows) {
    const status = row.revoked_at ? `${DIM}revoked${RESET}` : `\x1b[32mactive${RESET}`;
    const tierLabel = TIER_NAMES[row.trust_tier as TrustTier] ?? `Tier ${row.trust_tier}`;
    console.log(`  ${row.id.slice(0, 8)}  ${row.channel}:${row.user_id}  → ${tierLabel} (${row.trust_tier})  [${status}]`);
    console.log(`           granted by ${row.granted_by} at ${formatTimestamp(row.granted_at)}`);
    if (row.revoked_at) {
      console.log(`           revoked at ${formatTimestamp(row.revoked_at)}`);
    }
    if (row.reason) {
      console.log(`           reason: ${row.reason}`);
    }
  }
  console.log();
}

function showPending(app: VedApp, args: string[]): void {
  const { flags } = parseArgs(args);
  const sessionId = flags['session'] ?? undefined;

  const orders = app.workOrdersPending(sessionId);

  if (orders.length === 0) {
    console.log('\nNo pending work orders.\n');
    return;
  }

  console.log(`\n${BOLD}Pending Work Orders${RESET} (${orders.length})\n`);

  for (const wo of orders) {
    const remaining = wo.expiresAt - Date.now();
    const expiryStr = remaining > 0 ? `expires in ${formatDuration(remaining)}` : 'EXPIRED';
    const riskStr = `${RISK_COLORS[wo.riskLevel]}${wo.riskLevel}${RESET}`;

    console.log(`  ${BOLD}${wo.id}${RESET}`);
    console.log(`    Tool:     ${wo.tool}${wo.toolServer ? ` (${wo.toolServer})` : ''}`);
    console.log(`    Risk:     ${riskStr}`);
    console.log(`    Tier:     ${wo.trustTier} (${TIER_NAMES[wo.trustTier]})`);
    console.log(`    Session:  ${wo.sessionId}`);
    console.log(`    Created:  ${formatTimestamp(wo.createdAt)} (${expiryStr})`);
    if (Object.keys(wo.params).length > 0) {
      const paramStr = JSON.stringify(wo.params);
      console.log(`    Params:   ${paramStr.length > 80 ? paramStr.slice(0, 77) + '...' : paramStr}`);
    }
    console.log();
  }
}

function showWorkOrderHistory(app: VedApp, args: string[]): void {
  const { flags } = parseArgs(args);
  const limit = parseInt(flags['limit'] ?? '20', 10);
  const filterStatus = flags['status'] ?? null;
  const filterTool = flags['tool'] ?? null;

  // Query work order history via app's DB accessor
  let sql = 'SELECT * FROM work_orders';
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (filterStatus) {
    conditions.push('status = @status');
    params['status'] = filterStatus;
  }
  if (filterTool) {
    conditions.push('tool_name = @tool');
    params['tool'] = filterTool;
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC LIMIT @limit';
  params['limit'] = limit;

  const rows = app.queryDb(sql, params) as WorkOrderRow[];

  if (rows.length === 0) {
    console.log('\nNo work orders found.\n');
    return;
  }

  console.log(`\n${BOLD}Work Order History${RESET} (${rows.length})\n`);

  const STATUS_COLORS: Record<string, string> = {
    pending: '\x1b[33m',   // yellow
    approved: '\x1b[32m',  // green
    denied: '\x1b[31m',    // red
    expired: '\x1b[2m',    // dim
    cancelled: '\x1b[2m',
    executing: '\x1b[36m', // cyan
    completed: '\x1b[32m',
    failed: '\x1b[31m',
  };

  for (const row of rows) {
    const statusColor = STATUS_COLORS[row.status] ?? '';
    const riskColor = RISK_COLORS[row.risk_level as RiskLevel] ?? '';
    const duration = row.resolved_at ? formatDuration(row.resolved_at - row.created_at) : '—';

    console.log(`  ${row.id.slice(0, 12)}  ${row.tool_name.padEnd(12)}  ${riskColor}${row.risk_level.padEnd(9)}${RESET}  ${statusColor}${row.status.padEnd(10)}${RESET}  ${duration}`);
    if (row.resolved_by) {
      console.log(`               resolved by ${row.resolved_by} at ${formatTimestamp(row.resolved_at!)}`);
    }
    if (row.error) {
      console.log(`               error: ${row.error.slice(0, 80)}`);
    }
  }
  console.log();
}

function showWorkOrder(app: VedApp, args: string[]): void {
  const { positional } = parseArgs(args);
  if (positional.length < 1) {
    console.error('Usage: ved trust show <workOrderId>');
    process.exit(1);
  }

  const id = positional[0];
  const wo = app.workOrderGet(id);

  if (!wo) {
    // Try prefix match via DB
    const rows = app.queryDb(
      'SELECT * FROM work_orders WHERE id LIKE @prefix LIMIT 1',
      { prefix: `${id}%` },
    ) as WorkOrderRow[];
    const row = rows[0] as WorkOrderRow | undefined;
    if (!row) {
      console.error(`Work order not found: ${id}`);
      process.exit(1);
    }
    showWorkOrderDetail(row);
    return;
  }

  showWorkOrderDetail({
    id: wo.id,
    session_id: wo.sessionId,
    message_id: wo.messageId,
    tool_name: wo.tool,
    tool_server: wo.toolServer,
    params: JSON.stringify(wo.params),
    risk_level: wo.riskLevel,
    risk_reasons: JSON.stringify(wo.riskReasons),
    trust_tier: wo.trustTier,
    status: wo.status,
    result: wo.result ? JSON.stringify(wo.result) : null,
    error: wo.error ?? null,
    created_at: wo.createdAt,
    expires_at: wo.expiresAt,
    resolved_at: wo.resolvedAt ?? null,
    resolved_by: wo.resolvedBy ?? null,
    audit_id: wo.auditId ?? null,
  });
}

function showWorkOrderDetail(row: WorkOrderRow): void {
  const riskColor = RISK_COLORS[row.risk_level as RiskLevel] ?? '';

  console.log(`\n${BOLD}Work Order: ${row.id}${RESET}\n`);
  console.log(`  Tool:       ${row.tool_name}${row.tool_server ? ` (${row.tool_server})` : ''}`);
  console.log(`  Risk:       ${riskColor}${row.risk_level}${RESET}`);
  console.log(`  Tier:       ${row.trust_tier} (${TIER_NAMES[row.trust_tier as TrustTier]})`);
  console.log(`  Status:     ${row.status}`);
  console.log(`  Session:    ${row.session_id}`);
  console.log(`  Message:    ${row.message_id}`);
  console.log(`  Created:    ${formatTimestamp(row.created_at)}`);
  console.log(`  Expires:    ${formatTimestamp(row.expires_at)}`);

  if (row.resolved_at) {
    console.log(`  Resolved:   ${formatTimestamp(row.resolved_at)} by ${row.resolved_by}`);
    console.log(`  Duration:   ${formatDuration(row.resolved_at - row.created_at)}`);
  }

  if (row.audit_id) {
    console.log(`  Audit ID:   ${row.audit_id}`);
  }

  // Risk reasons
  try {
    const reasons = JSON.parse(row.risk_reasons) as string[];
    if (reasons.length > 0) {
      console.log(`\n  ${DIM}Risk Reasons:${RESET}`);
      for (const r of reasons) {
        console.log(`    • ${r}`);
      }
    }
  } catch { /* ignore */ }

  // Params
  try {
    const params = JSON.parse(row.params) as Record<string, unknown>;
    if (Object.keys(params).length > 0) {
      console.log(`\n  ${DIM}Parameters:${RESET}`);
      console.log(`    ${JSON.stringify(params, null, 2).replace(/\n/g, '\n    ')}`);
    }
  } catch { /* ignore */ }

  // Result/Error
  if (row.result) {
    console.log(`\n  ${DIM}Result:${RESET}`);
    try {
      const parsed = JSON.parse(row.result);
      console.log(`    ${JSON.stringify(parsed, null, 2).replace(/\n/g, '\n    ')}`);
    } catch {
      console.log(`    ${row.result.slice(0, 200)}`);
    }
  }
  if (row.error) {
    console.log(`\n  ${DIM}Error:${RESET}`);
    console.log(`    ${row.error}`);
  }

  console.log();
}

function showTrustConfig(app: VedApp): void {
  const config = app.trustConfig;

  console.log(`\n${BOLD}Trust Configuration${RESET}\n`);
  console.log(`  Default Tier:      ${config.defaultTier} (${TIER_NAMES[config.defaultTier as TrustTier]})`);
  console.log(`  Approval Timeout:  ${formatDuration(config.approvalTimeoutMs ?? 300_000)}`);
  console.log(`  Max Agentic Loops: ${config.maxAgenticLoops ?? 10}`);

  console.log(`\n  ${DIM}Owner IDs (Tier 4):${RESET}`);
  if (config.ownerIds.length === 0) {
    console.log('    (none configured)');
  } else {
    for (const id of config.ownerIds) {
      console.log(`    • ${id}`);
    }
  }

  console.log(`\n  ${DIM}Tribe IDs (Tier 3):${RESET}`);
  if (config.tribeIds.length === 0) {
    console.log('    (none configured)');
  } else {
    for (const id of config.tribeIds) {
      console.log(`    • ${id}`);
    }
  }

  console.log(`\n  ${DIM}Known IDs (Tier 2):${RESET}`);
  if (config.knownIds.length === 0) {
    console.log('    (none configured)');
  } else {
    for (const id of config.knownIds) {
      console.log(`    • ${id}`);
    }
  }

  console.log();
}

// === Main Entry ===

const TRUST_USAGE = `
Usage: ved trust <subcommand> [options]

Subcommands:
  matrix                                     Show trust × risk decision matrix
  resolve <channel> <userId>                 Resolve trust tier for a user
  assess <toolName> [--params <json>]        Assess risk level of a tool call
  grant <channel> <userId> <tier> --as <id>  Grant trust tier (owner-only)
  revoke <channel> <userId> --as <id>        Revoke trust grant (owner-only)
  ledger [--channel <ch>] [--user <id>]      Show trust ledger entries
         [--active] [--limit N]
  pending [--session <id>]                   List pending work orders
  history [--status <s>] [--tool <n>]        Work order history
          [--limit N]
  show <workOrderId>                         Work order details
  config                                     Show trust configuration

Aliases: t=trust, who=resolve, risk=assess, wo=pending, orders=history
`;

export async function trustCommand(app: VedApp, args: string[]): Promise<void> {
  const sub = args[0];
  const subArgs = args.slice(1);

  switch (sub) {
    case 'matrix':
    case 'mat':
      showMatrix();
      break;

    case 'resolve':
    case 'who':
      resolveTier(app, subArgs);
      break;

    case 'assess':
    case 'risk':
      assessRisk(app, subArgs);
      break;

    case 'grant':
      grantTrust(app, subArgs);
      break;

    case 'revoke':
      revokeTrust(app, subArgs);
      break;

    case 'ledger':
    case 'log':
      showLedger(app, subArgs);
      break;

    case 'pending':
    case 'wo':
      showPending(app, subArgs);
      break;

    case 'history':
    case 'orders':
      showWorkOrderHistory(app, subArgs);
      break;

    case 'show':
    case 'detail':
      showWorkOrder(app, subArgs);
      break;

    case 'config':
    case 'cfg':
      showTrustConfig(app);
      break;

    default:
      console.log(TRUST_USAGE);
      break;
  }
}
