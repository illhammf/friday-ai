const SCHEMA_KEYS = {
  object: new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
  ]),
  string: new Set([
    'type',
    'enum',
    'minLength',
    'maxLength',
  ]),
  number: new Set([
    'type',
    'enum',
    'minimum',
    'maximum',
  ]),
  integer: new Set([
    'type',
    'enum',
    'minimum',
    'maximum',
  ]),
  boolean: new Set(['type', 'enum']),
};

const JSON_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean']);

export class ToolSchemaError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'ToolSchemaError';
    this.code = 'INVALID_TOOL_SCHEMA';
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(path, message) {
  throw new ToolSchemaError(`${path}: ${message}`);
}

function validateEnum(schema, path) {
  if (!Object.hasOwn(schema, 'enum')) return;
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
    fail(path, 'enum must be a non-empty array.');
  }

  for (const value of schema.enum) {
    if (
      value !== null &&
      !['string', 'number', 'boolean'].includes(typeof value)
    ) {
      fail(path, 'enum values must be strings, numbers, booleans, or null.');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      fail(path, 'enum numbers must be finite.');
    }
  }
}

function validateSchema(schema, path = 'schema') {
  if (!isPlainObject(schema)) {
    fail(path, 'must be an object.');
  }

  if (!JSON_TYPES.has(schema.type)) {
    fail(path, 'type must be object, string, number, integer, or boolean.');
  }

  const allowedKeys = SCHEMA_KEYS[schema.type];
  for (const key of Object.keys(schema)) {
    if (!allowedKeys.has(key)) {
      fail(path, `unsupported keyword "${key}".`);
    }
  }
  validateEnum(schema, path);

  if (schema.type === 'object') {
    if (!isPlainObject(schema.properties)) {
      fail(path, 'object schemas require a properties object.');
    }
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== 'boolean'
    ) {
      fail(path, 'additionalProperties must be a boolean.');
    }
    const required = schema.required ?? [];
    if (
      !Array.isArray(required) ||
      required.some((name) => typeof name !== 'string') ||
      new Set(required).size !== required.length
    ) {
      fail(path, 'required must be an array of unique property names.');
    }
    for (const name of required) {
      if (!Object.hasOwn(schema.properties, name)) {
        fail(path, `required property "${name}" has no schema.`);
      }
    }
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      if (['__proto__', 'prototype', 'constructor'].includes(name)) {
        fail(path, `reserved property name "${name}" is not allowed.`);
      }
      validateSchema(propertySchema, `${path}.properties.${name}`);
    }
    return;
  }

  if (schema.type === 'string') {
    validateLengthBound(schema, 'minLength', path);
    validateLengthBound(schema, 'maxLength', path);
    if (
      schema.minLength !== undefined &&
      schema.maxLength !== undefined &&
      schema.minLength > schema.maxLength
    ) {
      fail(path, 'minLength cannot exceed maxLength.');
    }
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    validateNumberBound(schema, 'minimum', path);
    validateNumberBound(schema, 'maximum', path);
    if (
      schema.minimum !== undefined &&
      schema.maximum !== undefined &&
      schema.minimum > schema.maximum
    ) {
      fail(path, 'minimum cannot exceed maximum.');
    }
  }

  if (schema.enum) {
    for (const value of schema.enum) {
      if (!matchesType(schema.type, value)) {
        fail(path, `enum values must match type "${schema.type}".`);
      }
    }
  }
}

function validateLengthBound(schema, key, path) {
  if (
    schema[key] !== undefined &&
    (!Number.isInteger(schema[key]) || schema[key] < 0)
  ) {
    fail(path, `${key} must be a non-negative integer.`);
  }
}

function validateNumberBound(schema, key, path) {
  if (schema[key] !== undefined && !Number.isFinite(schema[key])) {
    fail(path, `${key} must be a finite number.`);
  }
}

function matchesType(type, value) {
  if (type === 'object') return isPlainObject(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string' || type === 'boolean') return typeof value === type;
  return false;
}

export function assertSupportedToolSchema(schema) {
  validateSchema(schema);
  return schema;
}

function validateValue(schema, value, path, errors) {
  if (!matchesType(schema.type, value)) {
    errors.push({
      path,
      message: `must be ${schema.type === 'integer' ? 'a safe integer' : `of type ${schema.type}`}.`,
    });
    return;
  }

  if (schema.enum && !schema.enum.some((allowed) => Object.is(allowed, value))) {
    errors.push({ path, message: 'must match one of the allowed values.' });
  }

  if (schema.type === 'object') {
    const properties = schema.properties;
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) {
        errors.push({ path: `${path}.${name}`, message: 'is required.' });
      }
    }
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(properties, name)) {
        if (schema.additionalProperties === false) {
          errors.push({ path: `${path}.${name}`, message: 'is not allowed.' });
        }
        continue;
      }
      validateValue(properties[name], value[name], `${path}.${name}`, errors);
    }
  } else if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `must contain at least ${schema.minLength} characters.` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `must contain at most ${schema.maxLength} characters.` });
    }
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `must be at least ${schema.minimum}.` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `must be at most ${schema.maximum}.` });
    }
  }
}

export function validateToolArguments(
  schema,
  argumentsValue,
  { maxSerializedBytes = 4096 } = {},
) {
  assertSupportedToolSchema(schema);

  if (!Number.isSafeInteger(maxSerializedBytes) || maxSerializedBytes <= 0) {
    throw new TypeError('maxSerializedBytes must be a positive safe integer.');
  }

  function cloneJsonValue(value, path = '$') {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      return value.map((item, index) => cloneJsonValue(item, `${path}[${index}]`));
    }
    if (!isPlainObject(value)) {
      throw new TypeError(`${path} is not plain JSON data.`);
    }

    const clone = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TypeError(`${path} contains a non-string property.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${path}.${key} is not plain JSON data.`);
      }
      Object.defineProperty(clone, key, {
        value: cloneJsonValue(descriptor.value, `${path}.${key}`),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return clone;
  }

  let serialized;
  let safeArguments;
  try {
    safeArguments = cloneJsonValue(argumentsValue);
    serialized = JSON.stringify(safeArguments);
  } catch {
    return {
      valid: false,
      errors: [{ path: '$', message: 'must be JSON-serializable.' }],
    };
  }

  if (typeof serialized !== 'string') {
    return {
      valid: false,
      errors: [{ path: '$', message: 'must be JSON-serializable.' }],
    };
  }

  if (Buffer.byteLength(serialized, 'utf8') > maxSerializedBytes) {
    return {
      valid: false,
      errors: [{
        path: '$',
        message: `serialized arguments exceed ${maxSerializedBytes} bytes.`,
      }],
    };
  }

  const errors = [];
  validateValue(schema, safeArguments, '$', errors);
  return {
    valid: errors.length === 0,
    errors,
    ...(errors.length === 0 ? { value: safeArguments } : {}),
  };
}
