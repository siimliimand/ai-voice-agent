/** Languages supported by the agent. */
export type Language = "et" | "ru" | "en";

export const LANGUAGES: readonly Language[] = ["et", "ru", "en"] as const;

export function isLanguage(value: string | undefined | null): value is Language {
  return value === "et" || value === "ru" || value === "en";
}

/** Speaker roles in a call transcript. */
export type Speaker = "caller" | "agent";

/** Status stored in the calls table. */
export type CallStatus = "in_progress" | "completed" | "failed";

/** Public metadata describing a call transport/session. */
export interface CallInfo {
  callSid: string;
  from: string;
  to?: string;
  provider: "twilio" | "browser";
}
