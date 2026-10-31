export function createMessageQueue({ maxPending = 3 } = {}) {
  const queues = new Map();

  return {
    enqueue(key, task) {
      const current = queues.get(key) || {
        pending: 0,
        tail: Promise.resolve(),
      };

      if (current.pending >= maxPending + 1) {
        return null;
      }

      current.pending++;
      const result = current.tail.catch(() => {}).then(task);
      current.tail = result.then(
        () => finish(key, current, queues),
        () => finish(key, current, queues),
      );
      queues.set(key, current);
      return result;
    },
    async drain() {
      while (queues.size > 0) {
        await Promise.all([...queues.values()].map(({ tail }) => tail));
      }
    },
  };
}

export function createMessageDeduplicator({
  ttlMs = 24 * 60 * 60 * 1000,
  maxEntries = 5000,
  now = Date.now,
} = {}) {
  const seen = new Map();

  function pruneExpired(currentTime) {
    for (const [key, expiresAt] of seen) {
      if (expiresAt <= currentTime) {
        seen.delete(key);
      }
    }
  }

  return {
    claim(key) {
      if (!key) {
        return true;
      }

      const currentTime = now();
      pruneExpired(currentTime);

      if (seen.has(key)) {
        return false;
      }

      while (seen.size >= maxEntries) {
        const oldestKey = seen.keys().next().value;
        seen.delete(oldestKey);
      }

      seen.set(key, currentTime + ttlMs);
      return true;
    },
    release(key) {
      if (key) {
        seen.delete(key);
      }
    },
  };
}

export function getMessageDeduplicationKey(message) {
  const id = message?.id;
  const serializedId = typeof id === 'string'
    ? id
    : id?._serialized ||
      id?.$1 ||
      (
        id?.fromMe != null && id?.remote && id?.id
          ? `${id.fromMe}_${id.remote}_${id.id}`
          : null
      );

  return message?.from && serializedId
    ? `${message.from}:${serializedId}`
    : null;
}

function finish(key, queue, queues) {
  queue.pending--;

  if (queue.pending === 0 && queues.get(key) === queue) {
    queues.delete(key);
  }
}

export function isQueueableMessage(message, botName) {
  if (
    message?.fromMe ||
    !message?.from ||
    (
      message.type !== 'ptt' &&
      message.type !== 'image' &&
      !message.body?.trim()
    )
  ) {
    return false;
  }

  if (!message.from.endsWith('@g.us')) {
    return true;
  }

  const escapedName = String(botName).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  const prefix = new RegExp(`^${escapedName}\\b[\\s,:-]*`, 'i');

  return prefix.test(message.body?.trim() || '');
}
