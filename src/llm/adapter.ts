export interface LlmToolCall {
  id?: string;
  name: string;
  args: unknown;
}

export interface LlmToolResult {
  id?: string;
  name: string;
  response: Record<string, unknown>;
}

export interface LlmMessage {
  role: "user" | "assistant";
  text?: string;
  toolCalls?: LlmToolCall[];
  toolResults?: LlmToolResult[];
  providerData?: unknown;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface LlmResponse {
  message: LlmMessage;
  text: string;
  toolCalls: LlmToolCall[];
}

export interface LlmAdapter {
  enviar(input: {
    model: string;
    systemPrompt: string;
    messages: LlmMessage[];
    tools: LlmToolDefinition[];
    maxOutputTokens: number;
  }): Promise<LlmResponse>;
}
