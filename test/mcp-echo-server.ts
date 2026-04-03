#!/usr/bin/env npx tsx
/**
 * Simple MCP stdio server for live testing.
 *
 * Provides 3 tools:
 *   - echo__echo: echoes back input text
 *   - echo__get_time: returns current UTC time
 *   - echo__calculate: evaluates simple math expressions
 *
 * Speaks JSON-RPC 2.0 over stdin/stdout (line-delimited).
 */

import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided text. Useful for testing tool calling.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo back' },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_time',
    description: 'Get the current UTC time as an ISO 8601 string.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'calculate',
    description: 'Evaluate a simple arithmetic expression (add, subtract, multiply, divide). Example: "2 + 3 * 4"',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Arithmetic expression to evaluate' },
      },
      required: ['expression'],
    },
  },
];

function handleRequest(request: { jsonrpc: string; id?: number; method: string; params?: any }) {
  const { id, method, params } = request;

  // Notifications (no id) — just ack
  if (id == null) return null;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'echo-server', version: '1.0.0' },
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      switch (toolName) {
        case 'echo':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Echo: ${args.text ?? '(empty)'}` }],
            },
          };

        case 'get_time':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: new Date().toISOString() }],
            },
          };

        case 'calculate': {
          const expr = String(args.expression ?? '');
          // Safe arithmetic eval: only allow digits, operators, spaces, parens, dots
          if (!/^[\d+\-*/().\s]+$/.test(expr)) {
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `Error: Invalid expression "${expr}"` }],
                isError: true,
              },
            };
          }
          try {
            // eslint-disable-next-line no-eval
            const result = Function(`"use strict"; return (${expr})`)();
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `${result}` }],
              },
            };
          } catch (e) {
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
                isError: true,
              },
            };
          }
        }

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
          };
      }
    }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown method: ${method}` },
      };
  }
}

// ── Main loop ──
const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);
    const response = handleRequest(request);
    if (response) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  } catch {
    // Unparseable — skip
  }
});
