const OFFSCREEN_PATH = 'offscreen/offscreen.html';
let isDictationActive = false;

// Helpers to manage Offscreen Document
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) {
    return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['AUDIO_CAPTURE'],
      justification: 'Capture user microphone stream for local automatic speech recognition (ASR)'
    });
    console.log('Offscreen document created successfully.');
  } catch (error) {
    console.error('Failed to create offscreen document:', error);
  }
}

async function closeOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length === 0) {
    return;
  }

  try {
    await chrome.offscreen.closeDocument();
    console.log('Offscreen document closed successfully.');
  } catch (error) {
    console.error('Failed to close offscreen document:', error);
  }
}

// Update Extension Icon representation
async function updateExtensionUI(tabId) {
  const state = isDictationActive ? 'active' : 'inactive';
  const title = isDictationActive
    ? 'Whisper STT - Continuous Dictation Active (Click to Stop)'
    : 'Whisper STT - Activate Continuous Dictation';

  // Set action icon (passing a single path string allows Chrome to auto-scale and avoids strict dimension checks)
  await chrome.action.setIcon({
    path: `icons/icon32_${state}.png`,
    tabId: tabId
  });

  await chrome.action.setTitle({
    title: title,
    tabId: tabId
  });
}

// Toggle Dictation Session On/Off
async function toggleDictation(tab) {
  const isRestrictedUrl = tab.url && (
    tab.url.startsWith('chrome://') ||
    tab.url.startsWith('chrome-extension://')
  );

  if (!tab || !tab.id || isRestrictedUrl) {
    console.warn('Dictation cannot run on browser internal or extension utility pages.');
    return;
  }

  isDictationActive = !isDictationActive;
  console.log(`Dictation state changed to: ${isDictationActive}`);

  await updateExtensionUI(tab.id);

  if (isDictationActive) {
    // 1. Ensure Offscreen is open and starting microphone capture
    await ensureOffscreenDocument();

    // 2. Alert the active page content script that dictation is starting
    try {
      await chrome.tabs.sendMessage(tab.id, {
        target: 'content',
        type: 'DICTATION_START'
      });
    } catch (e) {
      console.warn('Content script not loaded or ready. It will initialize upon receiving offscreen events.');
    }
  } else {
    // 1. Close offscreen recording
    await closeOffscreenDocument();

    // 2. Alert content script to close overlay UI
    try {
      await chrome.tabs.sendMessage(tab.id, {
        target: 'content',
        type: 'DICTATION_STOP'
      });
    } catch (e) {
      // Ignored
    }
  }
}

// Listen to Extension Pinned Icon Clicks
chrome.action.onClicked.addListener((tab) => {
  toggleDictation(tab);
});

// Route messaging between Offscreen (inference/recording) and Content Script (UI injection)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'background') {
    handleBackgroundMessages(message, sender, sendResponse);
  }
});

async function handleBackgroundMessages(message, sender, sendResponse) {
  // Query active tab to route messages
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || !activeTab.id) return;

  switch (message.type) {
    // Forward Speech Events from Offscreen to injected Content Script
    case 'SPEECH_START':
    case 'SPEECH_TRANSCRIPT':
    case 'SPEECH_COMMIT':
    case 'SPEECH_SILENCE':
    case 'MODEL_STATUS':
      try {
        await chrome.tabs.sendMessage(activeTab.id, {
          target: 'content',
          ...message
        });
      } catch (e) {
        console.warn('Failed to forward speech message to content script:', e);
      }
      break;

    // Handles when the offscreen document is ready and requesting active state
    case 'OFFSCREEN_READY':
      // Offscreen signals it is initialized and ready
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'START_RECORDING'
      });
      break;

    // If options page requests precaching
    case 'PRECACHE_MODEL':
      await ensureOffscreenDocument();
      setTimeout(() => {
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'TRIGGER_PRECACHE'
        });
      }, 1000);
      break;

    default:
      console.log('Unhandled background message:', message);
  }
}

// Clean up if a tab changes or service worker restarts
chrome.runtime.onSuspend.addListener(async () => {
  if (isDictationActive) {
    await closeOffscreenDocument();
  }
});
