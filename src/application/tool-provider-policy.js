const RETRY_DENIAL_REASONS = Object.freeze({
  not_started: 'provider_not_selected',
  invalid_request: 'request_invalid_or_unconfirmed',
  progress_unavailable: 'execution_progress_unavailable',
  execution_started: 'tool_execution_started',
  outcome_unknown: 'execution_outcome_unknown',
  unsafe_progress: 'retry_safety_denied',
  call_failed: 'pre_execution_tool_call_failed',
  not_provider_failure: 'failure_not_provider_generation',
  provider_failure_unclassified: 'provider_failure_not_retryable',
  provider_mismatch: 'failure_from_different_provider_or_model',
  budget_exhausted: 'provider_attempt_budget_exhausted',
  no_provider: 'no_alternate_provider_available',
});

export class ToolProviderPolicyError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'ToolProviderPolicyError';
    this.code = 'INVALID_TOOL_PROVIDER_POLICY';
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolProviderPolicyError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeProviders(providers) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new ToolProviderPolicyError(
      'At least one provider/model candidate is required.',
    );
  }

  const identities = new Set();
  return Object.freeze(providers.map((provider, index) => {
    if (
      !provider ||
      typeof provider !== 'object' ||
      Array.isArray(provider)
    ) {
      throw new ToolProviderPolicyError(
        `Provider candidate ${index + 1} must be an object.`,
      );
    }

    const providerId = assertNonEmptyString(
      provider.providerId,
      `Provider candidate ${index + 1} providerId`,
    );
    const modelId = assertNonEmptyString(
      provider.modelId,
      `Provider candidate ${index + 1} modelId`,
    );
    if (typeof provider.createGenerator !== 'function') {
      throw new ToolProviderPolicyError(
        `Provider candidate ${index + 1} must provide createGenerator.`,
      );
    }

    const identity = `${providerId}\u0000${modelId}`;
    if (identities.has(identity)) {
      throw new ToolProviderPolicyError(
        'Provider/model candidates must have unique identities.',
      );
    }
    identities.add(identity);

    return Object.freeze({
      providerId,
      modelId,
      createGenerator: provider.createGenerator,
    });
  }));
}

function getProgressDenialReason(progress) {
  if (
    !progress ||
    typeof progress !== 'object' ||
    typeof progress.hasExecutionStarted !== 'boolean' ||
    typeof progress.hasUncertainOutcome !== 'boolean' ||
    !Array.isArray(progress.calls) ||
    !progress.calls.every((call) =>
      call &&
      typeof call === 'object' &&
      typeof call.executionStarted === 'boolean' &&
      ['validated', 'running', 'succeeded', 'failed', 'unknown'].includes(
        call.state,
      ))
  ) {
    return RETRY_DENIAL_REASONS.progress_unavailable;
  }
  if (progress.hasUncertainOutcome) {
    return RETRY_DENIAL_REASONS.outcome_unknown;
  }
  if (
    progress.hasExecutionStarted ||
    progress.calls.some((call) =>
      call.executionStarted ||
      ['running', 'succeeded', 'unknown'].includes(call.state))
  ) {
    return RETRY_DENIAL_REASONS.execution_started;
  }
  if (progress.calls.some((call) => call.state === 'failed')) {
    return RETRY_DENIAL_REASONS.call_failed;
  }
  if (
    progress.retrySafety &&
    progress.retrySafety.safeToRetry === false
  ) {
    return RETRY_DENIAL_REASONS.unsafe_progress;
  }
  return null;
}

function hasRecognizedProviderFailure(failure) {
  return Boolean(
    failure &&
    typeof failure === 'object' &&
    (
      (
        failure.kind === 'provider' &&
        failure.code === 'GENERATOR_FAILED'
      ) ||
      failure.code === 'GEMINI_GENERATION_FAILED'
    ) &&
    failure.providerFailure &&
    failure.providerFailure.retryable === true,
  );
}

function createPinnedSelection(candidate, attempt) {
  const generator = candidate.createGenerator();
  if (typeof generator !== 'function') {
    throw new ToolProviderPolicyError(
      `Provider ${candidate.providerId}/${candidate.modelId} did not create a generator.`,
    );
  }

  const pinnedGenerator = async (...args) => generator(...args);
  Object.defineProperties(pinnedGenerator, {
    providerId: { value: candidate.providerId },
    modelId: { value: candidate.modelId },
  });
  Object.freeze(pinnedGenerator);

  return Object.freeze({
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    attempt,
    generator: pinnedGenerator,
  });
}

/**
 * Creates a decision-only provider policy. Each session pins one generator
 * until its caller explicitly requests an eligible provider switch.
 */
export function createToolProviderPolicy({
  providers,
  maxProviderAttempts = Array.isArray(providers) ? providers.length : 0,
} = {}) {
  const candidates = normalizeProviders(providers);
  if (
    !Number.isSafeInteger(maxProviderAttempts) ||
    maxProviderAttempts < 1 ||
    maxProviderAttempts > candidates.length
  ) {
    throw new ToolProviderPolicyError(
      `maxProviderAttempts must be between 1 and ${candidates.length}.`,
    );
  }

  return Object.freeze({
    createSession() {
      let selectedIndex = -1;
      let currentSelection = null;

      function denied(reason) {
        return Object.freeze({
          eligible: false,
          reason,
          current: currentSelection,
          next: null,
        });
      }

      function assessNext({ failure, executionProgress, requestValid } = {}) {
        if (!currentSelection) {
          return denied(RETRY_DENIAL_REASONS.not_started);
        }
        if (requestValid !== true) {
          return denied(RETRY_DENIAL_REASONS.invalid_request);
        }

        const progressReason = getProgressDenialReason(executionProgress);
        if (progressReason) return denied(progressReason);
        if (!hasRecognizedProviderFailure(failure)) {
          return denied(
            failure?.kind === 'provider' ||
              failure?.code === 'GEMINI_GENERATION_FAILED'
              ? RETRY_DENIAL_REASONS.provider_failure_unclassified
              : RETRY_DENIAL_REASONS.not_provider_failure,
          );
        }

        const providerFailure = failure.providerFailure;
        if (
          providerFailure.providerId !== currentSelection.providerId ||
          providerFailure.modelId !== currentSelection.modelId
        ) {
          return denied(RETRY_DENIAL_REASONS.provider_mismatch);
        }
        if (currentSelection.attempt >= maxProviderAttempts) {
          return denied(RETRY_DENIAL_REASONS.budget_exhausted);
        }
        if (selectedIndex + 1 >= candidates.length) {
          return denied(RETRY_DENIAL_REASONS.no_provider);
        }

        return Object.freeze({
          eligible: true,
          reason: 'retryable_provider_failure_before_tool_dispatch',
          current: currentSelection,
          next: Object.freeze({
            providerId: candidates[selectedIndex + 1].providerId,
            modelId: candidates[selectedIndex + 1].modelId,
            attempt: currentSelection.attempt + 1,
          }),
        });
      }

      return Object.freeze({
        selectInitial() {
          if (currentSelection) {
            throw new ToolProviderPolicyError(
              'The initial provider has already been selected for this session.',
            );
          }
          const selection = createPinnedSelection(candidates[0], 1);
          selectedIndex = 0;
          currentSelection = selection;
          return currentSelection;
        },
        assessNext,
        selectNext(input) {
          const decision = assessNext(input);
          if (!decision.eligible) return decision;

          const nextIndex = selectedIndex + 1;
          const selection = createPinnedSelection(
            candidates[nextIndex],
            nextIndex + 1,
          );
          selectedIndex = nextIndex;
          currentSelection = selection;
          return Object.freeze({
            ...decision,
            selection: currentSelection,
          });
        },
      });
    },
  });
}
