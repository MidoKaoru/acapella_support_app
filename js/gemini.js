'use strict';

/**
 * gemini.js
 * Gemini File API を用いたアカペラ音声解析クラス。
 * storage.js の getApiKey()、dict.js の normalizeMusicTerms() に依存する。
 */

const NO_SPEECH_MARKER  = '（このセグメントには話し声がありません）';
const SPLIT_OVERLAP_MIN = 1;
const SECTION_ENUMS  = ['Aメロ','Bメロ','Cメロ','1サビ','2サビ','ラスサビ','イントロ','アウトロ','ブリッジ','全体','不明'];
const CATEGORY_ENUMS = ['ピッチ','リズム','ダイナミクス','歌詞・発音','その他'];

class GeminiAudioAnalyzer {
  constructor() {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('Gemini APIキーが設定されていません。設定画面から登録してください。');
    this.apiKey     = apiKey;
    this.baseUrl    = 'https://generativelanguage.googleapis.com/v1beta';
    this.uploadUrl  = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
    this.modelNames = [
      'gemini-2.5-flash',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
    ];
  }

  get _authHeaders() {
    return { 'x-goog-api-key': this.apiKey };
  }

  // ─── モデルフォールバック付きfetch ────────────

  async _fetchForGenerate(options) {
    // モデルフォールバックループ
    for (const modelName of this.modelNames) {
      const url = `${this.baseUrl}/models/${modelName}:generateContent`;
      let response;
      try {
        response = await fetch(url, options);
      } catch (e) {
        if (e instanceof TypeError) {
          throw new Error('ネットワーク接続を確認してください。インターネットに接続されていない可能性があります。');
        }
        throw e;
      }
      if (response.ok) return response;
      if (response.status === 403) throw new Error('APIキーが無効です。設定画面から再登録してください。');
      if (response.status === 429 || response.status === 503) continue;
      throw new Error(`APIエラー [${response.status}]`);
    }

    // 全モデルが429/503 → gemini-2.5-flash固定で指数バックオフリトライ
    const backoffDelays = [2000, 4000, 8000, 16000, 32000];
    const fixedUrl = `${this.baseUrl}/models/gemini-2.5-flash:generateContent`;

    for (const baseDelay of backoffDelays) {
      const jitter = Math.random() * 1000;
      await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));

      let response;
      try {
        response = await fetch(fixedUrl, options);
      } catch (e) {
        if (e instanceof TypeError) {
          throw new Error('ネットワーク接続を確認してください。インターネットに接続されていない可能性があります。');
        }
        throw e;
      }
      if (response.ok) return response;
      if (response.status !== 429 && response.status !== 503) {
        throw new Error(`APIエラー [${response.status}]`);
      }
    }

    throw new Error('1日のAPI利用上限に達した可能性があります。時間をおいてやり直すか、設定画面から別のAPIキーをお試しください。');
  }

  // ─── レスポンス安全抽出 ──────────────────────

  _extractTextFromResponse(data) {
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts?.[0]?.text) {
      const reason = candidate?.finishReason || 'UNKNOWN';
      throw new Error(`APIによる生成が中断されました。finishReason: ${reason}`);
    }
    return candidate.content.parts[0].text;
  }

  _deduplicateLoop(text, threshold = 3) {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < threshold * 2) return text;

    const result = [];
    let consecutiveCount = 1;

    for (let i = 0; i < lines.length; i++) {
      const cur  = lines[i].trim();
      const prev = result.length > 0 ? result[result.length - 1].trim() : null;

      if (cur === prev) {
        consecutiveCount++;
        if (consecutiveCount >= threshold) {
          console.warn(`[deduplicateLoop] ループ検知: "${cur}" が ${consecutiveCount} 回連続`);
          continue;
        }
      } else {
        consecutiveCount = 1;
      }

      result.push(lines[i]);
    }

    return result.join('\n');
  }

  _isLoopedOutput(text, threshold = 3) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length >= 5);
    if (lines.length < 6) return false;
    const counts = new Map();
    for (const l of lines) counts.set(l, (counts.get(l) || 0) + 1);
    const maxCount = Math.max(...counts.values());
    return maxCount >= 4 && maxCount / lines.length >= 0.4;
  }

  _deduplicateFuzzy(text, { windowSize = 5, jaccardThreshold = 0.85, minLen = 8 } = {}) {
    const bigrams = str => {
      const set = new Set();
      for (let i = 0; i < str.length - 1; i++) set.add(str[i] + str[i + 1]);
      return set;
    };
    const jaccard = (a, b) => {
      const intersection = [...a].filter(g => b.has(g)).length;
      const union = new Set([...a, ...b]).size;
      return union === 0 ? 0 : intersection / union;
    };

    const rawLines = text.split('\n');
    const kept = [];
    const window = [];

    for (const line of rawLines) {
      const trimmed = line.trim();
      if (trimmed.length < minLen) {
        kept.push(line);
        continue;
      }
      const bg = bigrams(trimmed);
      const isDuplicate = window.some(w => jaccard(bg, w) >= jaccardThreshold);
      if (!isDuplicate) {
        kept.push(line);
        window.push(bg);
        if (window.length > windowSize) window.shift();
      }
    }

    return kept.join('\n');
  }

  // ─── ① ファイルアップロード（Resumable Upload） ─

  async uploadAudioFile(file) {
    const mimeType = file.type || 'audio/mp4';

    // Step 1: アップロードセッション開始
    const initResponse = await fetch(this.uploadUrl, {
      method: 'POST',
      headers: {
        ...this._authHeaders,
        'X-Goog-Upload-Protocol':             'resumable',
        'X-Goog-Upload-Command':              'start',
        'X-Goog-Upload-Header-Content-Length': file.size.toString(),
        'X-Goog-Upload-Header-Content-Type':   mimeType,
        'Content-Type':                        'application/json',
      },
      body: JSON.stringify({ file: { display_name: file.name } }),
    });

    if (!initResponse.ok) {
      const err = await initResponse.text();
      throw new Error(`アップロード初期化失敗 [${initResponse.status}]: ${err}`);
    }

    const uploadUrl = initResponse.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error('アップロード用URLが取得できませんでした。');

    // Step 2: 実データ送信
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...this._authHeaders,
        'X-Goog-Upload-Offset':  '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: file,
    });

    if (!uploadResponse.ok) {
      const err = await uploadResponse.text();
      throw new Error(`アップロード失敗 [${uploadResponse.status}]: ${err}`);
    }

    const data = await uploadResponse.json();
    return {
      fileUri:  data.file.uri,
      mimeType: data.file.mimeType,
      fileName: data.file.name,
    };
  }

  // ─── ①-2 アクティベーション待機（ポーリング） ──

  async waitForFileActive(fileName, timeoutMs = 300_000) {
    const url      = `${this.baseUrl}/${fileName}`;
    const deadline = Date.now() + timeoutMs;
    let pollInterval = 3000;

    while (Date.now() < deadline) {
      const res = await fetch(url, { headers: this._authHeaders });
      if (!res.ok) throw new Error(`ファイル状態確認失敗: ${res.status}`);

      const data = await res.json();
      if (data.state === 'ACTIVE') return;
      if (data.state === 'FAILED') throw new Error('Googleサーバー側でのファイル処理に失敗しました。');

      await new Promise(resolve => setTimeout(resolve, pollInterval));
      // 3000 → 4500 → 6750 → 10000 ms
      pollInterval = Math.min(Math.floor(pollInterval * 1.5), 10000);
    }
    throw new Error('ファイルのアクティベーションがタイムアウトしました。');
  }

  // ─── ② 文字起こし ───────────────────────────

  async _transcribeWithTemp(fileUri, mimeType, startMin, endMin, temperature) {
    const promptText = `音声の${startMin}:00〜${endMin}:00の話し声のみ文字起こし。
【最重要：何を出力するか】
- 話し声があれば書き起こす
- 話し声がない区間は「${NO_SPEECH_MARKER}」とだけ出力して終了
- 歌唱（リード/コーラス/ボイパ）は完全無視。歌詞は1文字も書かない
【ループ防止】
- 同じ文・フレーズを3回以上繰り返さない
- 直前に書いた行と同じ行を続けて書かない
- 繰り返しそうになったら出力を打ち切ってよい
【オーバーラップ】
- ${endMin - 2}:00以降は次セグメントとオーバーラップ範囲のため省略せず丁寧に`;

    const payload = {
      contents: [{
        parts: [
          { text: promptText },
          { file_data: { file_uri: fileUri, mime_type: mimeType } },
        ],
      }],
      generationConfig: {
        temperature,
        frequencyPenalty: 1.2,
        presencePenalty:  0.6,
        maxOutputTokens:  8192,
      },
    };

    const response = await this._fetchForGenerate({
      method:  'POST',
      headers: { ...this._authHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const data    = await response.json();
    const rawText = this._extractTextFromResponse(data);

    if (rawText.includes(NO_SPEECH_MARKER)) return '';

    return normalizeMusicTerms(
      this._deduplicateLoop(
        this._deduplicateFuzzy(
          rawText.replace(/\n{2,}/g, '\n').trim()
        )
      )
    );
  }

  async transcribeAudio(fileUri, mimeType, startMin, endMin, _isRetry = false) {
    const promptText = `音声の${startMin}:00〜${endMin}:00の話し声のみ文字起こし。
【最重要：何を出力するか】
- 話し声があれば書き起こす
- 話し声がない区間は「${NO_SPEECH_MARKER}」とだけ出力して終了
- 歌唱（リード/コーラス/ボイパ）は完全無視。歌詞は1文字も書かない
【ループ防止】
- 同じ文・フレーズを3回以上繰り返さない
- 直前に書いた行と同じ行を続けて書かない
- 繰り返しそうになったら出力を打ち切ってよい
【オーバーラップ】
- ${endMin - 2}:00以降は次セグメントとオーバーラップ範囲のため省略せず丁寧に`;

    const payload = {
      contents: [{
        parts: [
          { text: promptText },
          { file_data: { file_uri: fileUri, mime_type: mimeType } },
        ],
      }],
      generationConfig: {
        temperature:      0.4,
        frequencyPenalty: 1.2,
        presencePenalty:  0.6,
        maxOutputTokens:  8192,
      },
    };

    const response = await this._fetchForGenerate({
      method:  'POST',
      headers: { ...this._authHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const data      = await response.json();
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;

    // 1. MAX_TOKENS → 自動2分割（再帰1回まで）
    if (finishReason === 'MAX_TOKENS' && !_isRetry) {
      const durationMin = endMin - startMin;
      if (durationMin <= 3) {
        const partialText = candidate?.content?.parts?.[0]?.text || '';
        if (!partialText) return '';
        return normalizeMusicTerms(
          this._deduplicateLoop(
            this._deduplicateFuzzy(
              partialText.replace(/\n{2,}/g, '\n').trim()
            )
          )
        );
      }
      const midMin = Math.floor((startMin + endMin) / 2);
      const [firstHalf, secondHalf] = await Promise.all([
        this.transcribeAudio(fileUri, mimeType, startMin, midMin + SPLIT_OVERLAP_MIN, true),
        this.transcribeAudio(fileUri, mimeType, midMin, endMin, true),
      ]);
      return [firstHalf, secondHalf].filter(t => t).join('\n');
    }

    const rawText = this._extractTextFromResponse(data);

    // 2. NO_SPEECH_MARKER → 空文字を返す
    if (rawText.includes(NO_SPEECH_MARKER)) return '';

    // 3. ループ検出 → temperature 0.7 で1回再試行
    if (this._isLoopedOutput(rawText) && !_isRetry) {
      return this._transcribeWithTemp(fileUri, mimeType, startMin, endMin, 0.7);
    }

    // 4. 正常系
    return normalizeMusicTerms(
      this._deduplicateLoop(
        this._deduplicateFuzzy(
          rawText.replace(/\n{2,}/g, '\n').trim()
        )
      )
    );
  }

  // ─── ② カードスキーマビルダー・正規化ヘルパー ──

  _buildCardSchema(enumStrict = true) {
    const sectionProp  = enumStrict
      ? { type: 'STRING', enum: SECTION_ENUMS }
      : { type: 'STRING' };
    const categoryProp = enumStrict
      ? { type: 'STRING', enum: CATEGORY_ENUMS }
      : { type: 'STRING' };
    return {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id:       { type: 'STRING' },
          section:  sectionProp,
          part:     { type: 'ARRAY', items: { type: 'STRING' } },
          category: categoryProp,
          text:     { type: 'STRING' },
        },
        required: ['id', 'section', 'part', 'category', 'text'],
      },
    };
  }

  _coerceSection(val) {
    if (SECTION_ENUMS.includes(val)) return val;
    if (['ラストのサビ', '最後のサビ'].some(a => val.includes(a))) return 'ラスサビ';
    if (['最初のサビ', '1番のサビ'].some(a => val.includes(a)))   return '1サビ';
    return '不明';
  }

  _coerceCategory(val) {
    if (CATEGORY_ENUMS.includes(val)) return val;
    return 'その他';
  }

  // ─── ② セグメントカード抽出 ─────────────────

  async _callCardApi(promptText, enumStrict) {
    const payload = {
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        response_mime_type: 'application/json',
        response_schema: {
          type: 'OBJECT',
          properties: { cards: this._buildCardSchema(enumStrict) },
          required: ['cards'],
        },
        temperature: 0.1,
      },
    };

    const response = await this._fetchForGenerate({
      method:  'POST',
      headers: { ...this._authHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const data = await response.json();
    return this._extractTextFromResponse(data);
  }

  async analyzeSegmentCards(transcript, { practiceDate = '', songTitle = '', groupName = '' } = {}) {
    const contextLine = [
      practiceDate && `練習日: ${practiceDate}`,
      songTitle    && `曲名: ${songTitle}`,
      groupName    && `グループ名: ${groupName}`,
    ].filter(Boolean).join(' / ');

    const promptText = `あなたは優秀な練習フィードバック抽出アシスタントです。
以下の文字起こしテキストから、練習中にメンバーが実際に発言したフィードバック・指摘・決定事項のみを抽出し、カード配列として出力してください。
${contextLine ? `【練習情報】${contextLine}\n` : ''}
【厳守事項】
- あなた自身が評価・アドバイスを生成することは固く禁じます。
- 発言されたフィードバックのみを抽出すること。
- 重複する指摘は1つのカードに統合すること。
- 文字起こしの無意味なループ・繰り返しは完全に無視すること。

【セクション認識の基準】
「Aメロ」「Bメロ」「サビ」「イントロ」「ラスサビ」「ブリッジ」等の固有名詞、または「最初の」「2番の」等の順序表現が明示された場合のみセクションを特定すること。
代名詞のみの場合は「全体」とすること。

【パート識別】
「リード」「トップ」「セカンド」「サード」「フォース」「バリトン」「ベース」「パーカス/ボイパ」から判断すること。
判断できない場合は「全体」とすること。

【文字起こしテキスト】
${transcript}`.trim();

    let rawJson;
    let needsCoerce = false;

    try {
      rawJson = await this._callCardApi(promptText, true);
    } catch (e) {
      if (!e.message.includes('[400]')) throw e;
      needsCoerce = true;
      rawJson = await this._callCardApi(promptText, false);
    }

    const normalize = (cards) => {
      if (needsCoerce) {
        cards = cards.map(c => ({
          ...c,
          section:  this._coerceSection(c.section  ?? ''),
          category: this._coerceCategory(c.category ?? ''),
        }));
      }
      return cards.map(c => ({ ...c, text: normalizeMusicTerms(c.text ?? '') }));
    };

    const enumStrict = !needsCoerce;
    try {
      const parsed = JSON.parse(rawJson);
      return normalize(Array.isArray(parsed.cards) ? parsed.cards : []);
    } catch {
      try {
        const retryJson = await this._callCardApi(promptText, enumStrict);
        const parsed    = JSON.parse(retryJson);
        return normalize(Array.isArray(parsed.cards) ? parsed.cards : []);
      } catch {
        console.error('[analyzeSegmentCards] フェイルソフト: JSONパース再試行失敗');
        return [];
      }
    }
  }

  // ─── ③ 構造化解析（JSON生成） ───────────────

  async analyzeStructure(transcript, { practiceDate = '', songTitle = '', groupName = '' } = {}) {
    const contextLine = [
      practiceDate && `練習日: ${practiceDate}`,
      songTitle    && `曲名: ${songTitle}`,
      groupName    && `グループ名: ${groupName}`,
    ].filter(Boolean).join(' / ');

    const promptText = `
あなたは優秀な議事録作成アシスタントです。
提供された文字起こしテキストをもとに、練習中のメンバー同士が口頭で行ったフィードバックや話し合いの内容のみを抽出・構造化してください。
${contextLine ? `【練習情報】${contextLine}\n` : ''}
【session_name の生成規則】
「${practiceDate || '日付不明'} ${songTitle ? songTitle + ' ' : ''}練習」の形式で生成すること。

【厳守事項】
- あなた自身が歌唱を評価したり、新しいアドバイスを捏造することは固く禁じます。
- メンバーが実際に発言した内容（指摘・決定事項・反省点）だけを抽出してください。
- 誰が誰に向けて言ったか（対象パート）と、何についての指摘か（カテゴリ）を必ず分類してください。
【セクション認識の基準】
「Aメロ」「Bメロ」「サビ」「イントロ」「ラスサビ」「ブリッジ」等の固有名詞、
または「最初の」「2番の」「最後の」等の順序表現が明示された場合のみセクションを特定すること。
「さっきのとこ」「あそこ」等の代名詞のみの場合は直ちに「全体」として出力すること。
出力名称は「Aメロ」「Bメロ」「1サビ」「ラスサビ」「イントロ」「アウトロ」「全体」「不明」のように
短く統一感のある形式に揃えること。
- 文字起こしテキスト内にAIのバグによる無意味な言葉の無限ループや繰り返しが含まれている場合があるが、それらは完全に無視し、意味のあるフィードバック内容のみを抽出すること。
- 音源のオーバーラップ結合や練習中の反復による「同じ指摘の重複」を検知・排除し、重複する指摘は1つのカードに統合・集約すること。

【パート識別の補助】
「リード」「トップ」「セカンド」「サード」「フォース」「バリトン」「ベース」「パーカス/ボイパ」
これらの語が文中に現れない場合、直前の発言文脈からパートを推定すること。
「さっきのとこ」「あそこ」「そっち」等の代名詞はパート特定の根拠にしないこと。
それでも判断できない場合のみ「全体」とすること。

【文字起こしテキスト】
${transcript}
    `;

    const responseSchema = {
      type: 'OBJECT',
      properties: {
        session_name: { type: 'STRING' },
        recorded_at:  { type: 'STRING' },
        transcript:   { type: 'STRING' },
        cards: {
          type:  'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              id:            { type: 'STRING' },
              section:       { type: 'STRING' },
              part:          { type: 'ARRAY', items: { type: 'STRING' } },
              category:      { type: 'STRING', enum: ['ピッチ', 'リズム', 'ダイナミクス', '歌詞・発音', 'その他'] },
              text:          { type: 'STRING' },
            },
            required: ['id', 'section', 'part', 'category', 'text'],
          },
        },
      },
      required: ['session_name', 'recorded_at', 'transcript', 'cards'],
    };

    const payload = {
      contents: [{
        parts: [
          { text: promptText },
        ],
      }],
      generationConfig: {
        response_mime_type: 'application/json',
        response_schema:    responseSchema,
        temperature:        0.1,
      },
    };

    const response = await this._fetchForGenerate({
      method:  'POST',
      headers: { ...this._authHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const data       = await response.json();
    const jsonString = this._extractTextFromResponse(data);

    try {
      const result = JSON.parse(jsonString);
      if (Array.isArray(result.cards)) {
        result.cards = result.cards.map(card => ({
          ...card,
          text:     normalizeMusicTerms(card.text),
          section:  [card.section],
          category: [card.category],
        }));
      }
      return result;
    } catch (e) {
      throw new Error(`JSONパース失敗: ${e.message}`);
    }
  }

  // ─── サーバー上のファイルを削除（クリーンアップ） ─

  async deleteFile(fileName) {
    const url = `${this.baseUrl}/${fileName}`;
    const res = await fetch(url, { method: 'DELETE', headers: this._authHeaders });
    if (!res.ok) throw new Error(`ファイル削除失敗 [${res.status}]`);
  }

  _groupCardsForMerge(allCards) {
    const groups = new Map();
    for (const card of allCards) {
      const key = `${card.section}|${card.part.join(',')}|${card.category}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(card);
    }
    return groups;
  }

  // ─── ⑤ マージ＆ファイナライズ ────────────────

  _bigramsSet(str) {
    const set = new Set();
    for (let i = 0; i < str.length - 1; i++) set.add(str[i] + str[i + 1]);
    return set;
  }

  _jaccardScore(a, b) {
    const intersection = [...a].filter(g => b.has(g)).length;
    const union = new Set([...a, ...b]).size;
    return union === 0 ? 0 : intersection / union;
  }

  _jaccardFallbackMerge(cards, threshold = 0.7) {
    const merged = [];
    for (const card of cards) {
      const bg = this._bigramsSet(card.text);
      const isDup = merged.some(m => this._jaccardScore(bg, this._bigramsSet(m.text)) >= threshold);
      if (!isDup) merged.push(card);
    }
    return merged;
  }

  async _mergeGroupsByLLM(cards) {
    const cardLines = cards.map((c, i) => `[${i + 1}] ${c.text}`).join('\n');

    const promptText = `以下は同じセクション・パート・カテゴリに属する練習フィードバックカードのリストです。
完全に同じ内容、またはほぼ同一の指摘のみを1つに統合してください。

【厳守事項】
- 完全に同じ / ほぼ同一の指摘のみ統合すること
- 迷ったら統合しない。別カードのまま残すこと
- このリスト内のみで判断し、グループをまたいだ統合は禁止
- 統合後テキストは元カードのテキストをそのまま使うか最小限の編集にとどめること

【カードリスト】
${cardLines}`;

    const payload = {
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        response_mime_type: 'application/json',
        response_schema: {
          type: 'OBJECT',
          properties: {
            texts: { type: 'ARRAY', items: { type: 'STRING' } },
          },
          required: ['texts'],
        },
        temperature: 0.1,
      },
    };

    const response = await this._fetchForGenerate({
      method:  'POST',
      headers: { ...this._authHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const data    = await response.json();
    const rawJson = this._extractTextFromResponse(data);
    const { texts } = JSON.parse(rawJson);

    const { section, part, category } = cards[0];
    return texts.map(text => ({ section, part, category, text: normalizeMusicTerms(text) }));
  }

  async mergeAndFinalize(allCards, { session_name = '', recorded_at = '' } = {}) {
    const groups = this._groupCardsForMerge(allCards);
    const trivialMerged = [];
    const mergePromises = [];

    for (const [, cards] of groups) {
      if (cards.length === 1) {
        trivialMerged.push(cards[0]);
      } else {
        mergePromises.push(
          this._mergeGroupsByLLM(cards).catch(() => this._jaccardFallbackMerge(cards))
        );
      }
    }

    const mergedGroups = await Promise.all(mergePromises);
    const allMerged = [...trivialMerged, ...mergedGroups.flat()];

    const cards = allMerged.map((card, i) => ({
      id:       `card-${i + 1}`,
      section:  Array.isArray(card.section)  ? card.section  : [card.section],
      part:     Array.isArray(card.part)      ? card.part     : [card.part],
      category: Array.isArray(card.category) ? card.category : [card.category],
      text:     normalizeMusicTerms(card.text ?? ''),
    }));

    return { session_name, recorded_at, cards };
  }
}
