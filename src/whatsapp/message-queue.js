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
  };
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
