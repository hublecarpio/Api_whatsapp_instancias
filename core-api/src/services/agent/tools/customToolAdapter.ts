import { BaseTool, ToolCategory, ToolDefinition, ToolContext, ToolResult, ToolAvailabilityContext, ToolDefinitionContext, toolRegistry } from '../core/index.js';
import prisma from '../../prisma.js';
import axios from 'axios';

const customToolsCache: Map<string, { tools: string[]; loadedAt: number }> = new Map();
const CACHE_TTL_MS = 60000;

export interface CustomToolConfig {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  method: 'POST' | 'GET';
  headers?: Record<string, string>;
  parameters: Array<{
    name: string;
    type: string;
    description: string;
    required: boolean;
  }>;
  responseTemplate?: string;
  isActive: boolean;
}

export class CustomToolWrapper extends BaseTool {
  readonly name: string;
  readonly category: ToolCategory = 'CUSTOM';
  private config: CustomToolConfig;

  constructor(config: CustomToolConfig) {
    super();
    this.config = config;
    this.name = config.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const param of this.config.parameters) {
      properties[param.name] = {
        type: param.type as any,
        description: param.description
      };
      if (param.required) {
        required.push(param.name);
      }
    }

    return {
      name: this.name,
      description: this.config.description,
      category: this.category,
      parameters: {
        type: 'object',
        properties,
        required
      }
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('Execute custom tool', { endpoint: this.config.endpoint, args });

    try {
      const headers = {
        'Content-Type': 'application/json',
        ...(this.config.headers || {})
      };

      const enrichedBody = {
        ...args,
        _context: {
          businessId: context.businessId,
          contactPhone: context.contactPhone,
          contactName: context.contactName,
          instanceId: context.instanceId
        }
      };

      let response;
      if (this.config.method === 'GET') {
        response = await axios.get(this.config.endpoint, {
          params: args,
          headers,
          timeout: 30000
        });
      } else {
        response = await axios.post(this.config.endpoint, enrichedBody, {
          headers,
          timeout: 30000
        });
      }

      const data = response.data;

      if (this.config.responseTemplate) {
        let formatted = this.config.responseTemplate;
        for (const [key, value] of Object.entries(data)) {
          formatted = formatted.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
        }
        return this.success(formatted, data);
      }

      if (typeof data === 'string') {
        return this.success(data);
      }

      if (data.message || data.result || data.response) {
        return this.success(data.message || data.result || data.response, data);
      }

      return this.success(JSON.stringify(data, null, 2), data);
    } catch (error: any) {
      this.logError('Custom tool execution failed', error);
      
      if (axios.isAxiosError(error) && error.response) {
        return this.error(`Error del servicio externo: ${error.response.status} - ${error.response.statusText}`);
      }
      
      return this.error(`Error ejecutando herramienta: ${error.message}`);
    }
  }
}

export async function loadCustomToolsForBusiness(businessId: string): Promise<void> {
  try {
    const cached = customToolsCache.get(businessId);
    if (cached && (Date.now() - cached.loadedAt) < CACHE_TTL_MS) {
      return;
    }

    for (const toolName of cached?.tools || []) {
      toolRegistry.unregisterCustomTool(toolName, businessId);
    }

    const customTools = await (prisma as any).customTool?.findMany?.({
      where: {
        businessId,
        isActive: true
      }
    });

    if (!customTools || customTools.length === 0) {
      customToolsCache.set(businessId, { tools: [], loadedAt: Date.now() });
      return;
    }

    const loadedToolNames: string[] = [];

    for (const toolConfig of customTools) {
      const config: CustomToolConfig = {
        id: toolConfig.id,
        name: toolConfig.name,
        description: toolConfig.description,
        endpoint: toolConfig.endpoint,
        method: toolConfig.method || 'POST',
        headers: toolConfig.headers ? JSON.parse(toolConfig.headers) : undefined,
        parameters: toolConfig.parameters ? JSON.parse(toolConfig.parameters) : [],
        responseTemplate: toolConfig.responseTemplate,
        isActive: toolConfig.isActive
      };

      const wrapper = new CustomToolWrapper(config);
      toolRegistry.registerCustomTool(wrapper, businessId);
      loadedToolNames.push(wrapper.name);
    }

    customToolsCache.set(businessId, { tools: loadedToolNames, loadedAt: Date.now() });
    console.log(`[CustomTools] Loaded ${customTools.length} custom tools for business ${businessId}`);
  } catch (error) {
    console.error('[CustomTools] Error loading custom tools:', error);
  }
}

export async function unloadCustomToolsForBusiness(businessId: string): Promise<void> {
  const cached = customToolsCache.get(businessId);
  if (cached) {
    for (const toolName of cached.tools) {
      toolRegistry.unregisterCustomTool(toolName, businessId);
    }
    customToolsCache.delete(businessId);
  }
}

export function invalidateCustomToolsCache(businessId: string): void {
  customToolsCache.delete(businessId);
}
