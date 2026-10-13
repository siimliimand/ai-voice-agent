/**
 * Composition root: wires transports, sessions, providers, DB and the admin
 * surface into one Fastify app.
 *
 * Degradation contract — the app must BOOT and serve /health with zero
 * external credentials:
 * - no STT key        → calls run without transcription
 * - no TTS key        → calls run without speech
 * - no OPENROUTER_API_KEY → calls run without replies (announced per session)
 * - no DATABASE_URL   → no persistence, no notes, admin console disabled
 * Missing pieces are stubbed at this layer (see noop* providers) so the
 * pipeline itself keeps a single code path.
 */
import { EventEmitter } from "node:events";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { WebSocket } from "ws";

import { registerAdminApi } from "./api/routes.js";
import { registerSettingsApi, kyselySettingsDb } from "./api/settings.js";
import { kyselyAdminDb } from "./api/db.js";
import { basicAuthScope, registerBasicAuth } from "./auth/basic-auth.js";
import { ConversationManager } from "./agent/conversation-manager.js";
import { LanguageManager } from "./agent/language-manager.js";
import { voiceForLanguage } from "./agent/voice-registry.js";
import { EffectiveConfigResolver } from "./config/effective.js";
import { loadConfig } from "./config/index.js";
import type { AppConfig } from "./config/schema.js";
import { closeDb, createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import type { Database } from "./db/schema.js";
import { finalizeCall, insertCall, insertCallEvent } from "./db/queries.js";
import { OpenRouterClient } from "./llm/openrouter.js";
import { logger } from "./logging.js";
import { attachNotesPipeline, TranscriptWriter } from "./notes/index.js";
import {
  VoicePipeline,
  type ConversationAgent,
  type PipelineUtterance,
} from "./pipeline/voice-pipeline.js";
import { createSttProvider, type SttProvider } from "./stt/index.js";
import type { CallTransport } from "./telephony/transport.js";
import type { BrowserTransport } from "./telephony/browser-transport.js";
import { attachTwilioMediaStream } from "./telephony/twilio/media-stream.js";
import { registerTwilioRoutes } from "./telephony/twilio/routes.js";
import { createTtsProvider, type TtsProvider } from "./tts/index.js";
import type { Language } from "./types.js";
import { registerDevCallRoutes } from "./web/dev-call/routes.js";
import { registerAdminPages } from "./web/admin/pages.js";
import { registerSettingsPage } from "./web/admin/settings.js";
import { publicDir } from "./web/public-dir.js";
import { CallSession } from "./session/call-session.js";
import { CallSessionManager } from "./session/manager.js";

/**
 * Test/CI seams: substitute real providers or a ready database. When stt/tts
 * or llm is provided it wins for EVERY call (live-apply per-session provider
 * construction from the call's effective config is skipped for that piece);
 * db bypasses the settings-backed resolver's database entirely.
 */
export interface AppOverrides {
  stt?: SttProvider;
  tts?: TtsProvider;
  llm?: OpenRouterClient;
  /** Pre-built (e.g. migrated/test) database; owned and closed by the caller. */
  db?: Kysely<Database>;
}

/** Everything buildApp returns, for tests and the server entrypoint. */
export interface AppHandle {
  app: FastifyInstance;
  /** Active database, or undefined when running degraded. */
  db: Kysely<Database> | undefined;
  providers: {
    stt: SttProvider | undefined;
    tts: TtsProvider | undefined;
    llm: OpenRouterClient | undefined;
  };
  sessions: CallSessionManager;
  /** Live transports by callSid — used by graceful shutdown to drain calls. */
  transports: Map<string, CallTransport>;
  /** Wire one transport into a full call session. Never throws. */
  startCallSession: (transport: CallTransport) => () => void;
  /** Close the Fastify app, then the database when this app created it. */
  close: () => Promise<void>;
}

const ADMIN_DISABLED_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Voice Agent Admin</title></head>
<body>
<main>
<h1>Voice Agent Admin</h1>
<div class="empty">
<p><strong>The admin console is disabled:</strong> no DATABASE_URL is configured on this server.</p>
<p>Set DATABASE_URL (and run migrations) to enable call history, transcripts and notes.</p>
</div>
</main>
</body>
</html>`;

export async function buildApp(
  config: AppConfig = loadConfig(),
  overrides: AppOverrides = {},
): Promise<AppHandle> {
  // pino-typed app logger for the module helpers below (TranscriptWriter,
  // ConversationManager, …) which take pino.Logger rather than Fastify's
  // FastifyBaseLogger alias. Same underlying destination as app.log.
  // Note: the level must go in child()'s OPTIONS, not the bindings — a
  // `level` binding is recorded but does not change the effective level.
  const appLog = logger.child({}, { level: config.logLevel });
  const app = Fastify({
    // Cast: pino's class instance type is narrower than the FastifyBaseLogger
    // alias the route helpers below expect, but structurally identical.
    loggerInstance: appLog as unknown as FastifyBaseLogger,
    trustProxy: true,
  });

  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, { root: publicDir, prefix: "/static" });

  app.get("/health", async () => ({
    ok: true,
    uptime_s: Math.round(process.uptime()),
  }));

  // ------------------------------------------------------------- providers
  // Each factory throws a clear "missing X_API_KEY" error; degrade to
  // undefined (with a warning naming the variable) instead of refusing to boot.
  let stt: SttProvider | undefined;
  try {
    stt = overrides.stt ?? createSttProvider(config);
  } catch (err) {
    app.log.warn({ err }, "stt provider unavailable — calls run without transcription");
  }

  let tts: TtsProvider | undefined;
  try {
    tts = overrides.tts ?? createTtsProvider(config);
  } catch (err) {
    app.log.warn({ err }, "tts provider unavailable — calls run without speech");
  }

  let llm: OpenRouterClient | undefined;
  if (overrides.llm) {
    llm = overrides.llm;
  } else {
    try {
      llm = new OpenRouterClient({ apiKey: config.llm.apiKey, baseUrl: config.llm.baseUrl });
    } catch {
      app.log.warn("llm unavailable: OPENROUTER_API_KEY is not set — calls run without replies");
    }
  }

  // ------------------------------------------------------------- database
  let db: Kysely<Database> | undefined = overrides.db;
  let dbOwned = false;
  if (db === undefined && config.databaseUrl) {
    let created: Kysely<Database> | undefined;
    try {
      created = createDb(config.databaseUrl);
      const applied = await runMigrations(created);
      db = created;
      dbOwned = true;
      created = undefined;
      app.log.info({ migrationsApplied: applied.length }, "database ready");
    } catch (err) {
      app.log.error({ err }, "database init failed — running degraded without persistence");
      if (created) await created.destroy().catch(() => undefined);
    }
  }

  // ------------------------------------------------- live-apply settings
  // DB-backed settings (admin console) override the startup config for NEW
  // calls and for admin authentication, without a restart. The resolver
  // caches for a couple of seconds so per-call resolution stays a cheap
  // cache hit; without a database it simply returns the base config.
  const resolver = new EffectiveConfigResolver(config, db);

  // ------------------------------------------------------------- sessions
  const sessions = new CallSessionManager();
  const transports = new Map<string, CallTransport>();

  // Lazily-built shared LLM client for post-call work (notes). The client is
  // stateless, so one instance per distinct (apiKey, baseUrl) pair is safe
  // to reuse; it is rebuilt only when the effective llm config changes. Test
  // overrides (AppOverrides.llm) always win.
  let notesLlmCache: { client: OpenRouterClient; key: string } | undefined;
  const notesLlm = async (): Promise<OpenRouterClient | undefined> => {
    if (overrides.llm) return overrides.llm;
    const effective = await resolver.get();
    const key = `${effective.llm.apiKey ?? ""}|${effective.llm.baseUrl}`;
    if (notesLlmCache?.key === key) return notesLlmCache.client;
    try {
      const client = new OpenRouterClient({
        apiKey: effective.llm.apiKey,
        baseUrl: effective.llm.baseUrl,
      });
      notesLlmCache = { client, key };
      return client;
    } catch {
      return undefined;
    }
  };

  // Post-call notes: needs persistence AND an LLM; subscribes once, here.
  // Config + client resolve lazily at summarize time, so notes can be
  // enabled after boot (e.g. the API key added via the admin console); when
  // no client is available at summarize time the note is skipped with a
  // warning.
  if (db) {
    const database = db;
    attachNotesPipeline({
      db: database,
      sessions,
      config,
      getConfig: () => resolver.get(),
      getLlm: () => notesLlm(),
      logger: appLog,
    });
  } else {
    app.log.warn("notes pipeline disabled: needs DATABASE_URL");
  }

  // ------------------------------------------------------- call lifecycle
  // wireCall is async (it resolves the call's effective config first — a
  // single short-TTL-cached query). startCallSession keeps its synchronous
  // `() => void` teardown contract: the returned function delegates to the
  // real cleanup as soon as wiring completes, and a wiring failure hangs the
  // transport up instead of throwing.
  const startCallSession = (transport: CallTransport): (() => void) => {
    let cleanup: (() => void) | undefined;
    let teardownRequested = false;
    let failed = false;
    void wireCall(transport).then(
      (wired) => {
        cleanup = wired;
        if (teardownRequested) cleanup();
      },
      (err: unknown) => {
        failed = true;
        app.log.error({ err, callSid: transport.info.callSid }, "failed to start call session");
        void transport.hangup("internal_error").catch(() => undefined);
      },
    );
    return () => {
      if (failed) return;
      teardownRequested = true;
      cleanup?.();
    };
  };

  const wireCall = async (transport: CallTransport): Promise<() => void> => {
    // Live-apply: resolve THIS call's config (startup config <- DB settings
    // doc) before anything per-call is built. Every per-call component below
    // (STT/TTS factories, LLM client, conversation/language managers, voice
    // mapping) is constructed from callConfig, so admin changes apply to new
    // calls without a restart. Route registration further below keeps the
    // startup `config` — HTTP routes and socket bindings are startup-time.
    const callConfig = await resolver.get();
    const info = transport.info;
    const log = appLog.child({ callSid: info.callSid });
    const session = new CallSession(info);
    sessions.create(session);
    transports.set(info.callSid, transport);

    // ---- Per-call providers from the call's effective config. Test
    // overrides (AppOverrides.stt/tts/llm) win and skip the per-call
    // factories (they substitute providers wholesale in tests).
    let callStt: SttProvider | undefined;
    if (overrides.stt) {
      callStt = overrides.stt;
    } else {
      try {
        callStt = createSttProvider(callConfig);
      } catch (err) {
        log.warn({ err }, "stt provider unavailable — call runs without transcription");
      }
    }

    let callTts: TtsProvider | undefined;
    if (overrides.tts) {
      callTts = overrides.tts;
    } else {
      try {
        callTts = createTtsProvider(callConfig);
      } catch (err) {
        log.warn({ err }, "tts provider unavailable — call runs without speech");
      }
    }

    let callLlm: OpenRouterClient | undefined;
    if (overrides.llm) {
      callLlm = overrides.llm;
    } else {
      try {
        callLlm = new OpenRouterClient({
          apiKey: callConfig.llm.apiKey,
          baseUrl: callConfig.llm.baseUrl,
        });
      } catch {
        log.warn("llm unavailable: OPENROUTER_API_KEY is not set — call runs without replies");
      }
    }

    // ---- DB call row + incremental transcript persistence.
    const transcriptWriter = db
      ? new TranscriptWriter({
          db,
          // The calls row inserts asynchronously; the writer buffers until the
          // id lands on session.meta.
          callId: () => {
            const id = session.meta["callId"];
            return typeof id === "number" ? id : undefined;
          },
          logger: log,
        })
      : undefined;

    let callIdReady: Promise<number | undefined> | undefined;
    if (db) {
      const database = db;
      callIdReady = insertCall(database, {
        callSid: info.callSid,
        from: info.from,
        to: info.to,
        provider: info.provider,
      })
        .then(async (callId) => {
          session.meta["callId"] = callId;
          await insertCallEvent(database, {
            callId,
            type: "call_started",
            detail: { provider: info.provider },
          });
          return callId;
        })
        .catch((err: unknown) => {
          log.error({ err }, "failed to persist call row; DB features disabled for this call");
          return undefined;
        });
    }

    // ---- Conversation agent + language detection (skipped without an LLM).
    let conversation: ConversationManager | undefined;
    let languages: LanguageManager | undefined;
    if (callLlm) {
      const client = callLlm;
      languages = new LanguageManager(callConfig, client);
      conversation = new ConversationManager({
        config: callConfig,
        llm: client,
        language: languages,
        logger: log,
      });
    }

    const onUtterance = transcriptWriter
      ? (u: PipelineUtterance): void => void transcriptWriter.write(u)
      : undefined;
    const voice: (language: Language | null) => string = (language) =>
      voiceForLanguage(callConfig, language);

    let pipeline: VoicePipeline;
    if (conversation && languages) {
      const conversationRef = conversation;
      const languagesRef = languages;
      // Adapter joining language management with the conversation agent: the
      // first utterance detects + locks the language, later ones may re-lock.
      // Detection uses the utility-model vote; fusing the STT hint in lands
      // with the STT bake-off. (`pipeline` is assigned right after this
      // object literal; handleUtterance only runs once calls flow.)
      const agent: ConversationAgent = {
        async *handleUtterance(text: string, _language: Language | null) {
          const detected =
            languagesRef.current === null
              ? await languagesRef.detect(text)
              : await languagesRef.maybeRelock(text);
          if (detected !== null && detected !== session.language) {
            pipeline.setLanguage(detected);
          }
          yield* conversationRef.handleUtterance(text, detected);
        },
        onBargeIn: () => conversationRef.onBargeIn(),
        setLanguage: (language) => conversationRef.setLanguage(language),
        close: () => conversationRef.close(),
      };
      pipeline = new VoicePipeline({
        transport,
        session,
        stt: callStt ?? noopSttProvider(),
        tts: callTts ?? noopTtsProvider(),
        agent,
        resolveVoice: voice,
        logger: log,
        onUtterance,
      });
    } else {
      // Degraded: no LLM. The pipeline still transcribes; no replies, no greeting.
      pipeline = new VoicePipeline({
        transport,
        session,
        stt: callStt ?? noopSttProvider(),
        tts: callTts ?? noopTtsProvider(),
        agent: noopAgent(),
        resolveVoice: voice,
        logger: log,
        onUtterance,
      });
      log.warn("llm_not_configured: no OPENROUTER_API_KEY — call runs without replies");
      transport.announce({ type: "status", text: "llm_not_configured" });
    }

    pipeline.start();

    // Greeting is composition policy, not pipeline behavior.
    if (conversation) {
      const greeting = conversation.greet();
      void pipeline.speakGreeting(greeting).catch((err: unknown) => {
        log.warn({ err }, "greeting playback failed");
      });
    }

    const cleanup = (): void => {
      transport.removeListener("hangup", onHangup);
      transport.removeListener("error", onError);
      pipeline.close();
      transports.delete(info.callSid);
    };

    const onHangup = (reason: string): void => {
      log.info({ reason }, "call_ended");
      cleanup();
      sessions.end(session, "completed");
      if (db && callIdReady) {
        const database = db;
        void callIdReady
          .then(async (callId) => {
            if (callId === undefined) return;
            await finalizeCall(database, callId, {
              status: "completed",
              durationS: Math.round(session.durationMs / 1000),
              language: session.language ?? undefined,
            });
            await insertCallEvent(database, {
              callId,
              type: "call_ended",
              detail: { reason },
            });
          })
          .catch((err: unknown) => log.error({ err }, "failed to finalize call row"));
      }
    };

    const onError = (err: Error): void => {
      log.warn({ err }, "transport error (non-fatal)");
    };

    transport.on("hangup", onHangup);
    transport.on("error", onError);
    return cleanup;
  };

  // ---------------------------------------------------------------- routes
  registerTwilioRoutes(app, { config });

  // Twilio media websocket — the production call entrypoint. Registered
  // regardless of the dev flag.
  app.get(config.twilio.mediaWsPath, { websocket: true }, (socket: WebSocket) => {
    attachTwilioMediaStream(socket, {}, (twilioTransport) => {
      startCallSession(twilioTransport);
    });
  });

  await registerDevCallRoutes(app, {
    config,
    onTransport: (browserTransport: BrowserTransport) => {
      startCallSession(browserTransport);
    },
  });

  // Contract: basic auth MUST be registered before the admin API/pages.
  // Credentials resolve per request from the effective config (base admin
  // config overridden by the settings doc's admin.user/admin.password), so a
  // password change in the console applies immediately. Fail-closed is
  // preserved: an unset password locks the console.
  registerBasicAuth(app, {
    getAdminCredentials: async () => {
      const effective = await resolver.get();
      return { user: effective.admin.user, password: effective.admin.password };
    },
  });

  if (db) {
    registerAdminApi(app, { db: kyselyAdminDb(db), config });
    registerAdminPages(app, { db: kyselyAdminDb(db), config });
    // Settings console (HTML form at /admin/settings): same basic-auth scope,
    // same persistence seam as /api/settings. A successful save invalidates
    // the resolver cache so the next call picks the change up immediately.
    registerSettingsPage(app, {
      db: kyselySettingsDb(db),
      config,
      invalidate: () => resolver.invalidate(),
    });
    // DB-backed settings console: GET/PUT /api/settings (same basic-auth
    // scope). A successful PUT invalidates the resolver cache so the next
    // call picks the change up immediately.
    registerSettingsApi(app, {
      db: kyselySettingsDb(db),
      config,
      invalidate: () => resolver.invalidate(),
    });
  } else {
    app.log.warn("admin console disabled: no DATABASE_URL");
    // Keep the route (auth-gated) so operators get a clear disabled page
    // instead of a bare 404.
    basicAuthScope(app, "/admin", (scope) => {
      scope.get("/", async (_req, reply) =>
        reply.type("text/html; charset=utf-8").send(ADMIN_DISABLED_HTML),
      );
    });
  }

  const handle: AppHandle = {
    app,
    db,
    providers: { stt, tts, llm },
    sessions,
    transports,
    startCallSession,
    close: async () => {
      await app.close();
      if (dbOwned && db) await closeDb(db);
    },
  };
  return handle;
}

/* ------------------------------------------------------------- noop seams */

/** Degraded-mode STT: accepts audio, never transcribes. */
function noopSttProvider(): SttProvider {
  return {
    name: "noop",
    startStream: () => ({
      write: () => undefined,
      close: () => Promise.resolve(),
      on: () => undefined,
      closed: false,
    }),
  };
}

/** Degraded-mode TTS: sentences are "synthesized" silently. */
function noopTtsProvider(): TtsProvider {
  return {
    name: "noop",
    stream: () => {
      const events = new EventEmitter();
      return {
        events,
        push: () => undefined,
        end: () => events.emit("done"),
        close: () => undefined,
      };
    },
  };
}

/** Degraded-mode agent: no replies (composition announces llm_not_configured). */
function noopAgent(): ConversationAgent {
  return {
    async *handleUtterance(): AsyncGenerator<string> {
      return;
    },
    onBargeIn: () => undefined,
    setLanguage: () => undefined,
    close: () => undefined,
  };
}
