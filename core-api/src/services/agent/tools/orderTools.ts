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
      description: `Registra un pedido nuevo cuando el cliente confirma su compra. Usa esta función SOLO cuando el cliente dice explícitamente "sí lo quiero", "confirmo", "procede con el pedido", etc. ${context.zoneDescriptions ? `Zonas disponibles: ${context.zoneDescriptions}` : ''}`,
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          producto: { 
            type: 'string', 
            description: 'Nombre exacto del producto que el cliente quiere comprar' 
          },
          cantidad: { 
            type: 'number', 
            description: 'Cantidad de productos (default: 1)' 
          },
          nombre_cliente: { 
            type: 'string', 
            description: 'Nombre completo del cliente' 
          },
          direccion: { 
            type: 'string', 
            description: 'Dirección completa de envío' 
          },
          zona_envio: { 
            type: 'string', 
            description: 'Zona o distrito de envío para calcular costo' 
          },
          metodo_pago: { 
            type: 'string', 
            enum: ['YAPE', 'PLIN', 'TRANSFERENCIA', 'EFECTIVO', 'OTRO'],
            description: 'Método de pago preferido por el cliente' 
          },
          notas: { 
            type: 'string', 
            description: 'Notas adicionales del pedido (opcional)' 
          }
        },
        required: ['producto', 'nombre_cliente', 'direccion']
      },
      requiresProducts: true,
      requiresZones: true
    };
  }

  private validateProductMentionedInConversation(productName: string, messages?: { role: string; content: string }[]): { valid: boolean; reason?: string } {
    if (!messages || messages.length === 0) {
      this.log('No conversation messages available, allowing product');
      return { valid: true };
    }

    const userMessages = messages.filter(m => m.role === 'user').map(m => m.content.toLowerCase());
    const allConversation = userMessages.join(' ');
    
    const productLower = productName.toLowerCase().trim();
    const productWords = productLower.split(/\s+/).filter(w => w.length > 2);
    
    if (allConversation.includes(productLower)) {
      return { valid: true };
    }
    
    if (productWords.length <= 2) {
      const anyWordMatched = productWords.some(word => allConversation.includes(word));
      if (anyWordMatched) {
        this.log(`Product "${productName}" matched (short product name, any word match)`);
        return { valid: true };
      }
    }
    
    const matchedWords = productWords.filter(word => allConversation.includes(word));
    const matchRatio = matchedWords.length / productWords.length;
    
    if (matchRatio >= 0.5 && matchedWords.length >= 1) {
      this.log(`Product "${productName}" partially matched (${matchRatio * 100}% words): ${matchedWords.join(', ')}`);
      return { valid: true };
    }
    
    this.log(`[ORDER-VALIDATION] Product "${productName}" NOT found in conversation. User messages: ${userMessages.slice(-3).join(' | ')}`);
    return { 
      valid: false, 
      reason: `El cliente NO mencionó el producto "${productName}" en la conversación. Solo confirma pedidos de productos que el cliente haya solicitado explícitamente.` 
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('Execute called', args);
    
    const { businessId, instanceId, contactPhone, contactName, currencySymbol, conversationMessages } = context;
    const normalizedPhone = contactPhone.replace(/\D/g, '');
    
    try {
      if (!args.producto || !args.nombre_cliente || !args.direccion) {
        return this.error('Faltan datos requeridos: producto, nombre_cliente y direccion son obligatorios.');
      }

      const productValidation = this.validateProductMentionedInConversation(args.producto, conversationMessages);
      if (!productValidation.valid) {
        this.log(`[ORDER-BLOCKED] Rejecting order for product not mentioned: ${args.producto}`);
        return this.error(productValidation.reason || 'Producto no mencionado en la conversación.');
      }

      const product = await findProductWithScope(businessId, args.producto, instanceId);
      if (!product) {
        return this.error(`No se encontró el producto "${args.producto}" en el catálogo.`);
      }

      const quantity = Math.max(1, parseInt(args.cantidad) || 1);
      
      let zone = null;
      let shippingCost = 0;
      
      if (args.zona_envio) {
        zone = await prisma.deliveryZone.findFirst({
          where: {
            businessId,
            name: { contains: args.zona_envio, mode: 'insensitive' }
          }
        });
        
        if (zone) {
          const subtotal = product.price * quantity;
          if (zone.freeAbove && subtotal >= zone.freeAbove) {
            shippingCost = 0;
          } else {
            shippingCost = zone.cost || 0;
          }
        }
      }

      const subtotal = product.price * quantity;
      const total = subtotal + shippingCost;

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
          totalAmount: total,
          currencySymbol,
          notes: args.notas || undefined,
          status: 'AWAITING_VOUCHER',
          items: {
            create: [{
              productId: product.id,
              productTitle: product.title,
              quantity,
              unitPrice: product.price,
              imageUrl: product.imageUrl
            }]
          }
        },
        include: { items: true }
      });

      const orderId = order.id.slice(-6).toUpperCase();
      const variationInfo = product.variation ? ` (${product.variation})` : '';
      
      return this.success(`PEDIDO CONFIRMADO #${orderId}

Producto: ${product.title}${variationInfo} x${quantity} = ${currencySymbol}${subtotal.toFixed(2)}
Envío: ${currencySymbol}${shippingCost.toFixed(2)}${zone ? ` (${zone.name})` : ''}
━━━━━━━━━━━━━━━━━━━━
TOTAL: ${currencySymbol}${total.toFixed(2)}

Cliente: ${args.nombre_cliente}
Dirección: ${args.direccion}

Estado: Esperando comprobante de pago`, { orderId: order.id });
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
      description: 'Agrega un producto adicional a la orden activa del cliente. Usa esta función cuando el cliente ya tiene un pedido y quiere agregar más productos.',
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          producto: { 
            type: 'string', 
            description: 'Nombre del producto a agregar' 
          },
          cantidad: { 
            type: 'number', 
            description: 'Cantidad a agregar (default: 1)' 
          }
        },
        required: ['producto']
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
      if (!args.producto) {
        return this.error('Falta el nombre del producto a agregar.');
      }

      const product = await findProductWithScope(businessId, args.producto, instanceId);
      if (!product) {
        return this.error(`No se encontró el producto "${args.producto}" en el catálogo.`);
      }

      const quantity = Math.max(1, parseInt(args.cantidad) || 1);
      
      const result = await addItemToExistingOrder(
        businessId,
        normalizedPhone,
        {
          productId: product.id,
          productTitle: product.title,
          quantity,
          unitPrice: product.price,
          imageUrl: product.imageUrl
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
- Nuevo total del pedido: ${currencySymbol}${result.newTotal?.toFixed(2) || 'N/A'}`);
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
            items: { type: 'object' }
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
        where: { businessId }
      });

      const zonaNorm = args.zona_envio.toLowerCase().trim();
      let matchedZone = zones.find(z => 
        z.name.toLowerCase().includes(zonaNorm) || zonaNorm.includes(z.name.toLowerCase())
      );

      if (!matchedZone) {
        return this.error(`Zona "${args.zona_envio}" no encontrada. Disponibles: ${zones.map(z => z.name).join(', ')}`);
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

      return this.success(response, { subtotal, shipping, total, zone: matchedZone.name });
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
      description: `HERRAMIENTA DE RAZONAMIENTO para procesar comprobantes de pago. Cuando Gemini detecta un voucher válido, usa esta herramienta para:
1. Verificar si hay un pedido activo
2. Validar el monto contra el total pendiente
3. Registrar el pago (acepta pagos parciales y acumulativos)
4. Actualizar el estado del pedido automáticamente

LÓGICA DE DECISIÓN:
- Si paidAmount + nuevo_voucher >= totalAmount → Estado = PAID
- Si paidAmount + nuevo_voucher < totalAmount → Solicitar pago restante
- Siempre acumular pagos en paymentHistory[]`,
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          monto_detectado: {
            type: 'number',
            description: 'Monto del voucher detectado por Gemini'
          },
          banco: {
            type: 'string',
            description: 'Banco o método de pago (Yape, Plin, BCP, etc.)'
          },
          codigo_operacion: {
            type: 'string',
            description: 'Código de operación del comprobante (opcional)'
          },
          imagen_url: {
            type: 'string',
            description: 'URL de la imagen del voucher'
          }
        },
        required: ['monto_detectado']
      },
      requiresActiveOrder: true
    };
  }

  isAvailable(context: ToolAvailabilityContext): boolean {
    return context.hasActiveOrder;
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('[VOUCHER-TOOL] Execute called', args);
    
    const { businessId, instanceId, contactPhone, currencySymbol, geminiVoucherResult } = context;
    const normalizedPhone = contactPhone.replace(/\D/g, '');
    
    try {
      const order = await prisma.order.findFirst({
        where: {
          businessId,
          contactPhone: normalizedPhone,
          status: { in: [OrderStatus.AWAITING_VOUCHER, OrderStatus.PENDING_PAYMENT] },
          ...(instanceId ? { instanceId } : {})
        },
        orderBy: { createdAt: 'desc' },
        include: { items: true }
      });

      if (!order) {
        this.log('[VOUCHER-TOOL] No active order found');
        return this.error('No hay un pedido activo esperando pago. Primero necesito confirmar el pedido del cliente.');
      }

      const voucherAmount = args.monto_detectado || geminiVoucherResult?.amount || 0;
      const bank = args.banco || geminiVoucherResult?.brand || 'Desconocido';
      const operationCode = args.codigo_operacion || geminiVoucherResult?.operationCode || null;
      const imageUrl = args.imagen_url || geminiVoucherResult?.imageUrl || null;

      if (voucherAmount <= 0) {
        this.log('[VOUCHER-TOOL] Invalid voucher amount', { voucherAmount });
        return this.error('No se detectó un monto válido en el comprobante. Por favor pide al cliente que envíe una imagen más clara.');
      }

      const currentPaid = order.paidAmount || 0;
      const pendingBefore = order.totalAmount - currentPaid;
      const newPaidAmount = currentPaid + voucherAmount;
      const pendingAfter = Math.max(0, order.totalAmount - newPaidAmount);

      this.log('[VOUCHER-REASONING]', {
        orderId: order.id.slice(-6),
        totalAmount: order.totalAmount,
        previousPaid: currentPaid,
        voucherAmount,
        newPaidAmount,
        pendingAfter,
        decision: newPaidAmount >= order.totalAmount ? 'FULLY_PAID' : 'PARTIAL_PAYMENT'
      });

      const paymentEntry = {
        amount: voucherAmount,
        brand: bank,
        operationCode,
        imageUrl,
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

      const isFullyPaid = newPaidAmount >= order.totalAmount;
      const newStatus = isFullyPaid ? OrderStatus.PAID : OrderStatus.AWAITING_VOUCHER;

      await prisma.order.update({
        where: { id: order.id },
        data: {
          paidAmount: newPaidAmount,
          pendingAmount: pendingAfter,
          lastVoucherAmount: voucherAmount,
          status: newStatus,
          paidAt: isFullyPaid ? new Date() : null,
          notes: JSON.stringify({
            ...existingNotes,
            paymentHistory,
            lastVoucherBank: bank,
            lastVoucherCode: operationCode
          })
        }
      });

      const orderId = order.id.slice(-6).toUpperCase();

      if (isFullyPaid) {
        this.log(`[VOUCHER-TOOL] Order ${orderId} FULLY PAID`);
        return this.success(`✅ PAGO COMPLETO REGISTRADO

Pedido #${orderId}
Voucher recibido: ${currencySymbol}${voucherAmount.toFixed(2)} (${bank})
${operationCode ? `Código: ${operationCode}` : ''}

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
        this.log(`[VOUCHER-TOOL] Order ${orderId} PARTIAL PAYMENT, pending: ${pendingAfter}`);
        return this.success(`💳 PAGO PARCIAL REGISTRADO

Pedido #${orderId}
Voucher recibido: ${currencySymbol}${voucherAmount.toFixed(2)} (${bank})
${operationCode ? `Código: ${operationCode}` : ''}

Resumen de pagos:
• Total del pedido: ${currencySymbol}${order.totalAmount.toFixed(2)}
• Pagado hasta ahora: ${currencySymbol}${newPaidAmount.toFixed(2)}
• PENDIENTE: ${currencySymbol}${pendingAfter.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━
Por favor solicita al cliente el pago del monto pendiente.`, { 
          orderId: order.id, 
          status: 'AWAITING_VOUCHER', 
          fullyPaid: false,
          pendingAmount: pendingAfter 
        });
      }
    } catch (error: any) {
      this.logError('[VOUCHER-TOOL] Error processing voucher', error);
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
  
  console.log('[OrderTools] All order tools registered');
}
