/**
 * Anthropic Claude provider adapter.
 *
 * Handles Anthropic's unique API format:
 * - Separate system prompt (not in messages array)
 * - Tool use format: content blocks with type='tool_use'
 * - Tool results: role='user' with content blocks type='tool_result'
 */

import type {
  LLMProviderAdapter, LLMRequest, LLMResponse, ProviderConfig,
  ConversationMessage, MCPToolDefinition, ToolResultInput,
} from './types.js';
import type { LLMUsage, ToolCall } from '../types/index.js';
import { VedError } from '../types/errors.js';

// === Anthropic API types ===

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  temperature: number;
  system: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Converts Ved messages + tool results into Anthropic's message format.
 *
 * Key differences from OpenAI:
 * - System prompt is separate (not a message)
 * - Tool results are content blocks inside user messages
 * - No 'tool' role; tool results go in 'user' messages as tool_result blocks
 */
export class AnthropicAdapter implements LLMProviderAdapter {
  readonly provider = 'anthropic';

  formatRequest(request: LLMRequest): AnthropicRequest {
    const messages = this.convertMessages(request.messages, request.toolResults);

    const formatted: AnthropicRequest = {
      model: '', // filled by caller
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
      system: request.systemPrompt,
      messages,
    };

    if (request.tools && request.tools.length > 0) {
      formatted.tools = request.tools.map(this.convertTool);
    }

    return formatted;
  }

  parseResponse(raw: unknown): LLMResponse {
    const resp = raw as AnthropicResponse;
    // Timing is done by the caller (LLMClient.chat)

    const toolCalls: ToolCall[] = [];
    let responseText = '';

    for (const block of resp.content) {
      if (block.type === 'text') {
        responseText += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          tool: block.name,
          params: block.input,
        });
      }
    }

    const usage: LLMUsage = {
      promptTokens: resp.usage.input_tokens,
      completionTokens: resp.usage.output_tokens,
      totalTokens: resp.usage.input_tokens + resp.usage.output_tokens,
      model: resp.model,
      provider: 'anthropic',
    };

    const finishReason = this.mapStopReason(resp.stop_reason);

    return {
      decision: {
        response: responseText || undefined,
        toolCalls,
        memoryOps: [], // extracted by caller
        usage,
      },
      raw,
      usage,
      durationMs: 0, // set by caller
      finishReason,
    };
  }

  async call(formattedRequest: unknown, config: ProviderConfig): Promise<unknown> {
    const req = formattedRequest as AnthropicRequest;
    req.model = config.model;
    req.max_tokens = config.maxTokens;
    req.temperature = config.temperature;

    const baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
    const url = `${baseUrl}/v1/messages`;

    if (!config.apiKey) {
      throw new VedError('LLM_API_KEY_MISSING', 'Anthropic API key not configured');
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 429) {
        throw new VedError('LLM_RATE_LIMITED', `Anthropic rate limited: ${body}`);
      }
      throw new VedError('LLM_REQUEST_FAILED', `Anthropic API error ${response.status}: ${body}`);
    }

    return response.json();
  }

  /**
   * Streaming call via Anthropic SSE API.
   * Yields text tokens via `onToken` as they arrive.
   * Returns a reconstructed response compatible with `parseResponse`.
   */
  async callStream(
    formattedRequest: unknown,
    config: ProviderConfig,
    onToken: (token: string) => void,
  ): Promise<unknown> {
    const req = formattedRequest as AnthropicRequest;
    req.model = config.model;
    req.max_tokens = config.maxTokens;
    req.temperature = config.temperature;

    const baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
    const url = `${baseUrl}/v1/messages`;

    if (!config.apiKey) {
      throw new VedError('LLM_API_KEY_MISSING', 'Anthropic API key not configured');
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...req, stream: true }),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 429) {
        throw new VedError('LLM_RATE_LIMITED', `Anthropic rate limited: ${body}`);
      }
      throw new VedError('LLM_REQUEST_FAILED', `Anthropic API error ${response.status}: ${body}`);
    }

    if (!response.body) {
      throw new VedError('LLM_REQUEST_FAILED', 'Anthropic streaming response has no body');
    }

    // Parse SSE stream
    let inputTokens = 0;
    let outputTokens = 0;
    let model = config.model;
    let stopReason: AnthropicResponse['stop_reason'] = 'end_turn';
    let accumulatedText = '';

    // Tool call state
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';

    const decoder = new TextDecoder();
    let buffer = '';

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          const type = event['type'] as string | undefined;

          if (type === 'message_start') {
            const msg = event['message'] as Record<string, unknown> | undefined;
            if (msg) {
              model = (msg['model'] as string) ?? model;
              const usage = msg['usage'] as Record<string, number> | undefined;
              inputTokens = usage?.['input_tokens'] ?? 0;
            }
          } else if (type === 'content_block_start') {
            const block = event['content_block'] as Record<string, unknown> | undefined;
            if (block?.['type'] === 'tool_use') {
              currentToolId = (block['id'] as string) ?? '';
              currentToolName = (block['name'] as string) ?? '';
              currentToolInput = '';
            }
          } else if (type === 'content_block_delta') {
            const delta = event['delta'] as Record<string, unknown> | undefined;
            if (delta?.['type'] === 'text_delta') {
              const text = (delta['text'] as string) ?? '';
              accumulatedText += text;
              onToken(text);
            } else if (delta?.['type'] === 'input_json_delta') {
              currentToolInput += (delta['partial_json'] as string) ?? '';
            }
          } else if (type === 'content_block_stop') {
            if (currentToolId) {
              try {
                toolCalls.push({
                  id: currentToolId,
                  name: currentToolName,
                  input: JSON.parse(currentToolInput || '{}') as Record<string, unknown>,
                });
              } catch {
                // malformed tool input — skip
              }
              currentToolId = '';
              currentToolName = '';
              currentToolInput = '';
            }
          } else if (type === 'message_delta') {
            const delta = event['delta'] as Record<string, unknown> | undefined;
            const sr = delta?.['stop_reason'] as AnthropicResponse['stop_reason'] | undefined;
            if (sr) stopReason = sr;
            const usage = event['usage'] as Record<string, number> | undefined;
            outputTokens = usage?.['output_tokens'] ?? outputTokens;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Reconstruct a response compatible with parseResponse
    const content: AnthropicContentBlock[] = [];
    if (accumulatedText) {
      content.push({ type: 'text', text: accumulatedText });
    }
    for (const tc of toolCalls) {
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }

    return {
      id: 'streamed',
      type: 'message',
      role: 'assistant',
      content,
      model,
      stop_reason: stopReason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    } satisfies AnthropicResponse;
  }

  // ── Private ──

  private convertMessages(
    messages: ConversationMessage[],
    toolResults?: ToolResultInput[],
  ): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue; // system prompt handled separately

      if (msg.role === 'tool' && msg.toolCallId) {
        // Anthropic requires tool results as content blocks in a user message
        const block: AnthropicContentBlock = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.content,
          is_error: msg.content.startsWith('Error:'),
        };

        // Merge into previous user message or create new one
        const last = result[result.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content)) {
          (last.content as AnthropicContentBlock[]).push(block);
        } else {
          result.push({ role: 'user', content: [block] });
        }
        continue;
      }

      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        result.push({ role: 'assistant', content: msg.content });
      }
    }

    // Append any pending tool results not already in messages
    if (toolResults && toolResults.length > 0) {
      const blocks: AnthropicContentBlock[] = toolResults.map(tr => ({
        type: 'tool_result' as const,
        tool_use_id: tr.callId,
        content: tr.success ? JSON.stringify(tr.result ?? '') : `Error: ${tr.error ?? 'Unknown error'}`,
        is_error: !tr.success,
      }));

      const last = result[result.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as AnthropicContentBlock[]).push(...blocks);
      } else {
        result.push({ role: 'user', content: blocks });
      }
    }

    return result;
  }

  private convertTool(tool: MCPToolDefinition): AnthropicTool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    };
  }

  private mapStopReason(reason: string): LLMResponse['finishReason'] {
    switch (reason) {
      case 'end_turn': return 'stop';
      case 'tool_use': return 'tool_use';
      case 'max_tokens': return 'max_tokens';
      default: return 'stop';
    }
  }
}
