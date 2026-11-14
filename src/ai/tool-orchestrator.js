import { randomUUID } from 'node:crypto';
import { hasRequiredCapabilities } from './tools/tool-permission-policy.js';

const HARD_LIMITS = Object.freeze({
  maxToolRounds: 2,
  maxCallsPerRound: 3,
  maxTotalCalls: 6,
  maxFunctionResponseBytes: 64 * 1024,
});
const DEFAULT_MAX_FUNCTION_RESPONSE_BYTES = 64 * 1024;
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
  constructor(
    code,
    message,
    {
      kind = 'orchestration',
      executionProgress = null,
      functionResponses = [],
      retrySafety = null,
      cause,
      providerFailure = null,
    } = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ToolOrchestrationError';
    this.code = code;
    this.kind = kind;
    this.executionProgress = executionProgress;
    this.functionResponses = functionResponses;
    this.retrySafety = retrySafety;
    this.providerFailure = providerFailure;
  }
}

function snapshotProgress(requestId, calls) {
  const callRecords = calls.map((call) => {
    const record = {
      sequence: call.sequence,
      round: call.round,
      providerCallId: call.providerCallId,
      toolName: call.toolName,
      state: call.state,
      executionStarted: call.executionStarted,
    };
    if (call.responseIndex !== undefined) {
      record.functionResponseIndex = call.responseIndex;
    }
    if (call.error) record.error = Object.freeze({ ...call.error });
    return Object.freeze(record);
  });
  const hasExecutionStarted = callRecords.some((call) => call.executionStarted);
  const hasUncertainOutcome = callRecords.some((call) => call.state === 'unknown');
  const retrySafety = Object.freeze({
    safeToRetry: !hasExecutionStarted && !hasUncertainOutcome,
    reason: hasUncertainOutcome
      ? 'execution_outcome_unknown'
      : hasExecutionStarted
        ? 'tool_execution_started'
        : 'no_tool_execution_started',
  });
  return Object.freeze({
    requestId,
    state: hasUncertainOutcome
      ? 'unknown'
      : callRecords.some((call) => call.state === 'running')
        ? 'running'
        : callRecords.length === 0
          ? 'not_started'
          : !hasExecutionStarted && callRecords.every((call) => call.state === 'validated')
            ? 'validated'
            : callRecords.every((call) => call.state === 'succeeded')
              ? 'succeeded'
              : callRecords.some((call) => call.state === 'failed')
                ? 'failed'
                : 'not_started',
    hasExecutionStarted,
    hasUncertainOutcome,
    calls: Object.freeze(callRecords),
    retrySafety,
  });
}

function orchestrationFailure(
  code,
  message,
  kind,
  requestId,
  progress,
  responses,
  { cause, providerFailure = null } = {},
) {
  const executionProgress = snapshotProgress(requestId, progress);
  const functionResponses = Object.freeze([...responses]);
  return new ToolOrchestrationError(code, message, {
    kind,
    executionProgress,
    functionResponses,
    retrySafety: executionProgress.retrySafety,
    cause,
    providerFailure,
  });
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
    const safeArguments = clonePlainJson(data.arguments, 4096);
    if (safeArguments === null) {
      throw new ToolOrchestrationError(
        'INVALID_FUNCTION_CALL',
        'Function call arguments must be bounded JSON data.',
      );
    }
    return { id: data.id, name: data.name, arguments: safeArguments };
  });
  return normalized;
}

function clonePlainJson(value, maxBytes) {
  const active = new Set();
  function clone(item) {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean'
    ) {
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || active.has(item)) return undefined;

    active.add(item);
    let copy;
    if (Array.isArray(item)) {
      copy = [];
      for (const element of item) {
        const cloned = clone(element);
        if (cloned === undefined) {
          active.delete(item);
          return undefined;
        }
        copy.push(cloned);
      }
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        active.delete(item);
        return undefined;
      }
      copy = {};
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (
          typeof key !== 'string' ||
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        ) {
          active.delete(item);
          return undefined;
        }
        const cloned = clone(descriptor.value);
        if (cloned === undefined) {
          active.delete(item);
          return undefined;
        }
        Object.defineProperty(copy, key, {
          value: cloned,
          enumerable: true,
        });
      }
    }
    active.delete(item);
    return copy;
  }

  const result = clone(value);
  if (!result || Array.isArray(result) || typeof result !== 'object') return null;
  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch {
    return null;
  }
  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized, 'utf8') > maxBytes
  ) {
    return null;
  }
  return result;
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

function getSerializedBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Infinity;
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

async function getAuthorizedDeclarationNames(trustedContext, registry, executor) {
  const grants = trustedContext?.authorizedTools;
  const capabilities = trustedContext?.grantedCapabilities;
  if (
    !Array.isArray(grants) ||
    !Array.isArray(capabilities) ||
    capabilities.some((capability) =>
      typeof capability !== 'string' ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(capability)) ||
    new Set(capabilities).size !== capabilities.length
  ) return new Set();
  const names = new Set();
  for (const name of grants) {
    if (
      typeof name !== 'string' ||
      !TOOL_NAME_PATTERN.test(name) ||
      names.has(name) ||
      !registry.has(name)
    ) {
      return new Set();
    }
    const metadata = registry.getAuthorizationMetadata?.(name);
    if (!hasRequiredCapabilities(metadata, capabilities)) {
      return new Set();
    }
    names.add(name);
  }
  const currentlyAuthorized = new Set();
  for (const name of names) {
    if (await executor.isAuthorized(name, trustedContext)) {
      currentlyAuthorized.add(name);
    }
  }
  return currentlyAuthorized;
}

export function createToolOrchestrator({
  generator,
  executor,
  registry,
  createRequestId = randomUUID,
  maxFunctionResponseBytes = DEFAULT_MAX_FUNCTION_RESPONSE_BYTES,
  maxToolRounds = HARD_LIMITS.maxToolRounds,
  maxCallsPerRound = HARD_LIMITS.maxCallsPerRound,
  maxTotalCalls = HARD_LIMITS.maxTotalCalls,
} = {}) {
  if (typeof generator !== 'function') {
    throw new TypeError('A generator function is required.');
  }
  if (
    !executor ||
    typeof executor.execute !== 'function' ||
    typeof executor.isAuthorized !== 'function'
  ) {
    throw new TypeError('A tool executor is required.');
  }
  if (
    !registry ||
    typeof registry.getPublicDeclarations !== 'function' ||
    typeof registry.has !== 'function'
  ) {
    throw new TypeError('A tool registry is required.');
  }
  if (
    !executor ||
    typeof executor.isBoundTo !== 'function' ||
    executor.isBoundTo(registry) !== true
  ) {
    throw new TypeError('The tool executor must be bound to the same registry.');
  }
  if (typeof createRequestId !== 'function') {
    throw new TypeError('createRequestId must be a function.');
  }
  assertLimit('maxToolRounds', maxToolRounds);
  assertLimit('maxCallsPerRound', maxCallsPerRound);
  assertLimit('maxTotalCalls', maxTotalCalls);
  assertLimit('maxFunctionResponseBytes', maxFunctionResponseBytes);

  const declarations = registry.getPublicDeclarations();
  if (!Array.isArray(declarations)) {
    throw new TypeError('Registry public declarations must be an array.');
  }

  return Object.freeze({
    async run(input, trustedContext = {}) {
      const requestId = createRequestId();
      if (
        typeof requestId !== 'string' ||
        !requestId.trim() ||
        requestId.length > 128
      ) {
        throw new TypeError('createRequestId must return a non-empty string of at most 128 characters.');
      }
      const knownCallIds = new Set();
      const functionResponses = [];
      const progress = [];
      const authorizedDeclarationNames = await getAuthorizedDeclarationNames(
        trustedContext,
        registry,
        executor,
      );
      const declarationsForRequest = declarations.filter(({ name }) =>
        authorizedDeclarationNames.has(name));
      let completedRounds = 0;
      let totalCalls = 0;

      while (true) {
        let response;
        try {
          response = await generator({
            input,
            tools: declarationsForRequest,
            functionResponses: Object.freeze([...functionResponses]),
          });
        } catch (cause) {
          const isAdapterProtocolFailure =
            cause?.name === 'GeminiToolAdapterError' &&
            cause.kind === 'protocol';
          throw orchestrationFailure(
            isAdapterProtocolFailure
              ? cause.code || 'INVALID_GENERATOR_RESPONSE'
              : 'GENERATOR_FAILED',
            isAdapterProtocolFailure
              ? cause.message || 'The response generator returned an invalid response.'
              : 'The response generator failed.',
            isAdapterProtocolFailure ? 'protocol' : 'provider',
            requestId,
            progress,
            functionResponses,
            {
              cause,
              providerFailure: isAdapterProtocolFailure
                ? null
                : cause?.providerFailure || null,
            },
          );
        }

        let normalized;
        try {
          normalized = normalizeGeneratorResponse(response);
        } catch (error) {
          throw orchestrationFailure(
            error.code || 'INVALID_GENERATOR_RESPONSE',
            error.message || 'Generator response is invalid.',
            'protocol',
            requestId,
            progress,
            functionResponses,
          );
        }
        if (normalized.type === 'text') {
          const executionProgress = snapshotProgress(requestId, progress);
          return Object.freeze({
            status: 'succeeded',
            text: normalized.text,
            executionProgress,
            functionResponses: Object.freeze([...functionResponses]),
            retrySafety: executionProgress.retrySafety,
          });
        }

        let calls;
        try {
          calls = normalizeCalls(normalized.calls, knownCallIds);
        } catch (error) {
          throw orchestrationFailure(
            error.code || 'INVALID_FUNCTION_CALL',
            error.message || 'Function call is invalid.',
            'validation',
            requestId,
            progress,
            functionResponses,
          );
        }
        const nextRound = completedRounds + 1;
        const roundProgress = calls.map((call, index) => ({
          sequence: progress.length + index + 1,
          round: nextRound,
          providerCallId: call.id,
          toolName: call.name,
          state: 'validated',
          executionStarted: false,
        }));
        if (completedRounds >= maxToolRounds) {
          progress.push(...roundProgress);
          throw orchestrationFailure(
            'TOOL_ROUND_LIMIT',
            'The maximum number of tool-call rounds was reached.',
            'orchestration',
            requestId,
            progress,
            functionResponses,
          );
        }
        if (calls.length > HARD_LIMITS.maxCallsPerRound) {
          progress.push(...roundProgress);
          throw orchestrationFailure(
            'TOOL_CALL_LIMIT',
            'The maximum number of tool calls per round was reached.',
            'orchestration',
            requestId,
            progress,
            functionResponses,
          );
        }
        if (calls.length > maxCallsPerRound) {
          progress.push(...roundProgress);
          throw orchestrationFailure(
            'TOOL_CALL_LIMIT',
            'The maximum number of tool calls per round was reached.',
            'orchestration',
            requestId,
            progress,
            functionResponses,
          );
        }
        if (totalCalls + calls.length > maxTotalCalls) {
          progress.push(...roundProgress);
          throw orchestrationFailure(
            'TOOL_CALL_LIMIT',
            'The maximum number of tool calls was reached.',
            'orchestration',
            requestId,
            progress,
            functionResponses,
          );
        }

        completedRounds += 1;
        totalCalls += calls.length;
        progress.push(...roundProgress);
        const roundResponses = [];

        for (const [callIndex, call] of calls.entries()) {
          const callRecord = deepFreeze({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          });
          const callProgress = roundProgress[callIndex];
          const responseBase = {
            round: completedRounds,
            roundCallIndex: callIndex + 1,
            roundCallCount: calls.length,
            call: callRecord,
            id: call.id,
            name: call.name,
          };
          if (!registry.has(call.name)) {
            callProgress.state = 'failed';
            callProgress.error = {
              code: 'TOOL_NOT_FOUND',
              message: ERROR_DETAILS.TOOL_NOT_FOUND,
            };
            callProgress.responseIndex = functionResponses.length + roundResponses.length;
            roundResponses.push(Object.freeze({
              ...responseBase,
              error: Object.freeze({
                code: 'TOOL_NOT_FOUND',
                message: ERROR_DETAILS.TOOL_NOT_FOUND,
              }),
            }));
            if (
              getSerializedBytes([...functionResponses, ...roundResponses]) >
              maxFunctionResponseBytes
            ) {
              functionResponses.push(...roundResponses);
              throw orchestrationFailure(
                'FUNCTION_RESPONSE_HISTORY_TOO_LARGE',
                'Accumulated function-response history exceeded its allowed size.',
                'orchestration',
                requestId,
                progress,
                functionResponses,
              );
            }
            continue;
          }
          if (!authorizedDeclarationNames.has(call.name)) {
            callProgress.state = 'failed';
            callProgress.error = {
              code: 'TOOL_PERMISSION_DENIED',
              message: ERROR_DETAILS.TOOL_PERMISSION_DENIED,
            };
            callProgress.responseIndex = functionResponses.length + roundResponses.length;
            roundResponses.push(Object.freeze({
              ...responseBase,
              error: Object.freeze({
                code: 'TOOL_PERMISSION_DENIED',
                message: ERROR_DETAILS.TOOL_PERMISSION_DENIED,
              }),
            }));
            continue;
          }

          try {
            const markStarted = () => {
              callProgress.state = 'running';
              callProgress.executionStarted = true;
            };
            const result = await executor.execute(
              call.name,
              call.arguments,
              trustedContext,
              { onStarted: markStarted },
            );
            if (!callProgress.executionStarted) markStarted();
            const safeResult = cloneJson(result);
            if (safeResult === null && result !== null) {
              callProgress.state = 'failed';
              callProgress.error = {
                code: 'TOOL_OUTPUT_INVALID',
                message: ERROR_DETAILS.TOOL_OUTPUT_INVALID,
              };
              callProgress.responseIndex = functionResponses.length + roundResponses.length;
              roundResponses.push(Object.freeze({
                ...responseBase,
                error: Object.freeze({
                  code: 'TOOL_OUTPUT_INVALID',
                  message: ERROR_DETAILS.TOOL_OUTPUT_INVALID,
                }),
              }));
            } else {
              callProgress.state = 'succeeded';
              callProgress.responseIndex = functionResponses.length + roundResponses.length;
              roundResponses.push(Object.freeze({
                ...responseBase,
                result: deepFreeze(safeResult),
              }));
            }
            if (
              getSerializedBytes([...functionResponses, ...roundResponses]) >
              maxFunctionResponseBytes
            ) {
              functionResponses.push(...roundResponses);
              throw orchestrationFailure(
                'FUNCTION_RESPONSE_HISTORY_TOO_LARGE',
                'Accumulated function-response history exceeded its allowed size.',
                'orchestration',
                requestId,
                progress,
                functionResponses,
              );
            }
          } catch (error) {
            if (error instanceof ToolOrchestrationError) throw error;
            const errorCode = Object.hasOwn(ERROR_DETAILS, error?.code)
              ? error.code
              : 'TOOL_EXECUTION_FAILED';
            const hasExecutionMetadata =
              typeof error?.executionStarted === 'boolean';
            if (error?.executionStarted === true) {
              callProgress.executionStarted = true;
              if (callProgress.state === 'validated') callProgress.state = 'running';
            } else if (error?.executionStarted !== false && !callProgress.executionStarted) {
              callProgress.executionStarted = true;
              callProgress.state = 'unknown';
            }
            if (
              error?.outcomeUnknown === true ||
              errorCode === 'TOOL_TIMEOUT' ||
              (!hasExecutionMetadata && callProgress.executionStarted)
            ) {
              callProgress.state = 'unknown';
            } else {
              callProgress.state = 'failed';
            }
            callProgress.error = {
              code: errorCode,
              message: ERROR_DETAILS[errorCode],
            };
            callProgress.responseIndex = functionResponses.length + roundResponses.length;
            roundResponses.push(Object.freeze({
              ...responseBase,
              error: Object.freeze(normalizeToolError(error)),
            }));
            if (callProgress.state === 'unknown') {
              functionResponses.push(...roundResponses);
              throw orchestrationFailure(
                'TOOL_OUTCOME_UNKNOWN',
                'Tool execution timed out or its completion could not be confirmed.',
                'tool_execution',
                requestId,
                progress,
                functionResponses,
              );
            }
            if (
              getSerializedBytes([...functionResponses, ...roundResponses]) >
              maxFunctionResponseBytes
            ) {
              functionResponses.push(...roundResponses);
              throw orchestrationFailure(
                'FUNCTION_RESPONSE_HISTORY_TOO_LARGE',
                'Accumulated function-response history exceeded its allowed size.',
                'orchestration',
                requestId,
                progress,
                functionResponses,
              );
            }
          }
        }

        functionResponses.push(...roundResponses);
      }
    },
  });
}
