/**
 * Mic capture AudioWorklet: downsamples the native input rate to 16 kHz and
 * emits 20 ms PCM16 frames (320 samples) to the main thread.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const ratio = (options && options.processorOptions && options.processorOptions.ratio) || 3;
    this.ratio = ratio; // native sample rate / 16000
    this.pos = 0; // fractional read position within the current block
    this.prev = 0; // last input sample of the previous block
    this.out = new Int16Array(320);
    this.fill = 0;
    this.muted = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "mute") this.muted = !!e.data.value;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;

    let pos = this.pos;
    if (pos < 0) pos += 0; // positions in [-1,0) interpolate prev -> ch[0]
    let guard = 0;
    while (pos <= ch.length - 1 && guard++ < 100000) {
      const i = Math.floor(pos);
      const local = pos - i;
      const a = i < 0 ? this.prev : ch[i];
      const b = i + 1 < ch.length ? ch[i + 1] : a;
      let v = a + (b - a) * local;
      if (this.muted) v = 0;
      this.out[this.fill++] = v < 0 ? Math.max(-32768, Math.round(v * 32768)) : Math.min(32767, Math.round(v * 32767));
      if (this.fill === this.out.length) {
        this.port.postMessage(this.out.slice(0));
        this.fill = 0;
      }
      pos += this.ratio;
    }

    if (pos > ch.length - 1) {
      this.prev = ch[ch.length - 1];
      this.pos = pos - ch.length;
    } else {
      this.pos = pos;
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
