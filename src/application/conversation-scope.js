import { createHash } from 'node:crypto';

function safeEvidence(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Returns a stable conversational partition key. This is deliberately not a
 * verified principal and must never authorize personal memory or tools.
 */
export function createGroupSenderScope(groupId, senderEvidence) {
  const group = safeEvidence(groupId);
  const sender = safeEvidence(senderEvidence);
  if (!group || !sender) return null;

  const digest = createHash('sha256')
    .update(`${group}\u0000${sender}`, 'utf8')
    .digest('hex');
  return `group-sender:${digest}`;
}

export function isSenderScopedGroupSession(sessionId) {
  return typeof sessionId === 'string' && /^group-sender:[a-f0-9]{64}$/.test(sessionId);
}
