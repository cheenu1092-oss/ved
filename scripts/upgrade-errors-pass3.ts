#!/usr/bin/env npx tsx
/**
 * Pass 3: Handle colored errors, catch-block errors, and chat errors.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = join(import.meta.dirname!, '..');
const files = readdirSync(join(srcDir, 'src'))
  .filter(f => f.startsWith('cli-') && f.endsWith('.ts') && !f.includes('.test.'));

let totalReplaced = 0;
let filesModified = 0;

for (const file of files) {
  const filePath = join(srcDir, 'src', file);
  let content = readFileSync(filePath, 'utf-8');
  const original = content;
  let replacements = 0;

  // Pattern: console.error(`${C.red}Usage: ved ...${ C.reset}`)
  content = content.replace(
    /console\.error\(`\$\{C\.red\}Usage: (ved [^`]*)\$\{C\.reset\}`\)/g,
    (_match, msg) => {
      replacements++;
      return `errUsage('${msg}')`;
    }
  );

  // Pattern: console.error(`${C.red}...${C.reset}`) — generic colored errors
  content = content.replace(
    /console\.error\(`\$\{C\.red\}([^`]*)\$\{C\.reset\}`\)/g,
    (_match, msg) => {
      // Skip if it has template expressions (${...} other than C.xxx)
      if (msg.includes('${') && !msg.includes('${name}') && !msg.includes('${err}') && !msg.includes('${nameErr}') && !msg.includes('${cmd}')) {
        return _match; // too complex, skip
      }
      replacements++;
      return `errHint(\`${msg}\`)`;
    }
  );

  // Pattern: console.error(`${C.red}...${name}...${C.reset}`) with template vars
  // Already handled above for simple cases

  // Pattern: console.error('Failed to ...:', (e as Error).message)
  content = content.replace(
    /console\.error\('(Failed to [^']+)',\s*\(e as Error\)\.message\)/g,
    (_match, msg) => {
      replacements++;
      return `errHint(\`${msg} \${(e as Error).message}\`)`;
    }
  );

  // Pattern: console.error(`Failed to ... ${hash}:`, (e as Error).message)
  content = content.replace(
    /console\.error\(`(Failed to [^`]+)`,\s*\(e as Error\)\.message\)/g,
    (_match, msg) => {
      replacements++;
      return `errHint(\`${msg} \${(e as Error).message}\`)`;
    }
  );

  // Pattern: console.error(`\nChat error: ${err...}`)
  content = content.replace(
    /console\.error\(`\\nChat error: \$\{err instanceof Error \? err\.message : String\(err\)\}`\)/g,
    (_match) => {
      replacements++;
      return `errHint(\`Chat error: \${err instanceof Error ? err.message : String(err)}\`)`;
    }
  );

  // Pattern: console.error(`\nDaemon error: ...`)
  content = content.replace(
    /console\.error\(`\\nDaemon error: \$\{err instanceof Error \? err\.message : String\(err\)\}`\)/g,
    (_match) => {
      replacements++;
      return `errHint(\`Daemon error: \${err instanceof Error ? err.message : String(err)}\`)`;
    }
  );

  // Pattern: console.error(`\nFailed to start: ...`)
  content = content.replace(
    /console\.error\(`\\nFailed to start: \$\{err instanceof Error \? err\.message : String\(err\)\}`\)/g,
    (_match) => {
      replacements++;
      return `errHint(\`Failed to start: \${err instanceof Error ? err.message : String(err)}\`)`;
    }
  );

  // Ensure import exists
  if (replacements > 0 && !content.includes("from './errors.js'")) {
    const importMatch = content.match(/^(import .+from .+;?\n)/gm);
    if (importMatch) {
      const lastImport = importMatch[importMatch.length - 1];
      const lastImportIdx = content.lastIndexOf(lastImport);
      const insertPoint = lastImportIdx + lastImport.length;
      content = content.slice(0, insertPoint) +
        "import { errHint, errUsage } from './errors.js';\n" +
        content.slice(insertPoint);
    }
  }

  if (content !== original) {
    writeFileSync(filePath, content);
    filesModified++;
    totalReplaced += replacements;
    console.log(`  ${file}: ${replacements} replacements`);
  }
}

console.log(`\nTotal: ${totalReplaced} replacements across ${filesModified} files`);
