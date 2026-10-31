export function createShutdownHandler({
  drainMessages,
  destroyClient,
  closeResources,
  logger = console,
  setExitCode = (code) => {
    process.exitCode = code;
  },
} = {}) {
  let shutdownPromise;

  return function shutdown(signal) {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      logger.log(`\nMenutup FRIDAY (${signal})...`);
      let failed = false;

      for (const [label, operation] of [
        ['menunggu antrean pesan', drainMessages],
        ['menutup koneksi WhatsApp', destroyClient],
        ['menutup database', closeResources],
      ]) {
        try {
          await operation();
        } catch (error) {
          failed = true;
          logger.error(
            `[Shutdown] ${label} gagal:`,
            error?.stack || error?.message || error,
          );
        }
      }

      if (failed) {
        setExitCode(1);
      } else {
        logger.log('Friday berhasil dihentikan dengan aman.');
      }
    })();

    return shutdownPromise;
  };
}
