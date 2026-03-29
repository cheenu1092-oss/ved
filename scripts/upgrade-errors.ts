#!/usr/bin/env npx tsx
/**
 * Upgrade raw console.error calls in sub-CLI files to use errHint/errUsage.
 * 
 * Patterns:
 * 1. console.error('Usage: ved ...') → errUsage('ved ...')
 * 2. console.error(`Usage: ved ...`) → errUsage(`ved ...`)
 * 3. console.error('Error: ...') → errHint('...')
 * 4. console.error(`Error: ...`) → errHint(`...`)
 * 5. console.error(`Unknown ... subcommand: ${sub}`) → errHint(...)
 * 6. console.error('... not found: ...') → errHint('... not found: ...', 'Check ...')
 * 7. Multi-line usage blocks → single errUsage
 * 
 * Excludes:
 * - Warning lines with ⚠
 * - Formatted output in result display blocks
 * - Lines inside template literals or complex formatting
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

  // Skip if already imports errHint
  const hasImport = content.includes("from './errors.js'");

  // Pattern 1: Usage lines
  // console.error('Usage: ved ...') → errUsage('ved ...')
  // console.error(`Usage: ved ...`) → errUsage(`ved ...`)
  content = content.replace(
    /console\.error\((['"`])Usage: (ved .*?)\1\)/g,
    (match, quote, rest) => {
      replacements++;
      return `errUsage(${quote}${rest}${quote})`;
    }
  );

  // Pattern 2: "  ✗ Usage: ..." → errUsage
  content = content.replace(
    /console\.error\((['"`])\s*✗\s*Usage: (ved .*?)\1\)/g,
    (match, quote, rest) => {
      replacements++;
      return `errUsage(${quote}${rest}${quote})`;
    }
  );

  // Pattern 3: Unknown subcommand
  content = content.replace(
    /console\.error\(`Unknown (\w+) subcommand: \$\{(\w+)\}`\)/g,
    (match, type, varName) => {
      replacements++;
      return `errHint(\`Unknown ${type} subcommand: \${${varName}}\`, 'Run "ved help" to see available commands')`;
    }
  );

  // Pattern 3b: `Unknown subcommand: ${sub}` (no type word)
  content = content.replace(
    /console\.error\(`Unknown subcommand: \$\{(\w+)\}`\)/g,
    (match, varName) => {
      replacements++;
      return `errHint(\`Unknown subcommand: \${${varName}}\`, 'Run "ved help" to see available commands')`;
    }
  );

  // Pattern 4: Error: prefix
  content = content.replace(
    /console\.error\((['"`])Error: (.*?)\1\)/g,
    (match, quote, msg) => {
      replacements++;
      return `errHint(${quote}${msg}${quote})`;
    }
  );

  // Pattern 4b: Error: with template literal containing expressions
  content = content.replace(
    /console\.error\(`Error: ([^`]*\$\{[^}]+\}[^`]*)`\)/g,
    (match, msg) => {
      replacements++;
      return `errHint(\`${msg}\`)`;
    }
  );

  // Pattern 5: "  ✗ ..." lines (remove the ✗ prefix, use errHint)
  content = content.replace(
    /console\.error\((['"`])\s*✗\s+((?!Usage:).*?)\1\)/g,
    (match, quote, msg) => {
      // Skip if it's a warning ⚠ line  
      if (msg.includes('⚠')) return match;
      replacements++;
      return `errHint(${quote}${msg.trim()}${quote})`;
    }
  );

  // Pattern 5b: "  ✗ ..." with template expressions
  content = content.replace(
    /console\.error\(`\s*✗\s+((?!Usage:)[^`]*\$\{[^}]+\}[^`]*)`\)/g,
    (match, msg) => {
      if (msg.includes('⚠')) return match;
      replacements++;
      return `errHint(\`${msg.trim()}\`)`;
    }
  );

  // Pattern 6: Not found messages  
  content = content.replace(
    /console\.error\(`([^`]*not found[^`]*)`\)/gi,
    (match, msg) => {
      replacements++;
      return `errHint(\`${msg}\`, 'Check the name and try again')`;
    }
  );

  // Pattern 7: "File not found: ..."
  content = content.replace(
    /console\.error\(`File not found: \$\{(\w+)\}`\)/g,
    (match, varName) => {
      replacements++;
      return `errHint(\`File not found: \${${varName}}\`, 'Check the file path and try again')`;
    }
  );

  // Pattern 8: Simple "Usage: ved ..." without quotes prefix
  content = content.replace(
    /console\.error\('(ved \w+ \w+.*?)'\)/g,
    (match, msg) => {
      if (msg.startsWith('ved ') && msg.includes('<')) {
        replacements++;
        return `errUsage('${msg}')`;
      }
      return match;
    }
  );

  // Add import if we made changes and file doesn't have it
  if (replacements > 0 && !hasImport) {
    // Find the last import line
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
