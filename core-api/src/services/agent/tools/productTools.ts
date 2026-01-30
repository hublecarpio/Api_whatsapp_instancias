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
            description: 'Número máximo de resultados (default: 5)'
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
    this.log('Execute called', args);
    
    const { businessId, instanceId, currencySymbol } = context;
    
    try {
      if (!args.busqueda) {
        return this.error('Debes especificar qué producto buscar.');
      }

      const limit = Math.min(Math.max(1, args.limite || 5), 10);
      
      const searchResult = await searchProductsIntelligent(
        businessId,
        args.busqueda,
        limit,
        instanceId || undefined
      );
      
      const products = searchResult?.products || [];

      if (!products || products.length === 0) {
        return this.success(`No se encontraron productos para "${args.busqueda}". Pregunta si desea buscar algo diferente.`);
      }

      let response = `Productos encontrados para "${args.busqueda}":\n\n`;
      
      for (const product of products) {
        const variation = (product as any).variation ? ` (${(product as any).variation})` : '';
        response += `• ${product.title}${variation}: ${currencySymbol}${product.price}`;
        if ((product as any).stock !== undefined && (product as any).stock !== null) {
          response += ` | Stock: ${(product as any).stock}`;
        }
        if (product.description) {
          response += `\n  ${product.description.slice(0, 80)}...`;
        }
        response += '\n';
      }

      // Incluir datos estructurados de productos para el ToolMemory
      const productData = products.map((product: any) => ({
        id: product.id,
        title: product.title,
        variation: product.variation || null,
        price: product.price,
        stock: product.stock ?? null,
        description: product.description?.slice(0, 100) || null
      }));
      
      return this.success(response, { count: products.length, products: productData });
    } catch (error: any) {
      this.logError('Error searching products', error);
      return this.error(`Error al buscar productos: ${error.message}`);
    }
  }
}

export class ConsultarStockTool extends BaseTool {
  readonly name = 'consultar_stock';
  readonly category: ToolCategory = 'PRODUCT';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: 'Consulta el stock disponible de un producto específico.',
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          producto: {
            type: 'string',
            description: 'Nombre del producto a consultar'
          }
        },
        required: ['producto']
      },
      requiresProducts: true
    };
  }

  isAvailable(context: ToolAvailabilityContext): boolean {
    return context.hasProducts;
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('Execute called', args);
    
    const { businessId, instanceId, currencySymbol } = context;
    
    try {
      if (!args.producto) {
        return this.error('Debes especificar el nombre del producto.');
      }

      const searchResult = await searchProductsIntelligent(
        businessId,
        args.producto,
        3,
        instanceId || undefined
      );
      
      const products = searchResult?.products || [];

      if (!products || products.length === 0) {
        return this.success(`No se encontró el producto "${args.producto}".`);
      }

      const product = products[0] as any;
      const variation = product.variation ? ` (${product.variation})` : '';
      
      let response = `${product.title}${variation}\n`;
      response += `Precio: ${currencySymbol}${product.price}\n`;
      
      if (product.stock !== undefined && product.stock !== null) {
        if (product.stock > 0) {
          response += `Stock disponible: ${product.stock} unidades`;
        } else {
          response += `⚠️ AGOTADO - No hay stock disponible`;
        }
      } else {
        response += `Stock: Sin límite`;
      }

      return this.success(response);
    } catch (error: any) {
      this.logError('Error checking stock', error);
      return this.error(`Error al consultar stock: ${error.message}`);
    }
  }
}

export function registerProductTools(): void {
  toolRegistry.registerTool(new BuscarProductoTool());
  toolRegistry.registerTool(new ConsultarStockTool());
  
  console.log('[ProductTools] All product tools registered');
}
