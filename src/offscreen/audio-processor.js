/**
 * AudioWorklet Processor for Whisper STT
 * Replaces deprecated ScriptProcessorNode.
 * Runs on the audio rendering thread — collects PCM chunks and RMS energy.
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 4096;
    this._buffer = new Float32Array(this._bufferSize);
    this._bytesWritten = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channelData = input[0]; // mono channel
    if (!channelData) return true;

    // Accumulate samples into our buffer until we reach the target size
    for (let i = 0; i < channelData.length; i++) {
      this._buffer[this._bytesWritten++] = channelData[i];

      if (this._bytesWritten >= this._bufferSize) {
        // Calculate RMS for Voice Activity Detection
        let sum = 0;
        for (let j = 0; j < this._bufferSize; j++) {
          sum += this._buffer[j] * this._buffer[j];
        }
        const rms = Math.sqrt(sum / this._bufferSize);

        // Post the accumulated buffer + RMS to the main thread
        this.port.postMessage({
          type: 'AUDIO_CHUNK',
          audio: this._buffer.slice(), // copy to avoid detach issues
          rms: rms
        });

        // Reset for next chunk
        this._buffer = new Float32Array(this._bufferSize);
        this._bytesWritten = 0;
      }
    }

    return true; // keep processor alive
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
