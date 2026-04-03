import { MCPClient } from '../src/mcp/client.js';
import { resolve } from 'node:path';

const MCP_SERVER_PATH = resolve(import.meta.dirname ?? '.', 'mcp-test-server.ts');

const config = {
  mcp: {
    servers: [{
      name: 'test-tools',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['tsx', MCP_SERVER_PATH],
      enabled: true,
    }],
  },
} as any;

async function main() {
  const client = new MCPClient();
  try {
    await client.init(config);
    console.log('Init done, servers:', (client as any).servers.size);
    const tools = await client.discoverTools();
    console.log('Tools:', tools.length, tools.map(t => t.name));
  } catch (err) {
    console.error('Error:', err);
  }
  await client.shutdown();
}

main();
