/* ═══════════════════════════════════════════════════
   Whisper STT — Setup Wizard & Settings Controller
   ═══════════════════════════════════════════════════ */

// ── Element References ──
const micBtn = document.getElementById('mic-btn');
const micStatus = document.getElementById('mic-status');
const step1Next = document.getElementById('step1-next');

const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const downloadPercent = document.getElementById('download-percent');
const downloadStatus = document.getElementById('download-status');
const step2Next = document.getElementById('step2-next');

const testMicBtn = document.getElementById('test-mic-btn');
const testResult = document.getElementById('test-result');
const testCanvas = document.getElementById('test-canvas');
const testStatus = document.getElementById('test-status');
const setupCompleteBadge = document.getElementById('setup-complete-badge');

const wasmToggle = document.getElementById('wasm-toggle');
const sensitivitySlider = document.getElementById('sensitivity-slider');
const sensitivityVal = document.getElementById('sensitivity-val');
const delaySlider = document.getElementById('delay-slider');
const delayVal = document.getElementById('delay-val');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');

// ── Wizard State ──
let currentStep = 1;
let micGranted = false;
let modelReady = false;
let testStream = null;
let testAudioCtx = null;
let testAnimId = null;

// ═══════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  checkExistingSetupState();
});

async function checkExistingSetupState() {
  // Check if setup was previously completed
  const data = await chrome.storage.local.get(['setupComplete', 'micPermissionGranted']);

  if (data.micPermissionGranted) {
    showMicGranted();
  } else {
    // Also try querying the permission directly
    await checkMicPermission();
  }

  if (data.setupComplete) {
    // Setup was already completed — show all steps as done, jump to settings
    showCompletedWizardState();
  }
}

// ═══════════════════════════════════════════════════
// STEP 1: MICROPHONE PERMISSION
// ═══════════════════════════════════════════════════
async function checkMicPermission() {
  try {
    const permissions = await navigator.permissions.query({ name: 'microphone' });
    if (permissions.state === 'granted') {
      showMicGranted();
    } else {
      permissions.onchange = () => {
        if (permissions.state === 'granted') {
          showMicGranted();
        }
      };
    }
  } catch (e) {
    // Fallback: try getUserMedia directly
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      showMicGranted();
    } catch (err) {
      console.warn('Microphone permission check deferred.');
    }
  }
}

function showMicGranted() {
  micGranted = true;
  micBtn.classList.add('hidden');
  micStatus.classList.remove('hidden');
  step1Next.disabled = false;
  chrome.storage.local.set({ micPermissionGranted: true });
}

micBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    showMicGranted();
  } catch (err) {
    console.error('Microphone request denied:', err);
    alert('Microphone access is required for Speech-to-Text. Please check your browser privacy settings.');
  }
});

step1Next.addEventListener('click', () => {
  if (micGranted) {
    goToStep(2);
    // Start model download as soon as user advances to step 2
    triggerModelDownload();
  }
});

// ═══════════════════════════════════════════════════
// STEP 2: MODEL DOWNLOAD
// ═══════════════════════════════════════════════════
function triggerModelDownload() {
  progressText.textContent = 'Initializing model download...';
  progressFill.classList.add('active');
  downloadPercent.textContent = '0%';

  // Ask background to spin up the offscreen document and start downloading
  chrome.runtime.sendMessage({
    target: 'background',
    type: 'PRECACHE_MODEL'
  });
}

function handleModelProgress(message) {
  if (message.status === 'downloading') {
    const percent = Math.round(message.progress || 0);
    progressFill.style.width = `${percent}%`;
    progressFill.classList.add('active');
    downloadPercent.textContent = `${percent}%`;
    progressText.textContent = `Downloading model files... ${percent}%`;
  } else if (message.status === 'loaded' || message.status === 'ready') {
    modelReady = true;
    progressFill.style.width = '100%';
    progressFill.classList.remove('active');
    progressFill.classList.add('complete');
    downloadPercent.textContent = '100%';
    progressText.textContent = 'Download complete — model cached locally';
    downloadStatus.classList.remove('hidden');
    step2Next.disabled = false;
  }
}

step2Next.addEventListener('click', () => {
  if (modelReady) {
    goToStep(3);
    markSetupComplete();
  }
});

// ═══════════════════════════════════════════════════
// STEP 3: READY & TEST MICROPHONE
// ═══════════════════════════════════════════════════
function markSetupComplete() {
  chrome.storage.local.set({ setupComplete: true });

  // Show completion badge after a short delay for dramatic effect
  setTimeout(() => {
    setupCompleteBadge.classList.remove('hidden');
  }, 600);
}

testMicBtn.addEventListener('click', () => {
  if (testStream) {
    stopMicTest();
  } else {
    startMicTest();
  }
});

async function startMicTest() {
  try {
    testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    testResult.classList.remove('hidden');
    testMicBtn.textContent = '⏹ Stop Test';

    testAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = testAudioCtx.createMediaStreamSource(testStream);
    const analyser = testAudioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const ctx = testCanvas.getContext('2d');

    function drawTestWave() {
      if (!testStream) return;
      testAnimId = requestAnimationFrame(drawTestWave);
      analyser.getByteFrequencyData(dataArray);

      const width = testCanvas.width;
      const height = testCanvas.height;
      ctx.clearRect(0, 0, width, height);

      // Calculate average level for status text
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
      const avg = sum / bufferLength;

      if (avg > 30) {
        testStatus.textContent = '🟢 Voice detected!';
        testStatus.className = 'test-status speaking';
      } else {
        testStatus.textContent = 'Listening — speak to test...';
        testStatus.className = 'test-status';
      }

      // Draw frequency bars
      const barWidth = (width / bufferLength) * 2.5;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * height;
        const hue = 260 + (i / bufferLength) * 100; // purple → green gradient
        const alpha = 0.3 + (dataArray[i] / 255) * 0.7;
        ctx.fillStyle = `hsla(${hue}, 80%, 65%, ${alpha})`;
        ctx.fillRect(x, height - barHeight, barWidth - 1, barHeight);
        x += barWidth;
      }
    }

    drawTestWave();
  } catch (err) {
    console.error('Mic test failed:', err);
    testStatus.textContent = '❌ Microphone access denied';
    testStatus.className = 'test-status';
  }
}

function stopMicTest() {
  if (testAnimId) {
    cancelAnimationFrame(testAnimId);
    testAnimId = null;
  }
  if (testAudioCtx) {
    testAudioCtx.close();
    testAudioCtx = null;
  }
  if (testStream) {
    testStream.getTracks().forEach(track => track.stop());
    testStream = null;
  }
  testResult.classList.add('hidden');
  testMicBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.08"/>
    </svg>
    Test Microphone
  `;
}

// ═══════════════════════════════════════════════════
// WIZARD NAVIGATION
// ═══════════════════════════════════════════════════
function goToStep(step) {
  // Hide current step card
  const currentCard = document.getElementById(`step-${currentStep}`);
  if (currentCard) currentCard.classList.add('hidden');

  // Mark current step as completed in the progress indicator
  const currentDot = document.querySelector(`.wizard-step[data-step="${currentStep}"]`);
  if (currentDot) {
    currentDot.classList.remove('active');
    currentDot.classList.add('completed');
  }

  // Fill the connecting line
  if (currentStep < step) {
    const line = document.getElementById(`line-${currentStep}-${step}`);
    if (line) line.classList.add('filled');
  }

  // Show next step card
  currentStep = step;
  const nextCard = document.getElementById(`step-${step}`);
  if (nextCard) {
    nextCard.classList.remove('hidden');
    // Re-trigger animation
    nextCard.style.animation = 'none';
    nextCard.offsetHeight; // force reflow
    nextCard.style.animation = '';
  }

  // Activate the step dot
  const nextDot = document.querySelector(`.wizard-step[data-step="${step}"]`);
  if (nextDot) nextDot.classList.add('active');
}

function showCompletedWizardState() {
  // Mark all steps as completed
  document.querySelectorAll('.wizard-step').forEach(s => {
    s.classList.remove('active');
    s.classList.add('completed');
  });
  document.querySelectorAll('.wizard-line').forEach(l => l.classList.add('filled'));

  // Hide step 1 and 2 cards, show step 3 in completed state
  document.getElementById('step-1').classList.add('hidden');
  document.getElementById('step-2').classList.add('hidden');
  const step3 = document.getElementById('step-3');
  step3.classList.remove('hidden');
  setupCompleteBadge.classList.remove('hidden');

  currentStep = 3;
}

// ═══════════════════════════════════════════════════
// SETTINGS (Advanced)
// ═══════════════════════════════════════════════════
function loadSettings() {
  chrome.storage.local.get({
    rmsThreshold: '0.015',
    silenceDuration: '1500',
    forceWasm: false
  }, (items) => {
    wasmToggle.checked = items.forceWasm;

    sensitivitySlider.value = items.rmsThreshold;
    sensitivityVal.textContent = items.rmsThreshold;

    const seconds = (parseInt(items.silenceDuration) / 1000).toFixed(1);
    delaySlider.value = seconds;
    delayVal.textContent = `${seconds}s`;
  });
}

sensitivitySlider.addEventListener('input', (e) => {
  sensitivityVal.textContent = e.target.value;
});

delaySlider.addEventListener('input', (e) => {
  delayVal.textContent = `${parseFloat(e.target.value).toFixed(1)}s`;
});

saveBtn.addEventListener('click', () => {
  const forceWasm = wasmToggle.checked;
  const rmsThreshold = sensitivitySlider.value;
  const silenceDuration = Math.round(parseFloat(delaySlider.value) * 1000).toString();

  chrome.storage.local.set({
    rmsThreshold,
    silenceDuration,
    forceWasm
  }, () => {
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'PRECACHE_MODEL'
    });

    saveStatus.classList.remove('hidden');
    saveBtn.disabled = true;
    setTimeout(() => {
      saveStatus.classList.add('hidden');
      saveBtn.disabled = false;
    }, 1500);
  });
});

// ═══════════════════════════════════════════════════
// MESSAGE LISTENER (Model Status from Background)
// ═══════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'MODEL_STATUS') {
    handleModelProgress(message);
  }
});
