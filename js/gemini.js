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
    this.apiKey    = apiKey;
    this.baseUrl   = 'https://generativelanguage.googleapis.com/v1beta';
    this.uploadUrl = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
    this.modelName = 'gemini-2.5-flash-lite';
  }

  get _authHeaders() {
    return { 'x-goog-api-key': this.apiKey };
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

  async waitForFileActive(fileName, timeoutMs = 120_000) {
    const url      = `${this.baseUrl}/${fileName}`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const res = await fetch(url, { headers: this._authHeaders });
      if (!res.ok) throw new Error(`ファイル状態確認失敗: ${res.status}`);

      const data = await res.json();
      if (data.state === 'ACTIVE') return;
      if (data.state === 'FAILED') throw new Error('Googleサーバー側でのファイル処理に失敗しました。');

      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw new Error('ファイルのアクティベーションがタイムアウトしました。');
  }

  // ─── ② 文字起こし ───────────────────────────

  async transcribeAudio(fileUri, mimeType) {
    const url = `${this.baseUrl}/models/${this.modelName}:generateContent`;
    const payload = {
      contents: [{
        parts: [
          { text: 'この音声ファイルの文字起こしをしてください。誰がどのパートを歌っているかなどの推測は不要で、聞こえた言葉をそのまま抽出してください。' },
          { file_data: { file_uri: fileUri, mime_type: mimeType } },
        ],
      }],
    };

    const response = await fetch(url, {
      method:  'POST',
      headers: { ...this._authHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!response.ok) throw new Error(`文字起こし失敗 [${response.status}]`);

    const data    = await response.json();
    const rawText = this._extractTextFromResponse(data);

    // ハルシネーション対策：同一フレーズの繰り返しを切り詰める
    function truncateRepetition(text, windowSize = 50, maxRepeats = 5) {
      const pattern = new RegExp(`(.{${windowSize},})\\1{${maxRepeats},}`, 's');
      return text.replace(pattern, '$1\n[繰り返し検知により以降を省略]');
    }

    return normalizeMusicTerms(
      truncateRepetition(rawText)
        .replace(/^\d{2}:\d{2}\s*/gm, '')
        .replace(/\n{2,}/g, '\n')
        .trim()
    );
  }

  // ─── ③ 構造化解析（JSON生成） ───────────────

  async analyzeStructure(fileUri, mimeType, transcript) {
    const url = `${this.baseUrl}/models/${this.modelName}:generateContent`;

    const promptText = `
あなたはプロのアカペラ指導者です。提供された音声ファイルおよびその文字起こしテキストをもとに、アカペラの練習に対するフィードバックを抽出してください。

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
              timestamp_sec: { type: 'INTEGER' },
              part:          { type: 'ARRAY', items: { type: 'STRING' } },
              category:      { type: 'STRING', enum: ['ピッチ', 'リズム', 'ダイナミクス', '歌詞・発音', 'その他'] },
              importance:    { type: 'STRING', enum: ['high', 'normal'] },
              text:          { type: 'STRING' },
            },
            required: ['id', 'timestamp_sec', 'part', 'category', 'importance', 'text'],
          },
        },
      },
      required: ['session_name', 'recorded_at', 'transcript', 'cards'],
    };

    const payload = {
      contents: [{
        parts: [
          { text: promptText },
          { file_data: { file_uri: fileUri, mime_type: mimeType } },
        ],
      }],
      generationConfig: {
        response_mime_type: 'application/json',
        response_schema:    responseSchema,
        temperature:        0.1,
      },
    };

    const response = await fetch(url, {
      method:  'POST',
      headers: { ...this._authHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!response.ok) throw new Error(`構造化解析失敗 [${response.status}]`);

    const data       = await response.json();
    const jsonString = this._extractTextFromResponse(data);

    try {
      const result = JSON.parse(jsonString);
      if (Array.isArray(result.cards)) {
        result.cards = result.cards.map(card => ({
          ...card,
          text: normalizeMusicTerms(card.text),
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
