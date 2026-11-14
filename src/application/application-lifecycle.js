import { createShutdownHandler } from '../whatsapp/shutdown.js';

/**
 * @typedef {Object} ApplicationDependencies
 * @property {() => Promise<Object>|Object} openDatabase
 * @property {(database: Object) => Promise<Object>|Object} createClient
 * @property {(client: Object, database: Object) => Promise<void>|void} [configureClient]
 * @property {(client: Object, database: Object) => Promise<void>|void} initializeClient
 * @property {() => Promise<void>|void} drainMessages
 * @property {number} [drainTimeoutMs]
 * @property {number} [cleanupTimeoutMs]
 * @property {number} [startupTimeoutMs]
 * @property {() => Promise<void>|void} stopAccepting
 * @property {Object} logger
 * @property {(code: number) => void} [setExitCode]
 */

/**
 * Builds an application controller without opening resources or starting
 * external integrations.
 * @param {ApplicationDependencies} dependencies
 */
export function createApplication(dependencies) {
  let database;
  let client;
  let state = 'idle';
  let startPromise;
  let cleanupPromise;
  let shutdownPromise;
  let shutdownRequested = false;
  const startupTimeoutMs = Number.isFinite(dependencies.startupTimeoutMs) &&
    dependencies.startupTimeoutMs > 0
    ? dependencies.startupTimeoutMs
    : 30_000;

  const shutdownResources = createShutdownHandler({
    stopAccepting: dependencies.stopAccepting,
    drainMessages: dependencies.drainMessages,
    drainTimeoutMs: dependencies.drainTimeoutMs,
    cleanupTimeoutMs: dependencies.cleanupTimeoutMs,
    destroyClient: async () => {
      if (client) {
        await client.destroy();
      }
    },
    closeResources: async () => {
      if (database) {
        await database.close();
      }
    },
    logger: dependencies.logger,
    setExitCode: dependencies.setExitCode,
    onComplete: ({ completed, failed }) => {
      if (completed) state = failed ? 'failed' : 'stopped';
      else state = 'failed';
    },
  });

  const application = {
    get state() {
      return state;
    },
    get resources() {
      return { database, client };
    },
    start() {
      if (state === 'running') {
        return Promise.resolve(application.resources);
      }

      if (state === 'starting') {
        return startPromise;
      }

      if (state !== 'idle') {
        return Promise.reject(
          new Error(`Cannot start application from state "${state}".`),
        );
      }

      state = 'starting';
      startPromise = (async () => {
        try {
          database = await dependencies.openDatabase();
          client = await dependencies.createClient(database);
          await dependencies.configureClient?.(client, database);
          await dependencies.initializeClient(client, database);

          if (shutdownRequested) {
            throw new Error('Application startup interrupted by shutdown.');
          }

          state = 'running';
          return application.resources;
        } catch (startupError) {
          state = shutdownRequested ? 'stopping' : 'failed';
          await cleanup('STARTUP_FAILURE');

          throw startupError;
        }
      })();

      return startPromise;
    },
    shutdown(signal = 'SHUTDOWN') {
      if (shutdownPromise) {
        return shutdownPromise;
      }

      if (cleanupPromise) return cleanupPromise;

      shutdownRequested = true;
      state = 'stopping';
      shutdownPromise = (async () => {
        await shutdownResources.stopAccepting();
        if (startPromise) {
          let timer;
          const startupOutcome = await Promise.race([
            startPromise.then(
              () => 'settled',
              () => 'settled',
            ),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve('timeout'), startupTimeoutMs);
            }),
          ]);
          clearTimeout(timer);

          if (startupOutcome === 'timeout') {
            dependencies.logger?.error?.(
              `[Shutdown] startup belum selesai setelah ${startupTimeoutMs} ms; resource tetap terbuka sampai startup berhenti.`,
            );
            (dependencies.setExitCode || ((code) => { process.exitCode = code; }))(1);
            startPromise.then(
              () => cleanup(signal),
              () => cleanup(signal),
            ).catch((error) => {
              dependencies.logger?.error?.(
                `[Shutdown] cleanup tertunda gagal (${error?.name || 'Error'}).`,
              );
              (dependencies.setExitCode || ((code) => { process.exitCode = code; }))(1);
            });
            return false;
          }
          await startPromise.catch(() => {});
        }
        return cleanup(signal);
      })();

      return shutdownPromise;
    },
  };

  function cleanup(signal) {
    if (!cleanupPromise) {
      cleanupPromise = shutdownResources(signal);
    }

    return cleanupPromise;
  }

  return application;
}
