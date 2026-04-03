/**
 * OpenAI-compatible provider adapter.
 *
 * Works with:
 * - OpenAI (api.openai.com)
 * - OpenRouter (openrouter.ai/api) — via baseUrl override
 *
 * Handles the chat completions format with tool_calls in assistant messages.
 */

import type {
  LLMProviderAdapter, LLMRequest, LLMResponse, ProviderConfig,
  MCPToolDefinition,
} from './types.js';
import type { LLMUsage, ToolCall } from '../types/index.js';
import { VedError } from '../types/errors.js';

// === OpenAI API types ===

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: OpenAITool[];
}

interface OpenAIResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI-compatible adapter. Works with OpenAI and OpenRouter.
 */
export class OpenAIAdapter implements LLMProviderAdapter {
  readonly provider: string;

  constructor(provider: 'openai' | 'openrouter' = 'openai') {
    this.provider = provider;
  }

  formatRequest(request: LLMRequest): OpenAIRequest {
    const messages = this.convertMessages(request);

    const formatted: OpenAIRequest = {
      model: '', // filled by caller
      messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
    };

    if (request.tools && request.tools.length > 0) {
      formatted.tools = request.tools.map(this.convertTool);
    }

    return formatted;
  }

  parseResponse(raw: unknown): LLMResponse {
    const resp = raw as OpenAIResponse;
    const choice = resp.choices[0];

    if (!choice) {
      throw new VedError('LLM_INVALID_RESPONSE', 'No choices in OpenAI response');
    }

    const toolCalls: ToolCall[] = [];
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let params: Record<string, unknown> = {};
        try {
          params = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          params = { _raw: tc.function.arguments };
        }
        toolCalls.push({
          id: tc.id,
          tool: tc.function.name,
          params,
        });
      }
    }

    const usage: LLMUsage = {
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      completionTokens: resp.usage?.completion_tokens ?? 0,
      totalTokens: resp.usage?.total_tokens ?? 0,
      model: resp.model,
      provider: this.provider,
    };

    const finishReason = this.mapFinishReason(choice.finish_reason);

    return {
      decision: {
        response: choice.message.content ?? undefined,
        toolCalls,
        memoryOps: [],
        usage,
      },
      raw,
      usage,
      durationMs: 0,
      finishReason,
    };
  }

  async call(formattedRequest: unknown, config: ProviderConfig): Promise<unknown> {
    const req = formattedRequest as OpenAIRequest;
    req.model = config.model;
    if (config.maxTokens) req.max_tokens = config.maxTokens;
    if (config.temperature !== undefined) req.temperature = config.temperature;

    const baseUrl = config.baseUrl ?? this.defaultBaseUrl();
    const url = `${baseUrl}/chat/completions`;

    if (!config.apiKey) {
      throw new VedError('LLM_API_KEY_MISSING', `${this.provider} API key not configured`);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    };

    // OpenRouter requires additional headers
    if (this.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/cheenu1092-oss/ved';
      headers['X-Title'] = 'Ved';
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 429) {
        throw new VedError('LLM_RATE_LIMITED', `${this.provider} rate limited: ${body}`);
      }
      throw new VedError('LLM_REQUEST_FAILED', `${this.provider} API error ${response.status}: ${body}`);
    }

    return response.json();
  }

  async callStream(
    formattedRequest: unknown,
    config: ProviderConfig,
    onToken: (token: string) => void,
  ): Promise<unknown> {
    const req = formattedRequest as OpenAIRequest;
    req.model = config.model;
    if (config.maxTokens) req.max_tokens = config.maxTokens;
    if (config.temperature !== undefined) req.temperature = config.temperature;

    const baseUrl = config.baseUrl ?? this.defaultBaseUrl();
    const url = `${baseUrl}/chat/completions`;

    if (!config.apiKey) {
      throw new VedError('LLM_API_KEY_MISSING', `${this.provider} API key not configured`);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    };

    if (this.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/cheenu1092-oss/ved';
      headers['X-Title'] = 'Ved';
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...req, stream: true, stream_options: { include_usage: true } }),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 429) {
        throw new VedError('LLM_RATE_LIMITED', `${this.provider} rate limited: ${body}`);
      }
      throw new VedError('LLM_REQUEST_FAILED', `${this.provider} API error ${response.status}: ${body}`);
    }

    if (!response.body) {
      throw new VedError('LLM_REQUEST_FAILED', `${this.provider} streaming response has no body`);
    }

    // Parse SSE stream — accumulate into a synthetic non-stream response
    let accumulatedText = '';
    let finishReason = 'stop';
    let model = config.model;
    let promptTokens = 0;
    let completionTokens = 0;

    // Tool call accumulation
    const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

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

          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Model from first chunk
          if (chunk['model']) model = chunk['model'] as string;

          // Usage from final chunk (stream_options: include_usage)
          const usage = chunk['usage'] as Record<string, number> | undefined;
          if (usage) {
            promptTokens = usage['prompt_tokens'] ?? promptTokens;
            completionTokens = usage['completion_tokens'] ?? completionTokens;
          }

          const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
          if (!choices || choices.length === 0) continue;

          const choice = choices[0];
          if (choice['finish_reason']) {
            finishReason = choice['finish_reason'] as string;
          }

          const delta = choice['delta'] as Record<string, unknown> | undefined;
          if (!delta) continue;

          // Text content
          const content = delta['content'] as string | undefined;
          if (content) {
            accumulatedText += content;
            onToken(content);
          }

          // Tool calls (streamed incrementally)
          const toolCalls = delta['tool_calls'] as Array<Record<string, unknown>> | undefined;
          if (toolCalls) {
            for (const tc of toolCalls) {
              const idx = (tc['index'] as number) ?? 0;
              const fn = tc['function'] as Record<string, string> | undefined;

              if (!toolCallMap.has(idx)) {
                toolCallMap.set(idx, {
                  id: (tc['id'] as string) ?? '',
                  name: fn?.['name'] ?? '',
                  arguments: fn?.['arguments'] ?? '',
                });
              } else {
                const existing = toolCallMap.get(idx)!;
                if (tc['id']) existing.id = tc['id'] as string;
                if (fn?.['name']) existing.name += fn['name'];
                if (fn?.['arguments']) existing.arguments += fn['arguments'];
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Build synthetic response matching non-stream format
    const toolCallsArr: OpenAIToolCall[] = [];
    for (const [, tc] of [...toolCallMap.entries()].sort((a, b) => a[0] - b[0])) {
      toolCallsArr.push({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      });
    }

    const message: Record<string, unknown> = {
      role: 'assistant',
      content: accumulatedText || null,
    };
    if (toolCallsArr.length > 0) {
      message['tool_calls'] = toolCallsArr;
    }

    return {
      id: `stream-${Date.now()}`,
      object: 'chat.completion',
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  // ── Private ──

  private defaultBaseUrl(): string {
    return this.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : 'https://api.openai.com/v1';
  }

  private convertMessages(request: LLMRequest): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    // System prompt as first message
    result.push({ role: 'system', content: request.systemPrompt });

    for (const msg of request.messages) {
      if (msg.role === 'system') continue; // already added above

      if (msg.role === 'tool' && msg.toolCallId) {
        result.push({
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.toolCallId,
        });
        continue;
      }

      const converted: OpenAIMessage = {
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      };

      // Include tool_calls on assistant messages (required by OpenAI for tool result context)
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        converted.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.tool,
            arguments: JSON.stringify(tc.params),
          },
        }));
        // OpenAI: assistant messages with tool_calls may have null content
        if (!converted.content) converted.content = '';
      }

      result.push(converted);
    }

    // Append tool results if provided separately
    if (request.toolResults) {
      for (const tr of request.toolResults) {
        result.push({
          role: 'tool',
          content: tr.success ? JSON.stringify(tr.result ?? '') : `Error: ${tr.error ?? 'Unknown error'}`,
          tool_call_id: tr.callId,
        });
      }
    }

    return result;
  }

  private convertTool(tool: MCPToolDefinition): OpenAITool {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  }

  private mapFinishReason(reason: string): LLMResponse['finishReason'] {
    switch (reason) {
      case 'stop': return 'stop';
      case 'tool_calls': return 'tool_use';
      case 'length': return 'max_tokens';
      default: return 'stop';
    }
  }
}
