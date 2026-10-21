/**
 * CardioVision DSP Engine
 * Optical Photoplethysmography (rPPG) Digital Signal Processing & Heart Rate Metrics.
 * Author: Sabhyam Trivedy (https://github.com/sabhyamtrivedycoder)
 */

class BiquadFilter {
  constructor(b, a) {
    this.b = b;
    this.a = a;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  process(x) {
    const y = this.b[0] * x + this.b[1] * this.x1 + this.b[2] * this.x2 - this.a[1] * this.y1 - this.a[2] * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset() {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }
}

class DspEngine {
  constructor(sampleRate = 30) {
    this.sampleRate = sampleRate; // Hz (typical webcam frame rate)
    this.bufferSize = 256;        // ~8.5 seconds of data at 30fps
    this.rawBuffer = [];
    this.filteredBuffer = [];
    this.timestamps = [];
    this.peaks = [];              // Indices of detected peaks
    this.ibiList = [];            // Inter-beat intervals in ms
    
    // Telemetry state
    this.bpm = 0;
    this.hrv = 0;                 // RMSSD in ms
    this.respirationRate = 0;    // Breaths per min
    this.snr = 0;                 // Signal to noise ratio (dB)
    this.isPulseDetected = false;
    this.lastPeakTime = 0;

    // Bandpass filter via cascaded 2nd-order Butterworth biquad sections
    // Low-pass: 3.0 Hz (180 BPM cutoff)
    // High-pass: 0.7 Hz (42 BPM cutoff)
    this.initFilter();
  }

  initFilter() {
    this.lpFilter = this.createBiquadLP(3.0, this.sampleRate);
    this.hpFilter = this.createBiquadHP(0.7, this.sampleRate);
    // Expose coefficients for introspection / unit tests
    this.b = this.lpFilter.b;
    this.a = this.lpFilter.a;
  }

  createBiquadLP(f0, fs) {
    const w0 = 2 * Math.PI * f0 / fs;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cosw0 = Math.cos(w0);
    const b0 = (1 - cosw0) / 2;
    const b1 = 1 - cosw0;
    const b2 = (1 - cosw0) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cosw0;
    const a2 = 1 - alpha;
    return new BiquadFilter([b0 / a0, b1 / a0, b2 / a0], [1, a1 / a0, a2 / a0]);
  }

  createBiquadHP(f0, fs) {
    const w0 = 2 * Math.PI * f0 / fs;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cosw0 = Math.cos(w0);
    const b0 = (1 + cosw0) / 2;
    const b1 = -(1 + cosw0);
    const b2 = (1 + cosw0) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cosw0;
    const a2 = 1 - alpha;
    return new BiquadFilter([b0 / a0, b1 / a0, b2 / a0], [1, a1 / a0, a2 / a0]);
  }

  reset() {
    this.rawBuffer = [];
    this.filteredBuffer = [];
    this.timestamps = [];
    this.peaks = [];
    this.ibiList = [];
    this.bpm = 0;
    this.hrv = 0;
    this.respirationRate = 0;
    this.snr = 0;
    this.isPulseDetected = false;
    this.lastPeakTime = 0;
    if (this.lpFilter) this.lpFilter.reset();
    if (this.hpFilter) this.hpFilter.reset();
  }

  /**
   * Apply cascaded bandpass filtering (High-pass -> Low-pass)
   */
  filterSample(sample) {
    const hp = this.hpFilter.process(sample);
    return this.lpFilter.process(hp);
  }

  /**
   * Push raw optical green-channel intensity sample and time
   * @param {number} greenVal - Average green intensity from ROI
   * @param {number} timestamp - Milliseconds timestamp
   */
  pushSample(greenVal, timestamp = Date.now()) {
    this.rawBuffer.push(greenVal);
    this.timestamps.push(timestamp);

    if (this.rawBuffer.length > this.bufferSize) {
      this.rawBuffer.shift();
      this.timestamps.shift();
    }

    // Baseline detrending: subtract moving average of last 15 samples (~0.5s)
    const windowSize = Math.min(15, this.rawBuffer.length);
    let sum = 0;
    for (let i = this.rawBuffer.length - windowSize; i < this.rawBuffer.length; i++) {
      sum += this.rawBuffer[i];
    }
    const detrended = greenVal - (sum / windowSize);

    // Apply digital bandpass filter
    const filtered = this.filterSample(detrended);
    this.filteredBuffer.push(filtered);
    if (this.filteredBuffer.length > this.bufferSize) {
      this.filteredBuffer.shift();
    }

    // Run peak detection if buffer has enough historical data
    this.isPulseDetected = false;
    if (this.filteredBuffer.length >= 30) {
      this.detectPeaks(timestamp);
    }

    return {
      filtered,
      bpm: this.bpm,
      hrv: this.hrv,
      respirationRate: this.respirationRate,
      snr: this.snr,
      isPulseDetected: this.isPulseDetected
    };
  }

  /**
   * Adaptive threshold peak detection with physiological refractory period
   */
  detectPeaks(timestamp) {
    const len = this.filteredBuffer.length;
    const curr = this.filteredBuffer[len - 2];     // Check point just before latest for local maximum
    const prev = this.filteredBuffer[len - 3];
    const next = this.filteredBuffer[len - 1];

    // Compute dynamic standard deviation & mean of recent window
    const recent = this.filteredBuffer.slice(-60);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
    const std = Math.sqrt(variance);

    // Adaptive peak threshold: must be above mean + 0.45 * std
    const threshold = mean + 0.45 * std;

    // Check if point is local maximum and above threshold
    if (curr > prev && curr > next && curr > threshold) {
      // Dynamic refractory period: ~60% of expected cycle length, min 320ms (max 187 bpm)
      const minIntervalMs = this.bpm > 0 ? Math.max(320, Math.floor((60000 / this.bpm) * 0.6)) : 380;
      const timeSinceLastPeak = timestamp - this.lastPeakTime;

      if (this.lastPeakTime === 0 || timeSinceLastPeak > minIntervalMs) {
        this.lastPeakTime = timestamp;
        this.isPulseDetected = true;

        if (timeSinceLastPeak > 300 && timeSinceLastPeak < 1800) { // Valid IBI (< 1.8s -> > 33 BPM)
          this.ibiList.push(timeSinceLastPeak);
          if (this.ibiList.length > 20) this.ibiList.shift();

          this.calculateMetrics();
        }
      }
    }
  }

  calculateMetrics() {
    if (this.ibiList.length < 3) return;

    // Median IBI to filter out any ectopic/false spikes
    const sorted = [...this.ibiList].sort((a, b) => a - b);
    const medianIbi = sorted[Math.floor(sorted.length / 2)];
    
    // Heart Rate in BPM
    const calculatedBpm = Math.round(60000 / medianIbi);
    if (calculatedBpm >= 45 && calculatedBpm <= 190) {
      // Exponential moving average for smooth display
      this.bpm = this.bpm === 0 ? calculatedBpm : Math.round(this.bpm * 0.7 + calculatedBpm * 0.3);
    }

    // Heart Rate Variability: RMSSD (Root Mean Square of Successive Differences)
    if (this.ibiList.length >= 4) {
      let sumSqDiff = 0;
      for (let i = 0; i < this.ibiList.length - 1; i++) {
        const diff = this.ibiList[i + 1] - this.ibiList[i];
        sumSqDiff += diff * diff;
      }
      this.hrv = Math.round(Math.sqrt(sumSqDiff / (this.ibiList.length - 1)));
    }

    // Estimate Respiration Rate (breaths per min) from low-frequency baseline oscillation
    if (this.rawBuffer.length >= 90) {
      let baselineOscillations = 0;
      const recentRaw = this.rawBuffer.slice(-90);
      const rawMean = recentRaw.reduce((a, b) => a + b, 0) / recentRaw.length;
      for (let i = 1; i < recentRaw.length; i++) {
        if ((recentRaw[i - 1] < rawMean && recentRaw[i] >= rawMean)) {
          baselineOscillations++;
        }
      }
      const estimatedBrpm = Math.max(10, Math.min(26, Math.round(baselineOscillations * 15)));
      this.respirationRate = this.respirationRate === 0 ? estimatedBrpm : Math.round(this.respirationRate * 0.8 + estimatedBrpm * 0.2);
    }

    // Signal-to-Noise Ratio (SNR) in dB
    const recentFiltered = this.filteredBuffer.slice(-60);
    const signalPower = recentFiltered.reduce((acc, v) => acc + v * v, 0) / recentFiltered.length;
    this.snr = Math.min(25, Math.max(5, Math.round(10 * Math.log10(signalPower * 1000 + 1))));
  }

  /**
   * Fast Fourier Transform (FFT) power spectral density with Hanning window
   * Computes magnitude array across 0.6 Hz to 3.2 Hz
   */
  computePowerSpectrum() {
    if (this.filteredBuffer.length < 64) return [];
    const N = 64;
    const signal = this.filteredBuffer.slice(-N);
    const spectrum = [];
    const minFreq = 0.6; // 36 BPM
    const maxFreq = 3.2; // 192 BPM
    const numBins = 32;

    for (let k = 0; k < numBins; k++) {
      const f = minFreq + (k / numBins) * (maxFreq - minFreq);
      let real = 0;
      let imag = 0;
      for (let n = 0; n < N; n++) {
        // Hanning windowing to suppress spectral leakage
        const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
        const angle = (2 * Math.PI * f * n) / this.sampleRate;
        real += signal[n] * w * Math.cos(angle);
        imag -= signal[n] * w * Math.sin(angle);
      }
      const power = Math.sqrt(real * real + imag * imag);
      spectrum.push({ freq: f, bpm: Math.round(f * 60), power });
    }
    return spectrum;
  }

  /**
   * Synthetic Cardiovascular Pulse Generator
   * Double-Gaussian cardiac pressure wave model with dicrotic notch
   * @param {number} t - time in seconds
   * @param {number} targetBpm - default 72
   */
  static generateSyntheticPPG(t, targetBpm = 72) {
    const period = 60 / targetBpm;
    const tau = (t % period) / period; // 0 to 1 cycle
    
    // Primary systolic peak at tau = 0.2
    const systolic = Math.exp(-Math.pow((tau - 0.2) / 0.08, 2));
    // Dicrotic notch and secondary reflective peak at tau = 0.42
    const dicrotic = 0.35 * Math.exp(-Math.pow((tau - 0.42) / 0.09, 2));
    // Minor respiratory sinus modulation
    const respModulation = 0.05 * Math.sin(2 * Math.PI * 0.25 * t);
    // Baseline noise
    const noise = (Math.random() - 0.5) * 0.02;

    return (systolic + dicrotic + respModulation + noise) * 100 + 128;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DspEngine;
}
