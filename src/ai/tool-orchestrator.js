const HARD_LIMITS = Object.freeze({
  maxToolRounds: 2,
  maxCallsPerRound: 3,
  maxTotalCalls: 6,
});
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_DETAILS = Object.freeze({
  TOOL_NOT_FOUND: 'Requested tool is not available.',
  TOOL_ARGUMENTS_INVALID: 'Tool arguments are invalid.',
  TOOL_PERMISSION_DENIED: 'Tool permission denied.',
  TOOL_TIMEOUT: 'Tool execution timed out.',
  TOOL_OUTPUT_INVALID: 'Tool returned an invalid result.',
  TOOL_OUTPUT_TOO_LARGE: 'Tool result exceeded the allowed size.',
  TOOL_EXECUTION_FAILED: 'Tool execution failed.',
});

export class ToolOrchestrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolOrchestrationError';
    this.code = code;
  }
}

function assertLimit(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  if (value > HARD_LIMITS[name]) {
    throw new RangeError(`${name} cannot exceed ${HARD_LIMITS[name]}.`);
  }
}

function readDataObject(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new ToolOrchestrationError(
      'INVALID_GENERATOR_RESPONSE',
      `${label} must be a plain object.`,
    );
  }

  const data = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new ToolOrchestrationError(
        'INVALID_GENERATOR_RESPONSE',
        `${label} contains an invalid property.`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new ToolOrchestrationError(
        'INVALID_GENERATOR_RESPONSE',
        `${label} must contain only data properties.`,
      );
    }
    data[key] = descriptor.value;
  }
  return data;
}

function normalizeGeneratorResponse(response) {
  const data = readDataObject(response, 'Generator response');
  if (Object.keys(data).some((key) => !['text', 'functionCalls'].includes(key))) {
    throw new ToolOrchestrationError(
      'INVALID_GENERATOR_RESPONSE',
      'Generator response contains unsupported fields.',
    );
  }

  const calls = Object.hasOwn(data, 'functionCalls')
    ? data.functionCalls
    : [];
  if (!Array.isArray(calls)) {
    throw new ToolOrchestrationError(
      'INVALID_GENERATOR_RESPONSE',
      'functionCalls must be an array.',
    );
  }

  if (calls.length > 0) {
    if (data.text !== undefined && data.text !== '') {
      throw new ToolOrchestrationError(
        'INVALID_GENERATOR_RESPONSE',
        'A response cannot contain both text and function calls.',
      );
    }
    return { type: 'function_calls', calls };
  }

  if (typeof data.text !== 'string' || !data.text.trim()) {
    throw new ToolOrchestrationError(
      'INVALID_GENERATOR_RESPONSE',
      'Generator response must contain text or function calls.',
    );
  }
  return { type: 'text', text: data.text.trim() };
}

function normalizeCalls(calls, knownCallIds) {
  const normalized = calls.map((call, index) => {
    const data = readDataObject(call, `Function call ${index + 1}`);
    if (
      Object.keys(data).some(
        (key) => !['id', 'name', 'arguments'].includes(key),
      )
    ) {
      throw new ToolOrchestrationError(
        'INVALID_FUNCTION_CALL',
        'Function call contains unsupported fields.',
      );
    }
    if (
      typeof data.id !== 'string' ||
      !data.id.trim() ||
      data.id.length > 128 ||
      typeof data.name !== 'string' ||
      !TOOL_NAME_PATTERN.test(data.name) ||
      !data.arguments ||
      typeof data.arguments !== 'object' ||
      Array.isArray(data.arguments) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(data.arguments))
    ) {
      throw new ToolOrchestrationError(
        'INVALID_FUNCTION_CALL',
        'Function call must contain a valid id, tool name, and object arguments.',
      );
    }
    if (knownCallIds.has(data.id)) {
      throw new ToolOrchestrationError(
        'DUPLICATE_FUNCTION_CALL_ID',
        'Function call IDs must be unique within an orchestration request.',
      );
    }
    knownCallIds.add(data.id);
    return { id: data.id, name: data.name, arguments: data.arguments };
  });
  return normalized;
}

function cloneJson(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (typeof serialized !== 'string') return null;
  try {
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function normalizeToolError(error) {
  const code = Object.hasOwn(ERROR_DETAILS, error?.code)
    ? error.code
    : 'TOOL_EXECUTION_FAILED';
  return { code, message: ERROR_DETAILS[code] };
}

export function createToolOrchestrator({
  generator,
  executor,
  registry,
  maxToolRounds = HARD_LIMITS.maxToolRounds,
  maxCallsPerRound = HARD_LIMITS.maxCallsPerRound,
  maxTotalCalls = HARD_LIMITS.maxTotalCalls,
} = {}) {
  if (typeof generator !== 'function') {
    throw new TypeError('A generator function is required.');
  }
  if (!executor || typeof executor.execute !== 'function') {
    throw new TypeError('A tool executor is required.');
  }
  if (
    !registry ||
    typeof registry.getPublicDeclarations !== 'function' ||
    typeof registry.has !== 'function'
  ) {
    throw new TypeError('A tool registry is required.');
  }
  assertLimit('maxToolRounds', maxToolRounds);
  assertLimit('maxCallsPerRound', maxCallsPerRound);
  assertLimit('maxTotalCalls', maxTotalCalls);

  const declarations = registry.getPublicDeclarations();
  if (!Array.isArray(declarations)) {
    throw new TypeError('Registry public declarations must be an array.');
  }

  return Object.freeze({
    async run(input, trustedContext = {}) {
      const knownCallIds = new Set();
      const functionResponses = [];
      let completedRounds = 0;
      let totalCalls = 0;

      while (true) {
        let response;
        try {
          response = await generator({
            input,
            tools: declarations,
            functionResponses: Object.freeze([...functionResponses]),
          });
        } catch {
          throw new ToolOrchestrationError(
            'GENERATOR_FAILED',
            'The response generator failed.',
          );
        }

        const normalized = normalizeGeneratorResponse(response);
        if (normalized.type === 'text') return normalized.text;

        const calls = normalizeCalls(normalized.calls, knownCallIds);
        if (completedRounds >= maxToolRounds) {
          throw new ToolOrchestrationError(
            'TOOL_ROUND_LIMIT',
            'The maximum number of tool-call rounds was reached.',
          );
        }
        if (calls.length > maxCallsPerRound) {
          throw new ToolOrchestrationError(
            'TOOL_CALL_LIMIT',
            'The maximum number of tool calls per round was reached.',
          );
        }
        if (totalCalls + calls.length > maxTotalCalls) {
          throw new ToolOrchestrationError(
            'TOOL_CALL_LIMIT',
            'The maximum number of tool calls was reached.',
          );
        }

        completedRounds += 1;
        totalCalls += calls.length;
        const roundResponses = [];

        for (const call of calls) {
          if (!registry.has(call.name)) {
            roundResponses.push(Object.freeze({
              id: call.id,
              name: call.name,
              error: Object.freeze({
                code: 'TOOL_NOT_FOUND',
                message: ERROR_DETAILS.TOOL_NOT_FOUND,
              }),
            }));
            continue;
          }

          try {
            const result = await executor.execute(
              call.name,
              call.arguments,
              trustedContext,
            );
            const safeResult = cloneJson(result);
            if (safeResult === null && result !== null) {
              roundResponses.push(Object.freeze({
                id: call.id,
                name: call.name,
                error: Object.freeze({
                  code: 'TOOL_OUTPUT_INVALID',
                  message: ERROR_DETAILS.TOOL_OUTPUT_INVALID,
                }),
              }));
            } else {
              roundResponses.push(Object.freeze({
                id: call.id,
                name: call.name,
                result: deepFreeze(safeResult),
              }));
            }
          } catch (error) {
            roundResponses.push(Object.freeze({
              id: call.id,
              name: call.name,
              error: Object.freeze(normalizeToolError(error)),
            }));
          }
        }

        functionResponses.push(...roundResponses);
      }
    },
  });
}
