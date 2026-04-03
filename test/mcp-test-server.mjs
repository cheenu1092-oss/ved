#!/usr/bin/env node
/**
 * Minimal MCP Server for Live Testing (stdio transport)
 *
 * Tools:
 *   get_weather  — returns fake weather for a city
 *   calculator   — evaluates basic math expressions
 *   get_time     — returns current UTC time
 *
 * Protocol: JSON-RPC 2.0 over line-delimited stdio
 * Spec: MCP 2024-11-05
 */

import { createInterface } from 'node:readline';

const SERVER_NAME = 'test-tools';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a city. Returns temperature, conditions, and humidity.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name (e.g., "San Francisco")' },
      },
      required: ['city'],
    },
  },
  {
    name: 'calculator',
    description: 'Evaluate a basic math expression. Supports +, -, *, /, parentheses.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Math expression (e.g., "2 + 3 * 4")' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'get_time',
    description: 'Get the current date and time in UTC.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// Fake weather data
const WEATHER_DATA = {
  'san francisco': { temp: 62, conditions: 'Foggy', humidity: 78 },
  'new york': { temp: 45, conditions: 'Partly Cloudy', humidity: 55 },
  'tokyo': { temp: 72, conditions: 'Sunny', humidity: 60 },
  'london': { temp: 50, conditions: 'Rainy', humidity: 85 },
  'paris': { temp: 55, conditions: 'Overcast', humidity: 70 },
};

function handleToolCall(name, args) {
  switch (name) {
    case 'get_weather': {
      const city = (args.city || '').toLowerCase();
      const data = WEATHER_DATA[city] || { temp: 70, conditions: 'Clear', humidity: 50 };
      return {
        content: [{
          type: 'text',
          text: `Weather in ${args.city}: ${data.temp}°F, ${data.conditions}, Humidity: ${data.humidity}%`,
        }],
      };
    }
    case 'calculator': {
      const expr = args.expression || '';
      // Only allow safe math characters
      if (!/^[\d\s+\-*/().]+$/.test(expr)) {
        return {
          content: [{ type: 'text', text: `Error: Invalid expression "${expr}"` }],
          isError: true,
        };
      }
      try {
        // Safe eval for basic math
        const result = Function('"use strict"; return (' + expr + ')')();
        return {
          content: [{ type: 'text', text: `${expr} = ${result}` }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Error evaluating "${expr}": ${e.message}` }],
          isError: true,
        };
      }
    }
    case 'get_time': {
      return {
        content: [{ type: 'text', text: `Current UTC time: ${new Date().toISOString()}` }],
      };
    }
    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

function handleRequest(req) {
  const { method, params, id } = req;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };

    case 'notifications/initialized':
      // Notification — no response needed
      return null;

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      const result = handleToolCall(name, args || {});
      return {
        jsonrpc: '2.0',
        id,
        result,
      };
    }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ── Stdio Line-Delimited JSON-RPC ──

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const req = JSON.parse(trimmed);
    const resp = handleRequest(req);
    if (resp) {
      process.stdout.write(JSON.stringify(resp) + '\n');
    }
  } catch (e) {
    process.stderr.write(`Parse error: ${e.message}\n`);
  }
});

rl.on('close', () => {
  process.exit(0);
});
