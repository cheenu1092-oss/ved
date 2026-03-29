/**
 * `ved graph` — Knowledge graph analysis and visualization.
 *
 * Analyzes the Obsidian vault's wikilink structure to find orphans,
 * hubs, clusters, paths, and generate visual maps. Because Ved's memory
 * IS an Obsidian vault, the graph IS the agent's knowledge structure.
 *
 * Subcommands:
 *   ved graph                      — Overview: node/edge counts, density
 *   ved graph hubs [--limit N]     — Most-connected entities (by total links)
 *   ved graph orphans              — Files with no links in or out
 *   ved graph islands              — Disconnected subgraphs (clusters)
 *   ved graph path <a> <b>         — Shortest path between two entities
 *   ved graph neighbors <entity>   — Direct connections (in + out)
 *   ved graph broken               — Wikilinks pointing to nonexistent files
 *   ved graph dot [--output file]  — Export graph as Graphviz DOT format
 *   ved graph summary              — Per-folder breakdown with link stats
 *
 * Aliases: ved links, ved kg
 *
 * @module cli-graph
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, basename, dirname, extname } from 'node:path';
import { loadConfig } from './core/config.js';
import { errHint, errUsage } from './errors.js';

// ── ANSI ──

const C = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[2m',
  red: '\x1B[31m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  blue: '\x1B[34m',
  magenta: '\x1B[35m',
  cyan: '\x1B[36m',
};

// ── Arg parsing ──

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else if (args[i].startsWith('-') && args[i].length === 2) {
      const key = args[i].slice(1);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { positional, flags };
}

// ── Vault graph primitives ──

interface VaultNode {
  path: string;            // relative path in vault
  name: string;            // filename without .md
  folder: string;          // parent directory
  links: string[];         // outgoing wikilink targets (lowercased, no .md)
  tags: string[];          // #tags from content
  type?: string;           // frontmatter type field
}

interface VaultGraph {
  nodes: Map<string, VaultNode>;          // name (lowercased) → node
  pathToName: Map<string, string>;        // relPath → lowercased name
  backlinks: Map<string, Set<string>>;    // target name → set of source names
}

/** Walk directory recursively, returning .md file paths. */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.obsidian') continue;
        results.push(...walkDir(full));
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        results.push(full);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

/** Extract [[wikilinks]] from markdown text. */
function extractWikilinks(text: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]|#]+)(?:[|#][^\]]*?)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const target = match[1].trim().toLowerCase().replace(/\.md$/, '');
    if (target.length > 0) links.push(target);
  }
  return [...new Set(links)];
}

/** Extract #tags from markdown text. */
function extractTags(text: string): string[] {
  const tags: string[] = [];
  const regex = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    tags.push(match[1].toLowerCase());
  }
  return [...new Set(tags)];
}

/** Extract frontmatter 'type' field. */
function extractType(text: string): string | undefined {
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return undefined;
  const typeMatch = fmMatch[1].match(/^type:\s*(.+)$/m);
  return typeMatch ? typeMatch[1].trim().replace(/^['"]|['"]$/g, '') : undefined;
}

/** Build the full vault graph from disk. */
function buildGraph(vaultPath: string): VaultGraph {
  const files = walkDir(vaultPath);
  const nodes = new Map<string, VaultNode>();
  const pathToName = new Map<string, string>();
  const backlinks = new Map<string, Set<string>>();

  for (const absPath of files) {
    const relPath = relative(vaultPath, absPath);
    const name = basename(relPath, '.md').toLowerCase();
    const folder = dirname(relPath);

    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const links = extractWikilinks(content);
    const tags = extractTags(content);
    const type = extractType(content);

    nodes.set(name, { path: relPath, name, folder, links, tags, type });
    pathToName.set(relPath, name);
  }

  // Build backlink index
  for (const [sourceName, node] of nodes) {
    for (const target of node.links) {
      if (!backlinks.has(target)) backlinks.set(target, new Set());
      backlinks.get(target)!.add(sourceName);
    }
  }

  return { nodes, pathToName, backlinks };
}

/** Total connections for a node (outgoing + incoming unique). */
function totalConnections(graph: VaultGraph, name: string): number {
  const node = graph.nodes.get(name);
  const outgoing = node ? node.links.length : 0;
  const incoming = graph.backlinks.get(name)?.size ?? 0;
  return outgoing + incoming;
}

// ── Subcommands ──

/** Default: graph overview stats. */
function overview(graph: VaultGraph): void {
  const nodeCount = graph.nodes.size;

  // Count edges (directed)
  let edgeCount = 0;
  for (const node of graph.nodes.values()) {
    edgeCount += node.links.filter(l => graph.nodes.has(l)).length;
  }

  // Broken links (point to nonexistent files)
  let brokenCount = 0;
  for (const node of graph.nodes.values()) {
    brokenCount += node.links.filter(l => !graph.nodes.has(l)).length;
  }

  // Orphan count
  let orphanCount = 0;
  for (const [name, node] of graph.nodes) {
    const hasOutgoing = node.links.some(l => graph.nodes.has(l));
    const hasIncoming = (graph.backlinks.get(name)?.size ?? 0) > 0;
    if (!hasOutgoing && !hasIncoming) orphanCount++;
  }

  // Density = edges / (nodes * (nodes - 1)) for directed graph
  const maxEdges = nodeCount * (nodeCount - 1);
  const density = maxEdges > 0 ? edgeCount / maxEdges : 0;

  // Average connections
  const avgConn = nodeCount > 0
    ? [...graph.nodes.keys()].reduce((sum, n) => sum + totalConnections(graph, n), 0) / nodeCount
    : 0;

  // Folder breakdown
  const folders = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    const folder = node.folder === '.' ? '(root)' : node.folder;
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }

  // Type breakdown
  const types = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    const t = node.type ?? '(untyped)';
    types.set(t, (types.get(t) ?? 0) + 1);
  }

  console.log(`\n  ${C.bold}🕸️  Knowledge Graph Overview${C.reset}\n`);
  console.log(`  ${C.cyan}Nodes:${C.reset}        ${nodeCount}`);
  console.log(`  ${C.cyan}Edges:${C.reset}        ${edgeCount} (directed)`);
  console.log(`  ${C.cyan}Broken links:${C.reset} ${brokenCount}`);
  console.log(`  ${C.cyan}Orphans:${C.reset}      ${orphanCount}`);
  console.log(`  ${C.cyan}Density:${C.reset}      ${(density * 100).toFixed(3)}%`);
  console.log(`  ${C.cyan}Avg links:${C.reset}    ${avgConn.toFixed(1)} per node`);

  if (folders.size > 0) {
    console.log(`\n  ${C.bold}📁 Folders:${C.reset}`);
    for (const [folder, count] of [...folders.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${folder.padEnd(30)} ${count}`);
    }
  }

  if (types.size > 1 || !types.has('(untyped)')) {
    console.log(`\n  ${C.bold}📋 Types:${C.reset}`);
    for (const [type, count] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${type.padEnd(30)} ${count}`);
    }
  }

  console.log();
}

/** hubs: Most-connected entities. */
function hubs(graph: VaultGraph, limit: number): void {
  const scored: Array<{ name: string; path: string; out: number; in_: number; total: number }> = [];

  for (const [name, node] of graph.nodes) {
    const out = node.links.filter(l => graph.nodes.has(l)).length;
    const in_ = graph.backlinks.get(name)?.size ?? 0;
    scored.push({ name, path: node.path, out, in_: in_, total: out + in_ });
  }

  scored.sort((a, b) => b.total - a.total);

  console.log(`\n  ${C.bold}🏛️  Top ${limit} Hub Entities${C.reset}\n`);
  console.log(`  ${'Name'.padEnd(30)} ${'Out'.padStart(5)} ${'In'.padStart(5)} ${'Total'.padStart(6)}  Path`);
  console.log(`  ${'─'.repeat(30)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(6)}  ${'─'.repeat(30)}`);

  for (const entry of scored.slice(0, limit)) {
    const nameDisplay = entry.name.length > 28 ? entry.name.slice(0, 27) + '…' : entry.name;
    const color = entry.total >= 10 ? C.green : entry.total >= 5 ? C.yellow : C.dim;
    console.log(`  ${color}${nameDisplay.padEnd(30)}${C.reset} ${String(entry.out).padStart(5)} ${String(entry.in_).padStart(5)} ${String(entry.total).padStart(6)}  ${C.dim}${entry.path}${C.reset}`);
  }

  console.log();
}

/** orphans: Files with no connections. */
function orphans(graph: VaultGraph): void {
  const orphanList: VaultNode[] = [];

  for (const [name, node] of graph.nodes) {
    const hasOutgoing = node.links.some(l => graph.nodes.has(l));
    const hasIncoming = (graph.backlinks.get(name)?.size ?? 0) > 0;
    if (!hasOutgoing && !hasIncoming) orphanList.push(node);
  }

  if (orphanList.length === 0) {
    console.log(`\n  ${C.green}✅ No orphans — all files are connected.${C.reset}\n`);
    return;
  }

  orphanList.sort((a, b) => a.path.localeCompare(b.path));

  console.log(`\n  ${C.bold}🏝️  Orphan Files (${orphanList.length})${C.reset}\n`);
  for (const node of orphanList) {
    const typeTag = node.type ? ` ${C.dim}[${node.type}]${C.reset}` : '';
    console.log(`  ${C.yellow}${node.path}${C.reset}${typeTag}`);
  }
  console.log();
}

/** islands: Find disconnected subgraphs using BFS. */
function islands(graph: VaultGraph): void {
  const visited = new Set<string>();
  const clusters: Array<{ nodes: string[]; edges: number }> = [];

  for (const name of graph.nodes.keys()) {
    if (visited.has(name)) continue;

    // BFS from this node (undirected — follow links and backlinks)
    const queue: string[] = [name];
    const cluster: string[] = [];
    let clusterEdges = 0;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      cluster.push(current);

      const node = graph.nodes.get(current);
      if (node) {
        for (const link of node.links) {
          if (graph.nodes.has(link)) {
            clusterEdges++;
            if (!visited.has(link)) queue.push(link);
          }
        }
      }

      // Follow backlinks too (undirected traversal)
      const bl = graph.backlinks.get(current);
      if (bl) {
        for (const source of bl) {
          if (!visited.has(source)) queue.push(source);
        }
      }
    }

    clusters.push({ nodes: cluster, edges: clusterEdges });
  }

  // Sort by size descending
  clusters.sort((a, b) => b.nodes.length - a.nodes.length);

  console.log(`\n  ${C.bold}🏝️  Graph Islands (${clusters.length} disconnected subgraphs)${C.reset}\n`);

  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const sizeColor = c.nodes.length > 10 ? C.green : c.nodes.length > 1 ? C.yellow : C.dim;
    console.log(`  ${sizeColor}Cluster ${i + 1}:${C.reset} ${c.nodes.length} nodes, ${c.edges} edges`);

    // Show first few members
    const preview = c.nodes.slice(0, 8);
    const more = c.nodes.length > 8 ? ` ${C.dim}(+${c.nodes.length - 8} more)${C.reset}` : '';
    console.log(`    ${preview.map(n => {
      const node = graph.nodes.get(n);
      return node ? basename(node.path, '.md') : n;
    }).join(', ')}${more}`);
  }

  console.log();
}

/** path: BFS shortest path between two entities. */
function shortestPath(graph: VaultGraph, startName: string, endName: string): void {
  const start = startName.toLowerCase().replace(/\.md$/, '');
  const end = endName.toLowerCase().replace(/\.md$/, '');

  if (!graph.nodes.has(start)) {
    errHint(`Entity not found: ${startName}`, 'Check the name and try again');
    process.exit(1);
  }
  if (!graph.nodes.has(end)) {
    errHint(`Entity not found: ${endName}`, 'Check the name and try again');
    process.exit(1);
  }

  if (start === end) {
    console.log(`\n  ${C.green}Same entity — distance 0.${C.reset}\n`);
    return;
  }

  // BFS (undirected)
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const queue: string[] = [start];
  visited.add(start);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === end) break;

    // Outgoing links
    const node = graph.nodes.get(current);
    const neighbors: string[] = [];
    if (node) {
      for (const link of node.links) {
        if (graph.nodes.has(link)) neighbors.push(link);
      }
    }

    // Backlinks
    const bl = graph.backlinks.get(current);
    if (bl) {
      for (const source of bl) neighbors.push(source);
    }

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parent.set(neighbor, current);
        queue.push(neighbor);
      }
    }
  }

  if (!parent.has(end)) {
    console.log(`\n  ${C.red}No path exists between ${startName} and ${endName}.${C.reset}`);
    console.log(`  ${C.dim}They are in different disconnected subgraphs.${C.reset}\n`);
    return;
  }

  // Reconstruct path
  const path: string[] = [end];
  let current = end;
  while (parent.has(current)) {
    current = parent.get(current)!;
    path.unshift(current);
  }

  console.log(`\n  ${C.bold}🔗 Shortest Path (${path.length - 1} hops)${C.reset}\n`);

  for (let i = 0; i < path.length; i++) {
    const name = path[i];
    const node = graph.nodes.get(name);
    const display = node ? basename(node.path, '.md') : name;
    const pathStr = node ? ` ${C.dim}(${node.path})${C.reset}` : '';

    if (i === 0) {
      console.log(`  ${C.green}📍 ${display}${C.reset}${pathStr}`);
    } else if (i === path.length - 1) {
      console.log(`  ${'  '.repeat(i)}${C.cyan}↳ 🎯 ${display}${C.reset}${pathStr}`);
    } else {
      console.log(`  ${'  '.repeat(i)}${C.yellow}↳ ${display}${C.reset}${pathStr}`);
    }
  }

  console.log();
}

/** neighbors: Direct connections for an entity. */
function neighbors(graph: VaultGraph, entityName: string): void {
  const name = entityName.toLowerCase().replace(/\.md$/, '');
  const node = graph.nodes.get(name);

  if (!node) {
    errHint(`Entity not found: ${entityName}`, 'Check the name and try again');
    process.exit(1);
  }

  const outgoing = node.links
    .filter(l => graph.nodes.has(l))
    .map(l => ({ name: l, path: graph.nodes.get(l)!.path }));

  const bl = graph.backlinks.get(name);
  const incoming = bl
    ? [...bl].filter(s => graph.nodes.has(s)).map(s => ({ name: s, path: graph.nodes.get(s)!.path }))
    : [];

  console.log(`\n  ${C.bold}🔗 Neighbors of ${basename(node.path, '.md')}${C.reset} ${C.dim}(${node.path})${C.reset}\n`);

  if (outgoing.length > 0) {
    console.log(`  ${C.cyan}→ Outgoing (${outgoing.length}):${C.reset}`);
    for (const link of outgoing.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`    ${basename(link.path, '.md')} ${C.dim}${link.path}${C.reset}`);
    }
  } else {
    console.log(`  ${C.dim}→ No outgoing links${C.reset}`);
  }

  if (incoming.length > 0) {
    console.log(`  ${C.magenta}← Incoming (${incoming.length}):${C.reset}`);
    for (const link of incoming.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`    ${basename(link.path, '.md')} ${C.dim}${link.path}${C.reset}`);
    }
  } else {
    console.log(`  ${C.dim}← No incoming links${C.reset}`);
  }

  console.log(`\n  ${C.bold}Total:${C.reset} ${outgoing.length + incoming.length} connections\n`);
}

/** broken: Wikilinks pointing to nonexistent files. */
function brokenLinks(graph: VaultGraph): void {
  const broken: Array<{ source: string; target: string }> = [];

  for (const node of graph.nodes.values()) {
    for (const link of node.links) {
      if (!graph.nodes.has(link)) {
        broken.push({ source: node.path, target: link });
      }
    }
  }

  if (broken.length === 0) {
    console.log(`\n  ${C.green}✅ No broken links — all wikilinks resolve.${C.reset}\n`);
    return;
  }

  // Group by target
  const byTarget = new Map<string, string[]>();
  for (const b of broken) {
    if (!byTarget.has(b.target)) byTarget.set(b.target, []);
    byTarget.get(b.target)!.push(b.source);
  }

  const sorted = [...byTarget.entries()].sort((a, b) => b[1].length - a[1].length);

  console.log(`\n  ${C.bold}💔 Broken Links (${broken.length} across ${sorted.length} targets)${C.reset}\n`);

  for (const [target, sources] of sorted) {
    console.log(`  ${C.red}[[${target}]]${C.reset} ${C.dim}(missing — ${sources.length} reference${sources.length > 1 ? 's' : ''})${C.reset}`);
    for (const source of sources.slice(0, 5)) {
      console.log(`    ${C.dim}← ${source}${C.reset}`);
    }
    if (sources.length > 5) {
      console.log(`    ${C.dim}  (+${sources.length - 5} more)${C.reset}`);
    }
  }

  console.log();
}

/** dot: Export as Graphviz DOT format. */
function exportDot(graph: VaultGraph, outputPath?: string): void {
  const lines: string[] = ['digraph VedKnowledgeGraph {'];
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box, style=rounded, fontname="Helvetica"];');
  lines.push('  edge [color="#666666"];');
  lines.push('');

  // Color by folder
  const folderColors: Record<string, string> = {
    'entities': '#4CAF50',
    'concepts': '#2196F3',
    'decisions': '#FF9800',
    'daily': '#9E9E9E',
  };

  // Nodes
  for (const node of graph.nodes.values()) {
    const topFolder = node.folder.split('/')[0];
    const color = folderColors[topFolder] ?? '#607D8B';
    const escapedName = node.name.replace(/"/g, '\\"');
    const displayName = basename(node.path, '.md').replace(/"/g, '\\"');
    lines.push(`  "${escapedName}" [label="${displayName}", color="${color}", fontcolor="${color}"];`);
  }

  lines.push('');

  // Edges
  for (const node of graph.nodes.values()) {
    for (const link of node.links) {
      if (graph.nodes.has(link)) {
        const escapedSource = node.name.replace(/"/g, '\\"');
        const escapedTarget = link.replace(/"/g, '\\"');
        lines.push(`  "${escapedSource}" -> "${escapedTarget}";`);
      }
    }
  }

  lines.push('}');

  const dot = lines.join('\n');

  if (outputPath) {
    writeFileSync(outputPath, dot, 'utf-8');
    console.log(`\n  ${C.green}✅ DOT graph written to ${outputPath}${C.reset}`);
    console.log(`  ${C.dim}Render with: dot -Tsvg ${outputPath} -o graph.svg${C.reset}\n`);
  } else {
    console.log(dot);
  }
}

/** summary: Per-folder breakdown with link density stats. */
function summary(graph: VaultGraph): void {
  const folders = new Map<string, { nodes: VaultNode[]; internalEdges: number; externalEdgesOut: number; externalEdgesIn: number }>();

  // Group by folder
  for (const node of graph.nodes.values()) {
    const folder = node.folder === '.' ? '(root)' : node.folder;
    if (!folders.has(folder)) folders.set(folder, { nodes: [], internalEdges: 0, externalEdgesOut: 0, externalEdgesIn: 0 });
    folders.get(folder)!.nodes.push(node);
  }

  // Count edges
  for (const node of graph.nodes.values()) {
    const srcFolder = node.folder === '.' ? '(root)' : node.folder;
    for (const link of node.links) {
      const target = graph.nodes.get(link);
      if (!target) continue;
      const tgtFolder = target.folder === '.' ? '(root)' : target.folder;
      if (srcFolder === tgtFolder) {
        folders.get(srcFolder)!.internalEdges++;
      } else {
        folders.get(srcFolder)!.externalEdgesOut++;
        folders.get(tgtFolder)!.externalEdgesIn++;
      }
    }
  }

  const sorted = [...folders.entries()].sort((a, b) => b[1].nodes.length - a[1].nodes.length);

  console.log(`\n  ${C.bold}📊 Vault Summary by Folder${C.reset}\n`);
  console.log(`  ${'Folder'.padEnd(25)} ${'Files'.padStart(6)} ${'Internal'.padStart(9)} ${'Out→'.padStart(6)} ${'←In'.padStart(6)}`);
  console.log(`  ${'─'.repeat(25)} ${'─'.repeat(6)} ${'─'.repeat(9)} ${'─'.repeat(6)} ${'─'.repeat(6)}`);

  for (const [folder, data] of sorted) {
    const folderDisplay = folder.length > 23 ? folder.slice(0, 22) + '…' : folder;
    console.log(`  ${C.cyan}${folderDisplay.padEnd(25)}${C.reset} ${String(data.nodes.length).padStart(6)} ${String(data.internalEdges).padStart(9)} ${String(data.externalEdgesOut).padStart(6)} ${String(data.externalEdgesIn).padStart(6)}`);
  }

  console.log();
}

// ── Main dispatch ──

export async function graphCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0] || '';

  // Load vault path from config
  const config = loadConfig();
  const vaultPath = config.memory?.vaultPath;

  if (!vaultPath) {
    errHint('No vault path configured. Run `ved init` first.');
    process.exit(1);
  }

  // Build graph
  const graph = buildGraph(vaultPath);

  switch (sub) {
    case '':
      return overview(graph);
    case 'hubs':
    case 'hub': {
      const limit = flags.limit ? parseInt(flags.limit, 10) : 20;
      return hubs(graph, limit);
    }
    case 'orphans':
    case 'orphan':
      return orphans(graph);
    case 'islands':
    case 'island':
    case 'clusters':
    case 'cluster':
      return islands(graph);
    case 'path':
    case 'shortest': {
      const a = positional[1];
      const b = positional[2];
      if (!a || !b) {
        errUsage('ved graph path <entity-a> <entity-b>');
        process.exit(1);
      }
      return shortestPath(graph, a, b);
    }
    case 'neighbors':
    case 'neighbor':
    case 'nb': {
      const entity = positional[1];
      if (!entity) {
        errUsage('ved graph neighbors <entity>');
        process.exit(1);
      }
      return neighbors(graph, entity);
    }
    case 'broken':
    case 'dead':
      return brokenLinks(graph);
    case 'dot':
    case 'graphviz': {
      const output = flags.output || flags.o;
      return exportDot(graph, output);
    }
    case 'summary':
    case 'folders':
      return summary(graph);
    default:
      errHint(`Unknown subcommand: ${sub}`, 'Run "ved help" to see available commands');
      errHint('Run `ved graph --help` for usage.');
      process.exit(1);
  }
}

// ── Exports for testing ──

export {
  buildGraph,
  extractWikilinks,
  extractTags,
  extractType,
  totalConnections,
  type VaultGraph,
  type VaultNode,
};
