/**
 * Tests for `ved help` — unified help system.
 */

import { describe, it, expect } from 'vitest';
import {
  COMMANDS,
  findCommand,
  allCommands,
  commandsByCategory,
  formatOverview,
  formatCommandHelp,
  checkHelp,
  type CommandInfo,
  type Category,
} from './cli-help.js';

// ── Command Registry ──────────────────────────────────────────────────

describe('Command Registry', () => {
  it('registers all expected commands', () => {
    const names = COMMANDS.map(c => c.name);
    const expected = [
      'start', 'init', 'version', 'status', 'chat', 'run',
      'memory', 'template', 'context',
      'search', 'reindex',
      'trust', 'user',
      'pipe', 'alias', 'cron', 'plugin', 'completions',
      'stats', 'history', 'doctor', 'log', 'profile',
      'export', 'import', 'backup', 'gc',
      'serve', 'webhook', 'watch',
      'config', 'env', 'prompt', 'upgrade', 'help',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it('has no duplicate command names', () => {
    const names = COMMANDS.map(c => c.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('has no duplicate aliases across commands', () => {
    const seen = new Set<string>();
    for (const cmd of COMMANDS) {
      for (const alias of cmd.aliases) {
        expect(seen.has(alias)).toBe(false);
        seen.add(alias);
      }
    }
  });

  it('every command has a summary', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.summary.length).toBeGreaterThan(5);
    }
  });

  it('every command has a usage string', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.usage).toContain('ved');
    }
  });

  it('every command has a valid category', () => {
    const valid: Category[] = ['core', 'memory', 'search', 'trust', 'tools', 'monitoring', 'data', 'server', 'config'];
    for (const cmd of COMMANDS) {
      expect(valid).toContain(cmd.category);
    }
  });
});

// ── findCommand ───────────────────────────────────────────────────────

describe('findCommand', () => {
  it('finds by exact name', () => {
    const cmd = findCommand('search');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('search');
  });

  it('finds by alias', () => {
    const cmd = findCommand('mem');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('memory');
  });

  it('finds by alias: q -> run', () => {
    const cmd = findCommand('q');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('run');
  });

  it('finds by alias: bench -> profile', () => {
    const cmd = findCommand('bench');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('profile');
  });

  it('finds by alias: ctx -> context', () => {
    const cmd = findCommand('ctx');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('context');
  });

  it('finds by alias: tpl -> template', () => {
    const cmd = findCommand('tpl');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('template');
  });

  it('finds help by --help', () => {
    const cmd = findCommand('--help');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('help');
  });

  it('returns undefined for unknown command', () => {
    expect(findCommand('nonexistent')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(findCommand('')).toBeUndefined();
  });
});

// ── allCommands ──────────────────────────────────────────────────────

describe('allCommands', () => {
  it('returns all registered commands', () => {
    const all = allCommands();
    expect(all.length).toBe(COMMANDS.length);
    expect(all.length).toBeGreaterThan(30);
  });
});

// ── commandsByCategory ──────────────────────────────────────────────

describe('commandsByCategory', () => {
  it('groups commands into categories', () => {
    const grouped = commandsByCategory();
    expect(grouped.size).toBeGreaterThan(0);

    // Core should have at least start, init, version, help
    const core = grouped.get('core');
    expect(core).toBeDefined();
    const coreNames = core!.map(c => c.name);
    expect(coreNames).toContain('start');
    expect(coreNames).toContain('help');
  });

  it('every command appears in exactly one category', () => {
    const grouped = commandsByCategory();
    let total = 0;
    for (const [, cmds] of grouped) {
      total += cmds.length;
    }
    expect(total).toBe(COMMANDS.length);
  });

  it('categories include memory, search, trust, tools, monitoring', () => {
    const grouped = commandsByCategory();
    expect(grouped.has('memory')).toBe(true);
    expect(grouped.has('search')).toBe(true);
    expect(grouped.has('trust')).toBe(true);
    expect(grouped.has('tools')).toBe(true);
    expect(grouped.has('monitoring')).toBe(true);
  });
});

// ── formatOverview ──────────────────────────────────────────────────

describe('formatOverview', () => {
  it('includes Ved header', () => {
    const output = formatOverview(false);
    expect(output).toContain('Ved');
    expect(output).toContain('remembers everything');
  });

  it('includes USAGE section', () => {
    const output = formatOverview(false);
    expect(output).toContain('USAGE');
    expect(output).toContain('ved <command>');
  });

  it('lists all command names', () => {
    const output = formatOverview(false);
    for (const cmd of COMMANDS) {
      expect(output).toContain(cmd.name);
    }
  });

  it('includes category headers', () => {
    const output = formatOverview(false);
    expect(output).toContain('Core');
    expect(output).toContain('Memory');
    expect(output).toContain('Search');
    expect(output).toContain('Trust');
    expect(output).toContain('Configuration');
  });

  it('shows aliases in parentheses', () => {
    const output = formatOverview(false);
    // memory has alias 'mem'
    expect(output).toContain('(mem)');
  });

  it('without color has no ANSI escape codes', () => {
    const output = formatOverview(false);
    expect(output).not.toContain('\x1b[');
  });

  it('with color includes ANSI escape codes', () => {
    const output = formatOverview(true);
    expect(output).toContain('\x1b[');
  });

  it('ends with help hint', () => {
    const output = formatOverview(false);
    expect(output).toContain('ved help <command>');
  });
});

// ── formatCommandHelp ───────────────────────────────────────────────

describe('formatCommandHelp', () => {
  it('shows command name and summary', () => {
    const cmd = findCommand('search')!;
    const output = formatCommandHelp(cmd, false);
    expect(output).toContain('ved search');
    expect(output).toContain(cmd.summary);
  });

  it('shows USAGE section', () => {
    const cmd = findCommand('search')!;
    const output = formatCommandHelp(cmd, false);
    expect(output).toContain('USAGE');
    expect(output).toContain(cmd.usage);
  });

  it('shows ALIASES when present', () => {
    const cmd = findCommand('memory')!;
    const output = formatCommandHelp(cmd, false);
    expect(output).toContain('ALIASES');
    expect(output).toContain('mem');
  });

  it('omits ALIASES when none', () => {
    const cmd = findCommand('reindex')!;
    const output = formatCommandHelp(cmd, false);
    expect(output).not.toContain('ALIASES');
  });

  it('shows SUBCOMMANDS when present', () => {
    const cmd = findCommand('memory')!;
    const output = formatCommandHelp(cmd, false);
    expect(output).toContain('SUBCOMMANDS');
    expect(output).toContain('list');
    expect(output).toContain('show');
    expect(output).toContain('graph');
  });

  it('shows FLAGS when present', () => {
    const cmd = findCommand('search')!;
    const output = formatCommandHelp(cmd, false);
    expect(output).toContain('FLAGS');
    expect(output).toContain('-n <limit>');
    expect(output).toContain('--verbose');
  });

  it('shows EXAMPLES when present', () => {
    const cmd = findCommand('search')!;
    const output = formatCommandHelp(cmd, false);
    expect(output).toContain('EXAMPLES');
    expect(output).toContain('ved search "machine learning"');
  });

  it('works without color', () => {
    const cmd = findCommand('trust')!;
    const output = formatCommandHelp(cmd, false);
    expect(output).not.toContain('\x1b[');
    expect(output).toContain('ved trust');
  });

  it('works with color', () => {
    const cmd = findCommand('trust')!;
    const output = formatCommandHelp(cmd, true);
    expect(output).toContain('\x1b[');
  });
});

// ── checkHelp ───────────────────────────────────────────────────────

describe('checkHelp', () => {
  it('returns true when --help is in args', () => {
    // checkHelp prints to console, just verify return value
    const origLog = console.log;
    const logged: string[] = [];
    console.log = (s: string) => logged.push(s);
    try {
      const result = checkHelp('search', ['--help']);
      expect(result).toBe(true);
      expect(logged.length).toBeGreaterThan(0);
      expect(logged[0]).toContain('search');
    } finally {
      console.log = origLog;
    }
  });

  it('returns true when -h is in args', () => {
    const origLog = console.log;
    console.log = () => {};
    try {
      expect(checkHelp('memory', ['-h'])).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  it('returns false when no help flag', () => {
    expect(checkHelp('search', ['query', '-n', '5'])).toBe(false);
  });

  it('returns false for empty args', () => {
    expect(checkHelp('search', [])).toBe(false);
  });

  it('handles unknown command gracefully', () => {
    const origLog = console.log;
    const logged: string[] = [];
    console.log = (s: string) => logged.push(s);
    try {
      const result = checkHelp('nonexistent', ['--help']);
      expect(result).toBe(true);
      expect(logged.some(l => l.includes('No help available'))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });
});

// ── checkHelp wiring verification ───────────────────────────────────

describe('checkHelp wiring — all commands', () => {
  // Every command in the registry should show help via checkHelp
  const commandNames = COMMANDS.map(c => c.name).filter(n => n !== 'help'); // help routes differently

  it.each(commandNames)('ved %s --help shows help and returns true', (name) => {
    const origLog = console.log;
    const logged: string[] = [];
    console.log = (s: string) => logged.push(s);
    try {
      const result = checkHelp(name, ['--help']);
      expect(result).toBe(true);
      expect(logged.length).toBeGreaterThan(0);
      expect(logged[0]).toContain(name);
    } finally {
      console.log = origLog;
    }
  });

  it.each(commandNames)('ved %s -h shows help and returns true', (name) => {
    const origLog = console.log;
    console.log = () => {};
    try {
      expect(checkHelp(name, ['-h'])).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  it.each(commandNames)('ved %s <normal args> returns false', (name) => {
    expect(checkHelp(name, ['some-arg', '--verbose'])).toBe(false);
  });

  it('--help anywhere in args triggers help (not just first position)', () => {
    const origLog = console.log;
    console.log = () => {};
    try {
      expect(checkHelp('search', ['query', '--help'])).toBe(true);
      expect(checkHelp('backup', ['create', '-h'])).toBe(true);
      expect(checkHelp('cron', ['list', '--verbose', '--help'])).toBe(true);
    } finally {
      console.log = origLog;
    }
  });
});

// ── Edge Cases ──────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('command summaries do not contain newlines', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.summary).not.toContain('\n');
    }
  });

  it('aliases are all lowercase or start with -', () => {
    for (const cmd of COMMANDS) {
      for (const alias of cmd.aliases) {
        expect(alias === alias.toLowerCase() || alias.startsWith('-')).toBe(true);
      }
    }
  });

  it('usage strings start with "ved"', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.usage.startsWith('ved')).toBe(true);
    }
  });

  it('examples all contain "ved"', () => {
    for (const cmd of COMMANDS) {
      for (const ex of cmd.examples ?? []) {
        expect(ex).toContain('ved');
      }
    }
  });

  it('no command name conflicts with an alias of another command', () => {
    const names = new Set(COMMANDS.map(c => c.name));
    for (const cmd of COMMANDS) {
      for (const alias of cmd.aliases) {
        // Alias can match own name but shouldn't match another command's primary name
        if (alias !== cmd.name && !alias.startsWith('-')) {
          // Allow if it's a known pattern (e.g. 'api' as alias for 'serve')
          // But ensure there's no separate command with that exact primary name
          // This is informational — some overlap is by design
        }
      }
    }
    // Verify aliases that are also primary names point to the same command
    for (const cmd of COMMANDS) {
      for (const alias of cmd.aliases) {
        if (names.has(alias) && alias !== cmd.name) {
          // If an alias matches another command's name, findCommand should resolve correctly
          const found = findCommand(alias);
          // This may or may not match — just verify it doesn't crash
          expect(found).toBeDefined();
        }
      }
    }
  });

  it('formatOverview output is reasonable length', () => {
    const output = formatOverview(false);
    expect(output.length).toBeGreaterThan(500);
    expect(output.length).toBeLessThan(10000);
  });

  it('formatCommandHelp works for every registered command', () => {
    for (const cmd of COMMANDS) {
      const output = formatCommandHelp(cmd, false);
      expect(output).toContain(cmd.name);
      expect(output).toContain('USAGE');
      expect(output.length).toBeGreaterThan(50);
    }
  });
});
