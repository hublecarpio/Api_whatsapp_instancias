import { BaseTool, ToolCategory, ToolDefinition, ToolContext, ToolResult, ToolAvailabilityContext, ToolDefinitionContext, toolRegistry } from '../core/index.js';
import prisma from '../../prisma.js';
import { getContactStageStatus, setContactStage } from '../../funnelStageService.js';

export class ConsultarEtapaTool extends BaseTool {
  readonly name = 'consultar_etapa_venta';
  readonly category: ToolCategory = 'FUNNEL';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: 'Consulta en qué etapa del flujo de venta se encuentra el cliente y qué datos faltan recopilar.',
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
    
    const { businessId, contactPhone } = context;
    
    try {
      const status = await getContactStageStatus(businessId, contactPhone);

      if (!status || !status.currentStage) {
        return this.success('El cliente está en la etapa inicial del flujo de venta.');
      }

      let response = `ETAPA ACTUAL: ${status.currentStage.name}\n`;

      if (status.missingFields && status.missingFields.length > 0) {
        response += `\nDATOS PENDIENTES:\n`;
        for (const field of status.missingFields) {
          response += `• ${field}\n`;
        }
      }

      if (status.canAdvance) {
        response += `\n✅ Puede avanzar a la siguiente etapa`;
      }

      if (status.nextStage) {
        response += `\nSiguiente etapa: ${status.nextStage.name}`;
      }

      return this.success(response);
    } catch (error: any) {
      this.logError('Error querying funnel stage', error);
      return this.error(`Error al consultar etapa: ${error.message}`);
    }
  }
}

export class AvanzarEtapaTool extends BaseTool {
  readonly name = 'avanzar_etapa_venta';
  readonly category: ToolCategory = 'FUNNEL';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: 'Avanza al cliente a la siguiente etapa del flujo de venta. Solo usa esta función cuando hayas recopilado todos los datos requeridos de la etapa actual.',
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          etapa: {
            type: 'string',
            description: 'Nombre de la etapa a la que avanzar (opcional, por defecto la siguiente)'
          }
        },
        required: []
      }
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('Execute called', args);
    
    const { businessId, instanceId, contactPhone } = context;
    
    try {
      const currentStatus = await getContactStageStatus(businessId, contactPhone);

      if (currentStatus?.missingFields && currentStatus.missingFields.length > 0) {
        return this.error(`No puedes avanzar aún. Faltan datos: ${currentStatus.missingFields.join(', ')}`);
      }

      const stages = await prisma.funnelStage.findMany({
        where: {
          businessId,
          ...(instanceId ? { OR: [{ instanceId }, { instanceId: null }] } : {})
        },
        orderBy: { order: 'asc' }
      });

      if (stages.length === 0) {
        return this.success('No hay etapas de venta configuradas.');
      }

      let nextStage;
      if (args.etapa) {
        nextStage = stages.find(s => s.name.toLowerCase().includes(args.etapa.toLowerCase()));
      } else if (currentStatus?.currentStage) {
        const currentId = currentStatus.currentStage.id;
        const currentIndex = stages.findIndex(s => s.id === currentId);
        nextStage = stages[currentIndex + 1];
      } else {
        nextStage = stages[0];
      }

      if (!nextStage) {
        return this.success('El cliente ya está en la última etapa del flujo.');
      }

      await setContactStage(businessId, contactPhone, nextStage.id);

      return this.success(`Cliente avanzado a etapa: ${nextStage.name}`);
    } catch (error: any) {
      this.logError('Error advancing funnel stage', error);
      return this.error(`Error al avanzar etapa: ${error.message}`);
    }
  }
}

export function registerFunnelTools(): void {
  toolRegistry.registerTool(new ConsultarEtapaTool());
  toolRegistry.registerTool(new AvanzarEtapaTool());
  
  console.log('[FunnelTools] All funnel tools registered');
}
