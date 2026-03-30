/**
 * Tests for Session 104 — P5 Polish Phase 3.
 *
 * - Fuzzy command matching (suggestCommands)
 * - Enhanced version (--verbose)
 * - Quickstart command
 */

import { describe, it, expect } from 'vitest';
import { suggestCommands } from './cli-help.js';

describe('suggestCommands', () => {
  it('suggests "search" for "serch"', () => {
    const suggestions = suggestCommands('serch');
    expect(suggestions).toContain('search');
  });

  it('suggests "doctor" for "docter"', () => {
    const suggestions = suggestCommands('docter');
    expect(suggestions).toContain('doctor');
  });

  it('suggests "status" for "statis"', () => {
    const suggestions = suggestCommands('statis');
    expect(suggestions).toContain('status');
    expect(suggestions).toContain('stats');
  });

  it('suggests "backup" for "bacup"', () => {
    const suggestions = suggestCommands('bacup');
    expect(suggestions).toContain('backup');
  });

  it('suggests "memory" for "memry"', () => {
    const suggestions = suggestCommands('memry');
    expect(suggestions).toContain('memory');
  });

  it('suggests "reindex" for "reindx"', () => {
    const suggestions = suggestCommands('reindx');
    expect(suggestions).toContain('reindex');
  });

  it('returns empty for completely unrelated input', () => {
    const suggestions = suggestCommands('xyzzzzzzzzzz');
    expect(suggestions).toEqual([]);
  });

  it('does not suggest the exact command itself', () => {
    const suggestions = suggestCommands('search');
    // Exact match (distance 0) is excluded, but similar commands may appear
    expect(suggestions.includes('search')).toBe(false);
  });

  it('respects maxResults', () => {
    const suggestions = suggestCommands('s', 2);
    expect(suggestions.length).toBeLessThanOrEqual(2);
  });

  it('finds prefix matches', () => {
    const suggestions = suggestCommands('re', 10, 5);
    expect(suggestions).toContain('reindex');
    expect(suggestions).toContain('replay');
  });

  it('is case-insensitive', () => {
    // "DOCTOR" → lowercase "doctor" has distance 0 (exact), so not suggested.
    // But "DOCTER" (typo) should suggest "doctor"
    const suggestions = suggestCommands('DOCTER');
    expect(suggestions).toContain('doctor');
  });

  it('suggests "init" for "int"', () => {
    const suggestions = suggestCommands('int');
    expect(suggestions).toContain('init');
  });

  it('suggests "config" for "confg"', () => {
    const suggestions = suggestCommands('confg');
    expect(suggestions).toContain('config');
  });

  it('suggests "snapshot" for "snpashot"', () => {
    const suggestions = suggestCommands('snpashot');
    expect(suggestions).toContain('snapshot');
  });

  it('suggests "export" for "exort"', () => {
    const suggestions = suggestCommands('exort');
    expect(suggestions).toContain('export');
  });

  it('handles single character input without crash', () => {
    const suggestions = suggestCommands('z');
    expect(Array.isArray(suggestions)).toBe(true);
  });

  it('handles empty string', () => {
    const suggestions = suggestCommands('');
    // All commands are prefix matches of empty string, so we get results
    expect(Array.isArray(suggestions)).toBe(true);
  });

  it('suggests "help" for "hlep"', () => {
    const suggestions = suggestCommands('hlep');
    expect(suggestions).toContain('help');
  });

  it('suggests "chat" for "caht"', () => {
    const suggestions = suggestCommands('caht');
    expect(suggestions).toContain('chat');
  });

  it('respects maxDistance parameter', () => {
    // "abcdefgh" is very far from any command
    const suggestions = suggestCommands('abcdefgh', 3, 1);
    expect(suggestions).toEqual([]);
  });

  it('returns at most maxResults suggestions', () => {
    const suggestions = suggestCommands('s', 1);
    expect(suggestions.length).toBeLessThanOrEqual(1);
  });
});
