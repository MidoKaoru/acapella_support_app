/**
 * pitch-pipe.js
 * ピッチパイプ機能
 * - 12音ボタン ON/OFF トグル（複数同時発音対応）
 * - 基準周波数 420〜460Hz 可変（A4 基準）
 * - 音色：サイン波 / 三角波 / 矩形波
 * - iOS Safari 対応：AudioContext は外部から注入
 * - バックグラウンド再生：無音ループ ＋ visibilitychange でコンテキスト復帰
 */

class PitchPipe {
  constructor() {
    this.audioContext = null;

    // A4 からの半音オフセットで周波数を計算
    this.notes = [
      { name: 'C',  solfege: 'ド',    offset: -9, isSharp: false },
      { name: 'C♯', solfege: 'ド♯',  offset: -8, isSharp: true  },
      { name: 'D',  solfege: 'レ',    offset: -7, isSharp: false },
      { name: 'D♯', solfege: 'レ♯',  offset: -6, isSharp: true  },
      { name: 'E',  solfege: 'ミ',    offset: -5, isSharp: false },
      { name: 'F',  solfege: 'ファ',  offset: -4, isSharp: false },
      { name: 'F♯', solfege: 'ファ♯', offset: -3, isSharp: true  },
      { name: 'G',  solfege: 'ソ',    offset: -2, isSharp: false },
      { name: 'G♯', solfege: 'ソ♯',  offset: -1, isSharp: true  },
      { name: 'A',  solfege: 'ラ',    offset:  0, isSharp: false },
      { name: 'A♯', solfege: 'ラ♯',  offset:  1, isSharp: true  },
      { name: 'B',  solfege: 'シ',    offset:  2, isSharp: false },
    ];

    this.baseFreq    = 440;   // A4 基準（Hz）
    this.waveType    = 'sine';
    this.activeNodes = {};    // name -> { oscillator, gainNode }

    // バックグラウンド再生用
    this._bgAudio            = null;
    this._bgBlobUrl          = null;
    this._silentSource       = null;
    this._onStateChange      = null;
    this._onVisibilityChange = null;
  }

  /** app.js から共有 AudioContext を注入 */
  setAudioContext(ctx) {
    this.audioContext = ctx;
  }

  /** offset 半音ぶんずらした周波数を返す */
  _freq(offset) {
    return this.baseFreq * Math.pow(2, offset / 12);
  }

  /**
   * 音名をトグル（ON→OFF、OFF→ON）
   * @returns {boolean} true = 発音中になった
   */
  toggle(noteName) {
    if (this.activeNodes[noteName]) {
      this._stop(noteName);
      return false;
    } else {
      this._play(noteName);
      return true;
    }
  }

  /** 発音 */
  _play(noteName) {
    if (!this.audioContext) return;
    const note = this.notes.find(n => n.name === noteName);
    if (!note) return;

    const wasEmpty = Object.keys(this.activeNodes).length === 0;

    const ctx  = this.audioContext;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = this.waveType;
    osc.frequency.value = this._freq(note.offset);

    // フェードイン（クリックノイズ防止）
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 0.012);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();

    this.activeNodes[noteName] = { oscillator: osc, gainNode: gain };

    // 最初の音を鳴らしたタイミングでバックグラウンド再生を起動
    if (wasEmpty) this._startBgAudio();
  }

  /** 停止（フェードアウト付き） */
  _stop(noteName) {
    const entry = this.activeNodes[noteName];
    if (!entry) return;
    const { oscillator, gainNode } = entry;
    const ctx = this.audioContext;

    gainNode.gain.setTargetAtTime(0, ctx.currentTime, 0.008);
    oscillator.stop(ctx.currentTime + 0.05);
    delete this.activeNodes[noteName];

    // 全音が停止したらバックグラウンド再生を解放
    if (Object.keys(this.activeNodes).length === 0) this._stopBgAudio();
  }

  /** 全音停止 */
  stopAll() {
    Object.keys(this.activeNodes).forEach(name => this._stop(name));
  }

  /** 基準周波数を変更（発音中の音にリアルタイム反映） */
  setBaseFreq(freq) {
    this.baseFreq = freq;
    if (!this.audioContext) return;
    Object.entries(this.activeNodes).forEach(([name, { oscillator }]) => {
      const note = this.notes.find(n => n.name === name);
      if (note) {
        oscillator.frequency.setTargetAtTime(
          this._freq(note.offset),
          this.audioContext.currentTime,
          0.02
        );
      }
    });
  }

  /** 音色変更（発音中の音を再起動して即時反映） */
  setWaveType(type) {
    this.waveType = type;
    const playing = Object.keys(this.activeNodes);
    playing.forEach(name => {
      this._stop(name);
      this._play(name);
    });
  }

  // ─── バックグラウンド再生（iOS 対応） ────────────

  async _startBgAudio() {
    if (this._bgAudio || this._silentSource) return;
    const ctx = this.audioContext;

    try {
      // 1秒の無音 WAV を OfflineAudioContext でレンダリングして <audio loop> に渡す
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
      // フォールバック：AudioContext 内の無音ループ
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

    // AudioContext が suspend / interrupt されたら即 resume
    this._onStateChange = () => {
      if (Object.keys(this.activeNodes).length === 0) return;
      const s = this.audioContext.state;
      if (s === 'suspended' || s === 'interrupted') {
        this.audioContext.resume().catch(() => {});
      }
    };
    this.audioContext.addEventListener('statechange', this._onStateChange);

    // フォアグラウンド復帰時に AudioContext と <audio> を再開
    this._onVisibilityChange = () => {
      if (document.hidden) return;
      if (Object.keys(this.activeNodes).length === 0) return;
      if (this.audioContext.state !== 'running') {
        this.audioContext.resume().catch(() => {});
      }
      if (this._bgAudio && this._bgAudio.paused) {
        this._bgAudio.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  _stopBgAudio() {
    if (this._onStateChange) {
      this.audioContext?.removeEventListener('statechange', this._onStateChange);
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
}
