import { debug, warn, error } from './logger.mjs';

// Define expected response schema for DeepSeek API
const DEEPSEEK_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['id', 'choices'],
  properties: {
    id: { type: 'string' },
    choices: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'finish_reason'],
        properties: {
          index: { type: 'number' },
          finish_reason: { type: 'string' },
          message: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              content: { type: 'string' }
            }
          }
        }
      }
    }
  }
};

// Define expected response schema for Qwen API
const QWEN_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['output'],
  properties: {
    output: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string' }
      }
    }
  }
};

function validateObject(obj, schema) {
  if (schema.type === 'object') {
    if (typeof obj !== 'object' || obj === null) {
      return { valid: false, error: 'Expected object' };
    }
    
    // Check required properties
    if (schema.required) {
      for (const prop of schema.required) {
        if (!(prop in obj)) {
          return { valid: false, error: `Missing required property: ${prop}` };
        }
      }
    }
    
    // Validate properties
    if (schema.properties) {
      for (const [prop, propSchema] of Object.entries(schema.properties)) {
        if (prop in obj) {
          const result = validateObject(obj[prop], propSchema);
          if (!result.valid) {
            return { valid: false, error: `Property ${prop}: ${result.error}` };
          }
        }
      }
    }
    
    return { valid: true };
  } else if (schema.type === 'array') {
    if (!Array.isArray(obj)) {
      return { valid: false, error: 'Expected array' };
    }
    
    if (schema.items) {
      for (let i = 0; i < obj.length; i++) {
        const result = validateObject(obj[i], schema.items);
        if (!result.valid) {
          return { valid: false, error: `Item at index ${i}: ${result.error}` };
        }
      }
    }
    
    return { valid: true };
  } else if (schema.type === 'string') {
    if (typeof obj !== 'string') {
      return { valid: false, error: 'Expected string' };
    }
    return { valid: true };
  } else if (schema.type === 'number') {
    if (typeof obj !== 'number') {
      return { valid: false, error: 'Expected number' };
    }
    return { valid: true };
  } else if (schema.type === 'boolean') {
    if (typeof obj !== 'boolean') {
      return { valid: false, error: 'Expected boolean' };
    }
    return { valid: true };
  }
  
  return { valid: true };
}

export function validateApiResponse(response, provider) {
  if (!response) {
    error('Empty response provided for validation');
    return { valid: false, error: 'Response is empty' };
  }
  
  let schema;
  if (provider === 'deepseek') {
    schema = DEEPSEEK_RESPONSE_SCHEMA;
  } else if (provider === 'qwen') {
    schema = QWEN_RESPONSE_SCHEMA;
  } else {
    warn('Unknown provider for response validation', { provider });
    return { valid: true }; // Don't block unknown providers
  }
  
  const result = validateObject(response, schema);
  
  if (!result.valid) {
    warn('API response validation failed', { 
      provider, 
      error: result.error, 
      responsePreview: JSON.stringify(response).substring(0, 200) 
    });
  } else {
    debug('API response validation passed', { provider });
  }
  
  return result;
}

export function sanitizeResponse(response, provider) {
  // Basic sanitization to remove potentially dangerous content
  if (typeof response === 'object' && response !== null) {
    const sanitized = { ...response };
    
    // Remove any script tags or potentially dangerous content
    if (sanitized.output?.text) {
      sanitized.output.text = sanitized.output.text.replace(/<script[^<]*(?:(?!</script>)<[^<]*)*</script>/gi, '');
    }
    
    if (sanitized.choices) {
      sanitized.choices = sanitized.choices.map(choice => {
        if (choice.message?.content) {
          choice.message.content = choice.message.content.replace(/<script[^<]*(?:(?!</script>)<[^<]*)*</script>/gi, '');
        }
        return { ...choice };
      });
    }
    
    return sanitized;
  }
  
  return response;
}
