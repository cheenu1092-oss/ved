/**
 * Minimal MCP stdio server for live testing.
 *
 * Provides 3 tools:
 * - calculator: evaluates basic math expressions
 * - get_weather: returns fake weather data for a city
 * - get_time: returns current date/time
 *
 * Protocol: JSON-RPC 2.0 over stdio (line-delimited)
 */

import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'calculator',
    description: 'Evaluates a basic arithmetic expression. Supports +, -, *, /, and parentheses. Example: "2 + 3 * 4"',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The math expression to evaluate (e.g. "2 + 3 * 4")',
        },
      },
      required: ['expression'],
    },
  },
  {
    name: 'get_weather',
    description: 'Get current weather for a city. Returns temperature, conditions, and humidity.',
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'City name (e.g. "San Francisco")',
        },
      },
      required: ['city'],
    },
  },
  {
    name: 'get_time',
    description: 'Get the current date and time in ISO format.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// Fake weather data
const WEATHER_DATA: Record<string, { temp: number; conditions: string; humidity: number }> = {
  'san francisco': { temp: 62, conditions: 'Foggy', humidity: 78 },
  'new york': { temp: 45, conditions: 'Cloudy', humidity: 65 },
  'london': { temp: 50, conditions: 'Rainy', humidity: 85 },
  'tokyo': { temp: 68, conditions: 'Sunny', humidity: 55 },
  'paris': { temp: 55, conditions: 'Partly cloudy', humidity: 70 },
};

function safeEval(expr: string): number {
  // Strip everything except digits, operators, parens, dots, spaces
  const sanitized = expr.replace(/[^0-9+\-*/().%\s]/g, '');
  if (sanitized !== expr.trim()) {
    throw new Error(`Invalid characters in expression: "${expr}"`);
  }
  // Use Function constructor for basic math (safe since we stripped all non-math chars)
  const result = new Function(`return (${sanitized})`)();
  if (typeof result !== 'number' || !isFinite(result)) {
    throw new Error(`Expression did not produce a valid number: "${expr}"`);
  }
  return result;
}

function handleToolCall(name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  switch (name) {
    case 'calculator': {
      try {
        const expression = String(args.expression || '');
        const result = safeEval(expression);
        return { content: [{ type: 'text', text: `${expression} = ${result}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
    case 'get_weather': {
      const city = String(args.city || '').toLowerCase();
      const weather = WEATHER_DATA[city];
      if (weather) {
        return {
          content: [{
            type: 'text',
            text: `Weather in ${args.city}: ${weather.temp}°F, ${weather.conditions}, ${weather.humidity}% humidity`,
          }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: `Weather in ${args.city}: 70°F, Clear, 50% humidity`,
        }],
      };
    }
    case 'get_time': {
      return {
        content: [{
          type: 'text',
          text: `Current time: ${new Date().toISOString()}`,
        }],
      };
    }
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

function handleRequest(msg: { jsonrpc: string; id?: number; method: string; params?: unknown }): unknown | null {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ved-test-mcp', version: '1.0.0' },
      };

    case 'notifications/initialized':
      // Notification — no response
      return null;

    case 'tools/list':
      return { tools: TOOLS };

    case 'tools/call': {
      const params = msg.params as { name: string; arguments?: Record<string, unknown> } | undefined;
      if (!params?.name) {
        return { content: [{ type: 'text', text: 'Missing tool name' }], isError: true };
      }
      return handleToolCall(params.name, params.arguments ?? {});
    }

    default:
      return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

// ── Main loop ──
const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;

  try {
    const msg = JSON.parse(line);
    const result = handleRequest(msg);

    // Notifications have no id and expect no response
    if (result === null) return;

    const response = {
      jsonrpc: '2.0',
      id: msg.id,
      result,
    };

    process.stdout.write(JSON.stringify(response) + '\n');
  } catch (err) {
    // Parse error
    const response = {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    };
    process.stdout.write(JSON.stringify(response) + '\n');
  }
});

rl.on('close', () => {
  process.exit(0);
});
