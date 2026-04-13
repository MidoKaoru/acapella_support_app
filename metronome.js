/**
 * metronome.js
 * メトロノーム機能
 * - Web Audio API ルックアヘッドスケジューリング（精度優先）
 * - 1拍目アクセント音
 * - タップテンポ
 * - クリック音3種類：クリック / ウッドブロック / スネア
 * - DynamicsCompressor でクリック音をピッチパイプ音に埋もれにくくする
 * - バックグラウンド再生：MediaStreamDestination + Audio 要素（iOS 対応）
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
    this.soundType       = 'click'; // 'click' | 'woodblock' | 'snare'

    // スケジューラー設定
    this._lookaheadMs   = 25;   // setTimeout 間隔 (ms)
    this._scheduleAhead = 0.12; // 先読み時間 (秒)
    this._timerID       = null;

    // タップテンポ
    this._tapTimes = [];

    // メトロノーム出力用コンプレッサー（クリック音を際立たせる）
    this._compressor = null;

    // バックグラウンド再生用
    this._bgAudio      = null;
    this._bgOsc        = null;
    this._bgDest       = null;
    this._silentSource = null;

    // 拍ごとの UI コールバック（app.js からセット）
    this.onBeat = null; // (beatIndex: number) => void   -1 = 停止
  }

  /** app.js から共有 AudioContext を注入 */
  setAudioContext(ctx) {
    this.audioContext = ctx;
    this._compressor  = null; // コンテキスト変更時にリセット
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

    if (this.onBeat) this.onBeat(-1);
  }

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

  // ─── 内部: コンプレッサー（クリック音強化） ──

  /**
   * メトロノーム専用の出力ノードを返す。
   * DynamicsCompressor を挟むことで、ゲインを高めても歪まず
   * ピッチパイプ音と同時再生しても埋もれにくくなる。
   */
  _getOutput() {
    const ctx = this.audioContext;
    if (!this._compressor) {
      const comp          = ctx.createDynamicsCompressor();
      comp.threshold.value = -6;   // dB: この音量以上を圧縮
      comp.knee.value      = 4;    // dB: 緩やかに圧縮を開始
      comp.ratio.value     = 10;   // 圧縮率：超えた分を1/10に
      comp.attack.value    = 0.001; // 秒: 瞬時に反応
      comp.release.value   = 0.05; // 秒: すぐに戻す
      comp.connect(ctx.destination);
      this._compressor = comp;
    }
    return this._compressor;
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

  _scheduleClick(time, beat) {
    const ctx      = this.audioContext;
    const isAccent = beat === 0;

    switch (this.soundType) {
      case 'woodblock': this._soundWoodblock(ctx, time, isAccent); break;
      case 'snare':     this._soundSnare(ctx, time, isAccent);     break;
      default:          this._soundClick(ctx, time, isAccent);     break;
    }

    const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    setTimeout(() => {
      if (this.isPlaying && this.onBeat) this.onBeat(beat);
    }, delayMs);
  }

  // ─── 音種ごとの音生成 ─────────────────────────

  /**
   * クリック（デフォルト）
   * 従来より高いゲインでコンプレッサー経由出力
   */
  _soundClick(ctx, time, isAccent) {
    const out = this._getOutput();
    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.frequency.value = isAccent ? 1050 : 800;
    env.gain.setValueAtTime(isAccent ? 2.0 : 1.3, time);
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

    osc.connect(env);
    env.connect(out);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  /**
   * ウッドブロック
   * ノイズ + バンドパスフィルター
   */
  _soundWoodblock(ctx, time, isAccent) {
    const out    = this._getOutput();
    const bufLen = Math.floor(ctx.sampleRate * 0.08);
    const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src    = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const env    = ctx.createGain();

    src.buffer             = buf;
    filter.type            = 'bandpass';
    filter.frequency.value = isAccent ? 920 : 680;
    filter.Q.value         = 20;
    env.gain.setValueAtTime(isAccent ? 2.5 : 1.6, time);
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.07);

    src.connect(filter);
    filter.connect(env);
    env.connect(out);
    src.start(time);
    src.stop(time + 0.09);
  }

  /**
   * スネアドラム風
   * ① ノイズ（スネアのカラッとした「バシッ」感）
   * ② 低音オシレーター（ドラムの胴鳴り「ドン」感）
   * を合成して本物に近いスネア音を作る
   */
  _soundSnare(ctx, time, isAccent) {
    const out = this._getOutput();

    // ① ノイズ成分（白色ノイズ + ハイパスフィルター）
    const noiseLen  = Math.floor(ctx.sampleRate * 0.15);
    const noiseBuf  = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const noiseData = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) noiseData[i] = Math.random() * 2 - 1;

    const noiseSrc = ctx.createBufferSource();
    const hipass   = ctx.createBiquadFilter();
    const noiseEnv = ctx.createGain();

    noiseSrc.buffer        = noiseBuf;
    hipass.type            = 'highpass';
    hipass.frequency.value = 2000;
    noiseEnv.gain.setValueAtTime(isAccent ? 2.2 : 1.4, time);
    noiseEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.12);

    noiseSrc.connect(hipass);
    hipass.connect(noiseEnv);
    noiseEnv.connect(out);
    noiseSrc.start(time);
    noiseSrc.stop(time + 0.15);

    // ② 低音成分（ピッチが急降下するオシレーター）
    const bodyOsc = ctx.createOscillator();
    const bodyEnv = ctx.createGain();

    bodyOsc.frequency.setValueAtTime(isAccent ? 220 : 160, time);
    bodyOsc.frequency.exponentialRampToValueAtTime(55, time + 0.07);
    bodyEnv.gain.setValueAtTime(isAccent ? 1.8 : 1.1, time);
    bodyEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.09);

    bodyOsc.connect(bodyEnv);
    bodyEnv.connect(out);
    bodyOsc.start(time);
    bodyOsc.stop(time + 0.1);
  }

  // ─── 内部: バックグラウンド再生（iOS 対応） ──

  /**
   * MediaStreamDestination + Audio 要素 方式
   *
   * AudioContext の出力を MediaStream 経由で Audio 要素に渡す。
   * Audio 要素が iOS のオーディオセッションを保持し続けるため、
   * 画面ロック後も AudioContext が停止しない。
   *
   * 非対応環境は AudioBufferSource ループにフォールバック。
   */
  _startBackgroundAudio() {
    if (this._bgAudio || this._silentSource) return;
    const ctx = this.audioContext;

    if (typeof ctx.createMediaStreamDestination === 'function') {
      try {
        const dest = ctx.createMediaStreamDestination();
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.00001; // 実質無音（-100 dB 相当）
        osc.connect(gain);
        gain.connect(dest);
        osc.start();

        const audio     = new Audio();
        audio.srcObject = dest.stream;
        audio.volume    = 1;
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

    // フォールバック: 微小振幅バッファのループ
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

  // ─── Media Session API ───────────────────────

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
