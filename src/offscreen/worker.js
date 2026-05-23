import { env, pipeline } from '@huggingface/transformers';

// 1. Configure Transformers.js to load WASM binaries locally
// This complies with Chrome Manifest V3 Content Security Policies.
const localWasmPath = self.location.origin + '/transformers/';
env.backends.onnx.wasm.wasmPaths = localWasmPath;

console.log(`Transformers.js local WASM paths configured: ${localWasmPath}`);

let transcriber = null;
let isForceWasm = false;
let isModelLoading = false;

// Initialize Pipeline with automatic WebGPU -> WASM fallback
async function getPipeline(forceWasm) {
  if (transcriber) return transcriber;

  // Prevent concurrent duplicate loading threads
  if (isModelLoading) {
    while (isModelLoading) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return transcriber;
  }

  isModelLoading = true;
  const targetDevice = forceWasm ? 'wasm' : 'webgpu';
  console.log(`Loading Moonshine Tiny STT pipeline on device: ${targetDevice}`);

  try {
    transcriber = await pipeline('automatic-speech-recognition', 'onnx-community/moonshine-tiny-ONNX', {
      device: targetDevice,
      progress_callback: (data) => {
        // Send loading progress back to offscreen main thread
        if (data.status === 'progress') {
          postMessage({
            target: 'offscreen',
            type: 'MODEL_STATUS',
            status: 'downloading',
            progress: data.progress
          });
        } else if (data.status === 'ready') {
          postMessage({
            target: 'offscreen',
            type: 'MODEL_STATUS',
            status: 'loaded'
          });
        }
      }
    });

    console.log(`STT pipeline loaded successfully on: ${targetDevice}`);
    isModelLoading = false;
    return transcriber;
  } catch (error) {
    isModelLoading = false;
    // Fall back to WASM if WebGPU fails
    if (targetDevice === 'webgpu') {
      console.warn('WebGPU initialization failed. Attempting WASM fallback...', error);
      return await getPipeline(true);
    }
    console.error('ASR pipeline loading failed on WASM:', error);
    throw error;
  }
}

// Listen to audio processing commands from Offscreen recorder
self.onmessage = async (event) => {
  const message = event.data;

  if (message.target === 'worker') {
    switch (message.type) {
      case 'CONFIGURE':
        isForceWasm = message.forceWasm || false;
        // Warm up and pre-cache model immediately upon config/install
        try {
          await getPipeline(isForceWasm);
        } catch (e) {
          console.error('Pre-cache warm up failed:', e);
        }
        break;

      case 'INFERENCE':
        const audioBuffer = message.audio; // Float32Array PCM at 16kHz
        const isFinal = message.isFinal || false;

        try {
          const pipe = await getPipeline(isForceWasm);
          
          // Run Moonshine ASR model inference
          // Moonshine expects 16kHz Float32 mono arrays
          const output = await pipe(audioBuffer);
          const transcribedText = output.text || '';

          // Send result back to offscreen thread
          postMessage({
            target: 'offscreen',
            type: 'TRANSCRIPTION_RESULT',
            text: transcribedText,
            isFinal: isFinal
          });
        } catch (err) {
          console.error('Inference execution failed:', err);
        }
        break;
    }
  }
};
