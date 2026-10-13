import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config/schema.js";
import { logger } from "../../logging.js";
import { buildTwiML } from "./twiml.js";
import { validateTwilioSignature } from "./validate-signature.js";

export interface TwilioRouteDeps {
  config: AppConfig;
}

const XML = "text/xml";

function errorXml(status: number, comment: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<!-- ${comment} -->` +
    `<Response><Hangup/></Response>`
  );
}

/**
 * Twilio webhooks: POST /twiml answers an inbound call by returning
 * <Connect><Stream> TwiML pointing at our media websocket. Requests are
 * fail-closed: when TWILIO_AUTH_TOKEN is not configured the route rejects with
 * 503; when configured, X-Twilio-Signature must match or the route 403s
 * without starting a session.
 */
export function registerTwilioRoutes(app: FastifyInstance, deps: TwilioRouteDeps): void {
  // Twilio posts application/x-www-form-urlencoded; parse it into a plain
  // object scoped to this plugin so the rest of the app is unaffected.
  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => {
        const params: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(String(body))) {
          params[key] = value;
        }
        done(null, params);
      },
    );
  }

  const authToken = deps.config.twilio.authToken;
  let warnedMissingToken = false;

  app.post("/twiml", async (req, reply) => {
    // Fail closed when signature validation is impossible.
    if (!authToken) {
      if (!warnedMissingToken) {
        warnedMissingToken = true;
        logger.warn(
          "TWILIO_AUTH_TOKEN is not configured; /twiml rejects all requests (fail closed)",
        );
      }
      return reply
        .code(503)
        .type(XML)
        .send(
          errorXml(503, "twiml unavailable: TWILIO_AUTH_TOKEN is not configured on the server"),
        );
    }

    const params = (req.body ?? {}) as Record<string, string>;
    // Validate against the full original request URL, including query string.
    const url = `${req.protocol}://${req.headers.host ?? "localhost"}${req.raw.url ?? req.url}`;
    const signatureHeader = req.headers["x-twilio-signature"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

    if (!signature || !validateTwilioSignature(authToken, url, params, signature)) {
      logger.warn({ url }, "twilio signature validation failed");
      return reply.code(403).type(XML).send(errorXml(403, "twilio signature validation failed"));
    }

    const wsProto = req.protocol === "https" ? "wss" : "ws";
    const host = req.headers.host ?? "localhost";
    const mediaWsUrl = `${wsProto}://${host}${deps.config.twilio.mediaWsPath}`;
    const xml = buildTwiML({
      mediaWsUrl,
      caller: params["From"],
      callee: params["To"],
    });
    return reply.code(200).type(XML).send(xml);
  });
}
