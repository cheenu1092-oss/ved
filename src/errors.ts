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
