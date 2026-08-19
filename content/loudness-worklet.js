/**
 * Loudness measurement worklet - ITU-R BS.1770 K-weighting (real-time)
 *
 * Runs on the audio rendering thread, so it costs the page's main thread (and the
 * video player) nothing. It taps the program audio BEFORE our AGC gain, computes
 * K-weighted loudness over sliding windows and posts measurements to the main
 * thread ~20 Hz:
 *
 *   { type: "loudness", momentary: <LUFS 400 ms>, shortTerm: <LUFS 3 s> }
 *
 * The pure DSP helpers are `export`ed so they can be unit-tested in Node (the
 * processor registration is guarded and never runs outside an AudioWorklet).
 *
 * Reference implementations: lcweden/loudness-worklet, dsh0416/loudness_dd,
 * and the pyloudnorm filter design (both MIT).
 */

/** BS.1770 mean-square → loudness offset. */
export const LKFS_OFFSET = -0.691;

/**
 * K-weighting biquad coefficients for the given sample rate (bilinear transform).
 * Stage 1: high-shelf (~+4 dB above ~1.5 kHz). Stage 2: RLB high-pass (~38 Hz).
 * Returns normalised coefficients with a0 == 1 (b0,b1,b2,a1,a2 per stage).
 */
export function kWeightingCoeffs(fs) {
  // Stage 1 - high shelf
  const f0s = 1681.974450955533;
  const Gs = 3.999843853973347;
  const Qs = 0.7071752369554196;
  const Ks = Math.tan((Math.PI * f0s) / fs);
  const Vh = Math.pow(10, Gs / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const s_a0 = 1 + Ks / Qs + Ks * Ks;
  const shelf = {
    b0: (Vh + (Vb * Ks) / Qs + Ks * Ks) / s_a0,
    b1: (2 * (Ks * Ks - Vh)) / s_a0,
    b2: (Vh - (Vb * Ks) / Qs + Ks * Ks) / s_a0,
    a1: (2 * (Ks * Ks - 1)) / s_a0,
    a2: (1 - Ks / Qs + Ks * Ks) / s_a0,
  };

  // Stage 2 - high pass (RLB)
  const f0h = 38.13547087602444;
  const Qh = 0.5003270373238773;
  const Kh = Math.tan((Math.PI * f0h) / fs);
  const h_a0 = 1 + Kh / Qh + Kh * Kh;
  const hp = {
    b0: 1 / h_a0,
    b1: -2 / h_a0,
    b2: 1 / h_a0,
    a1: (2 * (Kh * Kh - 1)) / h_a0,
    a2: (1 - Kh / Qh + Kh * Kh) / h_a0,
  };

  return { shelf, hp };
}

/** Per-channel biquad filter state (two cascaded stages). */
export function createKWeightingState() {
  return { x1: 0, x2: 0, y1: 0, y2: 0, z1: 0, z2: 0, w1: 0, w2: 0 };
}

/**
 * Apply both K-weighting stages to one sample. Mutates `st` and returns the
 * weighted sample. (Direct-Form-I biquads.)
 */
export function processKWeighted(c, st, x) {
  // Stage 1 - high shelf
  const y =
    c.shelf.b0 * x + c.shelf.b1 * st.x1 + c.shelf.b2 * st.x2 -
    c.shelf.a1 * st.y1 - c.shelf.a2 * st.y2;
  st.x2 = st.x1; st.x1 = x;
  st.y2 = st.y1; st.y1 = y;

  // Stage 2 - high pass
  const w =
    c.hp.b0 * y + c.hp.b1 * st.z1 + c.hp.b2 * st.z2 -
    c.hp.a1 * st.w1 - c.hp.a2 * st.w2;
  st.z2 = st.z1; st.z1 = y;
  st.w2 = st.w1; st.w1 = w;

  return w;
}

/** Mean square of K-weighted channels → loudness (LUFS/LKFS). */
export function loudnessFromMeanSquare(sumMeanSquare) {
  if (sumMeanSquare <= 0) return -Infinity;
  return LKFS_OFFSET + 10 * Math.log10(sumMeanSquare);
}

// ── Processor registration (audio thread only) ──────────────────────────────
if (typeof registerProcessor === "function" && typeof AudioWorkletProcessor !== "undefined") {
  const SUB_BLOCK_MS = 50;                 // accumulation granularity
  const MOMENTARY_SUB = 8;                 // 8 × 50 ms = 400 ms
  const SHORT_TERM_SUB = 60;               // 60 × 50 ms = 3 s
  const POST_EVERY_SUB = 2;                // post ~10 Hz

  class LoudnessProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.coeffs = kWeightingCoeffs(sampleRate);
      this.states = [];                    // per-channel filter state
      this.subSamples = Math.max(1, Math.round((sampleRate * SUB_BLOCK_MS) / 1000));
      this.curSumSq = 0;                   // Σ weighted² across channels in current sub-block
      this.curCount = 0;                   // sample frames in current sub-block
      this.ring = new Float64Array(SHORT_TERM_SUB); // mean-square per sub-block
      this.ringPos = 0;
      this.ringFilled = 0;
      this.postCounter = 0;
    }

    _ensureStates(n) {
      while (this.states.length < n) this.states.push(createKWeightingState());
    }

    _pushSubBlock() {
      const ms = this.curCount > 0 ? this.curSumSq / this.curCount : 0;
      this.ring[this.ringPos] = ms;
      this.ringPos = (this.ringPos + 1) % SHORT_TERM_SUB;
      if (this.ringFilled < SHORT_TERM_SUB) this.ringFilled++;
      this.curSumSq = 0;
      this.curCount = 0;

      if (++this.postCounter >= POST_EVERY_SUB) {
        this.postCounter = 0;
        this.port.postMessage({
          type: "loudness",
          momentary: this._windowLoudness(MOMENTARY_SUB),
          shortTerm: this._windowLoudness(SHORT_TERM_SUB),
        });
      }
    }

    _windowLoudness(subCount) {
      const n = Math.min(subCount, this.ringFilled);
      if (n === 0) return -Infinity;
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const idx = (this.ringPos - 1 - i + SHORT_TERM_SUB * 2) % SHORT_TERM_SUB;
        acc += this.ring[idx];
      }
      return loudnessFromMeanSquare(acc / n);
    }

    process(inputs) {
      const input = inputs[0];
      if (input && input.length > 0) {
        const chCount = input.length;
        this._ensureStates(chCount);
        const frames = input[0].length;
        for (let i = 0; i < frames; i++) {
          let sumSq = 0;
          for (let ch = 0; ch < chCount; ch++) {
            const data = input[ch];
            if (!data) continue;
            const w = processKWeighted(this.coeffs, this.states[ch], data[i]);
            sumSq += w * w;
          }
          this.curSumSq += sumSq;
          this.curCount++;
          if (this.curCount >= this.subSamples) this._pushSubBlock();
        }
      }
      return true; // keep alive even when source is momentarily silent
    }
  }

  registerProcessor("yoho-loudness", LoudnessProcessor);
}
