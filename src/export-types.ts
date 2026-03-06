/**
 * Types for ved export/import functionality.
 */

export interface VaultExportFile {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  links: string[];
}

export interface VaultExport {
  vedVersion: string;
  exportedAt: string;
  vaultPath: string;
  fileCount: number;
  files: VaultExportFile[];
  audit?: {
    chainLength: number;
    chainHead: string;
    entries: number;
  };
  stats?: {
    rag: { filesIndexed: number; chunksStored: number; ftsEntries: number; graphEdges: number };
    vault: { fileCount: number; tagCount: number; typeCount: number };
    sessions: { active: number; total: number };
  };
}

export interface ExportOptions {
  folder?: string;
  includeAudit?: boolean;
  includeStats?: boolean;
}

export interface ImportResult {
  created: number;
  overwritten: number;
  skipped: number;
  errors: number;
  errorPaths: string[];
}
