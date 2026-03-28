/**
 * Completions auto-installer for Ved.
 *
 * Detects the current shell from $SHELL and installs completions
 * to the appropriate location. Idempotent — safe to run multiple times.
 */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Sentinel inserted into shell config files to detect existing installations */
export const COMPLETIONS_MARKER = '# ved completions — auto-installed';

export interface InstallResult {
  /** Which shell was targeted */
  shell: 'bash' | 'zsh' | 'fish';
  /** Files that were written or modified */
  filesWritten: string[];
  /** Whether installation was skipped because completions were already present */
  skipped: boolean;
  /** Human-readable messages to print */
  messages: string[];
}

/**
 * Auto-install completions for the given shell and completion script content.
 *
 * @param shell - Target shell ('bash', 'zsh', 'fish')
 * @param script - The completion script text to install
 * @param home - Override home directory (for testing)
 */
export function installCompletions(
  shell: 'bash' | 'zsh' | 'fish',
  script: string,
  home: string = homedir(),
): InstallResult {
  const result: InstallResult = {
    shell,
    filesWritten: [],
    skipped: false,
    messages: [],
  };

  if (shell === 'bash') {
    const rcPath = join(home, '.bashrc');
    let existing = '';
    try { existing = readFileSync(rcPath, 'utf8'); } catch { /* new file */ }

    if (existing.includes(COMPLETIONS_MARKER)) {
      result.skipped = true;
      result.messages.push(`✓ bash completions already installed in ${rcPath} — skipping.`);
      return result;
    }

    appendFileSync(rcPath, `\n${COMPLETIONS_MARKER}\n${script}\n`);
    result.filesWritten.push(rcPath);
    result.messages.push(`✅ Installed bash completions → ${rcPath}`);
    result.messages.push('   Reload with: source ~/.bashrc');

  } else if (shell === 'zsh') {
    const zfuncDir = join(home, '.zfunc');
    const compFile = join(zfuncDir, '_ved');
    const zshrcPath = join(home, '.zshrc');

    // Write completion file (always overwrite to keep it fresh)
    mkdirSync(zfuncDir, { recursive: true });
    writeFileSync(compFile, script, 'utf8');
    result.filesWritten.push(compFile);
    result.messages.push(`✅ Wrote zsh completions → ${compFile}`);

    // Ensure fpath includes ~/.zfunc in ~/.zshrc (idempotent)
    let zshrc = '';
    try { zshrc = readFileSync(zshrcPath, 'utf8'); } catch { /* new file */ }

    if (zshrc.includes(COMPLETIONS_MARKER)) {
      result.messages.push(`✓ ~/.zshrc already has ved fpath entry — skipping.`);
    } else {
      const fpathEntry = `\n${COMPLETIONS_MARKER}\nfpath=(~/.zfunc $fpath)\nautoload -Uz compinit && compinit\n`;
      appendFileSync(zshrcPath, fpathEntry);
      result.filesWritten.push(zshrcPath);
      result.messages.push(`✅ Added fpath entry to ${zshrcPath}`);
    }
    result.messages.push('   Reload with: exec zsh');

  } else if (shell === 'fish') {
    const fishDir = join(home, '.config', 'fish', 'completions');
    const compFile = join(fishDir, 'ved.fish');

    let existing = '';
    try { existing = readFileSync(compFile, 'utf8'); } catch { /* new file */ }

    if (existing.includes(COMPLETIONS_MARKER)) {
      result.skipped = true;
      result.messages.push(`✓ fish completions already installed in ${compFile} — skipping.`);
      return result;
    }

    mkdirSync(fishDir, { recursive: true });
    writeFileSync(compFile, `${COMPLETIONS_MARKER}\n${script}`, 'utf8');
    result.filesWritten.push(compFile);
    result.messages.push(`✅ Installed fish completions → ${compFile}`);
    result.messages.push('   Active immediately in new fish sessions.');
  }

  return result;
}

/**
 * Detect the shell from the $SHELL environment variable.
 * Returns 'bash' | 'zsh' | 'fish', or null if not detected/supported.
 */
export function detectShell(): 'bash' | 'zsh' | 'fish' | null {
  const shellBin = process.env.SHELL ?? '';
  const name = shellBin.split('/').pop() ?? '';
  if (name === 'bash' || name === 'zsh' || name === 'fish') return name;
  return null;
}
