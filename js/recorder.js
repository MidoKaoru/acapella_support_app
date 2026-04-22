'use strict';

class AudioRecorder {
  constructor() {
    this._mediaRecorder = null;
    this._chunks        = [];
    this._stream        = null;
    this._wakeLock      = null;
    this._state         = 'idle'; // 'idle' | 'recording' | 'paused'
    this._onVisibilityChange = this._handleVisibilityChange.bind(this);
  }

  get state() { return this._state; }

  async start() {
    this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this._chunks = [];
    this._mediaRecorder = new MediaRecorder(this._stream);
    this._mediaRecorder.addEventListener('dataavailable', e => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    });
    this._mediaRecorder.start(1000);
    this._state = 'recording';
    await this._acquireWakeLock();
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  resume() {
    if (this._mediaRecorder?.state === 'paused') {
      this._mediaRecorder.resume();
      this._state = 'recording';
    }
  }

  pause() {
    if (this._mediaRecorder?.state === 'recording') {
      this._mediaRecorder.pause();
      this._state = 'paused';
    }
  }

  stop() {
    return new Promise(resolve => {
      if (!this._mediaRecorder || this._mediaRecorder.state === 'inactive') {
        const blob = new Blob(this._chunks, { type: 'audio/webm' });
        this._cleanup();
        resolve(blob);
        return;
      }
      const mimeType = this._mediaRecorder.mimeType;
      this._mediaRecorder.addEventListener('stop', () => {
        const blob = new Blob(this._chunks, { type: mimeType });
        this._cleanup();
        resolve(blob);
      }, { once: true });
      this._mediaRecorder.stop();
    });
  }

  clear() {
    if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
      this._mediaRecorder.stop();
    }
    this._cleanup();
  }

  async _acquireWakeLock() {
    if (!navigator.wakeLock) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      this._wakeLock.addEventListener('release', () => {
        if (this._state !== 'idle') this._acquireWakeLock();
      });
    } catch (_) {}
  }

  async _releaseWakeLock() {
    if (!this._wakeLock) return;
    try { await this._wakeLock.release(); } catch (_) {}
    this._wakeLock = null;
  }

  _cleanup() {
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    this._stream?.getTracks().forEach(t => t.stop());
    this._stream        = null;
    this._mediaRecorder = null;
    this._chunks        = [];
    this._state         = 'idle';
    this._releaseWakeLock();
  }

  _handleVisibilityChange() {
    if (document.hidden && this._state === 'recording') {
      this.pause();
    }
  }
}
