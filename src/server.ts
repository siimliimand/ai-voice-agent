/**
 * Server entrypoint: build the app, listen, and own process lifecycle.
 *
 * Graceful shutdown (SIGTERM/SIGINT): stop listening, hang up every active
 * call ("server_shutdown"), wait for sessions to drain (≤ 10 s), close the
 * database, exit 0. A hard-exit timer (15 s) guarantees the process never
 * hangs on a stuck connection or DB call.
 */
import { loadConfig } from "./config/index.js";
import type { AppConfig } from "./config/schema.js";
import { closeDb } from "./db/client.js";
import { logger } from "./logging.js";
import { buildApp } from "./app.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Drain window for active calls after the listener is closed. */
const DRAIN_TIMEOUT_MS = 10_000;
/** Hard exit: the process never survives longer than this after a signal. */
const HARD_EXIT_MS = 15_000;

export async function startServer(config: AppConfig = loadConfig()) {
  const { app, db, sessions, transports, retention } = await buildApp(config);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`ai-voice-agent listening on ${config.host}:${config.port}`);

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.error(err, "uncaught exception — exiting");
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");

    const hardExit = setTimeout(() => {
      logger.error("graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, HARD_EXIT_MS);
    hardExit.unref();

    void (async () => {
      // 0. Stop the retention scheduler so no purge run starts mid-shutdown
      //    (an in-flight run finishes; bounded by the hard-exit timer).
      retention?.stop();

      // 1. Stop accepting NEW connections without tearing down live
      //    websocket transports — app.close() would kill their sockets
      //    before clients ever see the "server_shutdown" hangup notice.
      //    The close callback waits on the sockets we are about to drain,
      //    so it is intentionally not awaited here (fastify's own close
      //    below tolerates the already-closing server).
      app.server.close(() => undefined);

      // 2. Drain: hang up every active call, then wait for sessions to end.
      const active = sessions.active();
      if (active.length > 0) {
        app.log.info({ count: active.length }, "draining active calls");
      }
      for (const session of active) {
        const transport = transports.get(session.callSid);
        if (transport) {
          void transport.hangup("server_shutdown").catch(() => undefined);
        } else {
          sessions.end(session, "failed");
        }
      }
      const deadline = Date.now() + DRAIN_TIMEOUT_MS;
      while (sessions.active().length > 0 && Date.now() < deadline) {
        await sleep(100);
      }
      const remaining = sessions.active().length;
      if (remaining > 0) {
        app.log.warn({ count: remaining }, "calls still active after drain window");
      }

      // 3. Full teardown: plugin onClose hooks + server close (bounded).
      await Promise.race([app.close(), sleep(5_000)]);

      // 4. Close the database pool (hangup handlers have finalized rows).
      if (db) {
        try {
          await closeDb(db);
        } catch (err) {
          app.log.warn({ err }, "database close failed during shutdown");
        }
      }

      clearTimeout(hardExit);
      process.exit(0);
    })().catch((err) => {
      logger.error(err, "error during shutdown");
      process.exit(1);
    });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  return app;
}

// Entrypoint when run directly (`npm run dev` / dist build).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    logger.error(err, "Fatal startup error");
    process.exit(1);
  });
}
