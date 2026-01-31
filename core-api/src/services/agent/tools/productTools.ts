import { BaseTool, ToolCategory, ToolDefinition, ToolContext, ToolResult, ToolAvailabilityContext, ToolDefinitionContext, toolRegistry } from '../core/index.js';
import { searchProductsIntelligent } from '../../productSearch.js';
import prisma from '../../prisma.js';

export class BuscarProductoTool extends BaseTool {
  readonly name = 'buscar_producto';
  readonly category: ToolCategory = 'PRODUCT';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: 'Busca productos en el catálogo por nombre, descripción o categoría. Usa esta función cuando el cliente pregunte por un producto específico o quiera ver opciones.',
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          busqueda: {
            type: 'string',
            description: 'Término de búsqueda (nombre, descripción, categoría)'
          },
          limite: {
            type: 'number',
            description: 'Número máximo de resultados (default: 3, máximo: 10)'
          }
        },
        required: ['busqueda']
      },
      requiresProducts: true
    };
  }

  isAvailable(context: ToolAvailabilityContext): boolean {
    return context.hasProducts;
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const { businessId, instanceId, currencySymbol } = context;
    
    console.log(`[buscar_producto] ═══════════════════════════════════════════════════════`);
    console.log(`[buscar_producto] 🔍 Search query: "${args.busqueda}"`);
    console.log(`[buscar_producto] 📋 Context: businessId=${businessId?.slice(0, 8)}..., instanceId=${instanceId?.slice(0, 8) || 'NONE'}`);
    
    try {
      if (!args.busqueda) {
        console.log(`[buscar_producto] ❌ ERROR: No search term provided`);
        return this.error('Debes especificar qué producto buscar.');
      }

      // Default a 3 resultados para respuestas más concisas, máximo 10 si se especifica
      const limit = Math.min(Math.max(1, args.limite || 3), 10);
      
      console.log(`[buscar_producto] 🔄 Calling searchProductsIntelligent(businessId=${businessId?.slice(0, 8)}, query="${args.busqueda}", limit=${limit}, instanceId=${instanceId?.slice(0, 8) || 'NONE'})`);
      
      const searchResult = await searchProductsIntelligent(
        businessId,
        args.busqueda,
        limit * 2, // Fetch more to account for out-of-stock filtering
        instanceId || undefined
      );
      
      // Filter out products with stock = 0 (out of stock items should not be shown)
      const allProducts = searchResult?.products || [];
      const products = allProducts.filter((p: any) => {
        // If stock is undefined/null, product has unlimited stock - show it
        if (p.stock === undefined || p.stock === null) return true;
        // If stock > 0, show it
        return p.stock > 0;
      }).slice(0, limit); // Apply original limit after filtering
      
      console.log(`[buscar_producto] 📦 Results: ${products.length} products found (filtered ${allProducts.length - products.length} out-of-stock)`);
      if (products.length > 0) {
        console.log(`[buscar_producto] 📋 Top results: ${products.slice(0, 3).map((p: any) => `${p.title} (${p.id?.slice(0, 8)}...)`).join(', ')}`);
      } else {
        console.log(`[buscar_producto] ⚠️ NO PRODUCTS FOUND for "${args.busqueda}"`);
      }

      if (!products || products.length === 0) {
        return this.success(`No se encontraron productos para "${args.busqueda}". Pregunta si desea buscar algo diferente.`);
      }

      let response = `Productos encontrados para "${args.busqueda}":\n\n`;
      
      for (const product of products) {
        const variation = (product as any).variation ? ` (${(product as any).variation})` : '';
        response += `• ${product.title}${variation}: ${currencySymbol}${product.price}`;
        // Stock is internal info - do NOT expose to the agent/customer
        if (product.imageUrl) {
          response += `\n  Imagen: ${product.imageUrl}`;
        }
        if (product.description) {
          response += `\n  ${product.description.slice(0, 80)}...`;
        }
        response += '\n';
      }

      // Incluir datos estructurados de productos para el ToolMemory
      // Note: stock is intentionally excluded - it's internal business info
      const productData = products.map((product: any) => ({
        id: product.id,
        title: product.title,
        variation: product.variation || null,
        price: product.price,
        description: product.description?.slice(0, 100) || null,
        imageUrl: product.imageUrl || null
      }));
      
      return this.success(response, { count: products.length, products: productData });
    } catch (error: any) {
      console.log(`[buscar_producto] ❌ EXCEPTION: ${error.message}`);
      console.log(`[buscar_producto] Stack: ${error.stack?.substring(0, 300)}`);
      this.logError('Error searching products', error);
      return this.error(`Error al buscar productos: ${error.message}`);
    }
  }
}

// DISABLED: ConsultarStockTool - Stock info is internal and should not be exposed to the AI agent
// The agent should not be able to verbalize stock numbers to customers.
// Products with stock=0 are filtered out in buscar_producto instead.
// 
// export class ConsultarStockTool extends BaseTool {
//   readonly name = 'consultar_stock';
//   readonly category: ToolCategory = 'PRODUCT';
//   ...
// }

export function registerProductTools(): void {
  toolRegistry.registerTool(new BuscarProductoTool());
  // ConsultarStockTool disabled - stock info is internal, not for customer verbalization
  
  console.log('[ProductTools] All product tools registered');
}
