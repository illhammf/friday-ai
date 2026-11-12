import {
  assertAssistantRequest,
  AssistantRequestError,
  createAssistantRequest,
} from '../ai/assistant-request.js';
import { createToolOrchestrator } from '../ai/tool-orchestrator.js';

const REQUEST_OPTION_KEYS = new Set([
  'question',
  'history',
  'image',
  'systemInstruction',
  'conversationStyle',
  'memoryContext',
]);

const NOT_STARTED_PROGRESS = Object.freeze({
  requestId: null,
  state: 'not_started',
  hasExecutionStarted: false,
  hasUncertainOutcome: false,
  calls: Object.freeze([]),
  retrySafety: Object.freeze({
    safeToRetry: true,
    reason: 'no_tool_execution_started',
  }),
});

export class ToolAssistantError extends Error {
  constructor(code, message, {
    kind,
    executionProgress = NOT_STARTED_PROGRESS,
    functionResponses = [],
    retrySafety = NOT_STARTED_PROGRESS.retrySafety,
    hasUncertainOutcome = false,
    cause,
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ToolAssistantError';
    this.code = code;
    this.kind = kind;
    this.executionProgress = executionProgress;
    this.functionResponses = functionResponses;
    this.retrySafety = retrySafety;
    this.hasUncertainOutcome = hasUncertainOutcome;
  }
}

function isPlainRecord(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)),
  );
}

function readRequestOptions(value) {
  if (!isPlainRecord(value)) {
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      'Tool assistant request options must be a plain object.',
    );
  }

  const options = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === 'string'
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    if (
      typeof key !== 'string' ||
      !REQUEST_OPTION_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new AssistantRequestError(
        'INVALID_ASSISTANT_REQUEST',
        'Tool assistant request options contain unsupported or unsafe fields.',
      );
    }
    Object.defineProperty(options, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return options;
}

function preExecutionError(code, message, kind, cause) {
  return new ToolAssistantError(code, message, {
    kind,
    cause,
  });
}

function getRetrySafety(progress, reportedRetrySafety) {
  const reliableProgress = Boolean(
    progress &&
    typeof progress.hasExecutionStarted === 'boolean' &&
    typeof progress.hasUncertainOutcome === 'boolean',
  );
  const hasUncertainOutcome = !reliableProgress ||
    progress.hasUncertainOutcome;
  const hasExecutionStarted = reliableProgress &&
    progress.hasExecutionStarted;

  if (hasUncertainOutcome || hasExecutionStarted) {
    return Object.freeze({
      safeToRetry: false,
      reason: hasUncertainOutcome
        ? 'execution_outcome_unknown'
        : 'tool_execution_started',
    });
  }

  if (typeof reportedRetrySafety?.safeToRetry === 'boolean') {
    return reportedRetrySafety;
  }

  return Object.freeze({
    safeToRetry: false,
    reason: 'execution_status_unavailable',
  });
}

function normalizeOrchestrationError(error) {
  const hasProgress = Boolean(
    error?.executionProgress &&
    typeof error.executionProgress === 'object',
  );
  const progress = hasProgress ? error.executionProgress : null;
  const hasReliableProgress = Boolean(
    progress &&
    typeof progress.hasExecutionStarted === 'boolean' &&
    typeof progress.hasUncertainOutcome === 'boolean',
  );
  const hasUncertainOutcome = !hasReliableProgress ||
    progress.hasUncertainOutcome;
  const retrySafety = getRetrySafety(progress, [
    error?.retrySafety,
    progress?.retrySafety,
  ].find((candidate) =>
    candidate &&
    typeof candidate.safeToRetry === 'boolean',
  ));

  return new ToolAssistantError(
    typeof error?.code === 'string' ? error.code : 'TOOL_ASSISTANT_FAILED',
    typeof error?.message === 'string'
      ? error.message
      : 'Tool assistant orchestration failed.',
    {
      kind: typeof error?.kind === 'string' ? error.kind : 'unknown',
      executionProgress: progress,
      functionResponses: Array.isArray(error?.functionResponses)
        ? error.functionResponses
        : Object.freeze([]),
      retrySafety,
      hasUncertainOutcome,
      cause: error,
    },
  );
}

function assertSuccessfulResult(result) {
  const progress = result?.executionProgress &&
    typeof result.executionProgress === 'object'
    ? result.executionProgress
    : null;
  const hasReliableProgress = Boolean(
    progress &&
    typeof progress.hasExecutionStarted === 'boolean' &&
    typeof progress.hasUncertainOutcome === 'boolean',
  );
  const retrySafety = getRetrySafety(progress, result?.retrySafety);

  if (
    !result ||
    typeof result !== 'object' ||
    result.status !== 'succeeded' ||
    typeof result.text !== 'string' ||
    !result.text.trim() ||
    !result.executionProgress ||
    typeof result.executionProgress !== 'object' ||
    typeof result.executionProgress.hasExecutionStarted !== 'boolean' ||
    typeof result.executionProgress.hasUncertainOutcome !== 'boolean' ||
    !Array.isArray(result.executionProgress.calls) ||
    !Array.isArray(result.functionResponses) ||
    !result.retrySafety ||
    typeof result.retrySafety.safeToRetry !== 'boolean' ||
    !hasReliableProgress ||
    (
      result.retrySafety.safeToRetry &&
      (
        progress.hasExecutionStarted ||
        progress.hasUncertainOutcome
      )
    ) ||
    progress.hasUncertainOutcome
  ) {
    throw new ToolAssistantError(
      'INVALID_ORCHESTRATOR_RESULT',
      'Tool orchestrator returned an invalid success result.',
      {
        kind: 'protocol',
        executionProgress: progress,
        functionResponses: Array.isArray(result?.functionResponses)
          ? result.functionResponses
          : Object.freeze([]),
        retrySafety,
        hasUncertainOutcome: !hasReliableProgress ||
          progress.hasUncertainOutcome,
      },
    );
  }
}

/**
 * Creates one application-owned orchestration boundary for a preconfigured
 * registry/executor pair. Request data and trusted execution context remain
 * separate; tool registrations must be complete before this is constructed.
 */
export function createToolAssistant({
  registry,
  executor,
  generator,
  createTrustedContext,
  createRequest = createAssistantRequest,
  validateRequest = assertAssistantRequest,
  createOrchestrator = createToolOrchestrator,
} = {}) {
  if (!registry || typeof registry.getPublicDeclarations !== 'function') {
    throw new TypeError('A configured tool registry is required.');
  }
  if (
    !executor ||
    typeof executor.execute !== 'function' ||
    typeof executor.isBoundTo !== 'function' ||
    executor.isBoundTo(registry) !== true
  ) {
    throw new TypeError('The executor must be bound to the supplied registry.');
  }
  if (typeof generator !== 'function') {
    throw new TypeError('A provider generator function is required.');
  }
  if (typeof createTrustedContext !== 'function') {
    throw new TypeError('An application trusted-context factory is required.');
  }
  if (typeof createRequest !== 'function') {
    throw new TypeError('An assistant request factory is required.');
  }
  if (typeof validateRequest !== 'function') {
    throw new TypeError('An assistant request validator is required.');
  }
  if (typeof createOrchestrator !== 'function') {
    throw new TypeError('A tool orchestrator factory is required.');
  }

  const orchestrator = createOrchestrator({
    generator,
    executor,
    registry,
  });
  if (!orchestrator || typeof orchestrator.run !== 'function') {
    throw new TypeError('The orchestrator factory must return a run-capable orchestrator.');
  }

  return Object.freeze({
    async run({ request: requestOptions, applicationContext } = {}) {
      let trustedContext;
      try {
        trustedContext = await createTrustedContext(applicationContext);
        if (
          !isPlainRecord(trustedContext) ||
          !['private', 'group'].includes(trustedContext.conversationType)
        ) {
          throw new TypeError(
            'Trusted context must define a private or group conversation type.',
          );
        }
      } catch (error) {
        throw preExecutionError(
          typeof error?.code === 'string'
            ? error.code
            : 'TRUSTED_CONTEXT_INVALID',
          'Application trusted context could not be established.',
          'authorization',
          error,
        );
      }

      if (trustedContext.conversationType === 'group') {
        throw preExecutionError(
          'GROUP_TOOL_EXECUTION_DISABLED',
          'Tool execution is not enabled for group conversations.',
          'authorization',
        );
      }

      let request;
      try {
        const requestInput = readRequestOptions(requestOptions);
        requestInput.conversationType = trustedContext.conversationType;
        requestInput.senderName = typeof trustedContext.senderName === 'string'
          ? trustedContext.senderName
          : 'Pengguna';
        request = validateRequest(createRequest(requestInput));
        if (
          !request ||
          request.version !== 1 ||
          request.metadata?.conversationType !== trustedContext.conversationType
        ) {
          throw new AssistantRequestError(
            'INVALID_ASSISTANT_REQUEST',
            'Validated request does not match the trusted conversation scope.',
          );
        }
      } catch (error) {
        throw preExecutionError(
          typeof error?.code === 'string'
            ? error.code
            : 'INVALID_ASSISTANT_REQUEST',
          typeof error?.message === 'string'
            ? error.message
            : 'Assistant request validation failed.',
          'validation',
          error,
        );
      }

      let result;
      try {
        result = await orchestrator.run(request, trustedContext);
      } catch (error) {
        if (error instanceof ToolAssistantError) throw error;
        throw normalizeOrchestrationError(error);
      }

      assertSuccessfulResult(result);
      return result;
    },
  });
}
