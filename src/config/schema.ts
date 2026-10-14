import { z } from "zod";

const optionalString = (defaultValue = "") =>
  z
    .string()
    .default(defaultValue)
    .transform((v) => (v.trim() === "" ? undefined : v.trim()));

export const languageCode = z.enum(["et", "ru", "en"]);

export const configSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  host: z.string().default("0.0.0.0"),
  publicBaseUrl: optionalString(),
  databaseUrl: optionalString(),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  devBrowserCalls: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => v === true || v === "true" || v === "1"),
  devFakeCallerNumber: z.string().default("+37200000000"),

  twilio: z
    .object({
      accountSid: optionalString(),
      authToken: optionalString(),
      mediaWsPath: z.string().default("/media/twilio"),
    })
    .default({}),

  stt: z
    .object({
      provider: z.enum(["scribe", "soniox", "gladia"]).default("scribe"),
      model: z.string().default("scribe_v2_realtime"),
      /** Sample rate of PCM fed into the pipeline core. */
      sampleRateHz: z.number().int().default(16000),
    })
    .default({}),

  tts: z
    .object({
      provider: z.enum(["elevenlabs", "azure"]).default("elevenlabs"),
      model: z.string().default("eleven_v3"),
      voiceEt: z.string().default("pqHfZKP75CvOlQylNhV4"),
      voiceRu: z.string().default("pFZP5JQG7iQjIQuC4Bku"),
      voiceEn: z.string().default("21m00Tcm4TlvDq8ikWAM"),
      outputSampleRateHz: z.number().int().default(16000),
    })
    .default({}),

  elevenlabs: z
    .object({
      apiKey: optionalString(),
    })
    .default({}),

  soniox: z
    .object({
      apiKey: optionalString(),
      model: z.string().default("stt-rt-preview"),
    })
    .default({}),

  gladia: z
    .object({
      apiKey: optionalString(),
      model: z.string().default("solaria-1"),
    })
    .default({}),

  azure: z
    .object({
      speechKey: optionalString(),
      speechRegion: optionalString(),
      voiceEt: z.string().default("et-EE-AnuNeural"),
      voiceRu: z.string().default("ru-RU-SvetlanaNeural"),
      voiceEn: z.string().default("en-US-JennyNeural"),
    })
    .default({}),

  llm: z
    .object({
      apiKey: optionalString(),
      baseUrl: z.string().default("https://openrouter.ai/api/v1"),
      models: z
        .object({
          conversation: z.string().default("openai/gpt-4o-mini"),
          summarizer: z.string().default("openai/gpt-4o-mini"),
          utility: z.string().default("openai/gpt-4o-mini"),
        })
        .default({}),
      /** Optional per-language model overrides (any role). */
      overrides: z
        .object({
          et: z
            .object({
              conversation: z.string().optional(),
              summarizer: z.string().optional(),
              utility: z.string().optional(),
            })
            .optional(),
          ru: z
            .object({
              conversation: z.string().optional(),
              summarizer: z.string().optional(),
              utility: z.string().optional(),
            })
            .optional(),
          en: z
            .object({
              conversation: z.string().optional(),
              summarizer: z.string().optional(),
              utility: z.string().optional(),
            })
            .optional(),
        })
        .default({}),
    })
    .default({}),

  vad: z
    .object({
      /** RMS threshold in [0..1] for speech detection. */
      threshold: z.number().min(0).max(1).default(0.015),
      /** Hangover frames (20 ms each) to keep speech alive after last hit. */
      hangoverFrames: z.number().int().min(1).default(15),
      /** Consecutive frames required to trigger speech start. */
      onsetFrames: z.number().int().min(1).default(2),
    })
    .default({}),

  notes: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),

  admin: z
    .object({
      user: z.string().default("admin"),
      password: optionalString(),
    })
    .default({}),

  skills: z
    .object({
      /** Directory holding *.yaml skill manifests (loaded once at startup). */
      dir: z.string().default("./skills"),
      /** Upper bound on LLM tool-call round-trips per utterance. */
      maxToolIterations: z.number().int().min(1).max(10).default(5),
      /** Named HTTP endpoint templates; {param} substitution happens at dispatch. */
      http: z
        .record(
          z.object({
            url: z.string(),
            method: z.string().default("POST"),
            timeoutMs: z.number().int().default(10000),
          }),
        )
        .default({}),
      /** Named auth header credentials referenced by manifests (values are secrets). */
      auth: z
        .record(
          z.object({
            header: z.string(),
            value: z.string().default(""),
          }),
        )
        .default({}),
    })
    .default({}),

  consent: z
    .object({
      /** Spoken consent notice before transcription; decline = never transcribed. */
      enabled: z.boolean().default(true),
      /** Notice language until the caller's reply vote picks the call language. */
      initialLanguage: languageCode.default("et"),
    })
    .default({}),

  escalation: z
    .object({
      /** Staff number for <Dial> transfer; empty = announce + end call instead. */
      staffNumber: z.string().default(""),
    })
    .default({}),

  retention: z
    .object({
      /** Purge transcripts/notes and anonymize caller numbers past the window. */
      enabled: z.boolean().default(true),
      /** Retention window in days for transcripts, notes, and caller numbers. */
      days: z.number().int().min(1).default(90),
      /**
       * Secret salt for caller-number anonymization. Empty while enabled is
       * allowed at the config level — the retention job guards it.
       */
      hashSalt: z.string().default(""),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof configSchema>;
export type LlmRole = keyof AppConfig["llm"]["models"];
