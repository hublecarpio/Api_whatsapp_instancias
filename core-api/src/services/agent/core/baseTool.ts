import { ITool, ToolCategory, ToolDefinition, ToolContext, ToolResult, ToolAvailabilityContext, ToolDefinitionContext } from './types.js';

export abstract class BaseTool implements ITool {
  abstract readonly name: string;
  abstract readonly category: ToolCategory;
  
  protected abstract buildDefinition(context: ToolDefinitionContext): ToolDefinition;
  
  abstract execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult>;
  
  getDefinition(context: ToolDefinitionContext): ToolDefinition {
    return this.buildDefinition(context);
  }
  
  isAvailable(context: ToolAvailabilityContext): boolean {
    return true;
  }
  
  protected success(content: string, data?: Record<string, any>): ToolResult {
    return { success: true, content, data };
  }
  
  protected error(content: string): ToolResult {
    return { success: false, content };
  }
  
  protected formatCurrency(amount: number, symbol: string): string {
    return `${symbol}${amount.toFixed(2)}`;
  }
  
  protected log(message: string, data?: any): void {
    console.log(`[Tool:${this.name}] ${message}`, data ? JSON.stringify(data) : '');
  }
  
  protected logError(message: string, error: any): void {
    console.error(`[Tool:${this.name}] ERROR: ${message}`, error);
  }
}
