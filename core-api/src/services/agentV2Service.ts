import axios from 'axios';

const AGENT_V2_URL = process.env.AGENT_V2_URL || 'http://localhost:5001';

interface Product {
  id: string;
  name: string;
  description?: string;
  price?: number;
  currency?: string;
  category?: string;
  stock?: number;
  attributes?: Record<string, any>;
}

interface BusinessContext {
  business_id: string;
  business_name: string;
  timezone: string;
  products: Product[];
  policies: string[];
  custom_prompt?: string;
  tools_enabled: boolean;
  tools_config: any[];
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface GenerateRequest {
  business_context: BusinessContext;
  conversation_history: Message[];
  current_message: string;
  sender_phone: string;
  sender_name?: string;
}

interface GenerateResponse {
  success: boolean;
  response?: string;
  tool_calls?: any[];
  tokens_used?: number;
  model?: string;
  error?: string;
}

export async function isAgentV2Available(): Promise<boolean> {
  try {
    const response = await axios.get(`${AGENT_V2_URL}/health`, { timeout: 3000 });
    return response.data?.status === 'healthy';
  } catch {
    return false;
  }
}

export async function generateWithAgentV2(
  request: GenerateRequest
): Promise<GenerateResponse> {
  try {
    const response = await axios.post<GenerateResponse>(
      `${AGENT_V2_URL}/generate`,
      request,
      {
        timeout: 60000,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.data;
  } catch (error: any) {
    console.error('Agent V2 error:', error.message);
    
    if (error.response?.data) {
      return {
        success: false,
        error: error.response.data.detail || error.message
      };
    }
    
    return {
      success: false,
      error: `Agent V2 unavailable: ${error.message}`
    };
  }
}

interface DynamicVariable {
  name: string;
  description: string;
  formatExample?: string;
}

interface ToolConfig {
  name: string;
  description: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  bodyTemplate?: any;
  parameters?: any[];
  dynamicVariables?: DynamicVariable[];
  enabled: boolean;
}

export function buildBusinessContext(
  business: any,
  customPrompt?: string,
  tools?: ToolConfig[]
): BusinessContext {
  const policies: string[] = [];
  
  if (business.policy) {
    if (business.policy.shippingPolicy) {
      policies.push(`Envíos: ${business.policy.shippingPolicy}`);
    }
    if (business.policy.refundPolicy) {
      policies.push(`Devoluciones: ${business.policy.refundPolicy}`);
    }
    if (business.policy.brandVoice) {
      policies.push(`Tono de marca: ${business.policy.brandVoice}`);
    }
  }
  
  const products: Product[] = (business.products || []).map((p: any) => ({
    id: p.id,
    name: p.title || p.name,
    description: p.description,
    price: p.price,
    currency: 'USD',
    category: p.category,
    stock: p.stock
  }));
  
  const enabledTools = (tools || []).filter(t => t.enabled);
  
  return {
    business_id: business.id,
    business_name: business.name,
    timezone: business.timezone || 'America/Lima',
    products,
    policies,
    custom_prompt: customPrompt,
    tools_enabled: enabledTools.length > 0,
    tools_config: enabledTools
  };
}

export function buildConversationHistory(
  messages: any[]
): Message[] {
  return messages.map(m => ({
    role: m.direction === 'outbound' ? 'assistant' : 'user',
    content: m.message || ''
  }));
}

interface MemoryResponse {
  success: boolean;
  memory?: Record<string, any>;
  message?: string;
  note?: string;
}

interface MemoryStatsResponse {
  success: boolean;
  stats?: {
    business_id: string;
    active_memories: number;
    keys: string[];
  };
}

export async function getAgentMemory(
  businessId: string,
  leadId: string
): Promise<MemoryResponse> {
  try {
    const response = await axios.get<MemoryResponse>(
      `${AGENT_V2_URL}/memory/${businessId}/${leadId}`,
      { timeout: 5000 }
    );
    return response.data;
  } catch (error: any) {
    console.error('Error getting agent memory:', error.message);
    return {
      success: false,
      message: error.message
    };
  }
}

export async function clearAgentMemory(
  businessId: string,
  leadId: string
): Promise<MemoryResponse> {
  try {
    const response = await axios.delete<MemoryResponse>(
      `${AGENT_V2_URL}/memory/${businessId}/${leadId}`,
      { timeout: 5000 }
    );
    return response.data;
  } catch (error: any) {
    console.error('Error clearing agent memory:', error.message);
    return {
      success: false,
      message: error.message
    };
  }
}

export async function getMemoryStats(
  businessId: string
): Promise<MemoryStatsResponse> {
  try {
    const response = await axios.get<MemoryStatsResponse>(
      `${AGENT_V2_URL}/memory/stats/${businessId}`,
      { timeout: 5000 }
    );
    return response.data;
  } catch (error: any) {
    console.error('Error getting memory stats:', error.message);
    return {
      success: false
    };
  }
}
