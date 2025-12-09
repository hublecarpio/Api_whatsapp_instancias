export function replacePromptVariables(prompt: string, timezone: string = 'America/Lima'): string {
  const now = new Date();
  
  const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  
  const formatter = new Intl.DateTimeFormat('es-PE', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'long'
  });
  
  const parts = formatter.formatToParts(now);
  const getPart = (type: string) => parts.find(p => p.type === type)?.value || '';
  
  const day = getPart('day');
  const monthNum = parseInt(getPart('month')) - 1;
  const month = monthNames[monthNum];
  const year = getPart('year');
  const hour = getPart('hour');
  const minute = getPart('minute');
  const weekday = getPart('weekday');
  
  const weekdayCapitalized = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  
  const variables: Record<string, string> = {
    '{{now}}': `${weekdayCapitalized} ${day} de ${month} ${year}, ${hour}:${minute}`,
    '{{date}}': `${day} de ${month} ${year}`,
    '{{time}}': `${hour}:${minute}`,
    '{{day_of_week}}': weekdayCapitalized,
    '{{day}}': day,
    '{{month}}': month,
    '{{year}}': year,
    '{{hour}}': hour,
    '{{minute}}': minute
  };
  
  let result = prompt;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
  }
  
  return result;
}
