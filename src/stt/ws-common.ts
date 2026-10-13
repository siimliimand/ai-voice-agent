import WebSocket from "ws";
import type { RawData } from "ws";

/**
 * Convert a `ws` message payload to UTF-8 text. Text frames arrive as
 * Buffer (or Buffer[] when fragmented); this stays defensive across the
 * payload shapes `ws` can deliver.
 */
export function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

/**
 * Close a WebSocket gracefully and resolve when the socket is fully closed.
 * Falls back to a hard terminate when the peer does not answer the close
 * handshake within `timeoutMs`. Never rejects and never throws, so callers
 * can `await` it from cleanup paths without try/catch.
 */
export function closeWebSocket(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // Already dead — nothing to do.
      }
      finish();
    }, timeoutMs);
    timer.unref(); // never hold the process open for a close handshake

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    if (ws.readyState === WebSocket.CLOSED) {
      finish();
      return;
    }
    ws.once("close", finish);
    try {
      ws.close();
    } catch {
      try {
        ws.terminate();
      } catch {
        // Ignore — the timer above resolves us regardless.
      }
    }
  });
}
