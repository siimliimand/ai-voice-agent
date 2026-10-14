/** Escape a value for use inside a double-quoted XML attribute. */
export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export interface TwiMLOptions {
  /** WebSocket URL Twilio should stream media to (wss://...). */
  mediaWsUrl: string;
  /** Caller phone number, passed as a Stream Parameter. */
  caller?: string;
  /** Callee phone number, passed as a Stream Parameter. */
  callee?: string;
}

/**
 * Build the TwiML answer for an inbound call: connect the call's media to our
 * websocket via <Connect><Stream>. Caller/Callee are only included when
 * provided so Twilio forwards them in the stream "start" message.
 */
export function buildTwiML(opts: TwiMLOptions): string {
  const params: string[] = [];
  if (opts.caller !== undefined) {
    params.push(`<Parameter name="Caller" value="${xmlEscape(opts.caller)}"/>`);
  }
  if (opts.callee !== undefined) {
    params.push(`<Parameter name="Callee" value="${xmlEscape(opts.callee)}"/>`);
  }
  const inner = params.length > 0 ? params.join("") : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Connect>` +
    `<Stream url="${xmlEscape(opts.mediaWsUrl)}">${inner}</Stream>` +
    `</Connect>` +
    `</Response>`
  );
}

export interface TransferTwiMLOptions {
  /** Spoken to the caller (via <Say>) before the call is bridged. */
  announcementText: string;
  /** Staff number the caller is bridged to (<Dial><Number>). */
  staffNumber: string;
}

/**
 * TwiML for the REST transfer (design D7, task 5.2): play the escalation
 * announcement, then bridge the caller to the staff number. Sent as the
 * `Twiml` form parameter of POST …/Calls/{CallSid}.json — deliberately
 * without an XML declaration (a nested document must not carry one).
 */
export function buildTransferTwiML(opts: TransferTwiMLOptions): string {
  return (
    `<Response>` +
    `<Say>${xmlEscape(opts.announcementText)}</Say>` +
    `<Dial><Number>${xmlEscape(opts.staffNumber)}</Number></Dial>` +
    `</Response>`
  );
}
