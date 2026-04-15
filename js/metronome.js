/**
 * metronome.js
 * - ルックアヘッドスケジューリング（先読み3秒：iOS setTimeout throttle 対策）
 * - _scheduledNodes でスケジュール済みノードを追跡し stop() で即時キャンセル
 * - WAV Blob + <audio loop> でバックグラウンド再生（iOS 対応）
 * - Media Session API（ロック画面操作）
 */

class Metronome {
  constructor() {
    this.audioContext    = null;
    this.isPlaying       = false;
    this.bpm             = 120;
    this.beatsPerMeasure = 4;
    this.currentBeat     = 0;
    this.nextBeatTime    = 0;
    this.soundType       = 'woodblock';
    // 12等分の裏拍パターン。各要素は 0〜11 のステップ番号。
    // 0（12時）= 表拍で常にON（このリストには含まず別途鳴らす）。
    // 例: [6] = 8分裏、[3,6,9] = 16分、[8] = シャッフル
    this.subdivisionSteps = []; // 0〜11 のうち表拍(0)以外でONにするステップ

    this._lookaheadMs   = 25;
    this._scheduleAhead = 5.0; // 5秒先読み：スイッチ・スリープ時のビート枯渇を防ぐ
    this._timerID       = null;
    this._schedulerGen  = 0;

    // スケジュール済み source ノードの追跡（キャンセル用）
    this._scheduledNodes = [];

    this._tapTimes   = [];
    this._compressor = null;

    this._bgAudio            = null;
    this._bgBlobUrl          = null;
    this._silentSource       = null;
    this._onVisibilityChange = null;
    this._onStateChange      = null;

    this.onBeat = null;
  }

  setAudioContext(ctx) {
    this.audioContext = ctx;
    this._compressor  = null;
  }

  get _secondsPerBeat() { return 60.0 / this.bpm; }

  // ─── 公開 API ───────────────────────────────────

  setBPM(bpm) {
    this.bpm = Math.max(20, Math.min(300, Math.round(bpm)));
    if (this.isPlaying && this.audioContext) this._resetScheduler();
  }

  setTimeSignature(sig) {
    const map = { '4/4': 4, '3/4': 3, '2/4': 2, '6/8': 6 };
    this.beatsPerMeasure = map[sig] ?? 4;
    this.currentBeat = 0;
    if (this.isPlaying && this.audioContext) this._resetScheduler();
  }

  setSoundType(type) {
    this.soundType = type;
    if (this.isPlaying && this.audioContext) this._resetScheduler();
  }

  /** 裏拍ステップを設定（0〜11、0=表拍は除く）*/
  setSubdivisionSteps(steps) {
    this.subdivisionSteps = steps.filter(s => s !== 0);
    if (this.isPlaying && this.audioContext) this._resetScheduler();
  }

  start() {
    if (!this.audioContext || this.isPlaying) return;
    if (this.audioContext.state === 'suspended') this.audioContext.resume();

    this.isPlaying       = true;
    this.currentBeat     = 0;
    this.nextBeatTime    = this.audioContext.currentTime + 0.05;
    this._scheduledNodes = [];

    this._schedule();
    this._startBackgroundAudio();
    this._setupMediaSession();
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    clearTimeout(this._timerID);
    this._timerID = null;
    this._schedulerGen++;

    // スケジュール済みの音を全て即時停止
    this._cancelScheduledNodes();

    this._stopBackgroundAudio();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    if (this.onBeat) this.onBeat(-1);
  }

  tapTempo() {
    const now = Date.now();
    this._tapTimes = this._tapTimes.filter(t => now - t < 2000);
    this._tapTimes.push(now);
    if (this._tapTimes.length < 2) return null;
    const intervals = [];
    for (let i = 1; i < this._tapTimes.length; i++) {
      intervals.push(this._tapTimes[i] - this._tapTimes[i - 1]);
    }
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    return Math.max(20, Math.min(300, Math.round(60000 / avg)));
  }

  /** 通常拍頭（beatLevel=1）の音を即時再生。タップ入力のフィードバック用 */
  playBeatSound(ctx) {
    if (this.audioContext !== ctx) {
      this.audioContext = ctx;
      this._compressor  = null;
    }
    const now = ctx.currentTime;
    switch (this.soundType) {
      case 'woodblock': this._soundWoodblock(ctx, now, 1); break;
      default:          this._soundClick(ctx, now, 1);     break;
    }
  }

  // ─── スケジューラーリセット ──────────────────────

  /**
   * BPM・拍子・音色変更 / バックグラウンド復帰時に呼ぶ。
   * スケジュール済みノードを stop() で即時停止し、現在時刻から再スケジュール。
   * masterGain のゲイン操作は一切行わない（ゲイン操作では将来ノードを消せない）。
   */
  _resetScheduler() {
    this._schedulerGen++;
    clearTimeout(this._timerID);
    this._timerID = null;

    this._cancelScheduledNodes();

    this.nextBeatTime = this.audioContext.currentTime + 0.05;
    this._schedule();
  }

  /**
   * _scheduledNodes に登録されている全ノードを即時 stop() する。
   * Web Audio API では stop(now) を呼ぶと、まだ start していないノードも
   * 音を出さずに終了する（start time > stop time のため）。
   */
  _cancelScheduledNodes() {
    const now = this.audioContext ? this.audioContext.currentTime : 0;
    for (const node of this._scheduledNodes) {
      try { node.stop(now); } catch (_) {}
    }
    this._scheduledNodes = [];
  }

  // ─── 出力ノード ─────────────────────────────────

  _getOutput() {
    const ctx = this.audioContext;
    if (!this._compressor) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -6;
      comp.knee.value      = 4;
      comp.ratio.value     = 10;
      comp.attack.value    = 0.001;
      comp.release.value   = 0.05;
      comp.connect(ctx.destination);
      this._compressor = comp;
    }
    return this._compressor;
  }

  // ─── スケジューラー ──────────────────────────────

  _schedule() {
    const gen = this._schedulerGen; // この世代番号でスケジューラーを識別
    const ctx = this.audioContext;

    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        if (this.isPlaying && this._schedulerGen === gen) this._schedule();
      });
      return;
    }

    if (this.nextBeatTime < ctx.currentTime - 0.5) {
      this.nextBeatTime = ctx.currentTime + 0.05;
    }

    while (this.nextBeatTime < ctx.currentTime + this._scheduleAhead) {
      this._scheduleClick(this.nextBeatTime, this.currentBeat);
      this.nextBeatTime += this._secondsPerBeat;
      this.currentBeat = (this.currentBeat + 1) % this.beatsPerMeasure;
    }

    this._timerID = setTimeout(() => {
      // 世代が変わっていたら（_resetScheduler が呼ばれた）何もしない
      if (this.isPlaying && this._schedulerGen === gen) this._schedule();
    }, this._lookaheadMs);
  }

  _scheduleClick(time, beat) {
    const ctx = this.audioContext;
    // beatLevel: 2=1拍目アクセント / 1=その他の拍頭 / 0=裏拍（細分）
    const mainLevel = beat === 0 ? 2 : 1;

    // メインビート
    switch (this.soundType) {
      case 'woodblock': this._soundWoodblock(ctx, time, mainLevel); break;
      case 'snare':     this._soundSnare(ctx, time, mainLevel);     break;
      default:          this._soundClick(ctx, time, mainLevel);     break;
    }

    // 裏拍（12等分ステップ）
    for (const step of this.subdivisionSteps) {
      const subTime = time + this._secondsPerBeat * (step / 12);
      switch (this.soundType) {
        case 'woodblock': this._soundWoodblock(ctx, subTime, 0); break;
        case 'snare':     this._soundSnare(ctx, subTime, 0);     break;
        default:          this._soundClick(ctx, subTime, 0);     break;
      }
    }

    const gen     = this._schedulerGen;
    const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    setTimeout(() => {
      if (this.isPlaying && this.onBeat && this._schedulerGen === gen) {
        this.onBeat(beat);
      }
    }, delayMs);
  }

  // ─── 音生成（全ノードを _scheduledNodes に登録） ─

  // beatLevel: 2=アクセント(1拍目) / 1=通常拍頭 / 0=裏拍
  // 設計: 高域ノイズバースト(4kHz帯) + サイン波トーン の2層構造
  // → ノイズが "カチッ" という硬い立ち上がりを作り、トーンが音程感を与える
  _soundClick(ctx, time, beatLevel) {
    const out = this._getOutput();

    // [sub, beat, accent]
    const oscFreqs  = [ 900, 1300, 1700]; // トーン音程（高いほど硬く聞こえる）
    const oscGains  = [ 0.5,  1.0,  1.6];
    const oscDecays = [0.025, 0.038, 0.05];
    const nGains    = [ 0.5,  1.0,  1.6]; // 高域ノイズの強さ

    // ── 高域ノイズバースト（硬い立ち上がり "カチッ"）
    const nLen  = Math.floor(ctx.sampleRate * 0.007); // 7ms
    const nBuf  = ctx.createBuffer(1, nLen, ctx.sampleRate);
    const nData = nBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) nData[i] = Math.random() * 2 - 1;

    const nSrc = ctx.createBufferSource();
    const nBp  = ctx.createBiquadFilter();
    const nEnv = ctx.createGain();
    nSrc.buffer          = nBuf;
    nBp.type             = 'bandpass';
    nBp.frequency.value  = 4500; // 4.5kHz: 声域(300Hz〜3kHz)の上を突く
    nBp.Q.value          = 2.5;
    nEnv.gain.setValueAtTime(nGains[beatLevel], time);
    nEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.006);
    nSrc.connect(nBp); nBp.connect(nEnv); nEnv.connect(out);
    nSrc.start(time); nSrc.stop(time + 0.012);

    // ── サイン波トーン（音程感・持続）
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.value = oscFreqs[beatLevel];
    env.gain.setValueAtTime(oscGains[beatLevel], time);
    env.gain.exponentialRampToValueAtTime(0.001, time + oscDecays[beatLevel]);
    osc.connect(env); env.connect(out);
    osc.start(time); osc.stop(time + oscDecays[beatLevel] + 0.01);

    this._scheduledNodes.push(nSrc, osc);
    [nSrc, osc].forEach(node => {
      node.onended = () => {
        const i = this._scheduledNodes.indexOf(node);
        if (i !== -1) this._scheduledNodes.splice(i, 1);
      };
    });
  }

  // beatLevel: 2=アクセント(1拍目) / 1=通常拍頭 / 0=裏拍
  // 設計: 2本のバンドパス共鳴器を並列で鳴らす
  //   低域共鳴: 木の「コン」という胴体音
  //   高域共鳴: 「カッ」という硬い打撃感。声域(3kHz以上)を突く
  _soundWoodblock(ctx, time, beatLevel) {
    const out = this._getOutput();

    // [sub, beat, accent]
    const loFreqs  = [ 700, 1000, 1300]; // 低域共鳴周波数
    const loGains  = [ 1.4,  2.8,  4.5];
    const loDecays = [0.06, 0.08, 0.10];
    const loQ      = 14; // Qが高いほど「木」らしいリング感

    const hiFreqs  = [2200, 3000, 3800]; // 高域打撃成分（声を突き抜ける帯域）
    const hiGains  = [ 1.0,  2.0,  3.2];
    const hiDecays = [0.012, 0.018, 0.024]; // 非常に短い → 硬い立ち上がり
    const hiQ      = 6;

    const bufLen = Math.floor(ctx.sampleRate * 0.11);

    [[loFreqs, loGains, loDecays, loQ], [hiFreqs, hiGains, hiDecays, hiQ]]
      .forEach(([freqs, gains, decays, Q]) => {
        const buf  = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

        const src = ctx.createBufferSource();
        const bp  = ctx.createBiquadFilter();
        const env = ctx.createGain();

        src.buffer         = buf;
        bp.type            = 'bandpass';
        bp.frequency.value = freqs[beatLevel];
        bp.Q.value         = Q;
        env.gain.setValueAtTime(gains[beatLevel], time);
        env.gain.exponentialRampToValueAtTime(0.001, time + decays[beatLevel]);

        src.connect(bp); bp.connect(env); env.connect(out);
        src.start(time);
        src.stop(time + decays[beatLevel] + 0.02);

        this._scheduledNodes.push(src);
        src.onended = () => {
          const i = this._scheduledNodes.indexOf(src);
          if (i !== -1) this._scheduledNodes.splice(i, 1);
        };
      });
  }

  // beatLevel: 2=アクセント(1拍目) / 1=通常拍頭 / 0=裏拍
  _soundSnare(ctx, time, beatLevel) {
    // [sub, beat, accent]
    const noiseHpFreqs = [2400, 2000, 1800]; // 裏拍は高域カット→細く薄く
    const noiseGains   = [ 0.6,  1.4,  2.2];
    const noiseDecays  = [0.07, 0.10, 0.12];
    const bodyFreqs    = [ 110,  170,  220];
    const bodyGains    = [ 0.4,  1.0,  1.8];
    const bodyDecays   = [0.05, 0.07, 0.09];

    const out = this._getOutput();

    const noiseLen  = Math.floor(ctx.sampleRate * 0.15);
    const noiseBuf  = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const noiseData = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) noiseData[i] = Math.random() * 2 - 1;

    const noiseSrc = ctx.createBufferSource();
    const hipass   = ctx.createBiquadFilter();
    const noiseEnv = ctx.createGain();

    noiseSrc.buffer        = noiseBuf;
    hipass.type            = 'highpass';
    hipass.frequency.value = noiseHpFreqs[beatLevel];
    noiseEnv.gain.setValueAtTime(noiseGains[beatLevel], time);
    noiseEnv.gain.exponentialRampToValueAtTime(0.001, time + noiseDecays[beatLevel]);

    noiseSrc.connect(hipass);
    hipass.connect(noiseEnv);
    noiseEnv.connect(out);
    noiseSrc.start(time);
    noiseSrc.stop(time + noiseDecays[beatLevel] + 0.03);

    const bodyOsc = ctx.createOscillator();
    const bodyEnv = ctx.createGain();

    bodyOsc.frequency.setValueAtTime(bodyFreqs[beatLevel], time);
    bodyOsc.frequency.exponentialRampToValueAtTime(45, time + bodyDecays[beatLevel]);
    bodyEnv.gain.setValueAtTime(bodyGains[beatLevel], time);
    bodyEnv.gain.exponentialRampToValueAtTime(0.001, time + bodyDecays[beatLevel]);

    bodyOsc.connect(bodyEnv);
    bodyEnv.connect(out);
    bodyOsc.start(time);
    bodyOsc.stop(time + bodyDecays[beatLevel] + 0.02);

    this._scheduledNodes.push(noiseSrc, bodyOsc);
    const cleanup = (node) => {
      node.onended = () => {
        const i = this._scheduledNodes.indexOf(node);
        if (i !== -1) this._scheduledNodes.splice(i, 1);
      };
    };
    cleanup(noiseSrc);
    cleanup(bodyOsc);
  }

  // ─── バックグラウンド再生（iOS 対応） ────────────

  async _startBackgroundAudio() {
    if (this._bgAudio || this._silentSource) return;
    const ctx = this.audioContext;

    try {
      const offCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
        1, ctx.sampleRate, ctx.sampleRate
      );
      const osc  = offCtx.createOscillator();
      const gain = offCtx.createGain();
      gain.gain.value = 0.00001;
      osc.connect(gain);
      gain.connect(offCtx.destination);
      osc.start(0);
      osc.stop(1);

      const rendered = await offCtx.startRendering();
      const blobUrl  = URL.createObjectURL(this._audioBufferToWav(rendered));

      const audio = new Audio();
      audio.src    = blobUrl;
      audio.loop   = true;
      audio.volume = 0.001;
      audio.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0.001;pointer-events:none;';
      document.body.appendChild(audio);
      await audio.play().catch(() => {});

      this._bgAudio   = audio;
      this._bgBlobUrl = blobUrl;
    } catch (_) {
      const sr  = ctx.sampleRate;
      const buf = ctx.createBuffer(1, sr, sr);
      const d   = buf.getChannelData(0);
      for (let i = 0; i < sr; i++) d[i] = (Math.random() * 2 - 1) * 0.00005;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop   = true;
      src.connect(ctx.destination);
      src.start();
      this._silentSource = src;
    }

    this._onStateChange = () => {
      if (!this.isPlaying) return;
      const s = this.audioContext.state;
      if (s === 'suspended' || s === 'interrupted') {
        this.audioContext.resume().catch(() => {});
      }
    };
    this.audioContext.addEventListener('statechange', this._onStateChange);

    this._onVisibilityChange = () => {
      if (document.hidden || !this.isPlaying) return;
      const resumeCtx = this.audioContext;

      // ノードはキャンセルしない（地続きで再生継続）
      // 世代を上げてスケジューラーだけ再起動する
      const resume = () => {
        this._schedulerGen++;
        clearTimeout(this._timerID);
        this._timerID = null;

        // 現在鳴っているビートを逆算して即座にライトを点灯する。
        // nextBeatTime/currentBeat から「今の位置」を求める：
        //   nextBeatTime から k 個前のビート（k = ceil((nextBeatTime - now) / spb)）
        //   が now 以前に最も近い既スケジュール済みビート。
        const ctx = this.audioContext;
        const now = ctx.currentTime;
        if (this.onBeat && this.nextBeatTime > now) {
          const k = Math.ceil((this.nextBeatTime - now) / this._secondsPerBeat);
          const beatIdx = (this.currentBeat - k + this.beatsPerMeasure * 1000) % this.beatsPerMeasure;
          this.onBeat(beatIdx);
        }

        this._schedule();
      };

      // resume() の完了を待たずに即時呼ぶ。
      // AudioContext がまだ suspended でも _schedule() 内部で再試行するため安全。
      if (resumeCtx.state !== 'running') resumeCtx.resume().catch(() => {});
      resume();
      if (this._bgAudio && this._bgAudio.paused) {
        this._bgAudio.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  _audioBufferToWav(buffer) {
    const sr       = buffer.sampleRate;
    const data     = buffer.getChannelData(0);
    const len      = data.length;
    const arrBuf   = new ArrayBuffer(44 + len * 2);
    const view     = new DataView(arrBuf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + len * 2, true);
    writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);  view.setUint32(24, sr, true);
    view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); writeStr(36, 'data');
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

  // ─── Media Session API ───────────────────────────

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
