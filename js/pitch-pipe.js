/**
 * pitch-pipe.js
 * ピッチパイプ機能
 * - 12音ボタン ON/OFF トグル（複数同時発音対応）
 * - 基準周波数 420〜460Hz 可変（A4 基準）
 * - 音色：サイン波 / 三角波 / 矩形波
 * - iOS Safari 対応：AudioContext は外部から注入
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

    this.baseFreq = 440;      // A4 基準（Hz）
    this.waveType = 'sine';
    this.activeNodes = {};    // name -> { oscillator, gainNode }
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

    const ctx = this.audioContext;
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

}
