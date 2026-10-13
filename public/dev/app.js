/* Dev call harness: mic/wav -> WebSocket -> pipeline, Web Audio playback. */
/* eslint-env browser */
(() => {
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const transcriptEl = $("transcript");
  const startBtn = $("start");
  const stopBtn = $("stop");
  const modeSel = $("mode");
  const fixtureSel = $("fixture");
  const fixtureWrap = $("fixture-wrap");
  const fromInput = $("from");

  const TARGET_RATE = 16000;
  const FRAME_MS = 20;

  let ws = null;
  let captureCtx = null;
  let playCtx = null;
  let activeSources = new Set();
  let nextPlayTime = 0;
  let replayTimer = null;
  let callActive = false;

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status" + (cls ? " " + cls : "");
  }

  function addUtterance(speaker, text, partial) {
    const empty = transcriptEl.querySelector(".empty");
    if (empty) empty.remove();

    if (partial) {
      let el = transcriptEl.querySelector(`.partial[data-speaker="${speaker}"]`);
      if (el) {
        el.querySelector(".text").textContent = text;
        return;
      }
      el = buildBubble(speaker, text, true);
      transcriptEl.appendChild(el);
    } else {
      const partialEl = transcriptEl.querySelector(`.partial[data-speaker="${speaker}"]`);
      if (partialEl) partialEl.remove();
      transcriptEl.appendChild(buildBubble(speaker, text, false));
    }
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function buildBubble(speaker, text, partial) {
    const div = document.createElement("div");
    div.className = `utterance ${speaker}` + (partial ? " partial" : "");
    div.dataset.speaker = speaker;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = speaker === "caller" ? "caller" : "agent";
    const tx = document.createElement("span");
    tx.className = "text";
    tx.textContent = text;
    div.appendChild(who);
    div.appendChild(tx);
    return div;
  }

  // ---------------------------------------------------------------- websocket
  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + "/media/browser";
  }

  async function startCall() {
    if (callActive) return;
    transcriptEl.innerHTML = '<p class="empty">No utterances yet — speak or wait for the fixture.</p>';
    setStatus("connecting…", "");

    ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "start",
          from: fromInput.value.trim() || undefined,
          mode: modeSel.value,
          fixture: fixtureSel.value || undefined,
        }),
      );
      setStatus("call active — speak", "active");
    };
    ws.onmessage = onWsMessage;
    ws.onclose = () => {
      if (callActive) teardown("closed by server");
    };
    ws.onerror = () => setStatus("websocket error", "error");

    try {
      if (modeSel.value === "mic") await startMic();
      else await startReplay(fixtureSel.value);
      callActive = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
    } catch (err) {
      setStatus("failed: " + err.message, "error");
      teardown("startup failed");
    }
  }

  async function onWsMessage(msg) {
    if (typeof msg.data === "string") {
      const ev = JSON.parse(msg.data);
      switch (ev.type) {
        case "transcript":
          addUtterance(ev.speaker, ev.text, !!ev.partial);
          break;
        case "flush":
          flushPlayback();
          break;
        case "hangup":
          teardown("call ended (" + (ev.reason || "hangup") + ")");
          break;
        case "status":
          setStatus(ev.text || "", "active");
          break;
        default:
          break;
      }
      return;
    }
    // Binary frame: 16 kHz PCM16 agent audio.
    playChunk(new Int16Array(msg.data));
  }

  // ------------------------------------------------------------------ capture
  async function startMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    captureCtx = new AudioContext({ sampleRate: 48000 });
    await captureCtx.audioWorklet.addModule("/static/dev/worklet.js");
    const src = captureCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(captureCtx, "capture-processor", {
      processorOptions: { ratio: captureCtx.sampleRate / TARGET_RATE },
      numberOfOutputs: 0,
    });
    node.port.onmessage = (e) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(e.data.buffer);
    };
    src.connect(node);
    captureCtx.resume();
  }

  // ------------------------------------------------------------------- replay
  async function startReplay(fixtureName) {
    if (!fixtureName) throw new Error("no fixture selected");
    const res = await fetch("/dev/fixtures/" + encodeURIComponent(fixtureName));
    if (!res.ok) throw new Error("fixture fetch failed: " + res.status);
    const raw = await res.arrayBuffer();

    const decodeCtx = new AudioContext({ sampleRate: TARGET_RATE });
    const audio = await decodeCtx.decodeAudioData(raw);
    await decodeCtx.close();

    // Convert to Int16 and stream frame-by-frame at real-time pace.
    const chan = audio.getChannelData(0);
    const pcm = new Int16Array(chan.length);
    for (let i = 0; i < chan.length; i++) {
      const v = Math.max(-1, Math.min(1, chan[i]));
      pcm[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
    }
    const frameSamples = (TARGET_RATE * FRAME_MS) / 1000;
    let offset = 0;
    replayTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const end = Math.min(offset + frameSamples, pcm.length);
      if (offset >= end) {
        clearInterval(replayTimer);
        replayTimer = null;
        return;
      }
      const slice = pcm.subarray(offset, end);
      ws.send(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
      offset = end;
    }, FRAME_MS);
  }

  // ----------------------------------------------------------------- playback
  function ensurePlayCtx() {
    if (!playCtx) playCtx = new AudioContext({ sampleRate: TARGET_RATE });
    if (playCtx.state === "suspended") playCtx.resume();
  }

  function playChunk(int16) {
    ensurePlayCtx();
    const buf = playCtx.createBuffer(1, int16.length, TARGET_RATE);
    const data = buf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) data[i] = int16[i] / 32768;
    const src = playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(playCtx.destination);
    if (nextPlayTime < playCtx.currentTime) nextPlayTime = playCtx.currentTime + 0.02;
    src.start(nextPlayTime);
    nextPlayTime += buf.duration;
    activeSources.add(src);
    src.onended = () => activeSources.delete(src);
  }

  function flushPlayback() {
    for (const src of activeSources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    activeSources = new Set();
    nextPlayTime = 0;
  }

  // ------------------------------------------------------------------ lifecycle
  function teardown(reason) {
    callActive = false;
    if (replayTimer) {
      clearInterval(replayTimer);
      replayTimer = null;
    }
    if (captureCtx) {
      captureCtx.close().catch(() => {});
      captureCtx = null;
    }
    flushPlayback();
    if (ws) {
      const sock = ws;
      ws = null;
      try {
        sock.send(JSON.stringify({ type: "stop" }));
        sock.close();
      } catch {
        /* ignore */
      }
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus(reason ? "idle — " + reason : "idle", "");
  }

  // ------------------------------------------------------------------ fixtures
  async function loadFixtures() {
    try {
      const res = await fetch("/dev/fixtures");
      if (!res.ok) return;
      const list = await res.json();
      fixtureSel.innerHTML = "";
      for (const name of list) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        fixtureSel.appendChild(opt);
      }
      fixtureWrap.hidden = list.length === 0;
    } catch {
      /* fixture listing unavailable */
    }
  }

  modeSel.addEventListener("change", () => {
    fixtureWrap.hidden = modeSel.value !== "replay";
  });
  startBtn.addEventListener("click", () => {
    ensurePlayCtx(); // user gesture unlocks Web Audio
    startCall().catch((err) => setStatus("failed: " + err.message, "error"));
  });
  stopBtn.addEventListener("click", () => teardown("hung up"));

  fetch("/health")
    .then((r) => r.json())
    .then((h) => ($("server-info").textContent = "ok, uptime " + h.uptime_s + "s"))
    .catch(() => ($("server-info").textContent = "unreachable"));

  loadFixtures();
})();
