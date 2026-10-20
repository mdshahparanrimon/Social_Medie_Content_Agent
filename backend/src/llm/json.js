// Providers without native schema enforcement get the schema in the prompt, and their output is checked here.

export function schemaInstructions(schema) {
  return `Respond with only a JSON object (no markdown fences, no commentary) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
}

export function parseJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the response');
  return JSON.parse(text.slice(start, end + 1));
}

// A small JSON Schema check covering what our schemas use: object, array, string, integer, boolean, required.
export function checkSchema(schema, value, path = 'response') {
  switch (schema.type) {
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} should be an object`);
      for (const key of schema.required || []) {
        if (!(key in value)) throw new Error(`${path}.${key} is missing`);
      }
      for (const [key, sub] of Object.entries(schema.properties || {})) {
        if (key in value) checkSchema(sub, value[key], `${path}.${key}`);
      }
      break;
    case 'array':
      if (!Array.isArray(value)) throw new Error(`${path} should be an array`);
      value.forEach((item, i) => checkSchema(schema.items, item, `${path}[${i}]`));
      break;
    case 'string':
      if (typeof value !== 'string') throw new Error(`${path} should be a string`);
      break;
    case 'integer':
      if (!Number.isInteger(value)) throw new Error(`${path} should be an integer`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${path} should be true or false`);
      break;
  }
}
