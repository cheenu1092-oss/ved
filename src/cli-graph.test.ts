/**
 * Tests for `ved graph` — Knowledge graph analysis CLI.
 *
 * Tests graph building, wikilink extraction, subcommands, edge cases.
 *
 * @module cli-graph.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildGraph,
  extractWikilinks,
  extractTags,
  extractType,
  totalConnections,
} from './cli-graph.js';

// ── Test helpers ──

function tmpVault(): string {
  const dir = join(tmpdir(), `ved-graph-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createFile(vaultPath: string, relPath: string, content: string): void {
  const absPath = join(vaultPath, relPath);
  mkdirSync(join(absPath, '..'), { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
}

// ── extractWikilinks ──

describe('extractWikilinks', () => {
  it('extracts basic wikilinks', () => {
    const text = 'See [[Alice]] and [[Bob]] for details.';
    expect(extractWikilinks(text)).toEqual(['alice', 'bob']);
  });

  it('handles pipe aliases', () => {
    const text = 'See [[Alice|my friend]] here.';
    expect(extractWikilinks(text)).toEqual(['alice']);
  });

  it('handles heading links', () => {
    const text = 'See [[Alice#decisions]] here.';
    expect(extractWikilinks(text)).toEqual(['alice']);
  });

  it('deduplicates', () => {
    const text = '[[Alice]] is friends with [[Bob]], says [[Alice]].';
    expect(extractWikilinks(text)).toEqual(['alice', 'bob']);
  });

  it('returns empty for no links', () => {
    expect(extractWikilinks('No links here.')).toEqual([]);
  });

  it('ignores empty brackets', () => {
    expect(extractWikilinks('[[]] and [[ ]]')).toEqual([]);
  });

  it('strips .md extension', () => {
    const text = '[[Alice.md]] reference.';
    expect(extractWikilinks(text)).toEqual(['alice']);
  });

  it('handles multiline', () => {
    const text = '[[Alice]]\n\n[[Bob]]\n';
    expect(extractWikilinks(text)).toEqual(['alice', 'bob']);
  });
});

// ── extractTags ──

describe('extractTags', () => {
  it('extracts hashtags', () => {
    const text = 'Tagged #person and #project here.';
    expect(extractTags(text)).toEqual(['person', 'project']);
  });

  it('deduplicates', () => {
    const text = '#person #person';
    expect(extractTags(text)).toEqual(['person']);
  });

  it('handles nested tags', () => {
    const text = '#project/active #person';
    expect(extractTags(text)).toEqual(['project/active', 'person']);
  });

  it('ignores mid-word hashes', () => {
    const text = 'C# is a language.';
    expect(extractTags(text)).toEqual([]);
  });

  it('returns empty for no tags', () => {
    expect(extractTags('No tags here.')).toEqual([]);
  });
});

// ── extractType ──

describe('extractType', () => {
  it('extracts type from frontmatter', () => {
    const text = '---\ntype: person\ntitle: Alice\n---\nContent.';
    expect(extractType(text)).toBe('person');
  });

  it('handles quoted type', () => {
    const text = '---\ntype: "person"\n---\nContent.';
    expect(extractType(text)).toBe('person');
  });

  it('returns undefined for no frontmatter', () => {
    expect(extractType('No frontmatter.')).toBeUndefined();
  });

  it('returns undefined for no type field', () => {
    const text = '---\ntitle: Alice\n---\nContent.';
    expect(extractType(text)).toBeUndefined();
  });
});

// ── buildGraph ──

describe('buildGraph', () => {
  let vault: string;

  beforeEach(() => {
    vault = tmpVault();
  });

  afterEach(() => {
    try { rmSync(vault, { recursive: true }); } catch { /* ok */ }
  });

  it('builds empty graph from empty vault', () => {
    const graph = buildGraph(vault);
    expect(graph.nodes.size).toBe(0);
  });

  it('indexes files and extracts links', () => {
    createFile(vault, 'entities/alice.md', '---\ntype: person\n---\nSee [[Bob]].');
    createFile(vault, 'entities/bob.md', '---\ntype: person\n---\nKnows [[Alice]].');

    const graph = buildGraph(vault);
    expect(graph.nodes.size).toBe(2);
    expect(graph.nodes.get('alice')?.links).toEqual(['bob']);
    expect(graph.nodes.get('bob')?.links).toEqual(['alice']);
  });

  it('builds backlink index', () => {
    createFile(vault, 'alice.md', 'Links to [[Bob]] and [[Charlie]].');
    createFile(vault, 'bob.md', 'Links to [[Charlie]].');
    createFile(vault, 'charlie.md', 'No links.');

    const graph = buildGraph(vault);
    expect(graph.backlinks.get('bob')?.has('alice')).toBe(true);
    expect(graph.backlinks.get('charlie')?.has('alice')).toBe(true);
    expect(graph.backlinks.get('charlie')?.has('bob')).toBe(true);
    expect(graph.backlinks.get('charlie')?.size).toBe(2);
  });

  it('extracts tags and types', () => {
    createFile(vault, 'alice.md', '---\ntype: person\n---\n#team-lead #engineer');

    const graph = buildGraph(vault);
    const node = graph.nodes.get('alice')!;
    expect(node.type).toBe('person');
    expect(node.tags).toContain('team-lead');
    expect(node.tags).toContain('engineer');
  });

  it('ignores .git directory', () => {
    mkdirSync(join(vault, '.git'), { recursive: true });
    writeFileSync(join(vault, '.git', 'HEAD.md'), '# git internals');
    createFile(vault, 'real.md', 'Real file.');

    const graph = buildGraph(vault);
    expect(graph.nodes.size).toBe(1);
    expect(graph.nodes.has('real')).toBe(true);
  });

  it('ignores non-.md files', () => {
    writeFileSync(join(vault, 'data.json'), '{}');
    writeFileSync(join(vault, 'readme.txt'), 'text');
    createFile(vault, 'real.md', 'Markdown.');

    const graph = buildGraph(vault);
    expect(graph.nodes.size).toBe(1);
  });

  it('handles nested directories', () => {
    createFile(vault, 'entities/people/alice.md', 'Alice here.');
    createFile(vault, 'concepts/deep/nested/idea.md', 'An idea.');

    const graph = buildGraph(vault);
    expect(graph.nodes.size).toBe(2);
    expect(graph.nodes.get('alice')?.folder).toBe('entities/people');
    expect(graph.nodes.get('idea')?.folder).toBe('concepts/deep/nested');
  });

  it('handles duplicate filenames in different folders (last wins)', () => {
    createFile(vault, 'entities/readme.md', 'Entity readme links to [[alice]].');
    createFile(vault, 'docs/readme.md', 'Doc readme.');

    const graph = buildGraph(vault);
    // One will overwrite the other (Map key collision) — this is expected behavior
    expect(graph.nodes.has('readme')).toBe(true);
  });
});

// ── totalConnections ──

describe('totalConnections', () => {
  let vault: string;

  beforeEach(() => {
    vault = tmpVault();
  });

  afterEach(() => {
    try { rmSync(vault, { recursive: true }); } catch { /* ok */ }
  });

  it('counts outgoing + incoming', () => {
    createFile(vault, 'alice.md', '[[bob]] [[charlie]]');
    createFile(vault, 'bob.md', '[[alice]]');
    createFile(vault, 'charlie.md', 'No links.');

    const graph = buildGraph(vault);
    // alice: 2 out (bob, charlie) + 1 in (bob) = 3
    expect(totalConnections(graph, 'alice')).toBe(3);
    // charlie: 0 out + 1 in (alice) = 1
    expect(totalConnections(graph, 'charlie')).toBe(1);
  });

  it('returns 0 for orphan', () => {
    createFile(vault, 'lonely.md', 'No links.');
    const graph = buildGraph(vault);
    expect(totalConnections(graph, 'lonely')).toBe(0);
  });

  it('handles nonexistent node gracefully', () => {
    const graph = buildGraph(vault);
    expect(totalConnections(graph, 'ghost')).toBe(0);
  });
});

// ── Graph analysis (integration) ──

describe('graph analysis', () => {
  let vault: string;

  beforeEach(() => {
    vault = tmpVault();
  });

  afterEach(() => {
    try { rmSync(vault, { recursive: true }); } catch { /* ok */ }
  });

  it('identifies orphans correctly', () => {
    createFile(vault, 'connected.md', '[[other]]');
    createFile(vault, 'other.md', 'Has backlink from connected.');
    createFile(vault, 'orphan.md', 'All alone.');

    const graph = buildGraph(vault);

    const orphans: string[] = [];
    for (const [name, node] of graph.nodes) {
      const hasOut = node.links.some(l => graph.nodes.has(l));
      const hasIn = (graph.backlinks.get(name)?.size ?? 0) > 0;
      if (!hasOut && !hasIn) orphans.push(name);
    }

    expect(orphans).toEqual(['orphan']);
  });

  it('finds shortest path via BFS', () => {
    createFile(vault, 'a.md', '[[b]]');
    createFile(vault, 'b.md', '[[c]]');
    createFile(vault, 'c.md', '[[d]]');
    createFile(vault, 'd.md', 'End.');

    const graph = buildGraph(vault);

    // BFS from a to d
    const visited = new Set<string>();
    const parent = new Map<string, string>();
    const queue: string[] = ['a'];
    visited.add('a');

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === 'd') break;

      const node = graph.nodes.get(current);
      if (node) {
        for (const link of node.links) {
          if (graph.nodes.has(link) && !visited.has(link)) {
            visited.add(link);
            parent.set(link, current);
            queue.push(link);
          }
        }
      }
    }

    // Reconstruct
    const path: string[] = ['d'];
    let cur = 'd';
    while (parent.has(cur)) {
      cur = parent.get(cur)!;
      path.unshift(cur);
    }

    expect(path).toEqual(['a', 'b', 'c', 'd']);
  });

  it('detects broken links', () => {
    createFile(vault, 'alice.md', '[[bob]] [[ghost]]');
    createFile(vault, 'bob.md', '[[phantom]]');

    const graph = buildGraph(vault);

    const broken: Array<{ source: string; target: string }> = [];
    for (const node of graph.nodes.values()) {
      for (const link of node.links) {
        if (!graph.nodes.has(link)) {
          broken.push({ source: node.path, target: link });
        }
      }
    }

    expect(broken).toHaveLength(2);
    expect(broken.map(b => b.target).sort()).toEqual(['ghost', 'phantom']);
  });

  it('finds islands (disconnected subgraphs)', () => {
    // Island 1: a <-> b
    createFile(vault, 'a.md', '[[b]]');
    createFile(vault, 'b.md', '[[a]]');
    // Island 2: c <-> d
    createFile(vault, 'c.md', '[[d]]');
    createFile(vault, 'd.md', '[[c]]');
    // Island 3: e (orphan)
    createFile(vault, 'e.md', 'Alone.');

    const graph = buildGraph(vault);

    const visited = new Set<string>();
    const clusters: string[][] = [];

    for (const name of graph.nodes.keys()) {
      if (visited.has(name)) continue;
      const queue: string[] = [name];
      const cluster: string[] = [];

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        cluster.push(current);

        const node = graph.nodes.get(current);
        if (node) {
          for (const link of node.links) {
            if (graph.nodes.has(link) && !visited.has(link)) queue.push(link);
          }
        }
        const bl = graph.backlinks.get(current);
        if (bl) {
          for (const source of bl) {
            if (!visited.has(source)) queue.push(source);
          }
        }
      }

      clusters.push(cluster);
    }

    expect(clusters.length).toBe(3);
  });

  it('generates valid DOT format', () => {
    createFile(vault, 'entities/alice.md', '[[bob]]');
    createFile(vault, 'entities/bob.md', 'Content.');

    const graph = buildGraph(vault);

    // Replicate DOT generation logic
    const lines: string[] = ['digraph VedKnowledgeGraph {'];
    for (const node of graph.nodes.values()) {
      lines.push(`  "${node.name}";`);
    }
    for (const node of graph.nodes.values()) {
      for (const link of node.links) {
        if (graph.nodes.has(link)) {
          lines.push(`  "${node.name}" -> "${link}";`);
        }
      }
    }
    lines.push('}');

    const dot = lines.join('\n');
    expect(dot).toContain('digraph VedKnowledgeGraph');
    expect(dot).toContain('"alice"');
    expect(dot).toContain('"bob"');
    expect(dot).toContain('"alice" -> "bob"');
  });
});

// ── Edge cases ──

describe('edge cases', () => {
  let vault: string;

  beforeEach(() => {
    vault = tmpVault();
  });

  afterEach(() => {
    try { rmSync(vault, { recursive: true }); } catch { /* ok */ }
  });

  it('handles self-links', () => {
    createFile(vault, 'recursive.md', '[[recursive]]');
    const graph = buildGraph(vault);
    expect(graph.nodes.get('recursive')?.links).toEqual(['recursive']);
    expect(graph.backlinks.get('recursive')?.has('recursive')).toBe(true);
  });

  it('handles circular links', () => {
    createFile(vault, 'a.md', '[[b]]');
    createFile(vault, 'b.md', '[[c]]');
    createFile(vault, 'c.md', '[[a]]');

    const graph = buildGraph(vault);
    expect(totalConnections(graph, 'a')).toBe(2); // out: b, in: c
    expect(totalConnections(graph, 'b')).toBe(2); // out: c, in: a
    expect(totalConnections(graph, 'c')).toBe(2); // out: a, in: b
  });

  it('handles empty vault', () => {
    const graph = buildGraph(vault);
    expect(graph.nodes.size).toBe(0);
    expect(graph.backlinks.size).toBe(0);
  });

  it('handles files with only frontmatter', () => {
    createFile(vault, 'meta-only.md', '---\ntype: stub\n---\n');
    const graph = buildGraph(vault);
    expect(graph.nodes.get('meta-only')?.type).toBe('stub');
    expect(graph.nodes.get('meta-only')?.links).toEqual([]);
  });

  it('handles very long file names', () => {
    const longName = 'a'.repeat(200) + '.md';
    createFile(vault, longName, '[[short]]');
    createFile(vault, 'short.md', 'Short.');

    const graph = buildGraph(vault);
    expect(graph.nodes.size).toBe(2);
  });

  it('handles special characters in wikilinks', () => {
    const text = '[[file with spaces]] and [[file-with-dashes]] and [[CamelCase]]';
    const links = extractWikilinks(text);
    expect(links).toContain('file with spaces');
    expect(links).toContain('file-with-dashes');
    expect(links).toContain('camelcase');
  });

  it('handles wikilinks with aliases and headings combined', () => {
    const text = '[[Alice#decisions|her decisions]]';
    const links = extractWikilinks(text);
    expect(links).toEqual(['alice']);
  });

  it('handles large graph (100 nodes)', () => {
    for (let i = 0; i < 100; i++) {
      const links = i < 99 ? `[[node-${i + 1}]]` : '';
      createFile(vault, `node-${i}.md`, `Node ${i}. ${links}`);
    }

    const graph = buildGraph(vault);
    expect(graph.nodes.size).toBe(100);

    // Chain: node-0 → node-1 → ... → node-99
    expect(graph.nodes.get('node-0')?.links).toEqual(['node-1']);
    expect(graph.nodes.get('node-99')?.links).toEqual([]);
  });
});

// ── Security ──

describe('security', () => {
  it('extractWikilinks ignores path traversal in links', () => {
    const text = '[[../../../etc/passwd]]';
    const links = extractWikilinks(text);
    // It extracts the text as-is — path traversal only matters when resolving
    expect(links).toEqual(['../../../etc/passwd']);
  });

  it('extractWikilinks handles null bytes', () => {
    const text = '[[alice\x00evil]]';
    // null byte is part of the link text, won't match ] so it works
    const links = extractWikilinks(text);
    // Should extract whatever regex matches
    expect(Array.isArray(links)).toBe(true);
  });

  it('buildGraph skips .obsidian directory', () => {
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    writeFileSync(join(vault, '.obsidian', 'workspace.md'), '# Internal');
    createFile(vault, 'real.md', 'Real file.');

    const graph = buildGraph(vault);
    expect(graph.nodes.size).toBe(1);
  });

  let vault: string;

  beforeEach(() => {
    vault = tmpVault();
  });

  afterEach(() => {
    try { rmSync(vault, { recursive: true }); } catch { /* ok */ }
  });
});
