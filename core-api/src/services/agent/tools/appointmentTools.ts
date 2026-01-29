import { BaseTool, ToolCategory, ToolDefinition, ToolContext, ToolResult, ToolAvailabilityContext, ToolDefinitionContext, toolRegistry } from '../core/index.js';
import axios from 'axios';

const CORE_API_URL = process.env.CORE_API_URL || 'http://localhost:3001';

export class AgendarCitaTool extends BaseTool {
  readonly name = 'agendar_cita';
  readonly category: ToolCategory = 'APPOINTMENT';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: 'Agenda una cita con el cliente en la fecha y hora especificada. Usa esta función cuando el cliente confirme que quiere agendar una cita.',
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          fecha_hora: {
            type: 'string',
            description: 'Fecha y hora de la cita en formato ISO 8601 (YYYY-MM-DDTHH:mm:ss)'
          },
          nombre_cliente: {
            type: 'string',
            description: 'Nombre completo del cliente'
          },
          servicio: {
            type: 'string',
            description: 'Tipo de servicio o motivo de la cita'
          },
          duracion_minutos: {
            type: 'number',
            description: 'Duración de la cita en minutos (por defecto 60)'
          },
          notas: {
            type: 'string',
            description: 'Notas adicionales sobre la cita'
          }
        },
        required: ['fecha_hora', 'nombre_cliente']
      },
      requiresAppointments: true
    };
  }

  isAvailable(context: ToolAvailabilityContext): boolean {
    return context.businessObjective === 'APPOINTMENTS' || context.hasAppointments;
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('Execute called', args);
    
    const { businessId, instanceId, contactPhone, contactName } = context;
    
    try {
      if (!args.fecha_hora || !args.nombre_cliente) {
        return this.error('Faltan datos: fecha_hora y nombre_cliente son obligatorios.');
      }

      const response = await axios.post(
        `${CORE_API_URL}/appointments/internal/schedule`,
        {
          businessId,
          instanceId,
          contactPhone,
          customerName: args.nombre_cliente,
          dateTime: args.fecha_hora,
          service: args.servicio || 'Cita general',
          durationMinutes: args.duracion_minutos || 60,
          notes: args.notas || ''
        },
        { timeout: 10000 }
      );

      if (response.data.success && response.data.appointment) {
        const apt = response.data.appointment;
        const dateStr = new Date(apt.dateTime).toLocaleString('es-ES', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        let msg = `CITA AGENDADA\n\nFecha: ${dateStr}\nCliente: ${args.nombre_cliente}`;
        if (args.servicio) msg += `\nServicio: ${args.servicio}`;
        if (apt.googleMeetLink) msg += `\n\nEnlace Google Meet: ${apt.googleMeetLink}`;
        
        return this.success(msg, { appointmentId: apt.id });
      } else {
        return this.error(response.data.message || 'No se pudo agendar la cita.');
      }
    } catch (error: any) {
      this.logError('Error scheduling appointment', error);
      return this.error(`Error al agendar cita: ${error.message}`);
    }
  }
}

export class ConsultarDisponibilidadTool extends BaseTool {
  readonly name = 'consultar_disponibilidad';
  readonly category: ToolCategory = 'APPOINTMENT';

  protected buildDefinition(context: ToolDefinitionContext): ToolDefinition {
    return {
      name: this.name,
      description: 'Consulta la disponibilidad de horarios para citas en una fecha específica.',
      category: this.category,
      parameters: {
        type: 'object',
        properties: {
          fecha: {
            type: 'string',
            description: 'Fecha para consultar disponibilidad (YYYY-MM-DD)'
          }
        },
        required: ['fecha']
      },
      requiresAppointments: true
    };
  }

  isAvailable(context: ToolAvailabilityContext): boolean {
    return context.businessObjective === 'APPOINTMENTS' || context.hasAppointments;
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    this.log('Execute called', args);
    
    const { businessId, instanceId } = context;
    
    try {
      if (!args.fecha) {
        return this.error('Debes especificar una fecha para consultar disponibilidad.');
      }

      const response = await axios.get(
        `${CORE_API_URL}/appointments/internal/availability`,
        {
          params: {
            businessId,
            instanceId,
            date: args.fecha
          },
          timeout: 10000
        }
      );

      if (response.data.slots && response.data.slots.length > 0) {
        const slots = response.data.slots.map((s: any) => s.time || s).join(', ');
        return this.success(`Horarios disponibles para ${args.fecha}:\n${slots}`);
      } else {
        return this.success(`No hay horarios disponibles para ${args.fecha}. Sugiere otra fecha al cliente.`);
      }
    } catch (error: any) {
      this.logError('Error checking availability', error);
      return this.error(`Error al consultar disponibilidad: ${error.message}`);
    }
  }
}

export function registerAppointmentTools(): void {
  toolRegistry.registerTool(new AgendarCitaTool());
  toolRegistry.registerTool(new ConsultarDisponibilidadTool());
  
  console.log('[AppointmentTools] All appointment tools registered');
}
