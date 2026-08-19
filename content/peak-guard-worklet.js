/**
 * Peak-guard AudioWorklet - lookahead brick-wall attenuator.
 * Only reduces gain (never boosts). Linked stereo: one gain for all channels.
 */
class PeakGuardProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lookahead = Math.max(32, Math.ceil(sampleRate * 0.008));
    this.rings = [];
    this.writePos = [];
    this.gain = 1.0;
    this.ceilingLin = Math.pow(10, -10 / 20);
    this.enabled = false;
    this.frameCount = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d || d.type !== "config") return;
      if (typeof d.ceilingDb === "number") {
        const c = Math.max(-30, Math.min(0, d.ceilingDb));
        this.ceilingLin = Math.pow(10, c / 20);
      }
      if (typeof d.enabled === "boolean") this.enabled = d.enabled;
    };
  }

  _ring(ch) {
    while (this.rings.length <= ch) {
      this.rings.push(new Float32Array(this.lookahead));
      this.writePos.push(0);
    }
    return this.rings[ch];
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input?.length || !output?.length) return true;

    const L = this.lookahead;
    const n = input[0]?.length ?? 0;

    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < input.length; ch++) {
        const inCh = input[ch];
        if (!inCh) continue;
        const ring = this._ring(ch);
        ring[this.writePos[ch]] = inCh[i];
      }

      // Only scan the lookahead ring for the peak when the limiter is ENABLED -
      // otherwise targetGain stays 1.0 and this O(lookahead) per-sample scan is pure
      // waste (it previously ran unconditionally, every output sample - F1 audio perf).
      let targetGain = 1.0;
      if (this.enabled) {
        let peak = 0;
        for (let ch = 0; ch < this.rings.length; ch++) {
          const ring = this.rings[ch];
          for (let k = 0; k < L; k++) {
            const v = ring[k];
            const a = v < 0 ? -v : v;
            if (a > peak) peak = a;
          }
        }
        if (peak > 1e-8) targetGain = Math.min(1.0, this.ceilingLin / peak);
      }

      if (targetGain < this.gain) {
        this.gain += (targetGain - this.gain) * 0.18;
      } else {
        this.gain += (targetGain - this.gain) * 0.003;
      }

      for (let ch = 0; ch < output.length; ch++) {
        const outCh = output[ch];
        const ring = this._ring(ch);
        const wp = this.writePos[ch];
        const rp = (wp + 1) % L;
        outCh[i] = ring[rp] * this.gain;
        this.writePos[ch] = (wp + 1) % L;
      }

    }

    this.frameCount += n;
    if (this.frameCount >= 512) {
      this.frameCount = 0;
      const db = this.gain < 0.999 ? 20 * Math.log10(this.gain) : 0;
      this.port.postMessage({
        type: "reduction",
        db,
      });
    }
    return true;
  }
}

registerProcessor("yoho-peak-guard", PeakGuardProcessor);
