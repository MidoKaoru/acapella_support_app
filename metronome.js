/**
 * metronome.js
 * メトロノーム機能
 * - Web Audio API ルックアヘッドスケジューリング（精度優先）
 * - 1拍目アクセント音
 * - タップテンポ
 * - バックグラウンド再生：無音ループ + Media Session API
 * - iOS Safari 対応
 */

class Metronome {
  constructor() {
    this.audioContext = null;
    this.isPlaying    = false;

    this.bpm             = 120;
    this.beatsPerMeasure = 4;
    this.currentBeat     = 0;
    this.nextBeatTime    = 0;

    // スケジューラー設定
    this._lookaheadMs     = 25;   // setInterval 間隔 (ms)
    this._scheduleAhead   = 0.12; // 先読み時間 (秒)
    this._timerID         = null;

    // タップテンポ
    this._tapTimes = [];

    // バックグラウンド再生用
    this._silentSource = null;

    // 拍ごとの UI コールバック（app.js からセット）
    this.onBeat = null; // (beatIndex: number) => void   -1 = 停止
  }

  /** app.js から共有 AudioContext を注入 */
  setAudioContext(ctx) {
    this.audioContext = ctx;
  }

  get _secondsPerBeat() {
    return 60.0 / this.bpm;
  }

  // ─── 公開 API ───────────────────────────────

  setBPM(bpm) {
    this.bpm = Math.max(20, Math.min(300, Math.round(bpm)));
  }

  setTimeSignature(sig) {
    const map = { '4/4': 4, '3/4': 3, '2/4': 2, '6/8': 6 };
    this.beatsPerMeasure = map[sig] ?? 4;
    this.currentBeat = 0;
  }

  start() {
    if (!this.audioContext || this.isPlaying) return;
    if (this.audioContext.state === 'suspended') this.audioContext.resume();

    this.isPlaying   = true;
    this.currentBeat = 0;
    this.nextBeatTime = this.audioContext.currentTime + 0.05;

    this._startSilentLoop();
    this._setupMediaSession();
    this._schedule();
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    clearTimeout(this._timerID);
    this._stopSilentLoop();

    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
    }

    if (this.onBeat) this.onBeat(-1); // UI をリセット
  }

  /**
   * タップテンポ
   * @returns {number|null} 算出 BPM（tap が1回のみなら null）
   */
  tapTempo() {
    const now = Date.now();
    // 3秒以上前のタップは破棄
    this._tapTimes = this._tapTimes.filter(t => now - t < 3000);
    this._tapTimes.push(now);

    if (this._tapTimes.length < 2) return null;

    const intervals = [];
    for (let i = 1; i < this._tapTimes.length; i++) {
      intervals.push(this._tapTimes[i] - this._tapTimes[i - 1]);
    }
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const bpm = Math.round(60000 / avg);
    return Math.max(20, Math.min(300, bpm));
  }

  // ─── 内部: スケジューラー ────────────────────

  _schedule() {
    const ctx = this.audioContext;

    // コンテキストが停止していたら復帰を試みる
    if (ctx.state === 'suspended') ctx.resume();

    while (this.nextBeatTime < ctx.currentTime + this._scheduleAhead) {
      this._scheduleClick(this.nextBeatTime, this.currentBeat);
      this.nextBeatTime += this._secondsPerBeat;
      this.currentBeat = (this.currentBeat + 1) % this.beatsPerMeasure;
    }

    this._timerID = setTimeout(() => {
      if (this.isPlaying) this._schedule();
    }, this._lookaheadMs);
  }

  /** クリック音を指定時刻にスケジュール */
  _scheduleClick(time, beat) {
    const ctx      = this.audioContext;
    const isAccent = beat === 0;

    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    // アクセント：高め・大きめ / 通常：低め・小さめ
    osc.frequency.value = isAccent ? 1050 : 800;
    env.gain.setValueAtTime(isAccent ? 0.75 : 0.45, time);
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.045);

    osc.connect(env);
    env.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);

    // UI 更新タイマー（オーディオ再生と同期）
    const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    setTimeout(() => {
      if (this.isPlaying && this.onBeat) this.onBeat(beat);
    }, delayMs);
  }

  // ─── 内部: バックグラウンド再生 ─────────────

  /**
   * 無音ループ（iOS でスリープ中も AudioContext を維持する）
   * 完全な無音だと iOS が停止させる場合があるため
   * 聴こえないレベルのノイズを混ぜる
   */
  _startSilentLoop() {
    if (!this.audioContext || this._silentSource) return;
    const ctx        = this.audioContext;
    const sampleRate = ctx.sampleRate;
    const buffer     = ctx.createBuffer(1, sampleRate, sampleRate); // 1秒
    const data       = buffer.getChannelData(0);
    for (let i = 0; i < sampleRate; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.00005; // 実質無音
    }
    const src  = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop   = true;
    src.connect(ctx.destination);
    src.start();
    this._silentSource = src;
  }

  _stopSilentLoop() {
    if (this._silentSource) {
      try { this._silentSource.stop(); } catch (_) {}
      this._silentSource = null;
    }
  }

  /** Media Session API — ロック画面からの操作を受け付ける */
  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title:  `メトロノーム ${this.bpm} BPM`,
      artist: 'アカペラ練習サポート',
    });
    navigator.mediaSession.playbackState = 'playing';

    navigator.mediaSession.setActionHandler('play',  () => this.start());
    navigator.mediaSession.setActionHandler('pause', () => this.stop());
    navigator.mediaSession.setActionHandler('stop',  () => this.stop());
  }
}
