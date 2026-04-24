'use strict';

/**
 * gemini.js
 * Gemini File API を用いたアカペラ音声解析クラス。
 * storage.js の getApiKey()、dict.js の normalizeMusicTerms() に依存する。
 */

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

  async transcribeAudio(fileUri, mimeType, startMin, endMin) {
    const promptText =
      `この音声ファイルの${startMin}:00〜${endMin}:00の範囲内にある話し声だけを文字起こしして。` +
      `なお ${endMin - 2}:00 以降は次のセグメントとオーバーラップする範囲のため、` +
      `${endMin - 2}:00 以降の発言は特に省略せず丁寧に書き起こすこと。` +
      `歌唱（コーラス、リードボーカル、ボイパなど）の部分は絶対に含めず完全に無視してください。`;

    const payload = {
      contents: [{
        parts: [
          { text: promptText },
          { file_data: { file_uri: fileUri, mime_type: mimeType } },
        ],
      }],
      generationConfig: {
        temperature:      0.2,
        frequencyPenalty: 0.5,
        presencePenalty:  0.3,
      },
    };

    const response = await this._fetchForGenerate({
      method:  'POST',
      headers: { ...this._authHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const data    = await response.json();
    const rawText = this._extractTextFromResponse(data);

    return normalizeMusicTerms(
      this._deduplicateLoop(
        rawText.replace(/\n{2,}/g, '\n').trim()
      )
    );
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
}
