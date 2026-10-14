import { readFileSync } from "node:fs";
import { configSchema, type AppConfig } from "./schema.js";

/**
 * Load configuration: defaults <- optional JSON config file <- environment.
 * The JSON file (path via CONFIG_FILE env, default ./config.json if present)
 * may set any config field using the same names as the schema; environment
 * variables take precedence. Every external model/provider reference is a
 * config value and therefore overridable from either source.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  let fileConfig: unknown = {};
  const filePath = env.CONFIG_FILE ?? "config.json";
  try {
    fileConfig = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`Failed to read config file ${filePath}: ${(err as Error).message}`);
    }
  }

  const envConfig = mapEnv(env);

  const parsed = configSchema.parse(deepMerge(fileConfig, envConfig));
  return parsed;
}

function mapEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined) out[key] = value;
  };

  set("port", env.PORT);
  set("host", env.HOST);
  set("publicBaseUrl", env.PUBLIC_BASE_URL);
  set("databaseUrl", env.DATABASE_URL);
  set("logLevel", env.LOG_LEVEL);
  set("devBrowserCalls", env.DEV_BROWSER_CALLS);
  set("devFakeCallerNumber", env.DEV_FAKE_CALLER_NUMBER);

  out.twilio = pick(env, {
    accountSid: "TWILIO_ACCOUNT_SID",
    authToken: "TWILIO_AUTH_TOKEN",
    mediaWsPath: "TWILIO_MEDIA_WS_PATH",
  });

  out.stt = pick(env, {
    provider: "STT_PROVIDER",
    model: "STT_MODEL",
    sampleRateHz: env.STT_SAMPLE_RATE_HZ ? Number(env.STT_SAMPLE_RATE_HZ) : undefined,
  });

  out.tts = pick(env, {
    provider: "TTS_PROVIDER",
    api: "TTS_API",
    model: "TTS_MODEL",
    voiceEt: "TTS_VOICE_ET",
    voiceRu: "TTS_VOICE_RU",
    voiceEn: "TTS_VOICE_EN",
    outputSampleRateHz: env.TTS_OUTPUT_SAMPLE_RATE_HZ
      ? Number(env.TTS_OUTPUT_SAMPLE_RATE_HZ)
      : undefined,
  });

  out.elevenlabs = pick(env, { apiKey: "ELEVENLABS_API_KEY" });
  out.soniox = pick(env, { apiKey: "SONIOX_API_KEY", model: "SONIOX_MODEL" });
  out.gladia = pick(env, { apiKey: "GLADIA_API_KEY", model: "GLADIA_MODEL" });
  out.azure = pick(env, {
    speechKey: "AZURE_SPEECH_KEY",
    speechRegion: "AZURE_SPEECH_REGION",
    voiceEt: "AZURE_VOICE_ET",
    voiceRu: "AZURE_VOICE_RU",
    voiceEn: "AZURE_VOICE_EN",
  });

  out.llm = pick(env, {
    apiKey: "OPENROUTER_API_KEY",
    baseUrl: "OPENROUTER_BASE_URL",
    models: pick(env, {
      conversation: "LLM_CONVERSATION_MODEL",
      summarizer: "LLM_SUMMARIZER_MODEL",
      utility: "LLM_UTILITY_MODEL",
    }),
    overrides: {
      et: pick(env, { conversation: "LLM_CONVERSATION_MODEL_ET" }),
      ru: pick(env, { conversation: "LLM_CONVERSATION_MODEL_RU" }),
      en: pick(env, { conversation: "LLM_CONVERSATION_MODEL_EN" }),
    },
  });

  out.vad = pick(env, {
    threshold: env.VAD_THRESHOLD ? Number(env.VAD_THRESHOLD) : undefined,
    hangoverFrames: env.VAD_HANGOVER_FRAMES ? Number(env.VAD_HANGOVER_FRAMES) : undefined,
    onsetFrames: env.VAD_ONSET_FRAMES ? Number(env.VAD_ONSET_FRAMES) : undefined,
  });

  out.notes = pick(env, {
    enabled: env.NOTES_ENABLED !== undefined ? env.NOTES_ENABLED === "true" : undefined,
  });

  out.admin = pick(env, { user: "ADMIN_USER", password: "ADMIN_PASSWORD" });

  // skills.http/skills.auth are records with no generic env convention; the
  // shipped booking endpoint and calendar auth ref get flat, name-specific
  // keys (see .env.example). Additional endpoints/refs go through the JSON
  // config file. Entries are only emitted when the env sets at least one key
  // of theirs — an empty `{ booking: {} }` would fail the schema (url is
  // required) — and deepMerge still layers them over file-config entries.
  const skillsHttpBooking = pick(env, {
    url: "SKILLS_HTTP_BOOKING_URL",
    method: "SKILLS_HTTP_BOOKING_METHOD",
    timeoutMs: env.SKILLS_HTTP_BOOKING_TIMEOUT_MS
      ? Number(env.SKILLS_HTTP_BOOKING_TIMEOUT_MS)
      : undefined,
  });
  const skillsAuthCalendar = pick(env, {
    header: "SKILLS_AUTH_CALENDAR_HEADER",
    value: "SKILLS_AUTH_CALENDAR_VALUE",
  });
  const skills: Record<string, unknown> = pick(env, {
    dir: "SKILLS_DIR",
    maxToolIterations: env.SKILLS_MAX_TOOL_ITERATIONS
      ? Number(env.SKILLS_MAX_TOOL_ITERATIONS)
      : undefined,
  });
  if (Object.keys(skillsHttpBooking).length > 0) {
    skills.http = { booking: skillsHttpBooking };
  }
  if (Object.keys(skillsAuthCalendar).length > 0) {
    skills.auth = { calendar: skillsAuthCalendar };
  }
  out.skills = skills;

  out.consent = pick(env, {
    enabled: env.CONSENT_ENABLED !== undefined ? env.CONSENT_ENABLED === "true" : undefined,
    initialLanguage: "CONSENT_INITIAL_LANGUAGE",
  });

  out.escalation = pick(env, { staffNumber: "ESCALATION_STAFF_NUMBER" });

  out.retention = pick(env, {
    enabled: env.RETENTION_ENABLED !== undefined ? env.RETENTION_ENABLED === "true" : undefined,
    days: env.RETENTION_DAYS ? Number(env.RETENTION_DAYS) : undefined,
    hashSalt: "RETENTION_HASH_SALT",
  });

  return out;
}

/**
 * Build an object from the given (configKey -> value) pairs, dropping undefined
 * entries and empty-string env values.
 */
function pick(env: NodeJS.ProcessEnv, map: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "string") {
      // String values name an env var; copy the variable's value, not the name.
      const v = env[value];
      if (v !== undefined && v !== "") out[key] = v;
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `override` over `base` (both plain JSON objects): plain objects
 * merge recursively, every other value — including arrays — is replaced.
 * `undefined` values in the override are skipped. Pure: neither input is
 * mutated.
 */
export function deepMerge(base: unknown, override: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  if (!isPlainObject(override)) return out;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
