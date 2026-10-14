/**
 * Reusable mock calendar HTTP server for skills/e2e tests — node:http only,
 * no dependencies. It implements the contract the shipped `booking` skill
 * (skills/booking.yaml) expects: a POST endpoint that validates the booking
 * body shape (date/time/service/patient_name strings) and answers
 * `{ok: true, bookingId, ...echo}`. Every received request is recorded for
 * assertions, and failures can be injected (fixed status code and/or response
 * delay) to exercise error and timeout paths.
 *
 * Usage:
 *
 *   import { startMockCalendar } from "../fixtures/mock-calendar.js";
 *
 *   const cal = await startMockCalendar();            // port 0 → ephemeral port
 *   // point the skills config at it: skills.http.booking.url = cal.url
 *   ...run the executor/dispatcher under test...
 *   expect(cal.requests[0]?.headers.authorization).toBe("Bearer tok");
 *   expect(cal.requests[0]?.body).toEqual({ date: "...", ... });
 *   await cal.stop();                                 // releases the port
 *
 * Failure injection:
 *
 *   await startMockCalendar({ status: 503 });   // always answers 503
 *   await startMockCalendar({ delayMs: 500 });  // responds late (timeout tests)
 *
 * `bookingId`s are deterministic per server instance (BK-0001, BK-0002, …),
 * so e2e assertions can match them exactly.
 */

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/** Fields a valid booking body must carry as strings; the mock enforces these. */
export const BOOKING_FIELDS = ["date", "time", "service", "patient_name"] as const;

export type BookingBody = Record<(typeof BOOKING_FIELDS)[number], string>;

/** One request the mock received, kept verbatim for assertions. */
export interface RecordedBookingRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  /** Raw request body exactly as received. */
  rawBody: string;
  /** Parsed JSON body, or null when the body was not valid JSON. */
  body: unknown;
}

export interface MockCalendarOptions {
  /** Listen port; 0 (default) picks a free ephemeral port. */
  port?: number;
  /** Booking endpoint path (default "/book"); also the path of `url`. */
  path?: string;
  /** Failure injection: respond with this HTTP status instead of 201. */
  status?: number;
  /** Failure injection: wait this many ms before responding. */
  delayMs?: number;
}

export interface MockCalendar {
  /** Resolved listen port (useful when started with port 0). */
  readonly port: number;
  /** Full booking URL, e.g. http://127.0.0.1:45454/book — use as skills.http.booking.url. */
  readonly url: string;
  /** Requests received so far, in arrival order. */
  readonly requests: RecordedBookingRequest[];
  /** Close the server and resolve once the port is released. */
  stop(): Promise<void>;
}

/** Start the mock calendar server; resolves once it is listening. */
export function startMockCalendar(options: MockCalendarOptions = {}): Promise<MockCalendar> {
  const path = options.path ?? "/book";
  const requests: RecordedBookingRequest[] = [];
  let bookingCount = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", () => res.destroy());
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const record: RecordedBookingRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawBody,
        body: null,
      };
      try {
        record.body = JSON.parse(rawBody);
      } catch {
        // not JSON — `body` stays null and validation rejects it below
      }
      requests.push(record);

      const respond = (): void => {
        if (options.status !== undefined) {
          respondJson(res, options.status, {
            ok: false,
            error: `injected failure (HTTP ${options.status})`,
          });
        } else if (req.url !== path) {
          respondJson(res, 404, { ok: false, error: `unknown path ${String(req.url)}` });
        } else if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          respondJson(res, 405, { ok: false, error: "method not allowed" });
        } else {
          const problem = validateBooking(record.body);
          if (problem !== null) {
            respondJson(res, 400, { ok: false, error: problem });
          } else {
            bookingCount += 1;
            const bookingId = `BK-${String(bookingCount).padStart(4, "0")}`;
            respondJson(res, 201, {
              ok: true,
              bookingId,
              ...(record.body as BookingBody),
            });
          }
        }
      };

      if (options.delayMs !== undefined && options.delayMs > 0) {
        setTimeout(respond, options.delayMs);
      } else {
        respond();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        url: `http://127.0.0.1:${port}${path}`,
        requests,
        stop: () =>
          new Promise<void>((resolveStop, rejectStop) => {
            // Drop keep-alive sockets so close() is not held open by idle clients.
            server.closeIdleConnections();
            server.close((err) => (err ? rejectStop(err) : resolveStop()));
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** Non-empty-string check over the required booking fields; null when valid. */
function validateBooking(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "request body must be a JSON object";
  }
  const args = body as Record<string, unknown>;
  const invalid = BOOKING_FIELDS.filter(
    (field) => typeof args[field] !== "string" || (args[field] as string).trim() === "",
  );
  return invalid.length > 0 ? `missing or invalid fields: ${invalid.join(", ")}` : null;
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}
