let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let worker = null;

// Audio parameters
const TARGET_SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;

// Dictation state variables
let accumulatedAudio = [];
let isSpeaking = false;
let silenceTimer = null;
let transcriptionInterval = null;

// VAD Parameters
let RMS_THRESHOLD = 0.015; // default energy threshold
let SILENCE_DURATION_MS = 1500; // 1.5 seconds pause commits speech

// Load settings from storage
chrome.storage.local.get(['rmsThreshold', 'silenceDuration', 'forceWasm'], (settings) => {
  if (settings.rmsThreshold !== undefined) {
    RMS_THRESHOLD = parseFloat(settings.rmsThreshold);
  }
  if (settings.silenceDuration !== undefined) {
    SILENCE_DURATION_MS = parseInt(settings.silenceDuration);
  }
  console.log(`Initialized VAD: Threshold=${RMS_THRESHOLD}, SilenceMs=${SILENCE_DURATION_MS}`);
  
  // Initialize worker
  initWorker(settings.forceWasm || false);
});

// 1. Initialize our background Inference Web Worker
function initWorker(forceWasm) {
  worker = new Worker(new URL('worker.js', import.meta.url), { type: 'module' });

  // Handle messages back from the worker
  worker.onmessage = (event) => {
    const message = event.data;
    
    if (message.target === 'offscreen') {
      handleWorkerMessages(message);
    }
  };

  // Signal worker to configure options
  worker.postMessage({
    target: 'worker',
    type: 'CONFIGURE',
    forceWasm: forceWasm
  });
}

function handleWorkerMessages(message) {
  switch (message.type) {
    // Forward model loading state to background (which routes to content script UI)
    case 'MODEL_STATUS':
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'MODEL_STATUS',
        status: message.status,
        progress: message.progress
      });
      break;

    // Transcriber completed an inference slice
    case 'TRANSCRIPTION_RESULT':
      if (message.isFinal) {
        chrome.runtime.sendMessage({
          target: 'background',
          type: 'SPEECH_COMMIT',
          text: message.text
        });
      } else {
        chrome.runtime.sendMessage({
          target: 'background',
          type: 'SPEECH_TRANSCRIPT',
          text: message.text
        });
      }
      break;
  }
}

// 2. Microphone Capture & Resampling Pipeline
async function startRecording() {
  if (audioContext) return;

  console.log('Requesting microphone permissions...');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Create AudioContext, dynamically handling browser default rates
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(mediaStream);
    const inputSampleRate = audioContext.sampleRate;

    console.log(`Microphone captured successfully. Input Sample Rate: ${inputSampleRate}Hz`);

    // Create ScriptProcessor for PCM audio capture
    scriptProcessor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
    
    scriptProcessor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      
      // Calculate Root Mean Square (RMS) for VAD
      const rms = calculateRMS(inputData);
      
      // Downsample input chunks to 16,000Hz (required by ASR model)
      const resampledChunk = downsampleChunk(inputData, inputSampleRate, TARGET_SAMPLE_RATE);
      
      handleAudioProcessing(resampledChunk, rms);
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    chrome.runtime.sendMessage({
      target: 'background',
      type: 'MODEL_STATUS',
      status: 'ready'
    });
  } catch (err) {
    console.error('Audio capture failed:', err);
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'MODEL_STATUS',
      status: 'error',
      error: 'Microphone permission denied.'
    });
  }
}

function calculateRMS(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

// Downsample array in real-time using averaging low-pass resampling
function downsampleChunk(buffer, inputSampleRate, outputSampleRate) {
  if (inputSampleRate === outputSampleRate) {
    return new Float32Array(buffer);
  }
  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  
  let offsetResult = 0;
  let offsetBuffer = 0;
  
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

// 3. Continuous Audio Buffer Management and VAD Controller
function handleAudioProcessing(pcmData, rms) {
  // Push resampled PCM data into active sentence buffer
  // pcmData is a Float32Array, convert to simple array elements
  for (let i = 0; i < pcmData.length; i++) {
    accumulatedAudio.push(pcmData[i]);
  }

  // Voice Activity Detection Check
  if (rms > RMS_THRESHOLD) {
    // User is actively speaking
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }

    if (!isSpeaking) {
      isSpeaking = true;
      console.log('Voice activity detected.');
      
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'SPEECH_START'
      });

      // Start periodic streaming transcription updates
      startStreamingTranscriptions();
    }
  } else {
    // Silence detected
    if (isSpeaking && !silenceTimer) {
      // Start commit countdown
      silenceTimer = setTimeout(() => {
        commitSpeech();
      }, SILENCE_DURATION_MS);
    }
  }
}

function startStreamingTranscriptions() {
  if (transcriptionInterval) clearInterval(transcriptionInterval);
  
  // Every 1.5 seconds, send accumulated voice to model for streaming update
  transcriptionInterval = setInterval(() => {
    if (isSpeaking && accumulatedAudio.length > 0) {
      triggerInference(false);
    }
  }, 1500);
}

function stopStreamingTranscriptions() {
  if (transcriptionInterval) {
    clearInterval(transcriptionInterval);
    transcriptionInterval = null;
  }
}

function triggerInference(isFinal) {
  if (accumulatedAudio.length === 0) return;

  // Clone current buffer
  const audioData = new Float32Array(accumulatedAudio);
  
  // Post audio buffer to worker thread
  worker.postMessage({
    target: 'worker',
    type: 'INFERENCE',
    audio: audioData,
    isFinal: isFinal
  });
}

function commitSpeech() {
  console.log('Silence threshold reached. Committing text...');
  isSpeaking = false;
  stopStreamingTranscriptions();
  
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  // Trigger final inference pass
  triggerInference(true);

  // Clear audio buffer for next sentence
  accumulatedAudio = [];

  chrome.runtime.sendMessage({
    target: 'background',
    type: 'SPEECH_SILENCE'
  });
}

async function stopRecording() {
  stopStreamingTranscriptions();
  if (silenceTimer) clearTimeout(silenceTimer);
  
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  accumulatedAudio = [];
  isSpeaking = false;
  console.log('Recording stopped successfully.');
}

// Receive triggers from Background orchestrator
chrome.runtime.onMessage.addListener((message) => {
  if (message.target === 'offscreen') {
    switch (message.type) {
      case 'START_RECORDING':
        startRecording();
        break;
      case 'STOP_RECORDING':
        stopRecording();
        break;
      case 'TRIGGER_PRECACHE':
        // Loading the worker triggers background caching automatically
        console.log('Pre-cache triggered.');
        break;
    }
  }
});

// Alert background service worker that offscreen is loaded
chrome.runtime.sendMessage({
  target: 'background',
  type: 'OFFSCREEN_READY'
});
