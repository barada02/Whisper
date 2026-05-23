// Selectors
const micBtn = document.getElementById('mic-btn');
const micStatus = document.getElementById('mic-status');
const wasmToggle = document.getElementById('wasm-toggle');
const sensitivitySlider = document.getElementById('sensitivity-slider');
const sensitivityVal = document.getElementById('sensitivity-val');
const delaySlider = document.getElementById('delay-slider');
const delayVal = document.getElementById('delay-val');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');

// 1. Initial Load & Setup
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  checkMicPermission();
  triggerModelCaching();
});

// Load Settings from chrome.storage.local
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

// 2. Microphone Permissions Checker
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
    // navigator.permissions is not fully supported in all extension contexts, fallback to direct query check
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
  micBtn.classList.add('hidden');
  micStatus.classList.remove('hidden');
}

micBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop()); // close immediately
    showMicGranted();
  } catch (err) {
    console.error('Microphone request denied:', err);
    alert('Microphone access is required to run Speech-to-Text. Please check your browser privacy settings.');
  }
});

// 3. Dynamic Sliders Label Updates
sensitivitySlider.addEventListener('input', (e) => {
  sensitivityVal.textContent = e.target.value;
});

delaySlider.addEventListener('input', (e) => {
  delayVal.textContent = `${parseFloat(e.target.value).toFixed(1)}s`;
});

// 4. Save Settings to Local Storage
saveBtn.addEventListener('click', () => {
  const forceWasm = wasmToggle.checked;
  const rmsThreshold = sensitivitySlider.value;
  const silenceDuration = Math.round(parseFloat(delaySlider.value) * 1000).toString();

  chrome.storage.local.set({
    rmsThreshold: rmsThreshold,
    silenceDuration: silenceDuration,
    forceWasm: forceWasm
  }, () => {
    // Notify Background of potential config adjustments
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'PRECACHE_MODEL' // forces worker reload with new config
    });

    saveStatus.classList.remove('hidden');
    saveBtn.disabled = true;
    setTimeout(() => {
      saveStatus.classList.add('hidden');
      saveBtn.disabled = false;
    }, 1500);
  });
});

// 5. Pre-caching & Downloading UI progress
function triggerModelCaching() {
  // Request background to spawn offscreen worker to begin caching
  chrome.runtime.sendMessage({
    target: 'background',
    type: 'PRECACHE_MODEL'
  });
}

// Listen to Model Status updates routed from background service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.target === 'content' || message.target === 'options') {
    if (message.type === 'MODEL_STATUS') {
      if (message.status === 'downloading') {
        const percent = Math.round(message.progress || 0);
        progressFill.style.width = `${percent}%`;
        progressText.textContent = `Downloading Local Model: ${percent}%`;
        progressFill.classList.add('active');
      } else if (message.status === 'loaded' || message.status === 'ready') {
        progressFill.style.width = '100%';
        progressText.textContent = 'Model Pre-cached Successfully (Offline Ready)';
        progressFill.classList.remove('active');
      }
    }
  }
});
