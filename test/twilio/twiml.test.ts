import { describe, expect, it } from "vitest";
import { buildTwiML } from "../../src/telephony/twilio/twiml.js";

describe("buildTwiML", () => {
  it("produces the golden <Connect><Stream> shape", () => {
    const xml = buildTwiML({ mediaWsUrl: "wss://example.com/media/twilio" });
    expect(xml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Connect>` +
        `<Stream url="wss://example.com/media/twilio"></Stream>` +
        `</Connect></Response>`,
    );
    expect(xml).toContain(`<Connect><Stream url="wss://example.com/media/twilio">`);
  });

  it("includes Caller/Callee Parameters only when provided", () => {
    const xml = buildTwiML({
      mediaWsUrl: "wss://example.com/media/twilio",
      caller: "+37251234567",
      callee: "+37260000000",
    });
    expect(xml).toContain(`<Parameter name="Caller" value="+37251234567"/>`);
    expect(xml).toContain(`<Parameter name="Callee" value="+37260000000"/>`);

    const callerOnly = buildTwiML({
      mediaWsUrl: "wss://example.com/media/twilio",
      caller: "+37251234567",
    });
    expect(callerOnly).toContain(`<Parameter name="Caller"`);
    expect(callerOnly).not.toContain(`name="Callee"`);
  });

  it("XML-escapes values", () => {
    const xml = buildTwiML({
      mediaWsUrl: "wss://example.com/media/twilio",
      caller: `&<>"'`,
    });
    expect(xml).toContain(`<Parameter name="Caller" value="&amp;&lt;&gt;&quot;&apos;"/>`);
    // No raw unescaped quotes/angle brackets inside the attribute value.
    expect(xml).not.toMatch(/value="[^"]*["<>][^"]*"/);
  });
});
