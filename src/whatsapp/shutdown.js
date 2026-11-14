export function createShutdownHandler({
  stopAccepting = async () => {},
  drainMessages = async () => {},
  destroyClient = async () => {},
  closeResources = async () => {},
  drainTimeoutMs = 30_000,
  cleanupTimeoutMs = 30_000,
  logger = console,
  setExitCode = (code) => {
    process.exitCode = code;
  },
  onComplete = () => {},
} = {}) {
  let shutdownPromise;
  let exitCodeSet = false;
  let stopAdmissionPromise;
  let admissionFailed = false;
  const safeDrainTimeoutMs = Number.isFinite(drainTimeoutMs) && drainTimeoutMs > 0
    ? drainTimeoutMs
    : 30_000;
  const safeCleanupTimeoutMs = Number.isFinite(cleanupTimeoutMs) && cleanupTimeoutMs > 0
    ? cleanupTimeoutMs
    : 30_000;

  function markFailureExitCode() {
    if (exitCodeSet) return;
    exitCodeSet = true;
    setExitCode(1);
  }

  function stopAdmission() {
    if (!stopAdmissionPromise) {
      try {
        stopAdmissionPromise = Promise.resolve(stopAccepting()).catch((error) => {
          admissionFailed = true;
          logger.error(`[Shutdown] menghentikan penerimaan pesan gagal (${error?.name || 'Error'}).`);
        });
      } catch (error) {
        admissionFailed = true;
        logger.error(`[Shutdown] menghentikan penerimaan pesan gagal (${error?.name || 'Error'}).`);
        stopAdmissionPromise = Promise.resolve();
      }
    }
    return stopAdmissionPromise.then(() => !admissionFailed);
  }

  async function waitFor(operation, timeoutMs) {
    const promise = Promise.resolve().then(operation);
    let timer;
    const outcome = await Promise.race([
      promise.then(
        () => ({ type: 'completed' }),
        (error) => ({ type: 'failed', error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return { outcome, promise };
  }

  async function closeAfterDrain() {
    let failed = false;
    const pending = [];
    for (const [label, operation] of [
      ['menutup koneksi WhatsApp', destroyClient],
      ['menutup database', closeResources],
    ]) {
      const { outcome, promise } = await waitFor(operation, safeCleanupTimeoutMs);
      if (outcome.type === 'timeout') {
        failed = true;
        markFailureExitCode();
        logger.error(`[Shutdown] ${label} melewati batas ${safeCleanupTimeoutMs} ms; operasi masih berjalan.`);
        pending.push(promise.then(
          () => {},
          (error) => logger.error(`[Shutdown] ${label} gagal (${error?.name || 'Error'}).`),
        ));
      } else if (outcome.type === 'failed') {
        failed = true;
        logger.error(`[Shutdown] ${label} gagal (${outcome.error?.name || 'Error'}).`);
      }
    }
    return { failed, pending };
  }

  function complete({ completed, failed }) {
    onComplete({ completed, failed });
    if (!completed || failed) markFailureExitCode();
    if (completed && !failed) {
      logger.log('Friday berhasil dihentikan dengan aman.');
    }
  }

  const shutdown = function shutdown(signal) {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      logger.log(`\nMenutup FRIDAY (${signal})...`);
      const admissionStopped = await stopAdmission();
      if (!admissionStopped) {
        complete({ completed: false, failed: true });
        return false;
      }
      let failed = false;

      const { outcome: drainOutcome, promise: drainPromise } =
        await waitFor(drainMessages, safeDrainTimeoutMs);

      if (drainOutcome.type === 'timeout') {
        logger.error(`[Shutdown] antrean belum kosong setelah ${safeDrainTimeoutMs} ms; koneksi WhatsApp dan database tetap terbuka sampai antrean selesai.`);
        markFailureExitCode();
        drainPromise.then(async () => {
          const cleanup = await closeAfterDrain();
          if (cleanup.pending.length > 0) {
            await Promise.allSettled(cleanup.pending);
          }
          complete({ completed: true, failed: true });
        }).catch((error) => {
          logger.error(`[Shutdown] antrean gagal ditiriskan (${error?.name || 'Error'}); resource tetap terbuka.`);
          complete({ completed: false, failed: true });
        });
        return false;
      }

      if (drainOutcome.type === 'failed') {
        logger.error(`[Shutdown] pengosongan antrean gagal (${drainOutcome.error?.name || 'Error'}); koneksi WhatsApp dan database tetap terbuka.`);
        complete({ completed: false, failed: true });
        return false;
      }

      const cleanup = await closeAfterDrain();
      failed ||= cleanup.failed;
      if (cleanup.pending.length > 0) {
        Promise.allSettled(cleanup.pending).then(() => {
          complete({ completed: true, failed: true });
        });
        return false;
      }
      complete({ completed: true, failed });
      return !failed;
    })();

    return shutdownPromise;
  };

  shutdown.stopAccepting = stopAdmission;
  return shutdown;
}
