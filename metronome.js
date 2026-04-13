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
    this._bgAudio            = null;
    this._bgBlobUrl          = null;
    this._silentSource       = null;
    this._onVisibilityChange = null;
    this._onStateChange      = null;

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

    this._startBackgroundAudio().then(() => {
      if (this.isPlaying) this._schedule();
    });
    this._setupMediaSession();
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
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => this._schedule());
      return;
    }

    // 長時間バックグラウンドから復帰した場合、過去の拍をスキップして再同期
    if (this.nextBeatTime < ctx.currentTime - 1.0) {
      this.nextBeatTime = ctx.currentTime + 0.05;
    }

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
   * 短波形ピッチパイプとの同時再生でも埋もれないよう高ゲイン設定。
   * Q を低めにして通過帯域を広げ、エネルギーを確保。
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
    filter.Q.value         = 8;  // 20→8：帯域を広げてエネルギー増
    env.gain.setValueAtTime(isAccent ? 5.0 : 3.5, time);  // 2.5/1.6→5.0/3.5
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
   */
  _soundSnare(ctx, time, isAccent) {
    const out = this._getOutput();

    // ① ノイズ成分
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

    // ② 低音成分
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
   * WAV Blob + <audio loop> 方式
   *
   * iOS Safari では createMediaStreamDestination() が壊れているため（iOS 11〜未修正）、
   * OfflineAudioContext で無音WAVを生成して Blob URL を <audio loop> で再生する。
   * 実際の音声ファイルを再生する <audio> 要素だけが iOS のオーディオセッションを維持できる。
   *
   * 加えて：
   * - statechange で "interrupted"（iOS 独自状態）を検知して即座に resume
   * - visibilitychange で復帰時に resume + スケジューラー再同期
   */
  async _startBackgroundAudio() {
    if (this._bgAudio || this._silentSource) return;
    const ctx = this.audioContext;

    try {
      // 1秒間の極小音量WAVをOfflineAudioContextで生成
      const offCtx  = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
        1, ctx.sampleRate, ctx.sampleRate
      );
      const osc  = offCtx.createOscillator();
      const gain = offCtx.createGain();
      gain.gain.value = 0.00001; // -100dB 相当（実質無音）
      osc.connect(gain);
      gain.connect(offCtx.destination);
      osc.start(0);
      osc.stop(1);

      const rendered = await offCtx.startRendering();
      const wavBlob  = this._audioBufferToWav(rendered);
      const blobUrl  = URL.createObjectURL(wavBlob);

      const audio = new Audio();
      audio.src   = blobUrl;
      audio.loop  = true;
      audio.volume = 0.001;
      audio.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0.001;pointer-events:none;';
      document.body.appendChild(audio);

      await audio.play().catch(() => {});

      this._bgAudio  = audio;
      this._bgBlobUrl = blobUrl;
    } catch (_) {
      // OfflineAudioContext 未対応環境はフォールバックへ
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

    // AudioContext の状態変化を監視（iOS の "interrupted" 対応）
    this._onStateChange = () => {
      if (!this.isPlaying) return;
      const state = this.audioContext.state;
      if (state === 'suspended' || state === 'interrupted') {
        this.audioContext.resume().catch(() => {});
      }
    };
    this.audioContext.addEventListener('statechange', this._onStateChange);

    // 画面復帰時に AudioContext を再開してスケジューラーを再同期
    this._onVisibilityChange = () => {
      if (document.hidden || !this.isPlaying) return;
      const resumeCtx = this.audioContext;
      const resync = () => {
        this.nextBeatTime = resumeCtx.currentTime + 0.05;
        clearTimeout(this._timerID);
        this._timerID = null;
        this._schedule();
      };
      if (resumeCtx.state !== 'running') {
        resumeCtx.resume().then(resync).catch(() => {});
      } else {
        resync();
      }
      if (this._bgAudio && this._bgAudio.paused) {
        this._bgAudio.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  /**
   * AudioBuffer → WAV Blob 変換
   */
  _audioBufferToWav(buffer) {
    const numCh     = 1;
    const sr        = buffer.sampleRate;
    const data      = buffer.getChannelData(0);
    const len       = data.length;
    const arrBuf    = new ArrayBuffer(44 + len * 2);
    const view      = new DataView(arrBuf);
    const writeStr  = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

    writeStr(0,  'RIFF');
    view.setUint32(4,  36 + len * 2, true);
    writeStr(8,  'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1,    true); // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr,   true);
    view.setUint32(28, sr * 2, true);
    view.setUint16(32, 2,    true);
    view.setUint16(34, 16,   true);
    writeStr(36, 'data');
    view.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) {
      view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 0x7FFF, true);
    }
    return new Blob([arrBuf], { type: 'audio/wav' });
  }

  _stopBackgroundAudio() {
    if (this._onStateChange) {
      this.audioContext.removeEventListener('statechange', this._onStateChange);
      this._onStateChange = null;
    }
    if (this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
    if (this._bgAudio) {
      this._bgAudio.pause();
      if (this._bgAudio.parentNode) this._bgAudio.parentNode.removeChild(this._bgAudio);
      this._bgAudio = null;
    }
    if (this._bgBlobUrl) {
      URL.revokeObjectURL(this._bgBlobUrl);
      this._bgBlobUrl = null;
    }
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
