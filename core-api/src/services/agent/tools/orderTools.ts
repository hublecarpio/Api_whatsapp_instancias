import { BaseTool, ToolCategory, ToolDefinition, ToolContext, ToolResult, ToolAvailabilityContext, ToolDefinitionContext, toolRegistry } from '../core/index.js';
import prisma from '../../prisma.js';
import { createOrder, findProductWithScope, addItemToExistingOrder } from '../../orderService.js';
import { OrderStatus } from '@prisma/client';

export class ConfirmarPedidoTool extends BaseTool {
  readonly name = 'confirmar_pedido';
  readonly category: ToolCategory = 'ORDER';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: `Crea un pedido usando los UUIDs exactos de productos y zona. IMPORTANTE: Usa los productId y deliveryZoneId que obtuviste de buscar_producto y business-info. ${context.zoneDescriptions ? `Zonas: ${context.zoneDescriptions}` : ''}`,
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Lista de productos a ordenar',
            items: {
              type: 'object',
              properties: {
                productId: { type: 'string', description: 'UUID del producto' },
                quantity: { type: 'number', description: 'Cantidad (default: 1)' },
                variation: { type: 'string', description: 'Nombre EXACTO de variación' }
              },
              required: ['productId']
            } as any
          },
          deliveryZoneId: { 
            type: 'string', 
            description: 'UUID de la zona de envío (obtenido de business-info)' 
          },
          nombre_cliente: { 
            type: 'string', 
            description: 'Nombre completo del cliente' 
          },
          direccion: { 
            type: 'string', 
            description: 'Dirección completa de envío' 
          },
          metodo_pago: { 
            type: 'string', 
            enum: ['YAPE', 'PLIN', 'TRANSFERENCIA', 'EFECTIVO', 'OTRO'],
            description: 'Método de pago preferido' 
          },
          notas: { 
            type: 'string', 
            description: 'Notas adicionales (opcional)' 
          },
          descuento_porcentaje: {
            type: 'number',
            description: 'Porcentaje de descuento a aplicar (ej: 20 para 20% de descuento)'
          },
          descuento_razon: {
            type: 'string',
            description: 'Razón del descuento (ej: "2x1 en 100ml", "Promo Black Friday")'
          },
          // Legacy support
          producto: { type: 'string', description: '[LEGACY] Nombre del producto - usa items[] en su lugar' },
          cantidad: { type: 'number', description: '[LEGACY] Cantidad - usa items[] en su lugar' },
          zona_envio: { type: 'string', description: '[LEGACY] Nombre de zona - usa deliveryZoneId en su lugar' }
        },
        required: ['nombre_cliente', 'direccion']
      },
      requiresProducts: true,
      requiresZones: true
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('[CONFIRMAR_PEDIDO] Execute called', args);
    
    const { businessId, instanceId, contactPhone, contactName, currencySymbol } = context;
    const normalizedPhone = contactPhone.replace(/\D/g, '');
    
    try {
      // Check if there's already an active order for this contact
      const existingActiveOrder = await prisma.order.findFirst({
        where: {
          businessId,
          contactPhone: normalizedPhone,
          status: { in: ['AWAITING_VOUCHER', 'PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED'] },
          ...(instanceId ? { instanceId } : {})
        },
        orderBy: { createdAt: 'desc' }
      });
      
      if (existingActiveOrder) {
        this.log('[CONFIRMAR_PEDIDO] Active order detected, redirecting to upselling', { 
          orderId: existingActiveOrder.id, 
          status: existingActiveOrder.status 
        });
        
        // Return a silent instruction for LLM2 to use agregar_producto_orden instead
        // This is NOT shown to the customer - it's internal LLM communication
        return this.success(`[INSTRUCCIÓN INTERNA - NO MOSTRAR AL CLIENTE]
Ya existe una orden activa (ID: ${existingActiveOrder.id}, Estado: ${existingActiveOrder.status}).
Para agregar productos a esta orden, usa: agregar_producto_orden({ productId: "UUID", variation: "EXACTA", quantity: 1 })
NO crees otra orden. Usa agregar_producto_orden para añadir los productos solicitados.`, {
          _internal: true,
          _action: 'USE_AGREGAR_PRODUCTO_ORDEN',
          existingOrderId: existingActiveOrder.id,
          existingOrderStatus: existingActiveOrder.status
        });
      }
      
      if (!args.nombre_cliente || !args.direccion) {
        return this.error('Faltan datos requeridos: nombre_cliente y direccion son obligatorios.');
      }

      // Determine items to add - support both new format (items[]) and legacy format (producto)
      const itemsToCreate: Array<{
        productId: string;
        productTitle: string;
        quantity: number;
        unitPrice: number;
        variation?: string;
        imageUrl?: string | null;
      }> = [];

      // NEW FORMAT: items array with productId UUIDs
      if (args.items && Array.isArray(args.items) && args.items.length > 0) {
        this.log('[CONFIRMAR_PEDIDO] Using new items[] format with UUIDs');
        
        // Validate deliveryZoneId is provided when using new format
        if (!args.deliveryZoneId && !args.zona_envio) {
          return this.error('Falta la zona de envío. Usa deliveryZoneId (UUID) o zona_envio (nombre). Obtén el zoneId de calcular_total_pedido.');
        }
        
        for (const item of args.items) {
          if (!item.productId) {
            this.log('[CONFIRMAR_PEDIDO] Item missing productId, skipping', item);
            continue;
          }
          
          // Fetch product by UUID directly
          const product = await prisma.product.findFirst({
            where: {
              id: item.productId,
              businessId
            }
          });
          
          if (!product) {
            this.log(`[CONFIRMAR_PEDIDO] Product not found by UUID: ${item.productId}`);
            return this.error(`Producto con ID "${item.productId}" no encontrado. Verifica el UUID.`);
          }
          
          itemsToCreate.push({
            productId: product.id,
            productTitle: product.title,
            quantity: Math.max(1, parseInt(item.quantity) || 1),
            unitPrice: product.price,
            variation: item.variation || (product.variations?.[0]) || undefined,
            imageUrl: product.imageUrl
          });
        }
      }
      // LEGACY FORMAT: single producto string
      else if (args.producto) {
        this.log('[CONFIRMAR_PEDIDO] Using legacy producto format');
        
        const product = await findProductWithScope(businessId, args.producto, instanceId);
        if (!product) {
          return this.error(`No se encontró el producto "${args.producto}" en el catálogo.`);
        }
        
        itemsToCreate.push({
          productId: product.id,
          productTitle: product.title,
          quantity: Math.max(1, parseInt(args.cantidad) || 1),
          unitPrice: product.price,
          variation: (product as any).variation || undefined,
          imageUrl: product.imageUrl
        });
      }
      
      if (itemsToCreate.length === 0) {
        return this.error('No se especificaron productos. Usa items: [{productId: "uuid", quantity: 1}] o producto: "nombre"');
      }

      // Determine zone - support both UUID (deliveryZoneId) and name (zona_envio)
      let zone = null;
      
      if (args.deliveryZoneId) {
        this.log('[CONFIRMAR_PEDIDO] Looking up zone by UUID:', args.deliveryZoneId);
        zone = await prisma.deliveryZone.findFirst({
          where: {
            id: args.deliveryZoneId,
            businessId
          }
        });
        if (!zone) {
          this.log(`[CONFIRMAR_PEDIDO] Zone not found by UUID: ${args.deliveryZoneId}`);
        }
      }
      
      if (!zone && args.zona_envio) {
        this.log('[CONFIRMAR_PEDIDO] Falling back to zone name search:', args.zona_envio);
        zone = await prisma.deliveryZone.findFirst({
          where: {
            businessId,
            name: { contains: args.zona_envio, mode: 'insensitive' }
          }
        });
      }

      // Calculate totals
      const subtotal = itemsToCreate.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
      let shippingCost = 0;
      
      if (zone) {
        if (zone.freeAbove && subtotal >= zone.freeAbove) {
          shippingCost = 0;
        } else {
          shippingCost = zone.cost || 0;
        }
      }
      
      // Calculate discount if provided
      const discountPercent = args.descuento_porcentaje ? parseFloat(args.descuento_porcentaje) : 0;
      const discountReason = args.descuento_razon || undefined;
      let discountAmount = 0;
      
      if (discountPercent > 0 && discountPercent <= 100) {
        discountAmount = (subtotal * discountPercent) / 100;
        this.log('[CONFIRMAR_PEDIDO] Applying discount', { 
          discountPercent, 
          discountReason, 
          subtotal, 
          discountAmount 
        });
      }
      
      const total = subtotal + shippingCost - discountAmount;

      // Create order with items
      const notesWithPayment = args.metodo_pago 
        ? JSON.stringify({ paymentMethod: args.metodo_pago, userNotes: args.notas || '' })
        : args.notas || undefined;
        
      const order = await prisma.order.create({
        data: {
          businessId,
          instanceId: instanceId || undefined,
          contactPhone: normalizedPhone,
          contactName: args.nombre_cliente,
          shippingAddress: args.direccion,
          deliveryZoneId: zone?.id,
          subtotalAmount: subtotal,
          shippingCost,
          discountType: discountPercent > 0 ? 'PERCENTAGE' : undefined,
          discountValue: discountPercent > 0 ? discountPercent : undefined,
          discountAmount: discountAmount > 0 ? discountAmount : undefined,
          promotionName: discountReason,
          totalAmount: total,
          pendingAmount: total,
          currencySymbol,
          notes: notesWithPayment,
          status: 'AWAITING_VOUCHER',
          items: {
            create: itemsToCreate.map(item => ({
              productId: item.productId,
              productTitle: item.productTitle,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              variation: item.variation,
              imageUrl: item.imageUrl
            }))
          }
        },
        include: { items: true }
      }) as any;

      const orderIdShort = order.id.slice(-6).toUpperCase();
      
      // Build items summary
      const itemsSummary = itemsToCreate.map(item => {
        const variation = item.variation ? ` (${item.variation})` : '';
        return `• ${item.productTitle}${variation} x${item.quantity} = ${currencySymbol}${(item.unitPrice * item.quantity).toFixed(2)}`;
      }).join('\n');
      
      this.log('[CONFIRMAR_PEDIDO] Order created successfully', { 
        orderId: order.id, 
        itemsCount: order.items?.length || itemsToCreate.length,
        total,
        discountAmount,
        discountPercent
      });
      
      // Build discount line if applicable
      const discountLine = discountAmount > 0 
        ? `Descuento${discountReason ? ` (${discountReason})` : ''}: -${currencySymbol}${discountAmount.toFixed(2)} (${discountPercent}%)\n` 
        : '';
      
      return this.success(`PEDIDO CONFIRMADO #${orderIdShort}

${itemsSummary}
━━━━━━━━━━━━━━━━━━━━
Subtotal: ${currencySymbol}${subtotal.toFixed(2)}
${discountLine}Envío${zone ? ` (${zone.name})` : ''}: ${currencySymbol}${shippingCost.toFixed(2)}
TOTAL: ${currencySymbol}${total.toFixed(2)}

Cliente: ${args.nombre_cliente}
Dirección: ${args.direccion}
${args.metodo_pago ? `Pago: ${args.metodo_pago}` : ''}

Estado: Esperando comprobante de pago`, { 
        orderId: order.id,
        orderIdShort,
        total,
        itemsCount: order.items?.length || itemsToCreate.length,
        discountApplied: discountAmount > 0,
        discountAmount,
        discountPercent,
        discountReason
      });
    } catch (error: any) {
      this.logError('Error creating order', error);
      return this.error(`Error al crear pedido: ${error.message}`);
    }
  }
}

export class AgregarProductoTool extends BaseTool {
  readonly name = 'agregar_producto_orden';
  readonly category: ToolCategory = 'ORDER';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: 'Agrega un producto adicional a la orden activa del cliente. IMPORTANTE: Usa productId UUID y variation EXACTA de buscar_producto.',
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          productId: { 
            type: 'string', 
            description: 'UUID del producto (obtenido de buscar_producto)' 
          },
          variation: { 
            type: 'string', 
            description: 'Variación EXACTA del producto como viene de buscar_producto (ej: "100 ml", "50 ml")' 
          },
          quantity: { 
            type: 'number', 
            description: 'Cantidad a agregar (default: 1)' 
          },
          producto: { 
            type: 'string', 
            description: '[DEPRECATED] Nombre del producto - usar productId en su lugar' 
          }
        },
        required: []
      },
      requiresActiveOrder: true
    };
  }

  isAvailable(context: ToolAvailabilityContext): boolean {
    return context.hasActiveOrder;
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('Execute called', args);
    
    const { businessId, instanceId, contactPhone, currencySymbol } = context;
    const normalizedPhone = contactPhone.replace(/\D/g, '');
    
    try {
      let product: any = null;
      
      // NEW FORMAT: Use productId UUID directly
      if (args.productId) {
        this.log('[AGREGAR_PRODUCTO] Using productId UUID:', args.productId);
        
        // Find product by UUID
        product = await prisma.product.findFirst({
          where: {
            id: args.productId,
            businessId
          }
        });
        
        if (!product) {
          return this.error(`No se encontró el producto con ID "${args.productId}".`);
        }
        
        // If variation specified, find matching variation in arrays for correct price
        if (args.variation && product.variations && product.variations.length > 0) {
          const variationIndex = product.variations.findIndex(
            (v: string) => v === args.variation // EXACT match required
          );
          
          if (variationIndex !== -1) {
            const variationPrice = product.pricePerVariation?.[variationIndex] ?? product.price;
            const variationStock = product.stockPerVariation?.[variationIndex] ?? product.stock;
            this.log('[AGREGAR_PRODUCTO] Found variation:', { 
              name: args.variation, 
              price: variationPrice,
              index: variationIndex 
            });
            product = {
              ...product,
              price: variationPrice,
              variation: args.variation,
              stock: variationStock
            };
          } else {
            this.log('[AGREGAR_PRODUCTO] Variation not found in array, using base product');
          }
        }
      } 
      // FALLBACK: Legacy format with producto name
      else if (args.producto) {
        this.log('[AGREGAR_PRODUCTO] Using legacy producto name:', args.producto);
        product = await findProductWithScope(businessId, args.producto, instanceId);
        if (!product) {
          return this.error(`No se encontró el producto "${args.producto}" en el catálogo.`);
        }
      } else {
        return this.error('Falta productId (UUID del producto). Usa buscar_producto primero para obtener el UUID.');
      }

      const quantity = Math.max(1, parseInt(args.quantity || args.cantidad) || 1);
      
      const result = await addItemToExistingOrder(
        businessId,
        normalizedPhone,
        {
          productId: product.id,
          productTitle: product.title,
          quantity,
          unitPrice: product.price,
          imageUrl: product.imageUrl,
          variation: product.variation || null
        },
        instanceId || undefined
      );

      if (!result.success) {
        return this.error(`Error al agregar producto: ${result.reason}`);
      }

      const variationInfo = product.variation ? ` (${product.variation})` : '';
      const itemTotal = product.price * quantity;

      return this.success(`Producto agregado exitosamente.
- ${product.title}${variationInfo} x${quantity} = ${currencySymbol}${itemTotal.toFixed(2)}
- Nuevo total del pedido: ${currencySymbol}${result.newTotal?.toFixed(2) || 'N/A'}`, {
        productId: product.id,
        variation: product.variation,
        quantity,
        unitPrice: product.price,
        newTotal: result.newTotal
      });
    } catch (error: any) {
      this.logError('Error adding product', error);
      return this.error(`Error al agregar producto: ${error.message}`);
    }
  }
}

export class ConsultarPedidoTool extends BaseTool {
  readonly name = 'consultar_pedido';
  readonly category: ToolCategory = 'ORDER';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: 'Consulta el estado actual del pedido del cliente.',
      category: this.category,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('Execute called');
    
    const { businessId, instanceId, contactPhone, currencySymbol } = context;
    const normalizedPhone = contactPhone.replace(/\D/g, '');
    
    try {
      const order = await prisma.order.findFirst({
        where: {
          businessId,
          contactPhone: normalizedPhone,
          status: { in: ['AWAITING_VOUCHER', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] },
          ...(instanceId ? { instanceId } : {})
        },
        orderBy: { createdAt: 'desc' },
        include: { items: true }
      });

      if (!order) {
        return this.success('El cliente no tiene pedidos activos.');
      }

      const orderId = order.id.slice(-6).toUpperCase();
      let response = `PEDIDO #${orderId}\nEstado: ${order.status}\n`;
      
      if (order.items && order.items.length > 0) {
        response += '\nProductos:\n';
        for (const item of order.items) {
          response += `• ${item.productTitle} x${item.quantity} = ${currencySymbol}${(item.unitPrice * item.quantity).toFixed(2)}\n`;
        }
      }
      
      response += `\nTotal: ${currencySymbol}${order.totalAmount.toFixed(2)}`;
      
      if (order.paidAmount > 0) {
        response += `\nPagado: ${currencySymbol}${order.paidAmount.toFixed(2)}`;
        const pending = order.totalAmount - order.paidAmount;
        if (pending > 0) {
          response += `\nPendiente: ${currencySymbol}${pending.toFixed(2)}`;
        }
      }

      return this.success(response);
    } catch (error: any) {
      this.logError('Error querying order', error);
      return this.error(`Error al consultar pedido: ${error.message}`);
    }
  }
}

export class ConfirmarEntregaTool extends BaseTool {
  readonly name = 'confirmar_entrega';
  readonly category: ToolCategory = 'ORDER';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: 'Marca el pedido como entregado cuando el cliente confirma que recibió su pedido.',
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          notas: { 
            type: 'string', 
            description: 'Notas sobre la entrega (opcional)' 
          }
        },
        required: []
      },
      requiresActiveOrder: true
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('Execute called', args);
    
    const { businessId, instanceId, contactPhone } = context;
    const normalizedPhone = contactPhone.replace(/\D/g, '');
    
    try {
      const order = await prisma.order.findFirst({
        where: {
          businessId,
          contactPhone: normalizedPhone,
          status: { in: ['PAID', 'PROCESSING', 'SHIPPED'] },
          ...(instanceId ? { instanceId } : {})
        },
        orderBy: { createdAt: 'desc' }
      });

      if (!order) {
        return this.error('No se encontró un pedido que pueda marcarse como entregado.');
      }

      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: 'DELIVERED',
          deliveredAt: new Date(),
          notes: (order.notes || '') + (args.notas ? `\nEntrega: ${args.notas}` : '\nEntrega confirmada')
        }
      });

      return this.success(`Pedido #${order.id.slice(-6).toUpperCase()} marcado como ENTREGADO. ¡Gracias por confirmar!`);
    } catch (error: any) {
      this.logError('Error confirming delivery', error);
      return this.error(`Error al confirmar entrega: ${error.message}`);
    }
  }
}

export class CalcularTotalTool extends BaseTool {
  readonly name = 'calcular_total_pedido';
  readonly category: ToolCategory = 'ORDER';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: `OBLIGATORIO: Usa esta herramienta SIEMPRE antes de confirmar un pedido. Calcula subtotal + envío = total exacto. ${context.zoneDescriptions ? `Zonas: ${context.zoneDescriptions}` : ''}`,
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          productos: {
            type: 'array',
            description: 'Lista de productos con cantidad',
            items: {
              type: 'object',
              properties: {
                nombre: { type: 'string', description: 'Nombre del producto' },
                cantidad: { type: 'number', description: 'Cantidad' }
              },
              required: ['nombre']
            } as any
          },
          zona_envio: {
            type: 'string',
            description: 'Nombre de la zona de envío'
          }
        },
        required: ['productos', 'zona_envio']
      },
      isObligatory: true,
      obligatoryContext: 'Antes de confirmar pedido o dar precio total'
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('Execute called', args);
    
    const { businessId, instanceId, currencySymbol } = context;
    
    try {
      if (!args.productos || args.productos.length === 0) {
        return this.error('No se especificaron productos.');
      }
      
      if (!args.zona_envio) {
        return this.error('No se especificó la zona de envío.');
      }

      const zones = await prisma.deliveryZone.findMany({
        where: { businessId, isActive: true }
      });

      const zonaNorm = args.zona_envio.toLowerCase().trim();
      
      // First try: exact zone name match
      let matchedZone = zones.find(z => 
        z.name.toLowerCase().includes(zonaNorm) || zonaNorm.includes(z.name.toLowerCase())
      );

      // Second try: match by district name (smart zone detection)
      if (!matchedZone) {
        for (const zone of zones) {
          if (zone.districts && Array.isArray(zone.districts)) {
            const districtMatch = zone.districts.some((district: string) => {
              const districtNorm = district.toLowerCase().trim();
              // Check if input contains district or district contains input
              return districtNorm.includes(zonaNorm) || zonaNorm.includes(districtNorm);
            });
            if (districtMatch) {
              matchedZone = zone;
              console.log(`[CALCULAR_TOTAL] Smart zone match: "${args.zona_envio}" -> ${zone.name} (matched by district)`);
              break;
            }
          }
        }
      }

      if (!matchedZone) {
        // Build helpful error with zone names and sample districts
        const zoneInfo = zones.map(z => {
          const sampleDistricts = z.districts?.slice(0, 3).join(', ') || '';
          return `${z.name}${sampleDistricts ? ` (incluye: ${sampleDistricts})` : ''}`;
        }).join('; ');
        return this.error(`Zona o distrito "${args.zona_envio}" no encontrado. Zonas disponibles: ${zoneInfo}`);
      }

      let subtotal = 0;
      const details: string[] = [];
      const notFound: string[] = [];

      for (const item of args.productos) {
        const nombre = item.nombre || item.name || item.producto;
        const cantidad = Math.max(1, item.cantidad || item.quantity || 1);
        
        const product = await findProductWithScope(businessId, nombre, instanceId);
        
        if (product) {
          const itemTotal = product.price * cantidad;
          subtotal += itemTotal;
          const variation = product.variation ? ` (${product.variation})` : '';
          details.push(`• ${product.title}${variation} x${cantidad} = ${currencySymbol}${itemTotal.toFixed(2)}`);
        } else {
          notFound.push(nombre);
        }
      }

      if (details.length === 0) {
        return this.error(`Productos no encontrados: ${notFound.join(', ')}`);
      }

      const freeAbove = matchedZone.freeAbove;
      const qualifiesFree = freeAbove !== null && subtotal >= freeAbove;
      const shipping = qualifiesFree ? 0 : (matchedZone.cost || 0);
      const total = subtotal + shipping;

      let response = `CÁLCULO DE PEDIDO:
${details.join('\n')}

📦 Subtotal: ${currencySymbol}${subtotal.toFixed(2)}
🚚 Envío (${matchedZone.name}): ${currencySymbol}${shipping.toFixed(2)}${qualifiesFree ? ' (GRATIS)' : ''}
━━━━━━━━━━━━━━━━━━━━
💰 TOTAL: ${currencySymbol}${total.toFixed(2)}`;

      if (notFound.length > 0) {
        response += `\n\n⚠️ No encontrados: ${notFound.join(', ')}`;
      }

      if (freeAbove && !qualifiesFree) {
        response += `\n\n💡 Envío gratis desde ${currencySymbol}${freeAbove.toFixed(2)}`;
      }

      return this.success(response, { subtotal, shipping, total, zone: matchedZone.name, zoneId: matchedZone.id });
    } catch (error: any) {
      this.logError('Error calculating total', error);
      return this.error(`Error al calcular total: ${error.message}`);
    }
  }
}

export class RegistrarVoucherTool extends BaseTool {
  readonly name = 'registrar_voucher_pago';
  readonly category: ToolCategory = 'PAYMENT';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: `Registra un voucher de pago para una orden existente.
IMPORTANTE: Usa el orderId de la memoria (obtenido de confirmar_pedido).
Estructura requerida: { orderId, voucherImageUrl, amount, paymentMethod, autoConfirm }
- Si amount + pagos anteriores >= totalAmount → Estado = PAID
- Si amount + pagos anteriores < totalAmount → Solicitar pago restante`,
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          orderId: {
            type: 'string',
            description: 'UUID de la orden (REQUERIDO - obtenido de confirmar_pedido en memoria)'
          },
          voucherImageUrl: {
            type: 'string',
            description: 'URL de la imagen del voucher/comprobante de pago'
          },
          amount: {
            type: 'number',
            description: 'Monto del voucher detectado'
          },
          paymentMethod: {
            type: 'string',
            description: 'Método de pago: YAPE, PLIN, TRANSFERENCIA, BCP, INTERBANK, etc.'
          },
          autoConfirm: {
            type: 'boolean',
            description: 'Si es true y el monto completa el pago, confirma automáticamente. Default: false'
          }
        },
        required: ['orderId', 'amount']
      },
      requiresActiveOrder: true
    };
  }

  isAvailable(context: ToolAvailabilityContext): boolean {
    return context.hasActiveOrder;
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('[VOUCHER-TOOL] Execute called', args);
    
    const { businessId, currencySymbol, geminiVoucherResult } = context;
    
    // Debug: Log what we received from args vs context fallback
    this.log('[VOUCHER-TOOL] Data sources:', {
      fromArgs: {
        voucherImageUrl: args.voucherImageUrl || 'NOT PROVIDED',
        paymentMethod: args.paymentMethod || 'NOT PROVIDED',
        amount: args.amount || 'NOT PROVIDED'
      },
      fromContext: {
        hasGeminiResult: !!geminiVoucherResult,
        brand: geminiVoucherResult?.brand || 'N/A',
        amount: geminiVoucherResult?.amount || 'N/A',
        imageUrl: geminiVoucherResult?.imageUrl ? 'AVAILABLE' : 'MISSING'
      }
    });
    
    try {
      // Validate required parameters - matching endpoint structure
      if (!args.orderId) {
        return this.error('Falta el orderId. Usa el orderId de la memoria (obtenido de confirmar_pedido).');
      }
      
      // Parameter names matching endpoint: { orderId, voucherImageUrl, amount, paymentMethod, autoConfirm }
      // Priority: explicit args > geminiVoucherResult fallback > default
      const voucherAmount = args.amount || geminiVoucherResult?.amount || 0;
      const paymentMethod = args.paymentMethod || geminiVoucherResult?.brand || 'Desconocido';
      const voucherImageUrl = args.voucherImageUrl || geminiVoucherResult?.imageUrl || null;
      
      this.log('[VOUCHER-TOOL] Final values after fallback:', { voucherAmount, paymentMethod, voucherImageUrl: voucherImageUrl ? 'SET' : 'NULL' });
      const autoConfirm = args.autoConfirm ?? false;
      
      // STRICT VALIDATION: Require real voucher data from Gemini analysis
      // A valid voucher MUST have: amount > 0, valid imageUrl, and a recognized payment method
      if (!voucherImageUrl || !voucherImageUrl.startsWith('http')) {
        this.log('[VOUCHER-TOOL] REJECTED: Missing or invalid image URL');
        return this.error(`No se detectó imagen de comprobante válida.

Para registrar el pago necesito una captura o foto del comprobante de pago donde se vea claramente el monto, banco/app y fecha.`);
      }
      
      if (voucherAmount <= 0) {
        this.log('[VOUCHER-TOOL] REJECTED: Amount is 0 or negative');
        return this.error('No se pudo detectar el monto del voucher. Envía una imagen más clara o indica el monto exacto.');
      }
      
      if (!paymentMethod || paymentMethod === 'Desconocido' || paymentMethod === 'N/A') {
        this.log('[VOUCHER-TOOL] REJECTED: Unknown payment method');
        return this.error('No se identificó el método de pago. ¿Por qué medio realizaste el pago? (Yape, Plin, BCP, etc.)');
      }
      
      this.log('[VOUCHER-TOOL] Looking up order by UUID:', args.orderId);
      const order = await prisma.order.findFirst({
        where: {
          id: args.orderId,
          businessId,
          status: { in: [OrderStatus.AWAITING_VOUCHER, OrderStatus.PENDING_PAYMENT] }
        },
        include: { items: true }
      });

      if (!order) {
        this.log('[VOUCHER-TOOL] No active order found for orderId:', args.orderId);
        return this.error(`No se encontró un pedido activo con id ${args.orderId}. Verifica el orderId de la memoria.`);
      }

      const currentPaid = order.paidAmount || 0;
      const newPaidAmount = currentPaid + voucherAmount;
      const pendingAfter = Math.max(0, order.totalAmount - newPaidAmount);
      const isFullyPaid = newPaidAmount >= order.totalAmount;

      this.log('[VOUCHER-REASONING]', {
        orderId: order.id.slice(-6),
        totalAmount: order.totalAmount,
        previousPaid: currentPaid,
        voucherAmount,
        newPaidAmount,
        pendingAfter,
        autoConfirm,
        decision: isFullyPaid ? 'FULLY_PAID' : 'PARTIAL_PAYMENT'
      });

      // Build payment history entry matching endpoint structure
      const paymentEntry = {
        amount: voucherAmount,
        brand: paymentMethod,
        imageUrl: voucherImageUrl,
        timestamp: new Date().toISOString(),
        type: 'VOUCHER'
      };

      let existingNotes: any = {};
      try {
        existingNotes = order.notes ? JSON.parse(order.notes) : {};
      } catch (e) {
        this.log('[VOUCHER-TOOL] Could not parse existing notes, using empty object');
        existingNotes = { legacyNotes: order.notes };
      }
      const paymentHistory = existingNotes.paymentHistory || [];
      paymentHistory.push(paymentEntry);

      // Determine new status - matching endpoint logic with autoConfirm support
      let newStatus = order.status;
      if (autoConfirm && isFullyPaid) {
        newStatus = OrderStatus.PAID;
      } else if (voucherAmount > 0) {
        newStatus = isFullyPaid ? OrderStatus.PAID : OrderStatus.AWAITING_VOUCHER;
      }

      // Update order matching endpoint structure
      await prisma.order.update({
        where: { id: order.id },
        data: {
          voucherImageUrl: voucherImageUrl,
          voucherReceivedAt: new Date(),
          paidAmount: newPaidAmount,
          pendingAmount: pendingAfter,
          lastVoucherAmount: voucherAmount,
          status: newStatus,
          paidAt: newStatus === OrderStatus.PAID ? new Date() : order.paidAt,
          notes: JSON.stringify({
            ...existingNotes,
            paymentHistory,
            lastVoucherBank: paymentMethod
          })
        }
      });

      const orderIdShort = order.id.slice(-6).toUpperCase();

      if (isFullyPaid) {
        this.log(`[VOUCHER-TOOL] Order ${orderIdShort} FULLY PAID`);
        return this.success(`✅ PAGO COMPLETO REGISTRADO

Pedido #${orderIdShort}
Voucher recibido: ${currencySymbol}${voucherAmount.toFixed(2)} (${paymentMethod})

Total pagado: ${currencySymbol}${newPaidAmount.toFixed(2)}
Total del pedido: ${currencySymbol}${order.totalAmount.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━
Estado: PAGADO ✓

El pedido está listo para ser procesado.`, { 
          orderId: order.id, 
          status: 'PAID', 
          fullyPaid: true 
        });
      } else {
        this.log(`[VOUCHER-TOOL] Order ${orderIdShort} PARTIAL PAYMENT, pending: ${pendingAfter}`);
        // NOTE: Message is purely informational - no instructions on what to do next
        // The business's master prompt should define the next step (dispatch data, request more payment, etc.)
        return this.success(`💳 PAGO REGISTRADO

Pedido #${orderIdShort}
Voucher recibido: ${currencySymbol}${voucherAmount.toFixed(2)} (${paymentMethod})

Resumen de pagos:
• Total del pedido: ${currencySymbol}${order.totalAmount.toFixed(2)}
• Pagado hasta ahora: ${currencySymbol}${newPaidAmount.toFixed(2)}
• Saldo pendiente: ${currencySymbol}${pendingAfter.toFixed(2)}`, { 
          orderId: order.id, 
          status: 'AWAITING_VOUCHER', 
          fullyPaid: false,
          paidAmount: newPaidAmount,
          pendingAmount: pendingAfter 
        });
      }
    } catch (error: any) {
      this.logError('[VOUCHER-TOOL] Error processing voucher', error);
      return this.error(`Error al procesar voucher: ${error.message}`);
    }
  }
}

export class ProcesarVoucherInteligenteTool extends BaseTool {
  readonly name = 'procesar_voucher_inteligente';
  readonly category: ToolCategory = 'PAYMENT';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: `Procesa un voucher/comprobante de pago de forma inteligente:
1. Si hay orden activa → registra el pago en esa orden
2. Si NO hay orden pero el cliente tiene carrito con productos y datos → crea la orden automáticamente y registra el pago
3. Si no hay datos suficientes → indica qué falta

USAR SIEMPRE que llegue un voucher de pago. Los datos del voucher (monto, método, URL) se obtienen automáticamente del análisis de Gemini.`,
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          orderId: {
            type: 'string',
            description: 'UUID de la orden (opcional - si no se proporciona, busca orden activa o crea una nueva)'
          },
          amount: {
            type: 'number',
            description: 'Monto del voucher (se obtiene automáticamente del análisis de imagen)'
          },
          paymentMethod: {
            type: 'string',
            description: 'Método de pago: YAPE, PLIN, TRANSFERENCIA, etc.'
          },
          voucherImageUrl: {
            type: 'string',
            description: 'URL de la imagen del voucher (se obtiene automáticamente)'
          },
          nombre_cliente: {
            type: 'string',
            description: 'Nombre del cliente (requerido si se debe crear orden)'
          },
          direccion: {
            type: 'string',
            description: 'Dirección de envío (requerida si se debe crear orden)'
          }
        },
        required: []
      }
    };
  }

  isAvailable(context: ToolAvailabilityContext): boolean {
    return context.hasVoucherContext === true || context.hasActiveOrder || context.hasSessionCart === true;
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('[VOUCHER-INTELIGENTE] Execute called', args);
    
    const { businessId, instanceId, contactPhone, contactName, currencySymbol, geminiVoucherResult, extractedData } = context;
    const normalizedPhone = contactPhone.replace(/\D/g, '');
    
    // Get voucher data from args or geminiVoucherResult fallback
    const voucherAmount = args.amount || geminiVoucherResult?.amount || 0;
    const paymentMethod = args.paymentMethod || geminiVoucherResult?.brand || 'Desconocido';
    const voucherImageUrl = args.voucherImageUrl || geminiVoucherResult?.imageUrl || null;
    
    this.log('[VOUCHER-INTELIGENTE] Voucher data:', {
      amount: voucherAmount,
      method: paymentMethod,
      hasImageUrl: !!voucherImageUrl,
      fromArgs: { amount: args.amount, method: args.paymentMethod, url: args.voucherImageUrl ? 'YES' : 'NO' },
      fromGemini: { amount: geminiVoucherResult?.amount, method: geminiVoucherResult?.brand, url: geminiVoucherResult?.imageUrl ? 'YES' : 'NO' }
    });
    
    // STRICT VALIDATION: Require real voucher data from Gemini analysis
    // A valid voucher MUST have: amount > 0, valid imageUrl, and a recognized payment method
    if (!voucherImageUrl || !voucherImageUrl.startsWith('http')) {
      this.log('[VOUCHER-INTELIGENTE] REJECTED: Missing or invalid image URL');
      return this.error(`No se detectó imagen de comprobante válida.

Para registrar tu pago necesito que envíes una captura o foto del comprobante de pago (Yape, Plin, transferencia, etc.) donde se vea claramente:
- El monto transferido
- El banco o aplicación usada
- La fecha/hora de la operación`);
    }
    
    if (voucherAmount <= 0) {
      this.log('[VOUCHER-INTELIGENTE] REJECTED: Amount is 0 or negative');
      return this.error(`No se pudo detectar el monto del voucher en la imagen.

Por favor envía una imagen más clara del comprobante donde se vea el monto de la transferencia, o indícame el monto exacto que depositaste.`);
    }
    
    if (!paymentMethod || paymentMethod === 'Desconocido' || paymentMethod === 'N/A') {
      this.log('[VOUCHER-INTELIGENTE] REJECTED: Unknown payment method');
      return this.error(`No se pudo identificar el método de pago en el comprobante.

¿Por qué medio realizaste el pago? (Yape, Plin, BCP, Interbank, etc.)`);
    }
    
    try {
      // Step 1: Try to find existing active order
      let order = await prisma.order.findFirst({
        where: {
          businessId,
          contactPhone: normalizedPhone,
          status: { in: [OrderStatus.AWAITING_VOUCHER, OrderStatus.PENDING_PAYMENT] },
          ...(instanceId ? { instanceId } : {})
        },
        include: { items: true },
        orderBy: { createdAt: 'desc' }
      });
      
      // If orderId provided, try that specific order
      if (!order && args.orderId) {
        order = await prisma.order.findFirst({
          where: {
            id: args.orderId,
            businessId,
            status: { in: [OrderStatus.AWAITING_VOUCHER, OrderStatus.PENDING_PAYMENT] }
          },
          include: { items: true }
        });
      }
      
      this.log('[VOUCHER-INTELIGENTE] Order lookup:', { found: !!order, orderId: order?.id?.slice(0, 8) || 'NONE' });
      
      // Step 2: If no order, try to create one from session data
      if (!order) {
        this.log('[VOUCHER-INTELIGENTE] No active order found, checking session cart...');
        
        // Get session cart from extracted data OR load from DB directly
        let sessionCart = extractedData?.['_session_cart'];
        
        // If not in extractedData, load directly from ContactExtractedData
        if (!sessionCart) {
          this.log('[VOUCHER-INTELIGENTE] Session cart not in extractedData, loading from DB...');
          const sessionRecord = await prisma.contactExtractedData.findUnique({
            where: {
              businessId_contactPhone_fieldKey: {
                businessId,
                contactPhone: normalizedPhone,
                fieldKey: '_session_cart'
              }
            }
          });
          if (sessionRecord?.fieldValue) {
            sessionCart = sessionRecord.fieldValue;
            this.log('[VOUCHER-INTELIGENTE] Loaded session cart from DB');
          }
        }
        
        if (!sessionCart) {
          this.log('[VOUCHER-INTELIGENTE] No session cart found');
          return this.error(`No hay pedido activo para registrar este voucher.
          
Para procesar tu pago necesito:
1. Primero confirmar qué productos deseas
2. Tu nombre y dirección de envío
3. Zona de envío

¿Puedes indicarme qué productos te interesan?`);
        }
        
        const session = typeof sessionCart === 'string' ? JSON.parse(sessionCart) : sessionCart;
        const products = session.products || [];
        const totals = session.totals || {};
        
        this.log('[VOUCHER-INTELIGENTE] Session cart data:', {
          productCount: products.length,
          hasTotal: !!totals.total,
          total: totals.total
        });
        
        if (products.length === 0) {
          return this.error(`Recibí tu comprobante de pago pero aún no tienes productos en tu carrito.

Por favor indícame qué productos deseas ordenar para poder crear tu pedido.`);
        }
        
        // Check for required customer data
        const nombre = args.nombre_cliente || extractedData?.nombre || extractedData?.name || contactName;
        const direccion = args.direccion || extractedData?.direccion || extractedData?.address;
        
        if (!nombre || !direccion) {
          const missing: string[] = [];
          if (!nombre) missing.push('nombre completo');
          if (!direccion) missing.push('dirección de envío');
          
          return this.error(`Recibí tu voucher de ${currencySymbol}${voucherAmount.toFixed(2)} pero necesito los siguientes datos para crear tu pedido:

${missing.map(m => `• ${m}`).join('\n')}

Por favor proporcióname estos datos para completar tu orden.`);
        }
        
        // Create order from session cart
        this.log('[VOUCHER-INTELIGENTE] Creating order from session cart...');
        
        const orderItems = products.map((p: any) => ({
          productId: p.id,
          productTitle: p.title,
          quantity: p.quantity || 1,
          unitPrice: p.price,
          variation: p.variation,
          imageUrl: p.imageUrl
        }));
        
        const subtotal = totals.subtotal || orderItems.reduce((sum: number, item: any) => sum + (item.unitPrice * item.quantity), 0);
        const shipping = totals.shipping || 0;
        const totalAmount = totals.total || (subtotal + shipping);
        
        const createdOrder = await prisma.order.create({
          data: {
            businessId,
            instanceId,
            contactPhone: normalizedPhone,
            contactName: nombre,
            shippingAddress: direccion,
            deliveryZoneId: totals.zoneId || null,
            status: OrderStatus.AWAITING_VOUCHER,
            subtotalAmount: subtotal,
            shippingCost: shipping,
            totalAmount: totalAmount,
            notes: JSON.stringify({ preferredPaymentMethod: paymentMethod }),
            items: {
              create: orderItems.map((item: any) => ({
                productId: item.productId,
                productTitle: item.productTitle,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                variation: item.variation,
                imageUrl: item.imageUrl
              }))
            }
          },
          include: { items: true }
        });
        order = createdOrder;
        
        this.log('[VOUCHER-INTELIGENTE] Order created:', { orderId: order.id.slice(0, 8), total: totalAmount });
      }
      
      // At this point order must exist
      if (!order) {
        return this.error('No se pudo encontrar o crear una orden para este voucher.');
      }
      
      // Step 3: Register the voucher on the order
      const currentPaid = order.paidAmount || 0;
      const newPaidAmount = currentPaid + voucherAmount;
      const pendingAfter = Math.max(0, order.totalAmount - newPaidAmount);
      const isFullyPaid = newPaidAmount >= order.totalAmount;
      
      this.log('[VOUCHER-INTELIGENTE] Payment calculation:', {
        orderTotal: order.totalAmount,
        previousPaid: currentPaid,
        voucherAmount,
        newPaidAmount,
        pendingAfter,
        isFullyPaid
      });
      
      // Build payment history
      const paymentEntry = {
        amount: voucherAmount,
        brand: paymentMethod,
        imageUrl: voucherImageUrl,
        timestamp: new Date().toISOString(),
        type: 'VOUCHER'
      };
      
      let existingNotes: any = {};
      try {
        existingNotes = order.notes ? JSON.parse(order.notes) : {};
      } catch { 
        existingNotes = { legacyNotes: order.notes }; 
      }
      const paymentHistory = existingNotes.paymentHistory || [];
      paymentHistory.push(paymentEntry);
      
      const newStatus = isFullyPaid ? OrderStatus.PAID : OrderStatus.AWAITING_VOUCHER;
      
      // Update order
      await prisma.order.update({
        where: { id: order.id },
        data: {
          voucherImageUrl: voucherImageUrl,
          voucherReceivedAt: new Date(),
          paidAmount: newPaidAmount,
          pendingAmount: pendingAfter,
          lastVoucherAmount: voucherAmount,
          status: newStatus,
          paidAt: newStatus === OrderStatus.PAID ? new Date() : order.paidAt,
          notes: JSON.stringify({
            ...existingNotes,
            paymentHistory,
            lastVoucherBank: paymentMethod
          })
        }
      });
      
      const orderIdShort = order.id.slice(-6).toUpperCase();
      
      if (isFullyPaid) {
        this.log(`[VOUCHER-INTELIGENTE] Order ${orderIdShort} FULLY PAID`);
        return this.success(`✅ PAGO COMPLETO REGISTRADO

Pedido #${orderIdShort}
Voucher recibido: ${currencySymbol}${voucherAmount.toFixed(2)} (${paymentMethod})

Total pagado: ${currencySymbol}${newPaidAmount.toFixed(2)}
Total del pedido: ${currencySymbol}${order.totalAmount.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━
Estado: PAGADO ✓

El pedido está listo para ser procesado.`, { 
          orderId: order.id, 
          status: 'PAID', 
          fullyPaid: true,
          voucherImageUrl,
          paymentMethod
        });
      } else {
        this.log(`[VOUCHER-INTELIGENTE] Order ${orderIdShort} PARTIAL PAYMENT`);
        return this.success(`💳 PAGO REGISTRADO

Pedido #${orderIdShort}
Voucher recibido: ${currencySymbol}${voucherAmount.toFixed(2)} (${paymentMethod})

Resumen de pagos:
• Total del pedido: ${currencySymbol}${order.totalAmount.toFixed(2)}
• Pagado hasta ahora: ${currencySymbol}${newPaidAmount.toFixed(2)}
• Saldo pendiente: ${currencySymbol}${pendingAfter.toFixed(2)}`, { 
          orderId: order.id, 
          status: 'AWAITING_VOUCHER', 
          fullyPaid: false,
          paidAmount: newPaidAmount,
          pendingAmount: pendingAfter,
          voucherImageUrl,
          paymentMethod
        });
      }
    } catch (error: any) {
      this.logError('[VOUCHER-INTELIGENTE] Error processing voucher', error);
      return this.error(`Error al procesar voucher: ${error.message}`);
    }
  }
}

export function registerOrderTools(): void {
  toolRegistry.registerTool(new ConfirmarPedidoTool());
  toolRegistry.registerTool(new AgregarProductoTool());
  toolRegistry.registerTool(new ConsultarPedidoTool());
  toolRegistry.registerTool(new ConfirmarEntregaTool());
  toolRegistry.registerTool(new CalcularTotalTool());
  toolRegistry.registerTool(new RegistrarVoucherTool());
  toolRegistry.registerTool(new ProcesarVoucherInteligenteTool());
  
  console.log('[OrderTools] All order tools registered (including ProcesarVoucherInteligente)');
}
