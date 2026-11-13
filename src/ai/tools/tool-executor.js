import { validateToolArguments } from './tool-validator.js';
import { assertToolPermission } from './tool-permission-policy.js';

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_ARGUMENT_BYTES = 4096;
const DEFAULT_MAX_OUTPUT_BYTES = 8192;

export class ToolExecutionError extends Error {
  constructor(code, message, { executionStarted = false, outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'ToolExecutionError';
    this.code = code;
    this.executionStarted = executionStarted;
    this.outcomeUnknown = outcomeUnknown;
  }
}

function snapshotTrustedContext(context) {
  if (context == null) return Object.freeze({});
  if (
    typeof context !== 'object' ||
    Array.isArray(context) ||
    Object.getPrototypeOf(context) !== Object.prototype
  ) {
    throw new TypeError('Trusted tool context must be a plain object.');
  }

  const copy = Object.create(null);
  for (const [key, value] of Object.entries(context)) {
    if (key === 'authorizedTools') {
      const grants = value instanceof Set
        ? [...value]
        : Array.isArray(value)
          ? [...value]
          : null;
      if (!grants || grants.some((grant) => typeof grant !== 'string')) {
        throw new TypeError('authorizedTools must be an array or Set of tool names.');
      }
      Object.defineProperty(copy, key, {
        value: Object.freeze(grants),
        enumerable: true,
      });
      continue;
    }

    let cloned;
    try {
      cloned = structuredClone(value);
    } catch {
      throw new TypeError(`Trusted context field "${key}" is not cloneable.`);
    }
    Object.defineProperty(copy, key, {
      value: deepFreeze(cloned),
      enumerable: true,
    });
  }
  return Object.freeze(copy);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function serializeOutput(output, maxOutputBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(output);
  } catch {
    throw new ToolExecutionError(
      'TOOL_OUTPUT_INVALID',
      'Tool returned an invalid result.',
    );
  }

  if (typeof serialized !== 'string') {
    throw new ToolExecutionError(
      'TOOL_OUTPUT_INVALID',
      'Tool returned an invalid result.',
    );
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxOutputBytes) {
    throw new ToolExecutionError(
      'TOOL_OUTPUT_TOO_LARGE',
      'Tool result exceeded the allowed size.',
    );
  }

  try {
    return JSON.parse(serialized);
  } catch {
    throw new ToolExecutionError(
      'TOOL_OUTPUT_INVALID',
      'Tool returned an invalid result.',
    );
  }
}

export function createToolExecutor({
  registry,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxArgumentBytes = DEFAULT_MAX_ARGUMENT_BYTES,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!registry || typeof registry.get !== 'function') {
    throw new TypeError('A tool registry is required.');
  }
  for (const [name, value] of Object.entries({
    timeoutMs,
    maxArgumentBytes,
    maxOutputBytes,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite number.`);
    }
  }
  if (
    timeoutMs > DEFAULT_TIMEOUT_MS ||
    maxArgumentBytes > DEFAULT_MAX_ARGUMENT_BYTES ||
    maxOutputBytes > DEFAULT_MAX_OUTPUT_BYTES
  ) {
    throw new RangeError('Tool execution limits cannot exceed their safe maxima.');
  }
  if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('Timer dependencies must be functions.');
  }

  return Object.freeze({
    isBoundTo(candidateRegistry) {
      return candidateRegistry === registry;
    },
    async execute(name, args, trustedContext = {}, { onStarted } = {}) {
      if (onStarted !== undefined && typeof onStarted !== 'function') {
        throw new TypeError('onStarted must be a function.');
      }
      const tool = registry.get(name);
      if (!tool) {
        throw new ToolExecutionError(
          'TOOL_NOT_FOUND',
          'Requested tool is not available.',
        );
      }

      const validation = validateToolArguments(
        tool.inputSchema,
        args,
        { maxSerializedBytes: maxArgumentBytes },
      );
      if (!validation.valid) {
        throw new ToolExecutionError(
          'TOOL_ARGUMENTS_INVALID',
          `Tool arguments are invalid: ${validation.errors.map(({ path, message }) => `${path} ${message}`).join(' ')}`,
        );
      }

      let safeContext;
      try {
        safeContext = snapshotTrustedContext(trustedContext);
      } catch {
        throw new ToolExecutionError(
          'TOOL_PERMISSION_DENIED',
          'Tool permission denied.',
        );
      }
      try {
        assertToolPermission(tool, safeContext);
      } catch {
        throw new ToolExecutionError(
          'TOOL_PERMISSION_DENIED',
          'Tool permission denied.',
        );
      }

      const handlerContext = Object.create(null);
      for (const [key, value] of Object.entries(safeContext)) {
        if (key === 'authorizedTools' || key === 'grantedCapabilities') continue;
        Object.defineProperty(handlerContext, key, {
          value,
          enumerable: true,
        });
      }

      const abortController = new AbortController();
      Object.defineProperty(handlerContext, 'signal', {
        value: abortController.signal,
        enumerable: true,
      });
      Object.freeze(handlerContext);

      function freezeArguments(value) {
        if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
          return value;
        }
        for (const nested of Object.values(value)) freezeArguments(nested);
        return Object.freeze(value);
      }

      const safeArguments = freezeArguments(validation.value);
      let timeout;
      let timedOut = false;
      onStarted?.();
      const handlerPromise = Promise.resolve().then(
        () => tool.handler(safeArguments, handlerContext),
      );
      handlerPromise.catch(() => {});

      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimer(() => {
          timedOut = true;
          abortController.abort();
          reject(new ToolExecutionError(
            'TOOL_TIMEOUT',
            'Tool execution timed out; the handler may still be running.',
            { executionStarted: true, outcomeUnknown: true },
          ));
        }, timeoutMs);
      });

      try {
        const output = await Promise.race([handlerPromise, timeoutPromise]);
        if (timedOut) {
          throw new ToolExecutionError(
            'TOOL_TIMEOUT',
            'Tool execution timed out; the handler may still be running.',
          );
        }
        return serializeOutput(output, maxOutputBytes);
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          if (error.executionStarted) throw error;
          throw new ToolExecutionError(error.code, error.message, {
            executionStarted: true,
            outcomeUnknown: error.outcomeUnknown,
          });
        }
        throw new ToolExecutionError(
          'TOOL_EXECUTION_FAILED',
          'Tool execution failed.',
          { executionStarted: true },
        );
      } finally {
        if (timeout !== undefined) clearTimer(timeout);
      }
    },
  });
}
