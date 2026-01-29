export * from './orderTools.js';
export * from './appointmentTools.js';
export * from './productTools.js';
export * from './funnelTools.js';
export * from './customToolAdapter.js';

import { registerOrderTools } from './orderTools.js';
import { registerAppointmentTools } from './appointmentTools.js';
import { registerProductTools } from './productTools.js';
import { registerFunnelTools } from './funnelTools.js';

export function registerAllNativeTools(): void {
  registerOrderTools();
  registerAppointmentTools();
  registerProductTools();
  registerFunnelTools();
  console.log('[ToolRegistry] All native tools registered');
}
