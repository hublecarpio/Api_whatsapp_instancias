import prisma from '../prisma.js';
import { createOrder, findProductWithScope, addItemToExistingOrder } from '../orderService.js';
import { OrderStatus } from '@prisma/client';

export interface OrderToolDefinition {
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

export interface OrderToolContext {
  businessId: string;
  instanceId: string | null;
  contactPhone: string;
  contactName: string;
  currencySymbol: string;
}

export interface ToolResult {
  success: boolean;
  content: string;
  toolExecuted?: string;
}

export function getOrderToolDefinitions(
  zoneDescriptions: string,
  hasActiveOrder: boolean
): OrderToolDefinition[] {
  const tools: OrderToolDefinition[] = [];

  tools.push({
    type: 'function',
    function: {
      name: 'confirmar_pedido',
      description: `Registra un pedido nuevo cuando el cliente confirma su compra. Usa esta función SOLO cuando el cliente dice explícitamente "sí lo quiero", "confirmo", "procede con el pedido", etc. Zonas disponibles: ${zoneDescriptions}`,
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
      }
    }
  });

  tools.push({
    type: 'function',
    function: {
      name: 'agregar_producto_orden',
      description: 'Agrega un producto adicional a la orden activa del cliente. Usa esta función cuando el cliente ya tiene un pedido y quiere agregar más productos.',
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
      }
    }
  });

  tools.push({
    type: 'function',
    function: {
      name: 'consultar_pedido',
      description: 'Consulta el estado actual del pedido del cliente. Usa esta función cuando el cliente pregunta por su pedido, cuánto debe, qué productos tiene, etc.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  });

  tools.push({
    type: 'function',
    function: {
      name: 'confirmar_entrega',
      description: 'Marca el pedido como entregado. Usa esta función cuando el cliente confirma que recibió su pedido.',
      parameters: {
        type: 'object',
        properties: {
          notas: { 
            type: 'string', 
            description: 'Notas sobre la entrega (opcional)' 
          }
        },
        required: []
      }
    }
  });

  tools.push({
    type: 'function',
    function: {
      name: 'calcular_total_pedido',
      description: `OBLIGATORIO: Usa esta herramienta SIEMPRE antes de confirmar un pedido o cuando necesites dar el precio total al cliente. Calcula automáticamente: subtotal de productos + costo de envío = total. NO hagas cálculos mentales, SIEMPRE usa esta herramienta para obtener el precio exacto. Zonas disponibles: ${zoneDescriptions}`,
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
                cantidad: { type: 'number', description: 'Cantidad (default: 1)' }
              },
              required: ['nombre']
            }
          },
          zona_envio: {
            type: 'string',
            description: 'Nombre de la zona de envío (distrito, ciudad, etc.)'
          }
        },
        required: ['productos', 'zona_envio']
      }
    }
  });

  return tools;
}

export async function findActiveOrder(
  businessId: string,
  contactPhone: string,
  instanceId?: string | null
): Promise<any | null> {
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  const activeStatuses: OrderStatus[] = [
    OrderStatus.AWAITING_VOUCHER, 
    OrderStatus.PAID, 
    OrderStatus.PROCESSING, 
    OrderStatus.SHIPPED
  ];
  
  const order = await prisma.order.findFirst({
    where: {
      businessId,
      contactPhone: normalizedPhone,
      status: { in: activeStatuses },
      ...(instanceId ? { instanceId } : {})
    },
    orderBy: { createdAt: 'desc' },
    include: {
      items: true
    }
  });
  
  return order;
}

export async function handleAgregarProducto(
  args: any,
  ctx: OrderToolContext
): Promise<ToolResult> {
  const { businessId, instanceId, contactPhone, currencySymbol } = ctx;
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  console.log(`[OrderTools] agregar_producto_orden called:`, args);
  
  try {
    if (!args.producto || args.producto.trim() === '') {
      return {
        success: false,
        content: 'Error: Falta el nombre del producto a agregar. Pregunta qué producto adicional desea.'
      };
    }
    
    const activeOrder = await findActiveOrder(businessId, normalizedPhone, instanceId);
    
    if (!activeOrder) {
      return {
        success: false,
        content: 'Error: El cliente no tiene un pedido activo. Usa confirmar_pedido para crear uno nuevo.'
      };
    }
    
    const matchedProduct = await findProductWithScope(businessId, args.producto, instanceId);
    
    if (!matchedProduct) {
      return {
        success: false,
        content: `Error: No se encontró el producto "${args.producto}" en el catálogo.`
      };
    }
    
    const quantity = Math.max(1, parseInt(args.cantidad) || 1);
    
    const result = await addItemToExistingOrder(
      businessId,
      normalizedPhone,
      {
        productId: matchedProduct.id,
        productTitle: matchedProduct.title,
        quantity,
        unitPrice: matchedProduct.price,
        imageUrl: matchedProduct.imageUrl
      },
      instanceId || undefined
    );
    
    if (!result.success) {
      return {
        success: false,
        content: `Error al agregar producto: ${result.reason || 'Error desconocido'}`
      };
    }
    
    const variationInfo = matchedProduct.variation ? ` (${matchedProduct.variation})` : '';
    const itemTotal = matchedProduct.price * quantity;
    
    return {
      success: true,
      content: `Producto agregado exitosamente al pedido #${activeOrder.id.slice(-6).toUpperCase()}.
- Agregado: ${matchedProduct.title}${variationInfo} x${quantity} = ${currencySymbol}${itemTotal.toFixed(2)}
- Nuevo total del pedido: ${currencySymbol}${result.newTotal?.toFixed(2) || 'N/A'}

Informa al cliente el nuevo total.`,
      toolExecuted: 'agregar_producto_orden'
    };
  } catch (err: any) {
    console.error('[OrderTools] agregar_producto_orden error:', err.message);
    return {
      success: false,
      content: `Error al agregar producto: ${err.message}`
    };
  }
}

export async function handleConsultarPedido(
  ctx: OrderToolContext
): Promise<ToolResult> {
  const { businessId, instanceId, contactPhone, currencySymbol } = ctx;
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  console.log(`[OrderTools] consultar_pedido called for ${normalizedPhone}`);
  
  try {
    // Include DELIVERED orders so customer can check recent delivery
    const consultableStatuses: OrderStatus[] = [
      OrderStatus.AWAITING_VOUCHER, 
      OrderStatus.PAID, 
      OrderStatus.PROCESSING, 
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED
    ];
    
    const order = await prisma.order.findFirst({
      where: {
        businessId,
        contactPhone: normalizedPhone,
        status: { in: consultableStatuses },
        ...(instanceId ? { instanceId } : {})
      },
      orderBy: { createdAt: 'desc' },
      include: { items: true }
    });
    
    // Type assertion for financial fields that are guaranteed to exist on Order model
    const orderData = order as typeof order & {
      paidAmount: number | null;
      totalAmount: number;
      shippingCost: number | null;
      shippingAddress: string | null;
    } | null;
    
    if (!orderData) {
      return {
        success: true,
        content: 'El cliente no tiene pedidos recientes. Si desea hacer un pedido, recopila los datos necesarios y usa confirmar_pedido.',
        toolExecuted: 'consultar_pedido'
      };
    }
    
    const statusLabels: Record<string, string> = {
      'AWAITING_VOUCHER': 'Esperando comprobante de pago',
      'PAID': 'Pagado - En preparación',
      'PROCESSING': 'En proceso',
      'SHIPPED': 'Enviado',
      'DELIVERED': 'Entregado',
      'CANCELLED': 'Cancelado'
    };
    
    const itemsList = orderData.items.map((item) => 
      `  - ${item.productTitle} x${item.quantity} = ${currencySymbol}${(item.unitPrice * item.quantity).toFixed(2)}`
    ).join('\n');
    
    const paidAmount = orderData.paidAmount || 0;
    const totalAmount = orderData.totalAmount;
    const pendingAmount = totalAmount - paidAmount;
    const shippingCost = orderData.shippingCost || 0;
    
    let paymentInfo = '';
    if (paidAmount > 0 && pendingAmount > 0) {
      paymentInfo = `
- Pagado: ${currencySymbol}${paidAmount.toFixed(2)}
- Pendiente: ${currencySymbol}${pendingAmount.toFixed(2)}`;
    } else if (paidAmount >= totalAmount) {
      paymentInfo = `
- Estado de pago: COMPLETADO`;
    } else {
      paymentInfo = `
- Pendiente de pago: ${currencySymbol}${totalAmount.toFixed(2)}`;
    }
    
    return {
      success: true,
      content: `Pedido #${orderData.id.slice(-6).toUpperCase()}
Estado: ${statusLabels[orderData.status] || orderData.status}

Productos:
${itemsList}

- Subtotal: ${currencySymbol}${(totalAmount - shippingCost).toFixed(2)}
- Envío: ${currencySymbol}${shippingCost.toFixed(2)}
- TOTAL: ${currencySymbol}${totalAmount.toFixed(2)}${paymentInfo}

Dirección: ${orderData.shippingAddress || 'No especificada'}`,
      toolExecuted: 'consultar_pedido'
    };
  } catch (err: any) {
    console.error('[OrderTools] consultar_pedido error:', err.message);
    return {
      success: false,
      content: `Error al consultar pedido: ${err.message}`
    };
  }
}

export async function handleConfirmarEntrega(
  args: any,
  ctx: OrderToolContext
): Promise<ToolResult> {
  const { businessId, instanceId, contactPhone } = ctx;
  const normalizedPhone = contactPhone.replace(/\D/g, '');
  
  console.log(`[OrderTools] confirmar_entrega called for ${normalizedPhone}`);
  
  try {
    const deliverableStatuses: OrderStatus[] = [
      OrderStatus.PAID, 
      OrderStatus.PROCESSING, 
      OrderStatus.SHIPPED
    ];
    
    const order = await prisma.order.findFirst({
      where: {
        businessId,
        contactPhone: normalizedPhone,
        status: { in: deliverableStatuses },
        ...(instanceId ? { instanceId } : {})
      },
      orderBy: { createdAt: 'desc' }
    });
    
    if (!order) {
      return {
        success: false,
        content: 'Error: No se encontró un pedido que pueda marcarse como entregado. El pedido debe estar pagado o en camino.'
      };
    }
    
    const deliveryNotes = args.notas ? `\nEntrega confirmada: ${args.notas}` : '\nEntrega confirmada por el cliente';
    const existingNotes = order.notes || '';
    
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.DELIVERED,
        notes: existingNotes + deliveryNotes,
        updatedAt: new Date()
      }
    });
    
    return {
      success: true,
      content: `Pedido #${order.id.slice(-6).toUpperCase()} marcado como ENTREGADO.
Gracias por confirmar la recepción. ¡Esperamos que disfrutes tu compra!`,
      toolExecuted: 'confirmar_entrega'
    };
  } catch (err: any) {
    console.error('[OrderTools] confirmar_entrega error:', err.message);
    return {
      success: false,
      content: `Error al confirmar entrega: ${err.message}`
    };
  }
}

export interface CalcularTotalContext extends OrderToolContext {
  deliveryZones: Array<{ name: string; cost: number; freeAbove: number | null }>;
}

export async function handleCalcularTotal(
  args: { productos: Array<{ nombre: string; cantidad?: number }>; zona_envio: string },
  ctx: CalcularTotalContext
): Promise<ToolResult> {
  const { businessId, instanceId, currencySymbol, deliveryZones } = ctx;
  
  console.log(`[OrderTools] calcular_total_pedido called:`, JSON.stringify(args));
  
  try {
    if (!args.productos || args.productos.length === 0) {
      return {
        success: false,
        content: 'Error: No se especificaron productos. Pregunta qué productos desea el cliente.'
      };
    }
    
    if (!args.zona_envio || args.zona_envio.trim() === '') {
      return {
        success: false,
        content: 'Error: No se especificó la zona de envío. Pregunta al cliente su distrito o zona.'
      };
    }
    
    // Find matching delivery zone (fuzzy match)
    const zonaNormalizada = args.zona_envio.toLowerCase().trim();
    let matchedZone: { name: string; cost: number; freeAbove: number | null } | null = null;
    
    for (const zone of deliveryZones) {
      const zoneName = zone.name.toLowerCase().trim();
      if (zoneName === zonaNormalizada || 
          zoneName.includes(zonaNormalizada) || 
          zonaNormalizada.includes(zoneName)) {
        matchedZone = zone;
        break;
      }
    }
    
    if (!matchedZone) {
      const availableZones = deliveryZones.map(z => z.name).join(', ');
      return {
        success: false,
        content: `Error: No se encontró la zona "${args.zona_envio}". Zonas disponibles: ${availableZones}. Pregunta al cliente qué zona aplica.`
      };
    }
    
    // Calculate product subtotal
    let subtotal = 0;
    const productDetails: string[] = [];
    const notFoundProducts: string[] = [];
    
    for (const item of args.productos) {
      const product = await findProductWithScope(businessId, item.nombre, instanceId);
      const cantidad = Math.max(1, item.cantidad || 1);
      
      if (product) {
        const itemTotal = product.price * cantidad;
        subtotal += itemTotal;
        const variationInfo = product.variation ? ` (${product.variation})` : '';
        productDetails.push(`• ${product.title}${variationInfo} x${cantidad} = ${currencySymbol}${itemTotal.toFixed(2)}`);
      } else {
        notFoundProducts.push(item.nombre);
      }
    }
    
    if (productDetails.length === 0) {
      return {
        success: false,
        content: `Error: No se encontraron los productos: ${notFoundProducts.join(', ')}. Verifica los nombres exactos del catálogo.`
      };
    }
    
    // Check if subtotal qualifies for free shipping
    const freeShippingThreshold = matchedZone.freeAbove;
    const qualifiesForFreeShipping = freeShippingThreshold !== null && subtotal >= freeShippingThreshold;
    const shippingCost = qualifiesForFreeShipping ? 0 : (matchedZone.cost || 0);
    const total = subtotal + shippingCost;
    
    let response = `CÁLCULO DE PEDIDO:
${productDetails.join('\n')}

📦 Subtotal productos: ${currencySymbol}${subtotal.toFixed(2)}
🚚 Envío a ${matchedZone.name}: ${currencySymbol}${shippingCost.toFixed(2)}${qualifiesForFreeShipping ? ' (GRATIS)' : ''}
━━━━━━━━━━━━━━━━━━━━
💰 TOTAL A PAGAR: ${currencySymbol}${total.toFixed(2)}`;
    
    if (notFoundProducts.length > 0) {
      response += `\n\n⚠️ Productos no encontrados: ${notFoundProducts.join(', ')}`;
    }
    
    if (freeShippingThreshold && !qualifiesForFreeShipping) {
      const remaining = freeShippingThreshold - subtotal;
      response += `\n\n💡 Envío gratis desde ${currencySymbol}${freeShippingThreshold.toFixed(2)} (te faltan ${currencySymbol}${remaining.toFixed(2)})`;
    }
    
    return {
      success: true,
      content: response,
      toolExecuted: 'calcular_total_pedido'
    };
  } catch (err: any) {
    console.error('[OrderTools] calcular_total_pedido error:', err.message);
    return {
      success: false,
      content: `Error al calcular total: ${err.message}`
    };
  }
}
