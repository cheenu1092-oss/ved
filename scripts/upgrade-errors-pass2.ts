#!/usr/bin/env npx tsx
/**
 * Pass 2: Handle remaining console.error patterns missed by pass 1.
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

  // Skip warning lines (⚠), formatted result display (C.red, C.yellow), and skipped items in batch ops
  // These are intentional formatting, not error messages

  const lines = content.split('\n');
  const newLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();

    // Skip lines that should NOT be converted:
    // - Warning lines with ⚠
    // - Formatted output with color codes (C.red, C.yellow, etc.)
    // - Lines that are part of a multi-line console.error block (subcommand lists)
    // - Batch operation skip messages ("Skipped ...")
    // - Lines already using errHint/errUsage
    if (
      trimmed.includes('⚠') ||
      trimmed.includes('C.red') ||
      trimmed.includes('C.yellow') ||
      trimmed.includes('C.reset') ||
      trimmed.includes('errHint') ||
      trimmed.includes('errUsage') ||
      trimmed.includes('Skipped') ||
      trimmed.includes('console.error(\'\\n') ||  // newline-prefixed subcommand lists
      trimmed.includes("console.error('  ") ||    // indented help text
      !trimmed.startsWith('console.error(')
    ) {
      newLines.push(line);
      continue;
    }

    // Pattern: console.error(`Invalid ...: ${var}`)
    const invalidMatch = trimmed.match(/^console\.error\(`(Invalid [^`]*)`\);\s*$/);
    if (invalidMatch) {
      line = line.replace(/console\.error\(`(Invalid [^`]*)`\)/, `errHint(\`$1\`)`);
      replacements++;
      newLines.push(line);
      continue;
    }

    // Pattern: console.error(`...already exists...`)
    const existsMatch = trimmed.match(/^console\.error\(`([^`]*already exists[^`]*)`\);\s*$/);
    if (existsMatch) {
      line = line.replace(/console\.error\(`([^`]*already exists[^`]*)`\)/, `errHint(\`$1\`)`);
      replacements++;
      newLines.push(line);
      continue;
    }

    // Pattern: console.error(`Unknown ...: ${var}`)
    const unknownMatch = trimmed.match(/^console\.error\(`(Unknown [^`]*)`\);\s*$/);
    if (unknownMatch) {
      line = line.replace(/console\.error\(`(Unknown [^`]*)`\)/, `errHint(\`$1\`, 'Run "ved help" to see available commands')`);
      replacements++;
      newLines.push(line);
      continue;
    }

    // Pattern: console.error(`Unknown flag: ${args[i]}`)
    const flagMatch = trimmed.match(/^console\.error\(`Unknown flag: \$\{[^}]+\}`\);\s*$/);
    if (flagMatch) {
      line = line.replace(/console\.error\(`(Unknown flag: [^`]*)`\)/, `errHint(\`$1\`, 'Run "ved help" for available options')`);
      replacements++;
      newLines.push(line);
      continue;
    }

    // Pattern: simple string errors like console.error('No query provided')
    const simpleMatch = trimmed.match(/^console\.error\('([^']+)'\);\s*$/);
    if (simpleMatch) {
      const msg = simpleMatch[1];
      // Skip formatted/indented lines
      if (msg.startsWith('  ') || msg.startsWith('\\n') || msg.startsWith('\n')) {
        newLines.push(line);
        continue;
      }
      line = line.replace(`console.error('${msg}')`, `errHint('${msg}')`);
      replacements++;
      newLines.push(line);
      continue;
    }

    // Pattern: template literal errors like console.error(`...`)
    const templateMatch = trimmed.match(/^console\.error\(`([^`]+)`\);\s*$/);
    if (templateMatch) {
      const msg = templateMatch[1];
      if (msg.startsWith('  ') || msg.startsWith('\\n')) {
        newLines.push(line);
        continue;
      }
      line = line.replace(/console\.error\(`([^`]+)`\)/, 'errHint(`$1`)');
      replacements++;
      newLines.push(line);
      continue;
    }

    newLines.push(line);
  }

  content = newLines.join('\n');

  // Ensure import exists if we made replacements
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
