/**
 * metronome.js
 * メトロノーム機能
 * - Web Audio API ルックアヘッドスケジューリング（精度優先）
 * - 1拍目アクセント音
 * - タップテンポ
 * - クリック音3種類：クリック / ウッドブロック / ベル
 * - バックグラウンド再生：MediaStreamDestination + Audio要素（iOS対応）
 * - Media Session API（ロック画面から操作）
 */

class Metronome {
  constructor() {
    this.audioContext = null;
    this.isPlaying    = false;

    this.bpm             = 120;
    this.beatsPerMeasure = 4;
    this.currentBeat     = 0;
    this.nextBeatTime    = 0;
    this.soundType       = 'click'; // 'click' | 'woodblock' | 'bell'

    // スケジューラー設定
    this._lookaheadMs   = 25;   // setInterval 間隔 (ms)
    this._scheduleAhead = 0.12; // 先読み時間 (秒)
    this._timerID       = null;

    // タップテンポ
    this._tapTimes = [];

    // バックグラウンド再生用
    this._bgAudio      = null; // Audio 要素
    this._bgOsc        = null; // 無音 OscillatorNode
    this._bgDest       = null; // MediaStreamDestination
    this._silentSource = null; // フォールバック用 BufferSource

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

  setSoundType(type) {
    this.soundType = type;
  }

  start() {
    if (!this.audioContext || this.isPlaying) return;
    if (this.audioContext.state === 'suspended') this.audioContext.resume();

    this.isPlaying    = true;
    this.currentBeat  = 0;
    this.nextBeatTime = this.audioContext.currentTime + 0.05;

    this._startBackgroundAudio();
    this._setupMediaSession();
    this._schedule();
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    clearTimeout(this._timerID);
    this._stopBackgroundAudio();

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
    this._tapTimes = this._tapTimes.filter(t => now - t < 3000);
    this._tapTimes.push(now);

    if (this._tapTimes.length < 2) return null;

    const intervals = [];
    for (let i = 1; i < this._tapTimes.length; i++) {
      intervals.push(this._tapTimes[i] - this._tapTimes[i - 1]);
    }
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    return Math.max(20, Math.min(300, Math.round(60000 / avg)));
  }

  // ─── 内部: スケジューラー ────────────────────

  _schedule() {
    const ctx = this.audioContext;
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

  /** 音種ごとにクリック音をスケジュール */
  _scheduleClick(time, beat) {
    const ctx      = this.audioContext;
    const isAccent = beat === 0;

    switch (this.soundType) {
      case 'woodblock': this._soundWoodblock(ctx, time, isAccent); break;
      case 'bell':      this._soundBell(ctx, time, isAccent);      break;
      default:          this._soundClick(ctx, time, isAccent);     break;
    }

    // UI 更新タイマー（オーディオ再生と同期）
    const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    setTimeout(() => {
      if (this.isPlaying && this.onBeat) this.onBeat(beat);
    }, delayMs);
  }

  // ─── 音種ごとの音生成 ─────────────────────────

  /** クリック（デフォルト）: 矩形的な短い音 */
  _soundClick(ctx, time, isAccent) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.value = isAccent ? 1050 : 800;
    env.gain.setValueAtTime(isAccent ? 0.75 : 0.45, time);
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.045);
    osc.connect(env);
    env.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  /** ウッドブロック: ノイズ + バンドパスフィルター */
  _soundWoodblock(ctx, time, isAccent) {
    const bufLen = Math.floor(ctx.sampleRate * 0.08);
    const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src    = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const env    = ctx.createGain();

    src.buffer         = buf;
    filter.type        = 'bandpass';
    filter.frequency.value = isAccent ? 920 : 680;
    filter.Q.value     = 20;

    env.gain.setValueAtTime(isAccent ? 1.3 : 0.85, time);
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.07);

    src.connect(filter);
    filter.connect(env);
    env.connect(ctx.destination);
    src.start(time);
    src.stop(time + 0.09);
  }

  /** ベル: サイン波の倍音 + 長めの余韻 */
  _soundBell(ctx, time, isAccent) {
    const baseFreqs = isAccent ? [880, 1320, 2200] : [660, 990, 1650];
    const gainBase  = isAccent ? 0.38 : 0.24;
    const decay     = isAccent ? 0.55 : 0.38;

    baseFreqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type           = 'sine';
      osc.frequency.value = freq;
      env.gain.setValueAtTime(gainBase / (i + 1), time);
      env.gain.exponentialRampToValueAtTime(0.001, time + decay);
      osc.connect(env);
      env.connect(ctx.destination);
      osc.start(time);
      osc.stop(time + decay + 0.05);
    });
  }

  // ─── 内部: バックグラウンド再生 ─────────────

  /**
   * iOS Safari でスリープ中も AudioContext を維持する
   *
   * 方式①（推奨）: MediaStreamDestination + Audio 要素
   *   AudioContext の出力を MediaStream 経由で Audio 要素に流す。
   *   Audio 要素が iOS のオーディオセッションを保持し続けるため
   *   画面ロック後もメトロノームが鳴り続ける。
   *
   * 方式②（フォールバック）: AudioBufferSource ループ
   *   MediaStreamDestination が使えない環境向け。
   */
  _startBackgroundAudio() {
    if (this._bgAudio || this._silentSource) return;
    const ctx = this.audioContext;

    if (typeof ctx.createMediaStreamDestination === 'function') {
      try {
        const dest = ctx.createMediaStreamDestination();

        // 実質無音の発振器でストリームを「空でない」状態にする
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.00001; // -100dB 相当、聴こえない
        osc.connect(gain);
        gain.connect(dest);
        osc.start();

        // Audio 要素でストリームを再生 → iOS オーディオセッション確保
        const audio      = new Audio();
        audio.srcObject  = dest.stream;
        audio.volume     = 1;
        const p = audio.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});

        this._bgOsc   = osc;
        this._bgDest  = dest;
        this._bgAudio = audio;
        return;
      } catch (_) {
        // フォールバックへ
      }
    }

    // フォールバック: 微小振幅バッファのループ再生
    const sr  = ctx.sampleRate;
    const buf = ctx.createBuffer(1, sr, sr);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < sr; i++) d[i] = (Math.random() * 2 - 1) * 0.00005;
    const src  = ctx.createBufferSource();
    src.buffer = buf;
    src.loop   = true;
    src.connect(ctx.destination);
    src.start();
    this._silentSource = src;
  }

  _stopBackgroundAudio() {
    if (this._bgOsc) {
      try { this._bgOsc.stop(); } catch (_) {}
      this._bgOsc = null;
    }
    if (this._bgAudio) {
      this._bgAudio.pause();
      this._bgAudio.srcObject = null;
      this._bgAudio = null;
    }
    this._bgDest = null;

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
