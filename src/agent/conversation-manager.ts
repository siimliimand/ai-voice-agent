/**
 * ConversationManager: per-call conversation agent backed by the OpenRouter
 * streaming chat API. It owns the chat history for one call and implements
 * the ConversationAgent contract consumed by the voice pipeline
 * (src/pipeline/voice-pipeline.ts). The interface below mirrors the
 * pipeline's definition exactly, so this class satisfies it structurally
 * without a compile-time dependency on the pipeline module.
 */
import type { AppConfig } from "../config/schema.js";
import type { ChatMessage, OpenRouterClient } from "../llm/openrouter.js";
import { resolveModel } from "../llm/resolve-model.js";
import type { Logger } from "../logging.js";
import type { Language } from "../types.js";
import type { LanguageManager } from "./language-manager.js";
import { getGreeting, getSystemPrompt } from "./prompts/index.js";

/** Conversation half of the voice pipeline (see src/pipeline/voice-pipeline.ts). */
export interface ConversationAgent {
  handleUtterance(text: string, language: Language | null): AsyncIterable<string>;
  onBargeIn(): void;
  setLanguage(language: Language | null): void;
  close(): void;
}

export interface ConversationManagerDeps {
  config: AppConfig;
  llm: OpenRouterClient;
  language: LanguageManager;
  logger?: Logger;
}

/** History cap in messages; the system prompt at index 0 is always kept. */
const MAX_HISTORY_MESSAGES = 40;
const CONVERSATION_TEMPERATURE = 0.7;
const CONVERSATION_MAX_TOKENS = 300;

const LANGUAGE_NAMES: Record<Language, string> = {
  et: "Estonian",
  ru: "Russian",
  en: "English",
};

export class ConversationManager implements ConversationAgent {
  private history: ChatMessage[];
  private currentLanguage: Language | null = null;
  private abort: AbortController | null = null;
  private closed = false;

  constructor(private readonly deps: ConversationManagerDeps) {
    // Default to the English persona until the language is locked.
    this.history = [{ role: "system", content: getSystemPrompt(this.currentLanguage) }];
  }

  /** Opening utterance for the call, in the currently locked language. */
  async greeting(): Promise<string> {
    return this.greet();
  }

  /** Synchronous variant of greeting(). */
  greet(): string {
    return getGreeting(this.currentLanguage);
  }

  /** Currently locked conversation language, or null before setLanguage(). */
  get language(): Language | null {
    return this.currentLanguage;
  }

  /** Chat history snapshot (introspection for tests/pipeline summaries). */
  get messages(): readonly ChatMessage[] {
    return this.history;
  }

  /**
   * Switch the conversation language: rebuild the system prompt, drop an
   * explicit note into the history so replies follow immediately, and pin
   * the language on the LanguageManager (which fires the pipeline's
   * relock/voice-swap events). Null is a no-op: an unknown language never
   * un-locks a known one.
   */
  setLanguage(language: Language | null): void {
    if (language === null || language === this.currentLanguage || this.closed) return;
    const previous = this.currentLanguage;
    this.currentLanguage = language;
    this.history[0] = { role: "system", content: getSystemPrompt(language) };
    const name = LANGUAGE_NAMES[language];
    this.history.push({
      role: "system",
      content: `[client now speaks ${name}; reply in ${name} from now on]`,
    });
    this.deps.language.pin(language);
    this.deps.logger?.debug({ from: previous, to: language }, "conversation language switched");
  }

  /**
   * Handle one caller utterance: stream the assistant reply token by token.
   * The per-utterance language argument is informational; the locked language
   * on this manager (kept in sync via setLanguage) drives prompt and model.
   */
  async *handleUtterance(text: string, _language: Language | null): AsyncGenerator<string> {
    if (this.closed || text.trim() === "") return;
    // A new utterance implicitly interrupts anything still being spoken.
    this.abort?.abort();

    this.history.push({ role: "user", content: text });
    this.trimHistory();

    const controller = new AbortController();
    this.abort = controller;
    let partial = "";
    try {
      const stream = this.deps.llm.chatStream({
        model: resolveModel(this.deps.config, "conversation", this.currentLanguage),
        messages: [...this.history],
        temperature: CONVERSATION_TEMPERATURE,
        maxTokens: CONVERSATION_MAX_TOKENS,
        signal: controller.signal,
      });
      for await (const delta of stream) {
        if (delta.content === undefined) continue;
        partial += delta.content;
        yield delta.content;
      }
      if (partial !== "") this.history.push({ role: "assistant", content: partial });
    } catch (error) {
      if (controller.signal.aborted) {
        // Caller barged in: keep the partial answer as context so the model
        // does not lose track of what it already said.
        this.finalizeInterrupted(partial);
        return;
      }
      if (partial !== "") this.history.push({ role: "assistant", content: partial });
      throw error;
    } finally {
      if (this.abort === controller) this.abort = null;
      this.trimHistory();
    }
  }

  /**
   * Caller started talking over the assistant: abort the in-flight stream.
   * The suspended handleUtterance() finalises any partial text into history.
   */
  onBargeIn(): void {
    this.abort?.abort();
  }

  /** Abort any in-flight stream and drop the per-call history. */
  close(): void {
    this.closed = true;
    this.abort?.abort();
    this.abort = null;
    this.history = [];
  }

  /** Record an interrupted partial answer so the context is not lost. */
  private finalizeInterrupted(partial: string): void {
    if (partial.trim() === "") return;
    this.history.push({ role: "assistant", content: `${partial} [interrupted by caller]` });
  }

  /** Cap history to the last N messages, always keeping the system prompt. */
  private trimHistory(): void {
    if (this.history.length <= MAX_HISTORY_MESSAGES) return;
    const system = this.history[0];
    if (system === undefined) return;
    this.history = [system, ...this.history.slice(-(MAX_HISTORY_MESSAGES - 1))];
  }
}
