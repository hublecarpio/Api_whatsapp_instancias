import OpenAI from 'openai';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ToolContext {
  businessId: string;
  instanceId: string | null;
  contactPhone: string;
  contactName: string;
  currencySymbol: string;
  currencyCode: string;
  business?: any;
  contact?: any;
  existingOrder?: any;
  extractedData?: Record<string, any>;
  conversationMessages?: ChatMessage[];
  geminiVoucherResult?: {
    isValid: boolean;
    isPaymentProof: boolean;
    brand?: string;
    amount?: number;
    currency?: string;
    operationCode?: string;
    confidence: number;
    reason: string;
    imageUrl?: string;
  };
}

export interface ToolResult {
  success: boolean;
  content: string;
  data?: Record<string, any>;
  shouldContinue?: boolean;
}

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: { type: string };
  default?: any;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required: string[];
  };
  requiresActiveOrder?: boolean;
  requiresProducts?: boolean;
  requiresZones?: boolean;
  requiresAppointments?: boolean;
  isObligatory?: boolean;
  obligatoryContext?: string;
}

export type ToolCategory = 
  | 'ORDER'
  | 'PRODUCT'
  | 'APPOINTMENT'
  | 'PAYMENT'
  | 'FUNNEL'
  | 'COMMUNICATION'
  | 'CUSTOM';

export interface ITool {
  readonly name: string;
  readonly category: ToolCategory;
  
  getDefinition(context: ToolDefinitionContext): ToolDefinition;
  
  execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult>;
  
  isAvailable(context: ToolAvailabilityContext): boolean;
}

export interface ToolDefinitionContext {
  hasActiveOrder: boolean;
  hasProducts: boolean;
  hasZones: boolean;
  hasAppointments: boolean;
  zoneDescriptions?: string;
  productCategories?: string[];
  businessObjective?: 'SALES' | 'APPOINTMENTS';
}

export interface ToolAvailabilityContext {
  businessId: string;
  instanceId: string | null;
  hasActiveOrder: boolean;
  hasProducts: boolean;
  hasZones: boolean;
  hasAppointments: boolean;
  businessObjective?: 'SALES' | 'APPOINTMENTS';
  enabledToolNames?: string[];
}

export interface OpenAIToolFormat {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required: string[];
    };
  };
}

export function toOpenAIFormat(def: ToolDefinition): OpenAIToolFormat {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters
    }
  };
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

export interface LLMResponse {
  content: string | null;
  toolCalls?: {
    id: string;
    name: string;
    arguments: Record<string, any>;
  }[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}
