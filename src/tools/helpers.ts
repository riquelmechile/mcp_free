import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function textResult(summary: string, structuredContent?: object): CallToolResult {
  return {
    content: [{ type: 'text', text: summary }],
    ...(structuredContent ? { structuredContent: structuredContent as Record<string, unknown> } : {})
  };
}

export function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: message }] };
}
