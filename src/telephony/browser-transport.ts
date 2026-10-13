import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { BaseCallTransport } from "./transport.js";
import type { CallInfo } from "../types.js";
import type { AppConfig } from "../config/schema.js";

/**
 * Dev-only transport over the /media/browser WebSocket (design D11).
 * Protocol:
 * - client -> server JSON text frames: {type:"start", from?}, {type:"stop"},
 *   {type:"ping"}
 * - client -> server binary frames: 16 kHz mono PCM16 LE (caller audio)
 * - server -> client binary frames: 16 kHz mono PCM16 LE (agent audio)
 * - server -> client JSON text frames: {type:"transcript"...}, {type:"mark"},
 *   {type:"flush"}, {type:"hangup"}
 */
export class BrowserTransport extends BaseCallTransport {
  override readonly info: CallInfo;

  constructor(
    private readonly socket: WebSocket,
    info: CallInfo,
  ) {
    super();
    this.info = info;
  }

  override async start(): Promise<void> {
    this.socket.on("close", () => this.emitHangup("socket_closed"));
    this.socket.on("error", (err: Error) => {
      this.emitError(err);
      this.emitHangup("socket_error");
    });
  }

  override sendAudio(pcm: Buffer): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(pcm, { binary: true });
    }
  }

  override flush(): void {
    this.sendControl({ type: "flush" });
  }

  override sendMark(name: string): void {
    this.sendControl({ type: "mark", name });
  }

  override async hangup(reason: string): Promise<void> {
    this.sendControl({ type: "hangup", reason });
    try {
      this.socket.close(1000, reason);
    } catch {
      this.socket.terminate();
    }
    this.emitHangup(reason);
  }

  override announce(event: Record<string, unknown>): void {
    this.sendControl(event);
  }

  /** Feed one inbound caller audio frame into the transport (public seam for the attach helper). */
  feedAudio(pcm: Buffer): void {
    this.emitAudio(pcm);
  }

  sendControl(msg: Record<string, unknown>): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(msg), { binary: false });
    }
  }
}

export interface BrowserStartMessage {
  type: "start";
  from?: string;
  mode?: "mic" | "replay";
  fixture?: string;
}

/** Synthetic CallSid + fake caller number from config (per spec). */
export function makeBrowserCallInfo(config: AppConfig, start?: BrowserStartMessage): CallInfo {
  return {
    callSid: `dev-${randomUUID()}`,
    from: start?.from?.trim() || config.devFakeCallerNumber,
    provider: "browser",
  };
}

/**
 * Attach to an incoming /media/browser socket: wait for the `start` control
 * message, then construct the transport and hand it to `onTransport`.
 * Returns a disposer that tears the socket down.
 */
export function attachBrowserTransport(
  socket: WebSocket,
  config: AppConfig,
  onTransport: (transport: BrowserTransport, start: BrowserStartMessage) => void,
): () => void {
  let transport: BrowserTransport | undefined;

  const onMessage = (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      transport?.feedAudio(data);
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = msg["type"];
    if (type === "start") {
      if (transport) return; // ignore duplicate starts
      const start = msg as unknown as BrowserStartMessage;
      transport = new BrowserTransport(socket, makeBrowserCallInfo(config, start));
      void transport.start();
      onTransport(transport, start);
    } else if (type === "stop") {
      void transport?.hangup("client_stop");
    } else if (type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }), { binary: false });
    }
  };

  const onClose = () => {
    // Idempotent: if the client already hung up, this is a no-op.
    void transport?.hangup("socket_closed");
  };

  socket.on("message", onMessage);
  socket.on("close", onClose);

  return () => {
    socket.off("message", onMessage);
    socket.off("close", onClose);
    socket.close();
  };
}
