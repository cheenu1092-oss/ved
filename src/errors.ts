/**
 * Actionable error messages for Ved.
 *
 * Each error has a numeric code [VED-NNN], a human-readable message,
 * and a concrete fix hint so users know exactly what to do next.
 */

export interface VedErrorDef {
  /** 3-digit display number, e.g. "001" */
  num: string;
  /** Default error message template */
  message: string;
  /** Actionable fix suggestion */
  fix: string;
}

export const VED_ERRORS = {
  CONFIG_MISSING: {
    num: '001',
    message: 'Config file not found',
    fix: 'Run "ved init" to create a default configuration',
  },
  CONFIG_INVALID: {
    num: '002',
    message: 'Configuration is invalid',
    fix: 'Run "ved config" to review your settings, or "ved init --yes" to reset to defaults',
  },
  DB_CORRUPT: {
    num: '003',
    message: 'Database appears corrupt',
    fix: 'Run "ved backup restore" to restore from backup, or delete ~/.ved/ved.db and run "ved init"',
  },
  VAULT_MISSING: {
    num: '004',
    message: 'Vault directory not found',
    fix: 'Run "ved doctor --fix" to create vault directories automatically',
  },
  LLM_UNREACHABLE: {
    num: '005',
    message: 'LLM provider unreachable',
    fix: 'Check your API key and network connection. Run "ved config" to update LLM settings',
  },
  AUTH_FAILED: {
    num: '006',
    message: 'Authentication failed',
    fix: 'Check your API key in ~/.ved/config.local.yaml or set the VED_LLM_API_KEY environment variable',
  },
  COMMAND_NOT_FOUND: {
    num: '007',
    message: 'Unknown command',
    fix: 'Run "ved help" to see all available commands',
  },
  INIT_REQUIRED: {
    num: '008',
    message: 'Ved not initialized',
    fix: 'Run "ved init" to set up your configuration',
  },
  RAG_STALE: {
    num: '009',
    message: 'RAG index is stale or empty',
    fix: 'Run "ved reindex" or "ved doctor --fix" to rebuild the search index',
  },
  HOOK_FAILED: {
    num: '010',
    message: 'Hook execution failed',
    fix: 'Check your hook configuration with "ved hook list" and verify the hook command',
  },
  BACKUP_FAILED: {
    num: '011',
    message: 'Backup operation failed',
    fix: 'Check disk space and write permissions for the backup directory',
  },
  IMPORT_FAILED: {
    num: '012',
    message: 'Import failed',
    fix: 'Verify the import file format. Run "ved export" to see the expected structure',
  },
  EXPORT_FAILED: {
    num: '013',
    message: 'Export failed',
    fix: 'Check disk space and write permissions for the output directory',
  },
  SESSION_NOT_FOUND: {
    num: '014',
    message: 'Session not found',
    fix: 'Run "ved history" to list available sessions',
  },
  CRON_INVALID: {
    num: '015',
    message: 'Invalid cron schedule',
    fix: 'Use standard cron syntax e.g. "0 * * * *". Run "ved cron list" to see configured jobs',
  },
  SYNC_FAILED: {
    num: '016',
    message: 'Sync operation failed',
    fix: 'Check remote connectivity and auth. Run "ved sync status" to view remote health',
  },
  TEMPLATE_NOT_FOUND: {
    num: '017',
    message: 'Template not found',
    fix: 'Run "ved template list" to see available templates',
  },
  SNAPSHOT_NOT_FOUND: {
    num: '018',
    message: 'Snapshot not found',
    fix: 'Run "ved snapshot list" to see available snapshots',
  },
  MIGRATION_FAILED: {
    num: '019',
    message: 'Data migration failed',
    fix: 'Check the source file format. Run "ved migrate validate <file>" before importing',
  },
  INVALID_ARGUMENT: {
    num: '020',
    message: 'Invalid argument',
    fix: 'Run "ved help <command>" to see usage and valid options',
  },
  MISSING_ARGUMENT: {
    num: '021',
    message: 'Missing required argument',
    fix: 'Run "ved help <command>" to see required arguments',
  },
  PERMISSION_DENIED: {
    num: '022',
    message: 'Permission denied',
    fix: 'Check file permissions. You may need to run with appropriate access rights',
  },
  NOT_INITIALIZED: {
    num: '023',
    message: 'Ved is not initialized in this directory',
    fix: 'Run "ved init" first to create configuration and vault',
  },
  AGENT_NOT_FOUND: {
    num: '024',
    message: 'Agent profile not found',
    fix: 'Run "ved agent list" to see available profiles',
  },
  HOOK_BLOCKED: {
    num: '025',
    message: 'Hook command blocked for safety',
    fix: 'The command contains dangerous patterns. Review with "ved hook show <name>"',
  },
  ALREADY_EXISTS: {
    num: '026',
    message: 'Resource already exists',
    fix: 'Use a different name, or delete the existing one first',
  },
} as const satisfies Record<string, VedErrorDef>;

export type VedErrorCode = keyof typeof VED_ERRORS;

/**
 * Print a formatted, actionable error message to stderr.
 *
 * Format:
 *   ❌ Error [VED-001]: Config file not found
 *      Fix: Run "ved init" to create a default configuration
 *
 * @param code - Error code from VED_ERRORS (or a custom string key)
 * @param customMessage - Override the registry message (e.g. to include details)
 * @param customFix - Override the registry fix hint
 */
export function vedError(
  code: VedErrorCode | string,
  customMessage?: string,
  customFix?: string,
): void {
  const def = VED_ERRORS[code as VedErrorCode];
  const num = def ? def.num : '???';
  const message = customMessage ?? def?.message ?? code;
  const fix = customFix ?? def?.fix ?? '';

  console.error(`❌ Error [VED-${num}]: ${message}`);
  if (fix) {
    console.error(`   Fix: ${fix}`);
  }
}

/**
 * Print a compact, actionable error line to stderr (no exit).
 *
 * Format:
 *   ✗ Something went wrong
 *   → Here's how to fix it
 *
 * Use for non-fatal errors where the CLI continues (e.g. bad subcommand arg).
 * For fatal errors that should exit, use dieWithHint().
 */
export function errHint(message: string, hint?: string): void {
  console.error(`\x1B[31m✗ ${message}\x1B[0m`);
  if (hint) {
    console.error(`\x1B[2m  → ${hint}\x1B[0m`);
  }
}

/**
 * Print a usage line to stderr.
 *
 * Format:
 *   Usage: ved command <arg> [options]
 */
export function errUsage(usage: string): void {
  console.error(`\x1B[2mUsage: ${usage}\x1B[0m`);
}

/**
 * Print a fatal error and a fix hint to stderr, then exit with code 1.
 *
 * Format:
 *   ✗ Config not found
 *   → Run "ved init" to create one
 *
 * Use when you want to terminate the process with a clear, actionable error.
 * The message is printed in bold-red; the hint in dim gray.
 *
 * @param message - What went wrong
 * @param hint    - How to fix it
 */
export function dieWithHint(message: string, hint: string): never {
  console.error(`\x1B[31m✗ ${message}\x1B[0m`);
  console.error(`\x1B[2m  → ${hint}\x1B[0m`);
  process.exit(1);
}
