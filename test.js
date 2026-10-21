/**
 * CardioVision Unit Tests
 * Rigorous verification of DSP Engine: filtering, rPPG peak detection, BPM, HRV, FFT spectrum.
 * Author: Sabhyam Trivedy
 */

const assert = require('assert');
const DspEngine = require('./dsp-engine');

console.log('🧪 Starting CardioVision DSP Engine Unit Tests...\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     Error: ${err.message}`);
    process.exitCode = 1;
  }
}

// 1. Initialization and Default State
runTest('DspEngine initializes with proper default buffer sizes and sample rate', () => {
  const dsp = new DspEngine(30);
  assert.strictEqual(dsp.sampleRate, 30);
  assert.strictEqual(dsp.bufferSize, 256);
  assert.strictEqual(dsp.bpm, 0);
  assert.strictEqual(dsp.hrv, 0);
  assert.strictEqual(dsp.isPulseDetected, false);
  assert.strictEqual(dsp.rawBuffer.length, 0);
  assert.strictEqual(dsp.filteredBuffer.length, 0);
  assert.strictEqual(dsp.b.length, 3);
  assert.strictEqual(dsp.a.length, 3);
});

// 2. Reset Functionality
runTest('DspEngine.reset clears buffers and state cleanly', () => {
  const dsp = new DspEngine(30);
  for (let i = 0; i < 50; i++) {
    dsp.pushSample(128 + Math.sin(i * 0.2) * 10, i * 33.3);
  }
  assert(dsp.rawBuffer.length > 0);
  assert(dsp.filteredBuffer.length > 0);
  
  dsp.reset();
  assert.strictEqual(dsp.rawBuffer.length, 0);
  assert.strictEqual(dsp.filteredBuffer.length, 0);
  assert.strictEqual(dsp.bpm, 0);
  assert.strictEqual(dsp.hrv, 0);
  assert.strictEqual(dsp.snr, 0);
  assert.strictEqual(dsp.isPulseDetected, false);
});

// 3. Synthetic PPG Wave Generator
runTest('DspEngine.generateSyntheticPPG creates valid physiological waveform', () => {
  const sample1 = DspEngine.generateSyntheticPPG(0.0, 72);
  const samplePeak = DspEngine.generateSyntheticPPG((60 / 72) * 0.2, 72);
  const sampleTrough = DspEngine.generateSyntheticPPG((60 / 72) * 0.7, 72);
  
  assert(typeof sample1 === 'number');
  assert(!isNaN(sample1));
  assert(samplePeak > sampleTrough, `Expected peak (${samplePeak}) > trough (${sampleTrough})`);
  // Value should be around 100-250 range
  assert(samplePeak >= 128, `Peak value should be above baseline 128, got ${samplePeak}`);
});

// 4. Bandpass Filtering & DC Rejection
runTest('Bandpass filter attenuates constant DC offset', () => {
  const dsp = new DspEngine(30);
  // Feed 100 samples of constant DC offset = 180.0
  let lastFiltered = 0;
  for (let i = 0; i < 100; i++) {
    const res = dsp.pushSample(180, i * 33.33);
    lastFiltered = res.filtered;
  }
  // After detrending and high-pass rejection, steady-state DC output should be near 0
  assert(Math.abs(lastFiltered) < 1.0, `DC offset should be filtered near 0, got ${lastFiltered}`);
});

// 5. Heart Rate (BPM) Calculation under Synthetic 72 BPM Signal
runTest('Detects heart rate accurately for synthetic 72 BPM cardiac signal', () => {
  const dsp = new DspEngine(30);
  const targetBpm = 72;
  const fps = 30;
  const durationSeconds = 12; // 12 seconds
  const totalFrames = durationSeconds * fps;
  let pulseDetectionCount = 0;

  for (let frame = 0; frame < totalFrames; frame++) {
    const t = frame / fps;
    const sample = DspEngine.generateSyntheticPPG(t, targetBpm);
    const result = dsp.pushSample(sample, frame * (1000 / fps));
    if (result.isPulseDetected) {
      pulseDetectionCount++;
    }
  }

  // 12 seconds at 72 bpm = 12 * (72 / 60) = 14.4 beats
  assert(pulseDetectionCount >= 9 && pulseDetectionCount <= 18, 
    `Expected between 9 and 18 detected pulses, got ${pulseDetectionCount}`);

  // Final calculated BPM should be within +/- 6 BPM of target 72
  assert(Math.abs(dsp.bpm - targetBpm) <= 6, 
    `Calculated BPM ${dsp.bpm} should be close to target 72 BPM`);
});

// 6. Heart Rate (BPM) Calculation under Synthetic 90 BPM Signal
runTest('Detects elevated heart rate for 90 BPM signal', () => {
  const dsp = new DspEngine(30);
  const targetBpm = 90;
  const fps = 30;
  const durationSeconds = 12;
  const totalFrames = durationSeconds * fps;

  for (let frame = 0; frame < totalFrames; frame++) {
    const t = frame / fps;
    const sample = DspEngine.generateSyntheticPPG(t, targetBpm);
    dsp.pushSample(sample, frame * (1000 / fps));
  }

  assert(Math.abs(dsp.bpm - targetBpm) <= 7, 
    `Calculated BPM ${dsp.bpm} should be close to target 90 BPM`);
});

// 7. HRV (Heart Rate Variability - RMSSD) Calculation
runTest('Calculates RMSSD HRV when IBIs are collected', () => {
  const dsp = new DspEngine(30);
  // Simulate synthetic signal with slight physiological arrhythmia
  const fps = 30;
  let t = 0;
  let simulatedTimestamp = 0;
  for (let frame = 0; frame < 360; frame++) {
    t = frame / fps;
    simulatedTimestamp = frame * 33.33;
    const sample = DspEngine.generateSyntheticPPG(t, 75);
    dsp.pushSample(sample, simulatedTimestamp);
  }

  assert(dsp.ibiList.length >= 3, `Expected at least 3 IBIs, got ${dsp.ibiList.length}`);
  assert(typeof dsp.hrv === 'number', 'HRV should be a number');
  assert(dsp.hrv >= 0, `HRV should be non-negative, got ${dsp.hrv}`);
});

// 8. FFT Power Spectrum Estimation
runTest('Power spectrum computation returns valid frequency bins', () => {
  const dsp = new DspEngine(30);
  const fps = 30;
  for (let frame = 0; frame < 90; frame++) {
    const t = frame / fps;
    const sample = DspEngine.generateSyntheticPPG(t, 72);
    dsp.pushSample(sample, frame * 33.33);
  }

  const spectrum = dsp.computePowerSpectrum();
  assert(Array.isArray(spectrum), 'Spectrum should be an array');
  assert.strictEqual(spectrum.length, 32, 'Spectrum should contain 32 frequency bins');
  
  // Find peak frequency
  let maxPower = -1;
  let peakFreq = 0;
  let peakBpm = 0;
  for (const bin of spectrum) {
    assert(bin.freq > 0 && bin.power >= 0);
    if (bin.power > maxPower) {
      maxPower = bin.power;
      peakFreq = bin.freq;
      peakBpm = bin.bpm;
    }
  }

  // 72 BPM is 1.2 Hz. Peak in spectrum should be between 0.9 and 1.5 Hz (~54 - 90 BPM)
  assert(peakBpm >= 50 && peakBpm <= 95, 
    `Spectral peak BPM (${peakBpm}) should be around 72 BPM`);
});

// 9. SNR (Signal to Noise Ratio) Estimation
runTest('Signal to noise ratio produces realistic decibel values', () => {
  const dsp = new DspEngine(30);
  const fps = 30;
  for (let frame = 0; frame < 100; frame++) {
    const t = frame / fps;
    const sample = DspEngine.generateSyntheticPPG(t, 70);
    dsp.pushSample(sample, frame * 33.33);
  }

  assert(dsp.snr >= 5 && dsp.snr <= 25, `Expected SNR between 5 and 25 dB, got ${dsp.snr}`);
});

// 10. Buffer Overflow & Rolling Window Clamping
runTest('Rolling buffers maintain bufferSize limit without unbounded memory growth', () => {
  const dsp = new DspEngine(30);
  for (let i = 0; i < 500; i++) {
    dsp.pushSample(120 + (i % 10), i * 33.33);
  }
  assert.strictEqual(dsp.rawBuffer.length, dsp.bufferSize, 
    `rawBuffer length should cap at ${dsp.bufferSize}`);
  assert.strictEqual(dsp.filteredBuffer.length, dsp.bufferSize, 
    `filteredBuffer length should cap at ${dsp.bufferSize}`);
});

console.log(`\n========================================`);
console.log(`CardioVision DSP Test Suite Summary:`);
console.log(`Passed: ${passedTests} / ${totalTests}`);
console.log(`========================================\n`);

if (passedTests === totalTests) {
  console.log('🎉 All CardioVision DSP unit tests passed successfully!\n');
} else {
  console.error('❌ Some tests failed.');
  process.exit(1);
}
