import type { FastifyInstance } from "fastify";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import {
  attachBrowserTransport,
  type BrowserTransport,
} from "../../telephony/browser-transport.js";
import type { AppConfig } from "../../config/schema.js";
import { publicDir } from "../public-dir.js";

/** Committed et/ru/en fixture recordings used by replay mode + bake-off. */
export const fixturesDir = fileURLToPath(new URL("../../../test/fixtures/", import.meta.url));

export interface DevCallRouteDeps {
  config: AppConfig;
  /** Called when a browser session starts (wires the pipeline). */
  onTransport: (transport: BrowserTransport, start: { mode?: string; fixture?: string }) => void;
}

/**
 * Dev browser-call harness (design D11). Only registered when
 * DEV_BROWSER_CALLS=true; otherwise the routes 404 (per spec).
 */
export async function registerDevCallRoutes(app: FastifyInstance, deps: DevCallRouteDeps) {
  if (!deps.config.devBrowserCalls) return;

  app.get("/dev/call", async (_req, reply) => {
    return reply.sendFile("dev/index.html", publicDir);
  });

  app.get("/dev/fixtures", async () => {
    try {
      return readdirSync(fixturesDir)
        .filter((f) => f.endsWith(".wav"))
        .sort();
    } catch {
      return [];
    }
  });

  app.get("/dev/fixtures/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!/^[\w.-]+\.wav$/i.test(name)) return reply.code(400).send({ error: "bad fixture name" });
    try {
      const data = await readFile(join(fixturesDir, name));
      return reply.type("audio/wav").send(data);
    } catch {
      return reply.code(404).send({ error: "fixture not found" });
    }
  });

  app.get("/media/browser", { websocket: true }, (socket: WebSocket) => {
    attachBrowserTransport(socket, deps.config, (transport, start) => {
      deps.onTransport(transport, start);
    });
  });
}
