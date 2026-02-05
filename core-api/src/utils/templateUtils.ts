/**
 * Utility functions for template message content interpolation
 */

interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  parameters?: Array<{ type: string; text?: string }>;
  sub_type?: string;
  index?: number;
}

interface InterpolateTemplateOptions {
  bodyText?: string | null;
  templateName: string;
  variables?: string[];
  headerVariables?: string[];
  components?: TemplateComponent[];
}

/**
 * Interpolates template variables into the body text.
 * Returns the full message content or falls back to [Template: name] if no body text.
 * 
 * Priority:
 * 1. Use components.body.parameters if available
 * 2. Fall back to variables array
 * 3. Clean up any unmatched {{n}} placeholders
 */
export function interpolateTemplateContent(options: InterpolateTemplateOptions): string {
  const { bodyText, templateName, variables, headerVariables, components } = options;
  
  if (!bodyText || !bodyText.trim()) {
    return `[Template: ${templateName}]`;
  }
  
  let interpolatedText = bodyText;
  
  // Try to get variables from components first (preferred source)
  let bodyVariables: string[] = [];
  
  if (components && Array.isArray(components)) {
    const bodyComponent = components.find(c => c.type === 'body');
    if (bodyComponent?.parameters && Array.isArray(bodyComponent.parameters)) {
      bodyVariables = bodyComponent.parameters
        .filter(p => p.text !== undefined)
        .map(p => p.text!);
    }
  }
  
  // Fall back to variables array if no components or empty
  if (bodyVariables.length === 0 && variables && variables.length > 0) {
    bodyVariables = variables;
  }
  
  // Apply body variable interpolation
  if (bodyVariables.length > 0) {
    bodyVariables.forEach((value: string, index: number) => {
      interpolatedText = interpolatedText.replace(
        new RegExp(`\\{\\{${index + 1}\\}\\}`, 'g'),
        value
      );
    });
  }
  
  // Clean up any remaining unmatched placeholders
  interpolatedText = interpolatedText.replace(/\{\{\d+\}\}/g, '');
  
  // Return interpolated text or fallback to template name
  const finalText = interpolatedText.trim();
  return finalText || `[Template: ${templateName}]`;
}

/**
 * Builds metadata object for template message logs
 */
export function buildTemplateMetadata(options: {
  provider: string;
  templateName: string;
  templateBodyText?: string | null;
  variables?: string[];
  headerVariables?: string[];
  isTemplate: boolean;
  additionalMetadata?: Record<string, any>;
}): Record<string, any> {
  const metadata: Record<string, any> = {
    provider: options.provider,
    isTemplate: options.isTemplate,
    templateName: options.templateName,
  };
  
  if (options.templateBodyText) {
    metadata.templateBodyText = options.templateBodyText;
  }
  
  if (options.variables && options.variables.length > 0) {
    metadata.variables = options.variables;
  }
  
  if (options.headerVariables && options.headerVariables.length > 0) {
    metadata.headerVariables = options.headerVariables;
  }
  
  if (options.additionalMetadata) {
    Object.assign(metadata, options.additionalMetadata);
  }
  
  return metadata;
}
