import { ITool, ToolDefinition, ToolContext, ToolResult, ToolAvailabilityContext, ToolDefinitionContext, OpenAIToolFormat, toOpenAIFormat } from './types.js';

export class ToolRegistry {
  private static instance: ToolRegistry;
  private tools: Map<string, ITool> = new Map();
  private customTools: Map<string, ITool> = new Map();

  private constructor() {}

  static getInstance(): ToolRegistry {
    if (!ToolRegistry.instance) {
      ToolRegistry.instance = new ToolRegistry();
    }
    return ToolRegistry.instance;
  }

  registerTool(tool: ITool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Overwriting existing tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    console.log(`[ToolRegistry] Registered native tool: ${tool.name} (${tool.category})`);
  }

  registerCustomTool(tool: ITool, businessId: string): void {
    const key = `${businessId}:${tool.name}`;
    this.customTools.set(key, tool);
    console.log(`[ToolRegistry] Registered custom tool: ${tool.name} for business ${businessId}`);
  }

  unregisterCustomTool(toolName: string, businessId: string): void {
    const key = `${businessId}:${toolName}`;
    this.customTools.delete(key);
  }

  getTool(name: string, businessId?: string): ITool | undefined {
    if (businessId) {
      const customKey = `${businessId}:${name}`;
      const customTool = this.customTools.get(customKey);
      if (customTool) return customTool;
    }
    return this.tools.get(name);
  }

  getAvailableTools(context: ToolAvailabilityContext): ITool[] {
    const available: ITool[] = [];
    
    for (const tool of this.tools.values()) {
      if (tool.isAvailable(context)) {
        if (!context.enabledToolNames || context.enabledToolNames.includes(tool.name)) {
          available.push(tool);
        }
      }
    }
    
    // Aplicar mismo filtro de enabledToolNames a custom tools
    for (const [key, tool] of this.customTools.entries()) {
      if (key.startsWith(`${context.businessId}:`)) {
        if (tool.isAvailable(context)) {
          // Custom tools también deben respetar la whitelist del funnel stage
          if (!context.enabledToolNames || context.enabledToolNames.includes(tool.name)) {
            available.push(tool);
          }
        }
      }
    }
    
    return available;
  }

  getToolDefinitions(
    availabilityContext: ToolAvailabilityContext,
    definitionContext: ToolDefinitionContext
  ): ToolDefinition[] {
    const tools = this.getAvailableTools(availabilityContext);
    return tools.map(tool => tool.getDefinition(definitionContext));
  }

  getOpenAITools(
    availabilityContext: ToolAvailabilityContext,
    definitionContext: ToolDefinitionContext
  ): OpenAIToolFormat[] {
    const definitions = this.getToolDefinitions(availabilityContext, definitionContext);
    return definitions.map(toOpenAIFormat);
  }

  async executeTool(
    toolName: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.getTool(toolName, context.businessId);
    
    if (!tool) {
      console.error(`[ToolRegistry] Tool not found: ${toolName}`);
      return {
        success: false,
        content: `Error: Herramienta "${toolName}" no encontrada.`
      };
    }
    
    try {
      console.log(`[ToolRegistry] Executing tool: ${toolName}`, { args, contactPhone: context.contactPhone });
      const result = await tool.execute(args, context);
      console.log(`[ToolRegistry] Tool ${toolName} result:`, { success: result.success });
      return result;
    } catch (error) {
      console.error(`[ToolRegistry] Error executing tool ${toolName}:`, error);
      return {
        success: false,
        content: `Error ejecutando ${toolName}: ${error instanceof Error ? error.message : 'Error desconocido'}`
      };
    }
  }

  getAllToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getToolsByCategory(category: string): ITool[] {
    return Array.from(this.tools.values()).filter(tool => tool.category === category);
  }

  getStats(): { native: number; custom: number; byCategory: Record<string, number> } {
    const byCategory: Record<string, number> = {};
    for (const tool of this.tools.values()) {
      byCategory[tool.category] = (byCategory[tool.category] || 0) + 1;
    }
    return {
      native: this.tools.size,
      custom: this.customTools.size,
      byCategory
    };
  }
}

export const toolRegistry = ToolRegistry.getInstance();
