/* ============================================================
 * api.js —— 大模型客户端（OpenAI 兼容 / Anthropic）
 *  · 支持 SSE 流式输出
 *  · 自动重试、可中断、友好的错误信息
 * ============================================================ */
window.LLM = (function () {
  'use strict';

  const controllers = new Set();
  const TIMEOUT_MS = 180000;

  function abortAll() {
    controllers.forEach(c => { try { c.abort(); } catch (e) { /* ignore */ } });
    controllers.clear();
  }

  function normalizeBase(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function endpoint(provider, baseUrl) {
    const base = normalizeBase(baseUrl);
    if (provider === 'anthropic') {
      if (/\/v1\/messages$/.test(base)) return base;
      if (/\/v1$/.test(base)) return base + '/messages';
      return base + '/v1/messages';
    }
    if (/\/chat\/completions$/.test(base)) return base;
    if (!base) return '';
    return base + '/chat/completions';
  }

  /** 去掉思考过程（reasoning 模型的 think 段），避免污染台词 */
  function cleanText(text) {
    return String(text || '')
      .replace(/[\s\S]*?<\/think>/gi, '')
      .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
      .trim();
  }

  /** 从任意输出中尽量抠出 JSON 对象 */
  function parseJSON(text) {
    if (!text) return null;
    let t = cleanText(text).trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(t); } catch (e) { /* 继续尝试 */ }
    const start = t.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(t.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  function errorMessage(status, bodyText) {
    let detail = '';
    try {
      const j = JSON.parse(bodyText);
      detail = (j.error && (j.error.message || j.error.type)) || j.message || '';
    } catch (e) {
      detail = String(bodyText || '').slice(0, 240);
    }
    if (status === 401 || status === 403) return `鉴权失败（${status}）：请检查 API Key 是否正确。${detail ? ' ' + detail : ''}`;
    if (status === 404) return `接口地址未找到（404）：请检查 Base URL 与模型名。${detail ? ' ' + detail : ''}`;
    if (status === 429) return `请求过于频繁 / 额度不足（429）。${detail ? ' ' + detail : ''}`;
    return `接口返回错误（${status}）${detail ? '：' + detail : ''}`;
  }

  function pickText(json, provider) {
    if (!json) return '';
    if (provider === 'anthropic') {
      const blocks = Array.isArray(json.content) ? json.content : [];
      return blocks.filter(b => b && b.type === 'text').map(b => b.text || '').join('');
    }
    const ch = json.choices && json.choices[0];
    if (!ch) return '';
    const msg = ch.message || {};
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) return msg.content.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
    if (typeof ch.text === 'string') return ch.text;
    return '';
  }

  async function safeJSON(resp) {
    try { return await resp.json(); } catch (e) { return null; }
  }

  async function readSSE(resp, provider, onToken) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = chunk.split('\n');
        for (let li = 0; li < lines.length; li++) {
          const line = lines[li].trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let json;
          try { json = JSON.parse(payload); } catch (e) { continue; }
          let delta = '';
          if (provider === 'anthropic') {
            if (json.type === 'content_block_delta' && json.delta && typeof json.delta.text === 'string') delta = json.delta.text;
            if (json.type === 'error' && json.error) throw new Error(json.error.message || '流式返回出错');
          } else {
            const ch = json.choices && json.choices[0];
            if (ch) {
              if (ch.delta && typeof ch.delta.content === 'string') delta = ch.delta.content;
              else if (typeof ch.text === 'string') delta = ch.text;
            }
          }
          if (delta) {
            full += delta;
            if (onToken) onToken(delta, full);
          }
        }
      }
    }
    return full;
  }

  /**
   * 发起一次对话
   * @param {Object} opts
   *   messages: [{role, content}]
   *   temperature, maxTokens, stream, onToken(delta, full)
   */
  async function chat(opts) {
    const s = Store.settings();
    const o = opts || {};
    const provider = s.provider === 'anthropic' ? 'anthropic' : 'openai';
    const url = endpoint(provider, s.baseUrl);
    if (!url) throw new Error('请先在「设置」中填写 Base URL');
    if (!s.model) throw new Error('请先在「设置」中填写模型名称');

    const messages = (o.messages || []).filter(m => m && m.content);
    const wantStream = !!o.stream && typeof o.onToken === 'function';
    const temperature = typeof o.temperature === 'number' ? o.temperature : (Number(s.temperature) || 0.9);
    const maxTokens = Number(o.maxTokens) || 0;

    const headers = { 'Content-Type': 'application/json' };
    let body;
    if (provider === 'anthropic') {
      const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const rest = messages.filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      if (s.apiKey) headers['x-api-key'] = s.apiKey;
      body = { model: s.model, messages: rest, temperature: temperature, max_tokens: maxTokens || 1024, stream: wantStream };
      if (sys) body.system = sys;
    } else {
      if (s.apiKey) headers['Authorization'] = 'Bearer ' + s.apiKey;
      body = { model: s.model, messages: messages, temperature: temperature, stream: wantStream };
      if (maxTokens) body.max_tokens = maxTokens;
    }

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(new Error('timeout')), TIMEOUT_MS);
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });

        if (!resp.ok) {
          const text = await resp.text();
          const err = new Error(errorMessage(resp.status, text));
          err.status = resp.status;
          const retryable = resp.status === 408 || resp.status === 429 || resp.status >= 500;
          if (!retryable || attempt === 2) throw err;
          lastErr = err;
          await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
          continue;
        }

        let content = '';
        if (wantStream && resp.body) {
          content = await readSSE(resp, provider, o.onToken);
          if (!content) content = pickText(await safeJSON(resp), provider);
        } else {
          content = pickText(await safeJSON(resp), provider);
        }
        const cleaned = cleanText(content);
        if (!cleaned) {
          if (attempt === 2) throw new Error('模型返回了空内容，请重试或更换模型');
          lastErr = new Error('模型返回了空内容');
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        return cleaned;
      } catch (e) {
        if (e && e.name === 'AbortError') {
          const why = e.message || '';
          if (/abort|中断|cancel/i.test(why) && !/timeout/i.test(why)) throw new Error('已中断');
          lastErr = new Error('请求超时（180 秒），请检查网络或更换更快的模型');
        } else if (e && e.status && e.status !== 408 && e.status !== 429 && e.status < 500) {
          throw e;
        } else {
          lastErr = e;
        }
        if (attempt === 2) throw lastErr;
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
    }
    throw lastErr || new Error('请求失败');
  }

  /** 连接测试 */
  async function test() {
    return chat({
      messages: [
        { role: 'system', content: '你是一个乐于助人的助手。' },
        { role: 'user', content: '请只回复两个字：你好' }
      ],
      temperature: 0,
      maxTokens: 32,
      stream: false
    });
  }

  return {
    chat: chat,
    test: test,
    abortAll: abortAll,
    parseJSON: parseJSON,
    cleanText: cleanText,
    endpoint: endpoint
  };
})();
