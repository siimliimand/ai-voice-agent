/**
 * Tests for the server-rendered settings page (GET/POST /admin/settings).
 * Fake deps mirror test/api/settings.test.ts (in-memory SettingsDb) and
 * test/api/admin.test.ts (fastify.inject + registerBasicAuth).
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBasicAuth } from "../../src/auth/basic-auth.js";
import { EDITABLE_SECTIONS, type EditableSection } from "../../src/config/editable.js";
import { deepMerge } from "../../src/config/index.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { deleteAtPath } from "../../src/db/settings.js";
import {
  registerSettingsPage,
  renderSettingsPage,
  type SettingsPageState,
} from "../../src/web/admin/settings.js";

const USERNAME = "admin";
const PASSWORD = "s3cret";
const SECRET_KEY = "sk-test-abcd1234";

const authHeader = (user = USERNAME, pass = PASSWORD): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

const makeConfig = (): AppConfig =>
  configSchema.parse({
    admin: { user: USERNAME, password: PASSWORD },
    llm: { apiKey: SECRET_KEY },
  });

/** In-memory SettingsDb: mirrors saveSettingsDoc/clearSettingsPath semantics. */
function makeFakeSettingsDb() {
  let doc: Record<string, unknown> = {};
  return {
    getSettingsDoc: vi.fn(async () => doc),
    saveSettingsDoc: vi.fn(async (partial: Record<string, unknown>) => {
      doc = deepMerge(doc, partial);
    }),
    clearSettingsPath: vi.fn(async (path: string) => {
      doc = deleteAtPath(doc, path);
    }),
    doc: () => doc,
  };
}

function buildApp(
  db: ReturnType<typeof makeFakeSettingsDb>,
  config: AppConfig = makeConfig(),
): FastifyInstance {
  const app = Fastify({ logger: false });
  registerBasicAuth(app, config);
  registerSettingsPage(app, { db, config, invalidate: invalidate });
  return app;
}

const invalidate = vi.fn();

let db: ReturnType<typeof makeFakeSettingsDb>;
let app: FastifyInstance;

beforeEach(() => {
  db = makeFakeSettingsDb();
  invalidate.mockClear();
  app = buildApp(db);
});

afterAll(async () => {
  await app?.close();
});

const get = async (url = "/admin/settings"): Promise<{ status: number; body: string }> => {
  const res = await app.inject({ method: "GET", url, headers: { authorization: authHeader() } });
  return { status: res.statusCode, body: res.body };
};

const post = async (body: string): Promise<{ status: number; body: string; location?: string }> => {
  const res = await app.inject({
    method: "POST",
    url: "/admin/settings",
    headers: { authorization: authHeader(), "content-type": "application/x-www-form-urlencoded" },
    payload: body,
  });
  return { status: res.statusCode, body: res.body, location: res.headers["location"] as string | undefined };
};

describe("basic auth", () => {
  it("responds 401 with WWW-Authenticate for unauthenticated GET and POST", async () => {
    await app.ready();
    const getRes = await app.inject({ method: "GET", url: "/admin/settings" });
    const postRes = await app.inject({
      method: "POST",
      url: "/admin/settings",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "llm.models.conversation=x",
    });
    expect(getRes.statusCode).toBe(401);
    expect(postRes.statusCode).toBe(401);
    expect(getRes.headers["www-authenticate"]).toBe('Basic realm="admin"');
    expect(postRes.headers["www-authenticate"]).toBe('Basic realm="admin"');
    expect(db.saveSettingsDoc).not.toHaveBeenCalled();
  });

  it("responds 200 with valid credentials", async () => {
    await app.ready();
    const res = await get();
    expect(res.status).toBe(200);
  });
});

describe("GET /admin/settings (rendering)", () => {
  it("renders every section title and field label from the contract", async () => {
    await app.ready();
    const { body } = await get();
    for (const section of EDITABLE_SECTIONS) {
      expect(body).toContain(section.title);
      for (const field of section.fields) {
        expect(body).toContain(field.label);
        expect(body).toContain(`name="${field.path}"`);
      }
    }
    // One <fieldset> per section plus the read-only infra fieldset.
    expect(body.match(/<fieldset class="section/g)?.length).toBe(EDITABLE_SECTIONS.length + 1);
  });

  it("renders inputs by field type: text, number (min/max/step), checkbox, select, password", async () => {
    await app.ready();
    const { body } = await get();
    expect(body).toContain('name="llm.models.conversation" type="text"');
    expect(body).toContain('name="vad.threshold" type="number" min="0" max="1" step="0.001"');
    expect(body).toContain('name="notes.enabled" type="checkbox" value="true" checked');
    expect(body).toContain('name="stt.provider"');
    expect(body).toContain('<option value="scribe" selected>');
    expect(body).toContain('name="twilio.authToken" type="password" placeholder="unchanged"');
  });

  it("masks secrets: never renders a raw value, shows set/hint state", async () => {
    await app.ready();
    const { body } = await get();
    expect(body).not.toContain(SECRET_KEY);
    expect(body).not.toContain(PASSWORD);
    expect(body).toContain("currently set (…1234)"); // llm.apiKey …last4
    expect(body).toContain("currently not set"); // elevenlabs.apiKey
    // Password inputs never carry a value attribute.
    expect(body.match(/type="password"[^>]*value=/)).toBeNull();
  });

  it("shows the override badge, reset checkbox and stored value for DB-overridden paths", async () => {
    db.saveSettingsDoc({
      llm: { models: { conversation: "test/override-model" } },
      stt: { provider: "soniox" },
    });
    await app.ready();
    const { body } = await get();
    expect(body).toContain('value="test/override-model"');
    expect(body).toContain('<option value="soniox" selected>');
    // Two DB overrides → two badges (count the spans, not the CSS rule).
    expect(body.match(/class="badge badge-override"/g)?.length).toBe(2);
    expect(body).toContain('name="reset" value="llm.models.conversation"');
    expect(body).toContain('name="reset" value="stt.provider"');
    // Non-overridden fields get no reset checkbox.
    expect(body).not.toContain('name="reset" value="stt.model"');
  });

  it("escapes stored override values (XSS)", async () => {
    db.saveSettingsDoc({ llm: { models: { conversation: '<script>alert(1)</script>' } } });
    await app.ready();
    const { body } = await get();
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert(1)");
  });

  it("renders the read-only infra section with disabled, unnamed inputs", async () => {
    await app.ready();
    const { body } = await get();
    expect(body).toContain("Infrastructure");
    for (const path of ["port", "host", "publicBaseUrl", "databaseUrl"]) {
      expect(body).toContain(`id="infra-${path}"`);
      expect(body).not.toContain(`name="${path}"`);
    }
    expect(body).toContain('value="3000" disabled');
    expect(body.match(/set via environment/g)?.length).toBe(4);
  });

  it("shows the green saved banner only for ?saved=1", async () => {
    await app.ready();
    const plain = await get();
    expect(plain.body).not.toContain("banner saved");
    expect(plain.body).toContain("apply to");
    const saved = await get("/admin/settings?saved=1");
    expect(saved.body).toContain("banner saved");
    expect(saved.body).toContain("Settings saved.");
  });
});

describe("POST /admin/settings (valid)", () => {
  it("redirects 303 to ?saved=1 and persists the built payload", async () => {
    await app.ready();
    const res = await post(
      "llm.models.conversation=test%2Fnew-model&stt.sampleRateHz=24000&stt.model=scribe_v2_realtime" +
        "&twilio.accountSid=AC1234567890&vad.threshold=0.05",
    );
    expect(res.status).toBe(303);
    expect(res.location).toBe("/admin/settings?saved=1");
    // Only fields that differ from the effective value are persisted; the
    // unchanged stt.model is not turned into an override.
    expect(db.saveSettingsDoc).toHaveBeenCalledTimes(1);
    expect(db.saveSettingsDoc).toHaveBeenCalledWith({
      llm: { models: { conversation: "test/new-model" } },
      stt: { sampleRateHz: 24000 },
      twilio: { accountSid: "AC1234567890" },
      vad: { threshold: 0.05 },
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(db.doc()).toMatchObject({ vad: { threshold: 0.05 } });
  });

  it("persists explicit boolean submissions and skips untouched booleans", async () => {
    await app.ready();
    // notes.enabled is not part of the submission → untouched, no flip.
    const partial = await post("llm.models.conversation=x");
    expect(partial.status).toBe(303);
    expect(db.doc()).toEqual({ llm: { models: { conversation: "x" } } });

    // Explicit "false" persists false; explicit "true" (checkbox) persists true.
    const off = await post("notes.enabled=false");
    expect(off.status).toBe(303);
    expect(db.doc()).toMatchObject({ notes: { enabled: false } });

    const on = await post("notes.enabled=true");
    expect(on.status).toBe(303);
    expect(db.doc()).toMatchObject({ notes: { enabled: true } });
  });

  it("drops empty secrets (keep current) and stores a filled secret without echoing it", async () => {
    await app.ready();
    const keep = await post("elevenlabs.apiKey=");
    expect(keep.status).toBe(303);
    expect(db.saveSettingsDoc).not.toHaveBeenCalled();

    const set = await post("elevenlabs.apiKey=el-secret-9876");
    expect(set.status).toBe(303);
    expect(db.doc()).toEqual({ elevenlabs: { apiKey: "el-secret-9876" } });
  });
});

describe("POST /admin/settings (validation errors)", () => {
  it("re-renders 200 with per-field errors and preserved values; nothing persisted", async () => {
    await app.ready();
    const res = await post("vad.threshold=abc&llm.models.conversation=test%2Fpreserved");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Settings were not saved");
    expect(res.body).toContain("Expected number, received string");
    expect(res.body).toContain('value="test/preserved"');
    expect(db.saveSettingsDoc).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("re-renders invalid select values with an error", async () => {
    await app.ready();
    const res = await post("stt.provider=nope");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Invalid enum value");
    // The submitted value is preserved visibly (extra selected option).
    expect(res.body).toContain('value="nope" selected');
    expect(db.saveSettingsDoc).not.toHaveBeenCalled();
  });

  it("preserves submitted secrets as blank (never echoed back)", async () => {
    await app.ready();
    const res = await post("elevenlabs.apiKey=brand-new-secret&vad.threshold=not-a-number");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("brand-new-secret");
    expect(res.body).toContain('placeholder="unchanged"');
  });
});

describe("POST /admin/settings (reset)", () => {
  it("clears overridden paths and ignores reset paths without a DB override", async () => {
    db.saveSettingsDoc({ llm: { models: { conversation: "test/override-model" } } });
    await app.ready();
    db.saveSettingsDoc.mockClear(); // the seed call above must not count
    const res = await post("reset=llm.models.conversation&reset=stt.model");
    expect(res.status).toBe(303);
    expect(db.clearSettingsPath).toHaveBeenCalledTimes(1);
    expect(db.clearSettingsPath).toHaveBeenCalledWith("llm.models.conversation");
    expect(db.clearSettingsPath).not.toHaveBeenCalledWith("stt.model");
    expect(db.saveSettingsDoc).not.toHaveBeenCalled();
    expect(db.doc()).toEqual({});
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("applies resets before saves when both are present", async () => {
    db.saveSettingsDoc({ vad: { threshold: 0.5 } });
    await app.ready();
    const res = await post("reset=vad.threshold&vad.threshold=0.05");
    expect(res.status).toBe(303);
    expect(db.doc()).toEqual({ vad: { threshold: 0.05 } });
  });
});

describe("POST /admin/settings (urlencoded parser coexistence)", () => {
  it("applies multi-value resets even when the app has a last-value-wins urlencoded parser", async () => {
    // Mirrors registerTwilioRoutes: an app-level parser that collapses
    // repeated keys. The settings page must replace it inside its own scope.
    const host = Fastify({ logger: false });
    host.addContentTypeParser(
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
    registerBasicAuth(host, makeConfig());
    registerSettingsPage(host, { db, config: makeConfig() });
    await host.ready();
    db.saveSettingsDoc({ llm: { models: { conversation: "test/override-model" } }, notes: { enabled: false } });
    db.saveSettingsDoc.mockClear();
    const res = await host.inject({
      method: "POST",
      url: "/admin/settings",
      headers: { authorization: authHeader(), "content-type": "application/x-www-form-urlencoded" },
      payload: "reset=llm.models.conversation&reset=notes.enabled",
    });
    expect(res.statusCode).toBe(303);
    expect(db.clearSettingsPath).toHaveBeenCalledWith("llm.models.conversation");
    expect(db.clearSettingsPath).toHaveBeenCalledWith("notes.enabled");
    expect(db.doc()).toEqual({});
    await host.close();
  });
});

/* ------------------------------------------------------------------ */
/* Pure renderer over a stubbed sections dataset                        */
/* ------------------------------------------------------------------ */

const STUB_SECTIONS: EditableSection[] = [
  {
    id: "demo",
    title: "Demo section",
    fields: [
      { path: "demo.text", label: "Demo text", type: "string" },
      { path: "demo.count", label: "Demo count", type: "number", min: 1, max: 9, step: 2 },
      { path: "demo.flag", label: "Demo flag", type: "boolean" },
      { path: "demo.kind", label: "Demo kind", type: "select", options: ["alpha", "beta"] },
      {
        path: "demo.key",
        label: "Demo key",
        type: "secret",
        restartRequired: true,
        help: "write-only",
      },
    ],
  },
];

const STUB_STATE: SettingsPageState = {
  sections: STUB_SECTIONS,
  values: {
    demo: {
      text: 'hello & <world>',
      count: 5,
      flag: true,
      kind: "beta",
      key: { set: true, hint: "…9999" },
    },
  },
  overrides: new Set(["demo.text"]),
  saved: false,
  submitted: null,
  errors: null,
};

describe("renderSettingsPage (stubbed sections dataset)", () => {
  it("renders one fieldset per section with the right control per type", () => {
    const html = renderSettingsPage(STUB_STATE);
    expect(html).toContain("Demo section");
    for (const label of ["Demo text", "Demo count", "Demo flag", "Demo kind", "Demo key"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('value="hello &amp; &lt;world&gt;"'); // escaped
    expect(html).toContain('type="number" min="1" max="9" step="2" value="5"');
    expect(html).toContain('type="checkbox" value="true" checked');
    expect(html).toContain('<option value="beta" selected>');
    expect(html).toContain('type="password" placeholder="unchanged"');
  });

  it("shows override badge + reset checkbox, restart badge + help, masked secret state", () => {
    const html = renderSettingsPage(STUB_STATE);
    expect(html).toContain("badge-override");
    expect(html).toContain('name="reset" value="demo.text"');
    expect(html).toContain("badge-restart");
    expect(html).toContain("takes effect after restart");
    expect(html).toContain("currently set (…9999)");
  });

  it("renders per-field errors and preserves submitted values on re-render", () => {
    const html = renderSettingsPage({
      ...STUB_STATE,
      submitted: new Map([
        ["demo.text", "re-rendered"],
        ["demo.count", "oops"],
        ["demo.flag", "true"],
        ["demo.key", "typed-secret"],
      ]),
      errors: new Map([["demo.count", "Expected number, received string"]]),
    });
    expect(html).toContain('value="re-rendered"');
    expect(html).toContain('value="oops"');
    expect(html).toContain('type="checkbox" value="true" checked');
    expect(html).toContain("Expected number, received string");
    expect(html).toContain("banner error");
    // The typed secret is never echoed back.
    expect(html).not.toContain("typed-secret");
    // Effective values still shown for untouched fields.
    expect(html).toContain('<option value="beta" selected>');
  });
});
