/**
 * Declarative description of the operator-editable config surface.
 *
 * This module is the CONTRACT between the backend (PUT/GET /api/settings
 * sanitization + persistence) and the admin frontend (form rendering). The
 * exported names and shapes are consumed verbatim by src/web — change them
 * only together with the frontend.
 *
 * Not editable (infra, never stored in the settings doc): port, host,
 * databaseUrl, publicBaseUrl. twilio.mediaWsPath and devBrowserCalls ARE
 * editable but flagged restartRequired (HTTP route registration / dev-page
 * wiring happens once at startup).
 */

export type EditableFieldType = "string" | "number" | "boolean" | "select" | "secret";

export interface EditableField {
  /** dotted config path, e.g. "llm.models.conversation" or "tts.voiceEt" */
  path: string;
  label: string;
  type: EditableFieldType;
  /** for type "select": allowed values */
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  /** hint that changing it has no effect until server restart */
  restartRequired?: boolean;
  help?: string;
}

export interface EditableSection {
  id: string;
  title: string;
  fields: EditableField[];
}

/** Infra paths rejected outright by PUT /api/settings (never editable). */
export const INFRA_PATHS: ReadonlySet<string> = new Set([
  "port",
  "host",
  "databaseUrl",
  "publicBaseUrl",
]);

const SECRET_HELP = "write-only — leave blank to keep current value";

export const EDITABLE_SECTIONS: EditableSection[] = [
  {
    id: "general",
    title: "General",
    fields: [
      {
        path: "logLevel",
        label: "Log level",
        type: "select",
        options: ["fatal", "error", "warn", "info", "debug", "trace"],
        help: "Note: the process log level is read at startup.",
      },
      {
        path: "devFakeCallerNumber",
        label: "Dev fake caller number",
        type: "string",
        help: "Caller number reported for browser calls in development.",
      },
      {
        path: "devBrowserCalls",
        label: "Dev browser calls",
        type: "boolean",
        restartRequired: true,
        help: "Enables the /dev browser call page (route exists only after a restart).",
      },
    ],
  },
  {
    id: "twilio",
    title: "Twilio",
    fields: [
      { path: "twilio.accountSid", label: "Account SID", type: "string" },
      { path: "twilio.authToken", label: "Auth token", type: "secret", help: SECRET_HELP },
      {
        path: "twilio.mediaWsPath",
        label: "Media websocket path",
        type: "string",
        restartRequired: true,
        help: "WS route is bound at startup; a new value needs a restart.",
      },
    ],
  },
  {
    id: "stt",
    title: "Speech-to-text",
    fields: [
      {
        path: "stt.provider",
        label: "Provider",
        type: "select",
        options: ["scribe", "soniox", "gladia"],
      },
      { path: "stt.model", label: "Model", type: "string" },
      { path: "stt.sampleRateHz", label: "Sample rate (Hz)", type: "number" },
    ],
  },
  {
    id: "tts",
    title: "Text-to-speech",
    fields: [
      { path: "tts.provider", label: "Provider", type: "select", options: ["elevenlabs"] },
      { path: "tts.model", label: "Model", type: "string" },
      { path: "tts.voiceEt", label: "Estonian voice", type: "string" },
      { path: "tts.voiceRu", label: "Russian voice", type: "string" },
      { path: "tts.voiceEn", label: "English voice", type: "string" },
      { path: "tts.outputSampleRateHz", label: "Output sample rate (Hz)", type: "number" },
    ],
  },
  {
    id: "providers",
    title: "Provider credentials",
    fields: [
      { path: "elevenlabs.apiKey", label: "ElevenLabs API key", type: "secret", help: SECRET_HELP },
      { path: "soniox.apiKey", label: "Soniox API key", type: "secret", help: SECRET_HELP },
      { path: "gladia.apiKey", label: "Gladia API key", type: "secret", help: SECRET_HELP },
      { path: "azure.speechKey", label: "Azure Speech key", type: "secret", help: SECRET_HELP },
      { path: "azure.speechRegion", label: "Azure Speech region", type: "string" },
    ],
  },
  {
    id: "llm",
    title: "Language model (OpenRouter)",
    fields: [
      { path: "llm.apiKey", label: "OpenRouter API key", type: "secret", help: SECRET_HELP },
      { path: "llm.baseUrl", label: "OpenRouter base URL", type: "string" },
      { path: "llm.models.conversation", label: "Conversation model", type: "string" },
      { path: "llm.models.summarizer", label: "Summarizer model", type: "string" },
      { path: "llm.models.utility", label: "Utility model", type: "string" },
      {
        path: "llm.overrides.et.conversation",
        label: "Estonian conversation model override",
        type: "string",
      },
      {
        path: "llm.overrides.ru.conversation",
        label: "Russian conversation model override",
        type: "string",
      },
      {
        path: "llm.overrides.en.conversation",
        label: "English conversation model override",
        type: "string",
      },
    ],
  },
  {
    id: "vad",
    title: "Voice activity detection",
    fields: [
      {
        path: "vad.threshold",
        label: "RMS threshold",
        type: "number",
        min: 0,
        max: 1,
        step: 0.001,
      },
      { path: "vad.onsetFrames", label: "Onset frames", type: "number", min: 1 },
      { path: "vad.hangoverFrames", label: "Hangover frames", type: "number", min: 1 },
    ],
  },
  {
    id: "notes",
    title: "Post-call notes",
    fields: [
      {
        path: "notes.enabled",
        label: "Notes enabled",
        type: "boolean",
        help: "Structured post-call summaries; applies to calls ending after the change.",
      },
    ],
  },
  {
    id: "admin",
    title: "Admin console",
    fields: [
      { path: "admin.user", label: "Admin user", type: "string" },
      { path: "admin.password", label: "Admin password", type: "secret", help: SECRET_HELP },
    ],
  },
];

/** Flattened set of all editable dotted paths. */
export const EDITABLE_PATHS: ReadonlySet<string> = new Set(
  EDITABLE_SECTIONS.flatMap((section) => section.fields.map((field) => field.path)),
);

/** Whether a dotted config path may be stored in the settings document. */
export function isEditablePath(path: string): boolean {
  return EDITABLE_PATHS.has(path);
}
