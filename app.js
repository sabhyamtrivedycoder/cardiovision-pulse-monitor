/**
 * CardioVision - Main Application
 * Connects Optical ROI Capture, DSP Filter, Oscilloscope Canvas, and Telemetry.
 * Author: Sabhyam Trivedy (https://github.com/sabhyamtrivedycoder)
 */

document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('inputVideo');
  const oscCanvas = document.getElementById('oscilloscopeCanvas');
  const oscCtx = oscCanvas.getContext('2d');
  const spectrumCanvas = document.getElementById('spectrumCanvas');
  const specCtx = spectrumCanvas ? spectrumCanvas.getContext('2d') : null;
  const roiCanvas = document.getElementById('roiCanvas');
  const roiCtx = roiCanvas.getContext('2d');

  // UI Elements
  const startCamBtn = document.getElementById('startCamBtn');
  const simDemoBtn = document.getElementById('simDemoBtn');
  const startOverlay = document.getElementById('startOverlay');
  const bpmDisplay = document.getElementById('bpmDisplay');
  const hrvDisplay = document.getElementById('hrvDisplay');
  const respDisplay = document.getElementById('respDisplay');
  const snrDisplay = document.getElementById('snrDisplay');
  const pulseIcon = document.getElementById('pulseIcon');
  const modeSelect = document.getElementById('modeSelect');
  const audioBeepBtn = document.getElementById('audioBeepBtn');
  const exportBtn = document.getElementById('exportBtn');
  const resetBtn = document.getElementById('resetBtn');

  const engine = new DspEngine(30);

  let isRunning = false;
  let isSimulating = false;
  let audioBeepEnabled = true;
  let simTime = 0;
  let simAnimId = null;
  let audioCtx = null;
  let mode = 'face'; // 'face' or 'finger'

  // Initialize Web Audio API for cardiac pulse beep
  function playHeartbeatBeep() {
    if (!audioBeepEnabled) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(140, audioCtx.currentTime); // Low resonant cardiac thump
      osc.frequency.exponentialRampToValueAtTime(40, audioCtx.currentTime + 0.08);

      gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);

      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.09);
    } catch (e) {
      // Audio autoplay policy
    }
  }

  // Draw Medical Oscilloscope Trace
  function drawOscilloscope() {
    const w = oscCanvas.width = oscCanvas.clientWidth || 600;
    const h = oscCanvas.height = oscCanvas.clientHeight || 200;

    // Dark grid background
    oscCtx.fillStyle = '#050a14';
    oscCtx.fillRect(0, 0, w, h);

    // Grid lines (ECG style)
    oscCtx.strokeStyle = 'rgba(16, 185, 129, 0.08)';
    oscCtx.lineWidth = 1;
    for (let x = 0; x < w; x += 25) {
      oscCtx.beginPath();
      oscCtx.moveTo(x, 0);
      oscCtx.lineTo(x, h);
      oscCtx.stroke();
    }
    for (let y = 0; y < h; y += 25) {
      oscCtx.beginPath();
      oscCtx.moveTo(0, y);
      oscCtx.lineTo(w, y);
      oscCtx.stroke();
    }

    const buffer = engine.filteredBuffer;
    if (buffer.length < 2) return;

    // Normalize signal to fit canvas height
    let max = 0.01;
    for (let i = 0; i < buffer.length; i++) {
      if (Math.abs(buffer[i]) > max) max = Math.abs(buffer[i]);
    }
    const scale = (h * 0.4) / max;
    const midY = h / 2;
    const step = w / (engine.bufferSize || 256);

    // Draw glowing PPG trace
    oscCtx.strokeStyle = '#10b981'; // Medical Emerald
    oscCtx.shadowColor = '#059669';
    oscCtx.shadowBlur = 10;
    oscCtx.lineWidth = 2.5;
    oscCtx.beginPath();

    const startX = w - (buffer.length * step);
    for (let i = 0; i < buffer.length; i++) {
      const x = startX + i * step;
      const y = midY - buffer[i] * scale;
      if (i === 0) oscCtx.moveTo(x, y);
      else oscCtx.lineTo(x, y);
    }
    oscCtx.stroke();
    oscCtx.shadowBlur = 0;

    // Draw scanning cursor on the leading edge
    const leadX = w - step;
    const leadY = midY - buffer[buffer.length - 1] * scale;
    oscCtx.fillStyle = '#38bdf8';
    oscCtx.beginPath();
    oscCtx.arc(leadX, leadY, 4, 0, 2 * Math.PI);
    oscCtx.fill();
  }

  // Draw Spectral Power Frequency Bars
  function drawSpectrum() {
    if (!specCtx || !spectrumCanvas) return;
    const w = spectrumCanvas.width = spectrumCanvas.clientWidth || 300;
    const h = spectrumCanvas.height = spectrumCanvas.clientHeight || 100;

    specCtx.fillStyle = '#090d16';
    specCtx.fillRect(0, 0, w, h);

    const spectrum = engine.computePowerSpectrum();
    if (spectrum.length === 0) return;

    const maxPower = Math.max(...spectrum.map(s => s.power), 0.001);
    const barWidth = w / spectrum.length;

    spectrum.forEach((bin, idx) => {
      const barHeight = (bin.power / maxPower) * (h - 15);
      const isDominant = Math.abs(bin.bpm - engine.bpm) < 6;
      specCtx.fillStyle = isDominant ? '#38bdf8' : 'rgba(56, 189, 248, 0.35)';
      specCtx.fillRect(idx * barWidth, h - barHeight, barWidth - 1, barHeight);
    });
  }

  // Update UI telemetry badges
  function updateTelemetry(res) {
    bpmDisplay.innerText = res.bpm > 0 ? res.bpm : '--';
    hrvDisplay.innerText = res.hrv > 0 ? `${res.hrv} ms` : '--';
    respDisplay.innerText = res.respirationRate > 0 ? `${res.respirationRate} brpm` : '--';
    snrDisplay.innerText = `${res.snr} dB`;

    if (res.isPulseDetected) {
      pulseIcon.classList.add('scale-125', 'text-rose-500');
      setTimeout(() => pulseIcon.classList.remove('scale-125', 'text-rose-500'), 180);
      playHeartbeatBeep();
    }
  }

  // Extract Green Channel from Camera Frame
  function processVideoFrame() {
    if (!isRunning || isSimulating) return;

    if (video.readyState >= 2) {
      const vw = video.videoWidth || 640;
      const vh = video.videoHeight || 480;

      roiCanvas.width = 100;
      roiCanvas.height = 100;

      // Determine Region of Interest (ROI)
      let sx, sy, sw, sh;
      if (mode === 'face') {
        // Forehead / Upper central face ROI
        sx = Math.floor(vw * 0.40);
        sy = Math.floor(vh * 0.22);
        sw = Math.floor(vw * 0.20);
        sh = Math.floor(vh * 0.16);
      } else {
        // Fingertip center square
        sx = Math.floor(vw * 0.35);
        sy = Math.floor(vh * 0.35);
        sw = Math.floor(vw * 0.30);
        sh = Math.floor(vh * 0.30);
      }

      // Draw ROI onto small buffer canvas
      roiCtx.drawImage(video, sx, sy, sw, sh, 0, 0, 100, 100);
      const imgData = roiCtx.getImageData(0, 0, 100, 100);
      const data = imgData.data;

      // Extract average green channel intensity
      let totalGreen = 0;
      const pixelCount = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        totalGreen += data[i + 1]; // Green index
      }
      const avgGreen = totalGreen / pixelCount;

      // Send to DSP engine
      const res = engine.pushSample(avgGreen, Date.now());
      drawOscilloscope();
      drawSpectrum();
      updateTelemetry(res);
    }

    requestAnimationFrame(processVideoFrame);
  }

  // Simulation Loop for Camera-free demonstration & automated verification
  function runSimulationLoop() {
    if (!isSimulating) return;

    simTime += 0.033; // 30 fps
    // Target 74 BPM with realistic respiratory modulation
    const syntheticVal = DspEngine.generateSyntheticPPG(simTime, 74);
    const res = engine.pushSample(syntheticVal, Date.now());

    drawOscilloscope();
    drawSpectrum();
    updateTelemetry(res);

    simAnimId = requestAnimationFrame(runSimulationLoop);
  }

  // Start Simulation Demo
  simDemoBtn.addEventListener('click', () => {
    stopCamera();
    isSimulating = true;
    startOverlay.classList.add('hidden');
    cancelAnimationFrame(simAnimId);
    runSimulationLoop();
  });

  // Start Live Camera
  async function startCamera() {
    try {
      if (isSimulating) {
        isSimulating = false;
        cancelAnimationFrame(simAnimId);
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
      isRunning = true;
      startOverlay.classList.add('hidden');
      processVideoFrame();
    } catch (err) {
      console.error('Camera stream error:', err);
      alert('Could not access camera. Switching to Synthetic Pulse Simulation mode!');
      simDemoBtn.click();
    }
  }

  function stopCamera() {
    isRunning = false;
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(track => track.stop());
      video.srcObject = null;
    }
  }

  startCamBtn.addEventListener('click', startCamera);

  // Mode Selection
  modeSelect.addEventListener('change', (e) => {
    mode = e.target.value;
    engine.reset();
  });

  // Audio Beep Toggle
  audioBeepBtn.addEventListener('click', () => {
    audioBeepEnabled = !audioBeepEnabled;
    audioBeepBtn.innerHTML = audioBeepEnabled ? '🔊 Audio Beep: ON' : '🔇 Audio Beep: OFF';
    audioBeepBtn.classList.toggle('text-emerald-400', audioBeepEnabled);
  });

  // Reset Engine
  resetBtn.addEventListener('click', () => {
    engine.reset();
    bpmDisplay.innerText = '--';
    hrvDisplay.innerText = '--';
    respDisplay.innerText = '--';
    snrDisplay.innerText = '0 dB';
  });

  // Export CSV
  exportBtn.addEventListener('click', () => {
    const data = [
      ['Timestamp (ms)', 'Raw Optical Green', 'Bandpass Filtered'],
      ...engine.timestamps.map((t, idx) => [t, engine.rawBuffer[idx] || 0, engine.filteredBuffer[idx] || 0])
    ];
    const csvContent = 'data:text/csv;charset=utf-8,' + data.map(e => e.join(',')).join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `cardiovision-ppg-${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });
});
