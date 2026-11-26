import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGroupSenderScope,
  isSenderScopedGroupSession,
} from '../src/application/conversation-scope.js';

test('group sender scope separates participants and groups deterministically', () => {
  const ilhamA = createGroupSenderScope('group-a', 'sender-ilham');
  const gunawanA = createGroupSenderScope('group-a', 'sender-gunawan');
  const ilhamB = createGroupSenderScope('group-b', 'sender-ilham');

  assert.notEqual(ilhamA, gunawanA);
  assert.notEqual(ilhamA, ilhamB);
  assert.equal(ilhamA, createGroupSenderScope('group-a', 'sender-ilham'));
  assert.equal(isSenderScopedGroupSession(ilhamA), true);
});

test('missing or blank sender evidence cannot create a sender scope', () => {
  assert.equal(createGroupSenderScope('group-a', null), null);
  assert.equal(createGroupSenderScope('group-a', '   '), null);
  assert.equal(createGroupSenderScope(null, 'sender'), null);
});
