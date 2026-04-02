const Store = require('electron-store');
const { DeviceCodeCredential } = require('@azure/identity');

const store = new Store({ encryptionKey: 'smallchat-v1' });

const AZURE_OPENAI_SCOPE = 'https://cognitiveservices.azure.com/.default';

const COPILOT_ENDPOINT = 'https://api.githubcopilot.com/chat/completions';
const MODELS_ENDPOINT = 'https://models.github.ai/inference/chat/completions';
const DEFAULT_CUSTOM_ENDPOINT = 'http://localhost:11434/v1/chat/completions';
const DEFAULT_COPILOT_MODEL = 'gpt-4o';
const DEFAULT_MODELS_MODEL = 'openai/gpt-4.1';
const DEFAULT_CUSTOM_MODEL = 'llama3';

class CopilotClient {
  constructor(authManager) {
    this._auth = authManager;
    this._mode = store.get('api_mode', 'copilot');
    const defaultModel = this._mode === 'copilot' ? DEFAULT_COPILOT_MODEL : this._mode === 'custom' ? DEFAULT_CUSTOM_MODEL : DEFAULT_MODELS_MODEL;
    const defaultEndpoint = this._mode === 'copilot' ? COPILOT_ENDPOINT : this._mode === 'custom' ? DEFAULT_CUSTOM_ENDPOINT : MODELS_ENDPOINT;
    this._model = store.get('model', defaultModel);
    this._endpoint = store.get('endpoint', defaultEndpoint);
    this._abortController = null;
    this._entraCredential = null;
    this.onEntraDeviceCode = null; // callback set by main.js
  }

  getMode() {
    return this._mode;
  }

  setMode(mode) {
    this._mode = mode;
    store.set('api_mode', mode);
    if (mode === 'copilot') {
      this._endpoint = COPILOT_ENDPOINT;
      if (this._model.includes('/')) {
        this._model = DEFAULT_COPILOT_MODEL;
        store.set('model', this._model);
      }
    } else if (mode === 'custom') {
      this._endpoint = store.get('custom_endpoint', DEFAULT_CUSTOM_ENDPOINT);
      this._model = store.get('custom_model', DEFAULT_CUSTOM_MODEL);
      store.set('model', this._model);
    } else {
      this._endpoint = MODELS_ENDPOINT;
      if (!this._model.includes('/')) {
        this._model = DEFAULT_MODELS_MODEL;
        store.set('model', this._model);
      }
    }
    store.set('endpoint', this._endpoint);
  }

  getCustomApiKey() {
    return store.get('custom_api_key', '');
  }

  setCustomApiKey(key) {
    store.set('custom_api_key', key);
  }

  getCustomAuthType() {
    return store.get('custom_auth_type', 'apikey');
  }

  setCustomAuthType(type) {
    store.set('custom_auth_type', type);
    // Reset credential when switching auth type
    this._entraCredential = null;
  }

  async getEntraToken() {
    if (!this._entraCredential) {
      const tenantId = store.get('entra_tenant_id', '') || undefined;
      this._entraCredential = new DeviceCodeCredential({
        tenantId,
        userPromptCallback: (info) => {
          if (this.onEntraDeviceCode) {
            this.onEntraDeviceCode({
              message: info.message,
              userCode: info.userCode,
              verificationUri: info.verificationUri,
            });
          }
        },
      });
    }
    const tokenResponse = await this._entraCredential.getToken(AZURE_OPENAI_SCOPE);
    return tokenResponse.token;
  }

  getEntraTenantId() {
    return store.get('entra_tenant_id', '');
  }

  setEntraTenantId(tenantId) {
    store.set('entra_tenant_id', tenantId);
    // Reset credential so it picks up the new tenant
    this._entraCredential = null;
  }

  getModel() {
    return this._model;
  }

  setModel(model) {
    this._model = model;
    store.set('model', model);
    if (this._mode === 'custom') {
      store.set('custom_model', model);
    }
  }

  getEndpoint() {
    return this._endpoint;
  }

  setEndpoint(endpoint) {
    this._endpoint = endpoint;
    store.set('endpoint', endpoint);
    if (this._mode === 'custom') {
      store.set('custom_endpoint', endpoint);
    }
  }

  async getCopilotModels() {
    const token = await this._auth.getCopilotToken();
    const response = await fetch('https://api.githubcopilot.com/models', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'SmallChat/1.0',
        'Editor-Version': 'vscode/1.99.0',
        'Editor-Plugin-Version': 'copilot/1.0.0',
      },
    });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.data || data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
    }));
  }

  abort() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  async chat(messages, tools, onChunk) {
    let token;
    if (this._mode === 'copilot') {
      token = await this._auth.getCopilotToken();
    } else if (this._mode === 'custom') {
      if (this.getCustomAuthType() === 'entra') {
        token = await this.getEntraToken();
      } else {
        token = this.getCustomApiKey();
      }
      // Custom mode works without a key (e.g. local Ollama)
    } else {
      token = this._auth.getToken();
    }
    if (!token && this._mode !== 'custom') throw new Error('Not authenticated');

    // Models like o-series and gpt-5 only support temperature=1
    const noTempModels = /\b(o1|o3|o4|gpt-5)\b/;
    const isClaude = /claude/i.test(this._model);
    const body = {
      model: this._model,
      messages,
      stream: true,
    };

    if (!noTempModels.test(this._model) && !isClaude) {
      body.temperature = 0.7;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      if (!isClaude) {
        body.tool_choice = 'auto';
      }
    }

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'SmallChat/1.0',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (this._mode === 'copilot') {
      headers['Editor-Version'] = 'vscode/1.99.0';
      headers['Editor-Plugin-Version'] = 'copilot/1.0.0';
      headers['Openai-Intent'] = 'conversation-panel';
    }

    // Retry once on rate limit (429)
    for (let attempt = 0; attempt < 2; attempt++) {
      this._abortController = new AbortController();
      const response = await fetch(this._endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: this._abortController.signal,
      });

      if (response.status === 429 && attempt === 0) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '10', 10);
        const wait = Math.min(retryAfter, 60) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        console.error(`[Chat API] ${response.status} error:`, text);
        if (response.status === 429) {
          throw new Error('Rate limited. Try a different model or wait a minute.');
        }
        // Try to extract a meaningful error message from JSON response
        let detail = response.statusText || 'Bad Request';
        try {
          const errData = JSON.parse(text);
          detail = errData.error?.message || errData.message || detail;
        } catch { /* not JSON */ }
        throw new Error(`API error ${response.status}: ${detail}`);
      }

      const contentType = response.headers.get('content-type') || '';

      // Handle SSE streaming response
      if (contentType.includes('text/event-stream') || contentType.includes('text/plain')) {
        return await this._readStream(response, onChunk);
      }

      // Handle regular JSON response (GitHub Models / non-streaming fallback)
      const data = await response.json();
      return this._parseJsonResponse(data);
    }

    throw new Error('Rate limited after retry. Try a different model or wait a minute.');
  }

  _parseJsonResponse(data) {
    const choice = data.choices?.[0];
    if (!choice) throw new Error('No response from model');

    let content = '';
    let thinking = '';
    const rawContent = choice.message?.content;

    if (typeof rawContent === 'string') {
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      for (const block of rawContent) {
        if (block.type === 'thinking' || block.type === 'reasoning') {
          thinking += (block.thinking || block.text || block.content || '') + '\n';
        } else if (block.type === 'text') {
          content += (block.text || '') + '\n';
        } else {
          content += (block.text || block.content || '') + '\n';
        }
      }
      content = content.trim();
      thinking = thinking.trim();
    }

    return {
      content,
      thinking: thinking || null,
      toolCalls: choice.message?.tool_calls || null,
    };
  }

  async _readStream(response, onChunk) {
    const text = await response.text();
    const lines = text.split('\n');

    let content = '';
    let thinking = '';
    let toolCalls = null;
    const toolCallMap = {};

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') break;

      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // Accumulate content and emit chunk
      if (delta.content) {
        content += delta.content;
        if (onChunk) onChunk({ type: 'content', text: delta.content, full: content });
      }

      // Accumulate thinking (extended thinking / reasoning tokens)
      if (delta.reasoning_content) {
        thinking += delta.reasoning_content;
        if (onChunk) onChunk({ type: 'thinking', text: delta.reasoning_content, full: thinking });
      }
      if (delta.thinking) {
        thinking += delta.thinking;
        if (onChunk) onChunk({ type: 'thinking', text: delta.thinking, full: thinking });
      }

      // Accumulate tool calls across chunks
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallMap[idx]) {
            toolCallMap[idx] = {
              id: tc.id || '',
              type: 'function',
              function: { name: '', arguments: '' },
            };
          }
          if (tc.id) toolCallMap[idx].id = tc.id;
          if (tc.function?.name) toolCallMap[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCallMap[idx].function.arguments += tc.function.arguments;
        }
      }
    }

    const tcKeys = Object.keys(toolCallMap);
    if (tcKeys.length > 0) {
      toolCalls = tcKeys.sort((a, b) => a - b).map((k) => toolCallMap[k]);
    }

    return {
      content: content.trim(),
      thinking: thinking.trim() || null,
      toolCalls,
    };
  }
}

module.exports = { CopilotClient };
