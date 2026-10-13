/**
 * Fixture generator for the dev-page replay mode (task 2.5).
 *
 * Writes deterministic, speech-like SYNTHETIC placeholder recordings
 * (16 kHz mono PCM16 WAV) for et/ru/en plus their reference transcripts
 * into test/fixtures/. These are structural placeholders for pipeline,
 * replay and e2e testing only - NOT real speech (see test/fixtures/README.md).
 *
 * Usage: npm run fixtures
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 16_000;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const TARGET_DURATION_S = 5.0; // approximate per-file duration
const TARGET_PEAK = 0.7; // headroom so synthesized audio never clips

const fixturesDir = fileURLToPath(new URL("../test/fixtures/", import.meta.url));

/** Deterministic PRNG (mulberry32) so regeneration is byte-stable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Rng = () => number;

/** Random float in [min, max). */
function range(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

interface VoiceProfile {
  /** Output wav filename. */
  file: string;
  /** Reference transcript used later by the STT bake-off. */
  transcript: string;
  /** Fundamental frequency in Hz (human voice range; distinct per language). */
  f0: number;
  /** Syllable-rate amplitude envelope in Hz (kept in the 3-6 Hz band). */
  syllableHz: number;
  /** Number of "words" (voiced bursts separated by pauses), 5-8. */
  words: number;
  /** PRNG seed - different per language, fixed for determinism. */
  seed: number;
}

const PROFILES: VoiceProfile[] = [
  {
    file: "fixture-et.wav",
    transcript: "Tere, mul on küsimus arve kohta. Kas saaksite mind aidata?",
    f0: 110,
    syllableHz: 3.4,
    words: 6,
    seed: 0xefe7e5,
  },
  {
    file: "fixture-ru.wav",
    transcript: "Здравствуйте, у меня вопрос по счёту. Не могли бы вы мне помочь?",
    f0: 130,
    syllableHz: 4.4,
    words: 7,
    seed: 0x1206d00,
  },
  {
    file: "fixture-en.wav",
    transcript: "Hello, I have a question about my invoice. Could you help me with that?",
    f0: 150,
    syllableHz: 5.4,
    words: 8,
    seed: 0x0fee0ff,
  },
];

/** Write a canonical 44-byte RIFF/WAVE header for 16 kHz mono PCM16 in front of the samples. */
function encodeWav(samples: Float32Array): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] as number));
    pcm.writeInt16LE(Math.round(clamped * 32_767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4); // riffSize
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // audioFormat: PCM
  header.writeUInt16LE(NUM_CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE((SAMPLE_RATE * NUM_CHANNELS * BITS_PER_SAMPLE) / 8, 28); // byteRate
  header.writeUInt16LE((NUM_CHANNELS * BITS_PER_SAMPLE) / 8, 32); // blockAlign
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

interface SynthOptions {
  rng: Rng;
  f0: number;
  syllableHz: number;
  words: number;
}

/**
 * Synthesize a speech-like placeholder utterance: a sequence of voiced "words"
 * (2-4 syllables each, harmonics f0/2f0/3f0 falling off, per-syllable attack-decay
 * shaping, slight pitch jitter and downward drift) separated by low-noise pauses,
 * with a global syllable-rate (3-6 Hz) amplitude envelope and a slight noise floor.
 */
function synthesizeUtterance({ rng, f0, syllableHz, words }: SynthOptions): Float32Array {
  const chunks: Float32Array[] = [];
  const noiseFloor = 0.006;
  const envelopePhase = range(rng, 0, Math.PI * 2);
  let time = 0; // running position in seconds (drives the global envelope)
  let wordIndex = 0;

  while (wordIndex < words) {
    // --- voiced word: 2-4 syllables ---
    const syllables = 2 + Math.floor(rng() * 3);
    for (let s = 0; s < syllables; s++) {
      const syllableDur = range(rng, 0.16, 0.28);
      const n = Math.floor(syllableDur * SAMPLE_RATE);
      const buf = new Float32Array(n);

      // Pitch contour: slight jitter per syllable + declination over the utterance.
      const drift = 1 - 0.12 * (time / TARGET_DURATION_S); // f0 falls ~12% towards the end
      const syllableF0 = f0 * drift * range(rng, 0.95, 1.05);

      // Phase-continuous oscillators (no clicks at chunk boundaries).
      const phases = [0, 0, 0];
      const harmonicGain = [1, 0.5, 0.25]; // f0, 2f0, 3f0 falling off
      const attack = Math.floor(n * 0.2);
      const release = Math.floor(n * 0.35);

      for (let i = 0; i < n; i++) {
        const t = i / SAMPLE_RATE;
        let sample = 0;
        for (let h = 0; h < 3; h++) {
          // Subtle vibrato keeps the tone from sounding like a pure siren.
          const f = syllableF0 * (h + 1) * (1 + 0.01 * Math.sin(2 * Math.PI * 5 * t));
          phases[h] = (phases[h]! + (2 * Math.PI * f) / SAMPLE_RATE) % (2 * Math.PI);
          sample += harmonicGain[h]! * Math.sin(phases[h]!);
        }

        // Per-syllable smooth attack/decay window.
        let env: number;
        if (i < attack) env = i / attack;
        else if (i > n - release) env = (n - i) / release;
        else env = 1;

        // Global syllable-rate amplitude envelope (3-6 Hz band) for word rhythm.
        const rhythm = 0.65 + 0.35 * Math.sin(2 * Math.PI * syllableHz * time + envelopePhase);

        buf[i] = sample * env * rhythm * 0.4;
        time += 1 / SAMPLE_RATE;
      }
      chunks.push(buf);
    }

    // --- inter-word pause: near-silence with the noise floor only ---
    const pauseDur = range(rng, 0.1, 0.25);
    const pauseN = Math.floor(pauseDur * SAMPLE_RATE);
    const pause = new Float32Array(pauseN);
    for (let i = 0; i < pauseN; i++) {
      pause[i] = (rng() * 2 - 1) * noiseFloor;
      time += 1 / SAMPLE_RATE;
    }
    chunks.push(pause);
    wordIndex++;
  }

  // Concatenate, cap at the target duration, and fade the edges so the trim never clicks.
  const targetSamples = Math.floor(TARGET_DURATION_S * SAMPLE_RATE);
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(Math.min(total, targetSamples));
  let offset = 0;
  for (const c of chunks) {
    if (offset >= out.length) break;
    out.set(c.subarray(0, out.length - offset), offset);
    offset += c.length;
  }

  const fadeS = 0.015;
  const fadeN = Math.min(out.length, Math.floor(fadeS * SAMPLE_RATE));
  for (let i = 0; i < fadeN; i++) {
    // Raised-cosine fade-in at the head, fade-out at the tail.
    const fadeIn = 0.5 - 0.5 * Math.cos((Math.PI * (i + 1)) / fadeN);
    const fadeOut = 0.5 - 0.5 * Math.cos((Math.PI * (fadeN - i)) / fadeN);
    out[i] = (out[i] as number) * fadeIn;
    out[out.length - 1 - i] = (out[out.length - 1 - i] as number) * fadeOut;
  }
  return out;
}

/** Mix in a slight noise floor across the whole utterance and normalize so it cannot clip. */
function addNoiseFloorAndNormalize(samples: Float32Array, rng: Rng): Float32Array {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? TARGET_PEAK / peak : 1;
  const noiseFloor = 0.006;
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (samples[i] as number) * gain + (rng() * 2 - 1) * noiseFloor;
  }
  return samples;
}

interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
}

/** Parse a RIFF/WAVE header, walking chunks until "data" (tolerates extra chunks). */
function parseWavHeader(buf: Buffer): WavInfo {
  if (
    buf.length < 44 ||
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("not a RIFF/WAVE file");
  }
  let pos = 12;
  let info: WavInfo | undefined;
  while (pos + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", pos, pos + 4);
    const chunkSize = buf.readUInt32LE(pos + 4);
    if (chunkId === "fmt ") {
      info = {
        audioFormat: buf.readUInt16LE(pos + 8),
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        bitsPerSample: buf.readUInt16LE(pos + 22),
        dataBytes: 0,
      };
    } else if (chunkId === "data") {
      info = { ...(info as WavInfo), dataBytes: chunkSize };
      break;
    }
    pos += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  if (!info || info.dataBytes === 0) throw new Error("missing fmt/data chunk");
  return info;
}

/** Assert the file is 16 kHz mono 16-bit PCM and print a one-line summary. */
function verifyFixture(file: string): void {
  const buf = readFileSync(join(fixturesDir, file));
  const info = parseWavHeader(buf);
  const durationS = info.dataBytes / ((info.sampleRate * info.channels * info.bitsPerSample) / 8);
  const ok =
    info.audioFormat === 1 &&
    info.channels === NUM_CHANNELS &&
    info.sampleRate === SAMPLE_RATE &&
    info.bitsPerSample === BITS_PER_SAMPLE &&
    info.dataBytes === buf.length - 44;
  if (!ok) throw new Error(`${file}: unexpected format ${JSON.stringify(info)}`);
  console.log(
    `${file}: ${buf.length} bytes, ${durationS.toFixed(2)} s ` +
      `(${info.sampleRate} Hz, mono, ${info.bitsPerSample}-bit PCM) - OK`,
  );
}

function main(): void {
  mkdirSync(fixturesDir, { recursive: true });

  for (const profile of PROFILES) {
    const samples = addNoiseFloorAndNormalize(
      synthesizeUtterance({
        rng: mulberry32(profile.seed),
        f0: profile.f0,
        syllableHz: profile.syllableHz,
        words: profile.words,
      }),
      mulberry32(profile.seed ^ 0x9e3779b9),
    );
    const wavPath = join(fixturesDir, profile.file);
    writeFileSync(wavPath, encodeWav(samples));
    writeFileSync(
      join(fixturesDir, profile.file.replace(/\.wav$/, ".txt")),
      `${profile.transcript}\n`,
    );
  }

  console.log(`Wrote ${PROFILES.length} synthetic fixtures to ${fixturesDir}`);
  for (const profile of PROFILES) verifyFixture(profile.file);
}

main();
