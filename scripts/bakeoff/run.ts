/**
 * STT bake-off (task 3.5): score available STT providers against the
 * test/fixtures/fixture-*.wav fixtures and their sibling reference .txt
 * transcripts.
 *
 * Usage: npm run bakeoff
 *
 * Providers without an API key are skipped with a notice; with no providers
 * at all the script exits 0. Every provider x fixture run is isolated: a
 * provider error becomes an error row and never changes the exit code.
 *
 * NOTE: the shipped wavs are SYNTHETIC placeholders (see
 * test/fixtures/README.md) — WER numbers are only meaningful once real
 * recordings replace them.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config/index.js";
import { logger } from "../../src/logging.js";
import { GladiaSttProvider } from "../../src/stt/gladia.js";
import { ScribeSttProvider } from "../../src/stt/scribe.js";
import { SonioxSttProvider } from "../../src/stt/soniox.js";
import type { AppConfig } from "../../src/config/schema.js";
import type { SttEvent, SttProvider, SttStream } from "../../src/stt/types.js";
import { werDetail } from "./wer.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Audio format streamed to every provider (same as Twilio Media Streams). */
const SAMPLE_RATE_HZ = 16_000;
/** PCM16 = 2 bytes per sample. */
const CHUNK_MS = 20;
const CHUNK_BYTES = Math.round((SAMPLE_RATE_HZ * CHUNK_MS) / 1000) * 2; // 640
/** Pace the stream slightly faster than real time but keep natural timing. */
const TICK_CHUNKS = 5; // 100 ms of audio per tick...
const TICK_DELAY_MS = 10; // ...every 10 ms wall time (~10x realtime)
/** Hard cap on how long we wait for a final after the audio has been fed. */
const FINAL_TIMEOUT_MS = 20_000;
/** Where full JSON reports are written. */
const REPORTS_DIR = "reports";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WavPcm {
  sampleRateHz: number;
  channels: number;
  bitsPerSample: number;
  /** Raw PCM payload of the data chunk. */
  pcm: Buffer;
}

export interface BakeoffRow {
  provider: string;
  fixture: string;
  /** WER as a fraction (0.12 = 12%); null when no transcript was produced. */
  wer: number | null;
  insertions: number | null;
  deletions: number | null;
  substitutions: number | null;
  /** Latency from first audio byte written to the first "partial" event. */
  firstPartialMs: number | null;
  /** Time from first audio byte to the first "final" event. */
  totalMs: number | null;
  /** Final transcript (first "final" event), when received. */
  transcript: string | null;
  error: string | null;
}

export interface BakeoffReport {
  generatedAt: string;
  sampleRateHz: number;
  syntheticFixtureWarning: string;
  skippedProviders: Array<{ provider: string; reason: string }>;
  rows: BakeoffRow[];
}

// ---------------------------------------------------------------------------
// WAV parsing (small RIFF helper)
// ---------------------------------------------------------------------------

/**
 * Parse a RIFF/WAVE file and return its fmt info plus raw data-chunk PCM.
 * Only uncompressed PCM (format 1) is supported — the same format Twilio
 * Media Streams delivers.
 */
export function readWavPcm(path: string): WavPcm {
  const buf = readFileSync(path);
  if (
    buf.length < 12 ||
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }

  let fmt:
    | { audioFormat: number; channels: number; sampleRateHz: number; bitsPerSample: number }
    | undefined;
  let data: Buffer | undefined;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRateHz: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt || !data) throw new Error(`${path} is missing a fmt or data chunk`);
  if (fmt.audioFormat !== 1) throw new Error(`${path}: only uncompressed PCM wav is supported`);
  return {
    sampleRateHz: fmt.sampleRateHz,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    pcm: data,
  };
}

// ---------------------------------------------------------------------------
// Provider / fixture discovery
// ---------------------------------------------------------------------------

interface ProviderEntry {
  name: string;
  create: () => SttProvider;
}

/** Providers with an API key configured; the rest are skipped with a notice. */
function availableProviders(config: AppConfig): {
  available: ProviderEntry[];
  skipped: Array<{ provider: string; reason: string }>;
} {
  const candidates: Array<ProviderEntry & { apiKey?: string; envVar: string }> = [
    {
      name: "scribe",
      apiKey: config.elevenlabs.apiKey,
      envVar: "ELEVENLABS_API_KEY",
      create: () => new ScribeSttProvider(config),
    },
    {
      name: "soniox",
      apiKey: config.soniox.apiKey,
      envVar: "SONIOX_API_KEY",
      create: () => new SonioxSttProvider(config),
    },
    {
      name: "gladia",
      apiKey: config.gladia.apiKey,
      envVar: "GLADIA_API_KEY",
      create: () => new GladiaSttProvider(config),
    },
  ];

  const available: ProviderEntry[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  for (const candidate of candidates) {
    if (candidate.apiKey) {
      available.push({ name: candidate.name, create: candidate.create });
    } else {
      skipped.push({
        provider: candidate.name,
        reason: `no API key (${candidate.envVar} not set) — skipping`,
      });
    }
  }
  return { available, skipped };
}

interface Fixture {
  name: string;
  wavPath: string;
  referencePath: string;
}

/** fixture-*.wav files (with sibling .txt references) in test/fixtures/. */
function discoverFixtures(fixturesDir: string): Fixture[] {
  return readdirSync(fixturesDir)
    .filter((file) => /^fixture-.*\.wav$/.test(file))
    .sort()
    .map((file) => ({
      name: file.replace(/\.wav$/, ""),
      wavPath: join(fixturesDir, file),
      referencePath: join(fixturesDir, file.replace(/\.wav$/, ".txt")),
    }));
}

// ---------------------------------------------------------------------------
// One provider x fixture measurement
// ---------------------------------------------------------------------------

/** Stream one fixture through one provider and collect latency/transcript. */
export async function measureFixture(provider: SttProvider, fixture: Fixture): Promise<BakeoffRow> {
  const row: BakeoffRow = {
    provider: provider.name,
    fixture: fixture.name,
    wer: null,
    insertions: null,
    deletions: null,
    substitutions: null,
    firstPartialMs: null,
    totalMs: null,
    transcript: null,
    error: null,
  };

  let stream: SttStream | undefined;
  try {
    const wav = readWavPcm(fixture.wavPath);
    if (wav.bitsPerSample !== 16) {
      throw new Error(`fixture is ${wav.bitsPerSample}-bit; expected 16-bit PCM`);
    }
    if (wav.channels !== 1) {
      throw new Error(`fixture has ${wav.channels} channels; expected mono`);
    }
    if (wav.sampleRateHz !== SAMPLE_RATE_HZ) {
      console.warn(
        `warning: ${fixture.name} is ${wav.sampleRateHz} Hz (expected ${SAMPLE_RATE_HZ}); streaming as-is`,
      );
    }

    const events: SttEvent[] = [];
    stream = provider.startStream({ language: "auto", sampleRateHz: SAMPLE_RATE_HZ });
    stream.on((event) => events.push(event));

    const startedAtMs = Date.now();
    let chunkStart = 0;
    let chunkCount = 0;
    while (chunkStart < wav.pcm.length) {
      stream.write(
        wav.pcm.subarray(chunkStart, Math.min(chunkStart + CHUNK_BYTES, wav.pcm.length)),
      );
      chunkStart += CHUNK_BYTES;
      // Natural pacing: brief pause every few chunks, bounded by the cap below.
      if (++chunkCount % TICK_CHUNKS === 0) await sleep(TICK_DELAY_MS);
    }

    // Wait (bounded) for the first final transcript event. If the provider
    // stream dies early (e.g. auth error), stop immediately — no final is
    // ever coming.
    const deadline = Date.now() + FINAL_TIMEOUT_MS;
    while (Date.now() < deadline && !events.some((e) => e.type === "final")) {
      if (stream.closed) break;
      await sleep(25);
    }

    await stream.close();
    stream = undefined;

    const firstPartial = events.find((e) => e.type === "partial");
    const final = events.find((e) => e.type === "final");
    if (firstPartial) row.firstPartialMs = firstPartial.atMs - startedAtMs;
    if (final) {
      row.totalMs = final.atMs - startedAtMs;
      row.transcript = final.text;
      if (existsSync(fixture.referencePath)) {
        const reference = readFileSync(fixture.referencePath, "utf8");
        const detail = werDetail(reference, final.text);
        row.wer = detail.wer;
        row.insertions = detail.insertions;
        row.deletions = detail.deletions;
        row.substitutions = detail.substitutions;
      } else {
        row.error = `missing reference transcript: ${fixture.referencePath}`;
      }
    } else if (Date.now() < deadline) {
      row.error = "provider stream closed before a final transcript";
    } else {
      row.error = `no final transcript within ${FINAL_TIMEOUT_MS} ms`;
    }
    return row;
  } catch (err) {
    row.error = err instanceof Error ? err.message : String(err);
    return row;
  } finally {
    // Never leak a socket when a run fails midway.
    if (stream) await stream.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function snippet(text: string | null, max = 48): string {
  if (text === null) return "—";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function printTable(rows: BakeoffRow[]): void {
  const header = [
    "provider",
    "fixture",
    "WER%",
    "first-partial ms",
    "total s",
    "transcript snippet",
  ];
  const body = rows.map((row) => [
    row.provider,
    row.fixture,
    row.wer === null ? "—" : `${(row.wer * 100).toFixed(1)}%`,
    row.firstPartialMs === null ? "—" : String(row.firstPartialMs),
    row.totalMs === null ? "—" : (row.totalMs / 1000).toFixed(2),
    `${snippet(row.transcript)}${row.error ? ` [ERROR: ${snippet(row.error, 60)}]` : ""}`,
  ]);

  const widths = header.map((h, col) =>
    Math.max(h.length, ...body.map((cells) => cells[col]!.length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, col) => cell.padEnd(widths[col]!)).join(" | ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("-|-"));
  for (const cells of body) console.log(line(cells));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const fixturesDir = join(packageRoot, "test", "fixtures");

  const { available, skipped } = availableProviders(config);
  for (const skip of skipped) console.log(`skip: ${skip.provider} — ${skip.reason}`);
  if (available.length === 0) {
    console.log(
      "No STT providers configured (set ELEVENLABS_API_KEY / SONIOX_API_KEY / GLADIA_API_KEY). Nothing to run.",
    );
    return;
  }

  const fixtures = discoverFixtures(fixturesDir);
  if (fixtures.length === 0) {
    console.log(`No fixture-*.wav files found in ${fixturesDir}. Nothing to run.`);
    return;
  }

  console.log(
    `Running ${available.length} provider(s) x ${fixtures.length} fixture(s). ` +
      "NOTE: the shipped wavs are synthetic placeholders — WER is only meaningful with real recordings (test/fixtures/README.md).",
  );

  const rows: BakeoffRow[] = [];
  for (const provider of available) {
    for (const fixture of fixtures) {
      process.stdout.write(`streaming ${provider.name} / ${fixture.name} ... `);
      const row = await measureFixture(provider.create(), fixture);
      console.log(
        row.error ? `error (${row.error})` : `done in ${((row.totalMs ?? 0) / 1000).toFixed(2)}s`,
      );
      rows.push(row);
    }
  }

  console.log("");
  printTable(rows);

  mkdirSync(join(packageRoot, REPORTS_DIR), { recursive: true });
  const report: BakeoffReport = {
    generatedAt: new Date().toISOString(),
    sampleRateHz: SAMPLE_RATE_HZ,
    syntheticFixtureWarning:
      "Fixtures are synthetic placeholders; WER numbers are only meaningful with real recordings (test/fixtures/README.md).",
    skippedProviders: skipped,
    rows,
  };
  // Colons would be awkward on some filesystems; keep it sortable ISO-ish.
  const stamp = report.generatedAt.replace(/:/g, "-");
  const reportPath = join(packageRoot, REPORTS_DIR, `bakeoff-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nfull report written to ${reportPath}`);
}

// Entrypoint when run directly (`npm run bakeoff`).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  logger.debug("starting STT bake-off");
  main().catch((err: unknown) => {
    console.error(`bake-off failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
