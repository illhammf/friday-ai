import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateWithModelFallback,
  getModelChain,
  isModelFallbackError,
} from '../src/ai/model-fallback.js';

test('builds ordered model chains, trimming and deduplicating candidates', () => {
  assert.deepEqual(
    getModelChain(
      ' gemini-main ',
      'gemini-backup, gemini-third',
      'gemini-third,gemini-legacy',
    ),
    [
      'gemini-main',
      'gemini-backup',
      'gemini-third',
      'gemini-legacy',
    ],
  );
});

test('falls through quota and temporary service errors in model order', async () => {
  const attempts = [];
  const fallbacks = [];
  const response = await generateWithModelFallback(
    ['main', 'backup-1', 'backup-2'],
    async (model) => {
      attempts.push(model);
      if (model === 'main') {
        throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
      }
      if (model === 'backup-1') {
        throw Object.assign(new Error('UNAVAILABLE'), { status: 503 });
      }
      return 'response';
    },
    { onFallback: (entry) => fallbacks.push(entry) },
  );

  assert.equal(response, 'response');
  assert.deepEqual(attempts, ['main', 'backup-1', 'backup-2']);
  assert.deepEqual(
    fallbacks.map(({ model, nextModel }) => [model, nextModel]),
    [['main', 'backup-1'], ['backup-1', 'backup-2']],
  );
});

test('tries a backup for an unknown model but not for invalid credentials', async () => {
  const attempts = [];
  const result = await generateWithModelFallback(
    ['unknown-model', 'available-model'],
    async (model) => {
      attempts.push(model);
      if (model === 'unknown-model') {
        throw Object.assign(new Error('model not found'), { status: 404 });
      }
      return 'ok';
    },
  );

  assert.equal(result, 'ok');
  assert.deepEqual(attempts, ['unknown-model', 'available-model']);

  const denied = Object.assign(new Error('permission denied'), { status: 403 });
  await assert.rejects(
    generateWithModelFallback(['main', 'backup'], async () => {
      throw denied;
    }),
    (error) => error === denied,
  );
  assert.equal(isModelFallbackError(denied), false);
});

test('returns the last model error when every configured candidate fails', async () => {
  const finalError = Object.assign(new Error('quota exceeded'), { status: 429 });
  await assert.rejects(
    generateWithModelFallback(
      ['main', 'backup'],
      async (model) => {
        throw model === 'main' ? new Error('quota exceeded') : finalError;
      },
    ),
    (error) => error === finalError,
  );
});
