import pino from "pino";

/** Root logger; child loggers are derived per session/pipeline. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
});

export type Logger = pino.Logger;
