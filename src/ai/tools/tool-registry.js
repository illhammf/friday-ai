import { assertSupportedToolSchema } from './tool-validator.js';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const TOOL_CATEGORIES = new Set([
  'read_only',
  'action',
  'approval_required',
]);
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function cloneAndFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreeze));
  }
  if (value && typeof value === 'object') {
    const copy = Object.create(null);
    for (const [key, nested] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        value: cloneAndFreeze(nested),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(copy);
  }
  return value;
}

function validateDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new TypeError('Tool definition must be an object.');
  }
  const { name, description, inputSchema, category, handler } = definition;
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
    throw new TypeError('Tool name must match ^[a-z][a-z0-9_]{0,63}$.');
  }
  if (
    typeof description !== 'string' ||
    !description.trim() ||
    description.length > 1024
  ) {
    throw new TypeError('Tool description must contain 1 to 1024 characters.');
  }
  if (!inputSchema) {
    throw new TypeError('Tool inputSchema is required.');
  }
  assertSupportedToolSchema(inputSchema);
  if (inputSchema.type !== 'object') {
    throw new TypeError('Tool inputSchema must have type "object".');
  }
  if (RESERVED_KEYS.has(name)) {
    throw new TypeError(`Reserved tool name "${name}" is not allowed.`);
  }
  if (typeof category !== 'string' || !TOOL_CATEGORIES.has(category)) {
    throw new TypeError('Tool category must be read_only, action, or approval_required.');
  }
  if (typeof handler !== 'function') {
    throw new TypeError('Tool handler must be a function.');
  }
}

export function createToolRegistry() {
  const tools = new Map();

  return Object.freeze({
    register(definition) {
      validateDefinition(definition);
      if (tools.has(definition.name)) {
        throw new Error(`Tool "${definition.name}" is already registered.`);
      }

      const tool = Object.freeze({
        name: definition.name,
        description: definition.description.trim(),
        inputSchema: cloneAndFreeze(definition.inputSchema),
        category: definition.category,
        handler: definition.handler,
      });
      tools.set(tool.name, tool);
      return tool.name;
    },
    get(name) {
      return tools.get(name);
    },
    has(name) {
      return tools.has(name);
    },
    getPublicDeclarations() {
      return Object.freeze([...tools.values()].map((tool) => Object.freeze({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.inputSchema,
      })));
    },
    get size() {
      return tools.size;
    },
  });
}
