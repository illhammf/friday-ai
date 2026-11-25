import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canUsePersonalMemory,
  createSenderIdentityVerifier,
} from '../src/application/sender-identity.js';
import { normalizeWhatsAppMessage } from '../src/whatsapp/message-adapter.js';

const message = (overrides = {}) => ({
  messageId: 'synthetic-message',
  chatId: 'group@g.us',
  senderId: 'participant@c.us',
  chatType: 'group',
  ...overrides,
});

test('default identity verifier fails closed and never creates a principal', async () => {
  const verifier = createSenderIdentityVerifier();
  const result = await verifier.verify(message());
  assert.deepEqual(result, { status: 'unavailable', reason: 'identity_verification_unavailable' });
  assert.equal(canUsePersonalMemory(result), false);
});

test('verified principal comes only from the injected resolver', async () => {
  const verifier = createSenderIdentityVerifier({
    resolve: async (evidence) => {
      assert.equal(evidence.conversationType, 'group');
      return { status: 'verified', principalId: 'principal:gunawan' };
    },
  });
  const result = await verifier.verify(message());
  assert.deepEqual(result, { status: 'verified', principalId: 'principal:gunawan' });
  assert.equal(canUsePersonalMemory(result), true);
});

test('invalid, ambiguous, provider failures, and malformed principals fail closed', async () => {
  for (const resolve of [
    async () => ({ status: 'verified', principalId: 'gunawan' }),
    async () => ({ status: 'ambiguous' }),
    async () => { throw new Error('provider failed'); },
    async () => ({ status: 'unknown' }),
  ]) {
    const result = await createSenderIdentityVerifier({ resolve }).verify(message());
    assert.notEqual(result.status, 'verified');
    assert.equal(canUsePersonalMemory(result), false);
  }
});

test('missing group author never falls back to the group chat ID', () => {
  const normalized = normalizeWhatsAppMessage({
    from: 'group@g.us',
    author: undefined,
    id: { _serialized: 'message-1' },
    type: 'chat',
    body: 'Friday, halo',
    timestamp: 123,
  }, async () => null);
  assert.equal(normalized.chatId, 'group@g.us');
  assert.equal(normalized.senderId, null);
  assert.notEqual(normalized.senderId, normalized.chatId);
});

test('quoted-message metadata cannot replace the current sender evidence', async () => {
  const current = message({ senderId: 'principal-candidate:gunawan', quotedAuthor: 'ilham@c.us' });
  const seen = [];
  const verifier = createSenderIdentityVerifier({
    resolve: async (evidence) => {
      seen.push(evidence);
      return { status: 'unavailable' };
    },
  });
  await verifier.verify(current);
  assert.equal(seen[0].senderEvidence, 'principal-candidate:gunawan');
  assert.equal('quotedAuthor' in seen[0], false);
});
