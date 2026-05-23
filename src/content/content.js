let lastFocusedElement = null;
let shadowRoot = null;
let overlayHost = null;
let overlayActive = false;
let isSpeaking = false;
let canvasAnimId = null;

// UI Elements inside Shadow DOM
let bubbleEl = null;
let statusEl = null;
let transcriptEl = null;
let canvasEl = null;
let canvasCtx = null;

// Audio wave state variables
let waveAmplitude = 0;
let targetAmplitude = 0;
let phase = 0;

// Track focused text areas or inputs on the active web page
document.addEventListener('focusin', (e) => {
  if (isInputTarget(e.target)) {
    lastFocusedElement = e.target;
  }
});

document.addEventListener('click', (e) => {
  if (isInputTarget(e.target)) {
    lastFocusedElement = e.target;
  }
});

function isInputTarget(el) {
  if (!el) return false;
  return (
    el.tagName === 'INPUT' || 
    el.tagName === 'TEXTAREA' || 
    el.isContentEditable ||
    el.getAttribute('contenteditable') === 'true'
  );
}

// Inject shadow DOM UI
function ensureOverlayUI() {
  if (overlayHost) return;

  overlayHost = document.createElement('div');
  overlayHost.id = 'whisper-stt-host';
  // Ensure host doesn't occupy page layout space
  overlayHost.style.position = 'fixed';
  overlayHost.style.zIndex = '999999';
  overlayHost.style.pointerEvents = 'none'; // click-through
  document.body.appendChild(overlayHost);

  shadowRoot = overlayHost.attachShadow({ mode: 'closed' });

  // 1. Inject isolated Stylesheet
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('content/content.css');
  shadowRoot.appendChild(link);

  // 2. Inject Overlay container
  const container = document.createElement('div');
  container.className = 'whisper-overlay-container';
  container.innerHTML = `
    <div class="whisper-bubble">
      <div class="whisper-glow-bg"></div>
      <div class="whisper-header">
        <div class="whisper-indicator">
          <span class="whisper-dot"></span>
          <span class="whisper-status">Initializing...</span>
        </div>
      </div>
      <div class="whisper-canvas-wrapper">
        <canvas class="whisper-waveform"></canvas>
      </div>
      <div class="whisper-transcript-container">
        <p class="whisper-transcript">Focus a text box and start speaking...</p>
      </div>
    </div>
  `;
  shadowRoot.appendChild(container);

  // Bind internal variables
  bubbleEl = container.querySelector('.whisper-bubble');
  statusEl = container.querySelector('.whisper-status');
  transcriptEl = container.querySelector('.whisper-transcript');
  canvasEl = container.querySelector('.whisper-waveform');
  canvasCtx = canvasEl.getContext('2d');

  // Set initial sizes
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

function resizeCanvas() {
  if (!canvasEl) return;
  canvasEl.width = 300;
  canvasEl.height = 60;
}

// Audio Wave Animation Logic (Dynamic Canvas rendering at 60fps)
function drawWave() {
  if (!canvasCtx || !overlayActive) return;

  canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  
  // Smoothly transition wave amplitude based on speaking state
  targetAmplitude = isSpeaking ? 18 : 3;
  waveAmplitude += (targetAmplitude - waveAmplitude) * 0.1;

  phase += isSpeaking ? 0.15 : 0.04;
  
  const width = canvasEl.width;
  const height = canvasEl.height;
  const midY = height / 2;

  // We draw 3 layers of glowing transparent sine waves
  const waveLayers = [
    { color: 'rgba(108, 92, 231, 0.45)', speed: 1.0, scale: 1.0 },   // Purple
    { color: 'rgba(0, 230, 118, 0.35)', speed: -0.7, scale: 0.8 },  // Green-neon
    { color: 'rgba(239, 71, 111, 0.25)', speed: 1.3, scale: 0.6 }    // Red-pink
  ];

  canvasCtx.lineWidth = 2.5;
  canvasCtx.lineCap = 'round';

  waveLayers.forEach(layer => {
    canvasCtx.beginPath();
    canvasCtx.strokeStyle = layer.color;

    for (let x = 0; x < width; x++) {
      // Gaussian envelope to taper the wave at the screen boundaries
      const envelope = Math.sin((x / width) * Math.PI);
      const angle = (x / 25) + (phase * layer.speed);
      const y = midY + Math.sin(angle) * waveAmplitude * layer.scale * envelope;

      if (x === 0) {
        canvasCtx.moveTo(x, y);
      } else {
        canvasCtx.lineTo(x, y);
      }
    }
    canvasCtx.stroke();
  });

  canvasAnimId = requestAnimationFrame(drawWave);
}

// Text Emulating Insert Algorithm
function insertTextAtCursor(element, text) {
  if (!element) {
    // Fallback to active document element
    element = document.activeElement;
  }
  
  if (!isInputTarget(element)) {
    console.warn('Whisper STT: No valid input element is currently focused.');
    return;
  }

  element.focus();

  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const val = element.value;
    // Inject and concatenate text
    const newVal = val.slice(0, start) + text + val.slice(end);
    element.value = newVal;
    
    // Set updated cursor positioning
    const newPos = start + text.length;
    element.setSelectionRange(newPos, newPos);
    
    // Dispatch core events so modern frameworks trigger state changes
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (element.isContentEditable || element.getAttribute('contenteditable') === 'true') {
    // Support Rich-Text editors (Notion, Google Docs, Quill, etc.)
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      
      // Advance selection cursor
      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      element.textContent += text;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Listen to Background Signals
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'content') {
    console.log(`[Whisper Content] Received: ${message.type}`, message.text ? `text="${message.text}"` : '');
    ensureOverlayUI();
    handleBackgroundMessages(message);
  }
});

function handleBackgroundMessages(message) {
  switch (message.type) {
    // 1. Trigger session active (listening state)
    case 'DICTATION_START':
      overlayActive = true;
      bubbleEl.classList.add('visible');
      bubbleEl.classList.remove('speaking');
      statusEl.textContent = 'Listening...';
      transcriptEl.textContent = 'Speak now. Focus a text box and start speaking...';
      isSpeaking = false;
      if (!canvasAnimId) {
        drawWave();
      }
      break;

    // 2. Terminate session (hide overlay)
    case 'DICTATION_STOP':
      overlayActive = false;
      bubbleEl.classList.remove('visible', 'speaking');
      isSpeaking = false;
      if (canvasAnimId) {
        cancelAnimationFrame(canvasAnimId);
        canvasAnimId = null;
      }
      break;

    // 3. Live Model Loading Progress from Offscreen worker
    case 'MODEL_STATUS':
      if (message.status === 'downloading') {
        const percent = Math.round(message.progress || 0);
        statusEl.textContent = `Loading Model (${percent}%)`;
        transcriptEl.textContent = 'Downloading local speech model to browser cache...';
      } else if (message.status === 'loaded') {
        statusEl.textContent = 'Model Loaded';
        transcriptEl.textContent = 'Ready! Start speaking to dictate.';
      } else if (message.status === 'ready') {
        statusEl.textContent = 'Listening...';
        transcriptEl.textContent = 'Speak clearly into your microphone.';
      }
      break;

    // 4. Voice Activity Detected (Speech Start)
    case 'SPEECH_START':
      isSpeaking = true;
      bubbleEl.classList.add('speaking', 'visible');
      statusEl.textContent = 'Transcribing...';
      break;

    // 5. Streaming Real-Time Transcription Update
    case 'SPEECH_TRANSCRIPT':
      isSpeaking = true;
      bubbleEl.classList.add('speaking', 'visible');
      statusEl.textContent = 'Transcribing...';
      
      if (message.text && message.text.trim()) {
        transcriptEl.innerHTML = `<span class="streaming-text">${message.text}</span>`;
      }
      break;

    // 6. Finalized Text Commited (Paste into active element)
    case 'SPEECH_COMMIT':
      isSpeaking = false;
      bubbleEl.classList.remove('speaking');
      statusEl.textContent = 'Typed!';
      
      if (message.text && message.text.trim()) {
        transcriptEl.textContent = message.text;
        // Paste into current textbox focus target
        insertTextAtCursor(lastFocusedElement, message.text + ' ');
      }
      
      // Auto-fade bubble UI after 1.5 seconds, but remain actively listening
      setTimeout(() => {
        if (!isSpeaking && overlayActive) {
          bubbleEl.classList.remove('visible');
        }
      }, 1500);
      break;

    // 7. Silence detected (User paused speaking)
    case 'SPEECH_SILENCE':
      isSpeaking = false;
      bubbleEl.classList.remove('speaking');
      statusEl.textContent = 'Listening...';
      
      // Auto-fade bubble UI, ready to slide up when speech resumes
      setTimeout(() => {
        if (!isSpeaking && overlayActive) {
          bubbleEl.classList.remove('visible');
        }
      }, 1000);
      break;
  }
}
