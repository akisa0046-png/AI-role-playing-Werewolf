/* ============================================================
 * store.js —— 本地存储：模型设置 + 单一「角色卡文件」
 * ============================================================ */
window.Store = (function () {
  'use strict';

  const KEY_SETTINGS = 'aiww.settings.v1';
  const KEY_CARDS = 'aiww.cards.v1';
  const KEY_HUMAN = 'aiww.human.v1';
  const FILE_FORMAT = 'ai-werewolf-character-cards';
  const FILE_VERSION = 2;

  /* ---------------- 角色属性枚举 ---------------- */

  /** 狼人杀经验：全场都知道，但没人会在对话里提；影响「怎么说话」也影响「别人怎么读他的话」 */
  const EXPERIENCE = [
    { key: 'novice', name: '新手', icon: '🌱', desc: '术语少、话偏短，没人怀疑时只说自己的信息，容易被带节奏' },
    { key: 'skilled', name: '熟手', icon: '🎯', desc: '套路熟练、术语自然，能跟票也能带一点节奏' },
    { key: 'veteran', name: '老手', icon: '🏆', desc: '信息量大、术语密集，擅长安身份与算票' }
  ];

  /** 口头禅出现频率 */
  const CATCH_RATES = [
    { key: 'low', name: '低', desc: '整局偶尔一两句，情绪到位才说' },
    { key: 'mid', name: '中', desc: '大约每两次发言出现一次' },
    { key: 'high', name: '高', desc: '几乎每次开口都带上' }
  ];

  const EXP_KEYS = EXPERIENCE.map(e => e.key);
  const CATCH_RATE_KEYS = CATCH_RATES.map(r => r.key);

  function expMeta(key) {
    const k = String(key || '').trim();
    return EXPERIENCE.find(e => e.key === k) || EXPERIENCE[1];
  }
  function expName(key) { return expMeta(key).name; }
  function catchRateMeta(key) {
    const k = String(key || '').trim();
    return CATCH_RATES.find(r => r.key === k) || CATCH_RATES[1];
  }

  const DEFAULT_SETTINGS = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.9,
    speechLength: 'normal',
    stream: true
  };

  let _settings = null;
  let _cards = null;

  /* ---------------- 基础读写 ---------------- */
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return (v === null || v === undefined) ? fallback : v;
    } catch (e) {
      console.warn('[Store] 读取失败', key, e);
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('[Store] 写入失败', key, e);
      return false;
    }
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------------- 设置 ---------------- */
  function settings() {
    if (!_settings) {
      const stored = readJSON(KEY_SETTINGS, {});
      _settings = Object.assign({}, DEFAULT_SETTINGS, stored && typeof stored === 'object' ? stored : {});
    }
    return _settings;
  }

  function saveSettings(patch) {
    _settings = Object.assign({}, settings(), patch || {});
    writeJSON(KEY_SETTINGS, _settings);
    return _settings;
  }

  function resetSettings() {
    _settings = Object.assign({}, DEFAULT_SETTINGS);
    writeJSON(KEY_SETTINGS, _settings);
    return _settings;
  }

  /* ---------------- 真人玩家（自己下场）偏好 ---------------- */
  const DEFAULT_HUMAN = {
    join: false,
    name: '你',
    avatar: '😎',
    experience: 'skilled'
  };

  let _human = null;

  function humanPrefs() {
    if (!_human) {
      const stored = readJSON(KEY_HUMAN, {});
      const p = Object.assign({}, DEFAULT_HUMAN, stored && typeof stored === 'object' ? stored : {});
      p.join = !!p.join;
      p.name = String(p.name || '').trim().slice(0, 12) || DEFAULT_HUMAN.name;
      p.avatar = String(p.avatar || '').trim().slice(0, 40) || DEFAULT_HUMAN.avatar;
      p.experience = EXP_KEYS.indexOf(String(p.experience || '').trim()) >= 0
        ? String(p.experience).trim() : DEFAULT_HUMAN.experience;
      _human = p;
    }
    return _human;
  }

  function saveHumanPrefs(patch) {
    const clean = {};
    Object.keys(patch || {}).forEach(function (k) {
      if (patch[k] !== undefined) clean[k] = patch[k];
    });
    _human = Object.assign({}, humanPrefs(), clean);
    _human.name = String(_human.name || '').trim().slice(0, 12) || DEFAULT_HUMAN.name;
    _human.avatar = String(_human.avatar || '').trim().slice(0, 40) || DEFAULT_HUMAN.avatar;
    if (EXP_KEYS.indexOf(String(_human.experience || '').trim()) < 0) _human.experience = DEFAULT_HUMAN.experience;
    _human.join = !!_human.join;
    writeJSON(KEY_HUMAN, _human);
    return _human;
  }

  /** 生成真人玩家的"角色卡"（不存进角色卡库，只用于本局） */
  function humanCard(prefs) {
    const p = Object.assign({}, humanPrefs(), prefs || {});
    return {
      id: 'human_player',
      human: true,
      name: String(p.name || DEFAULT_HUMAN.name).trim() || DEFAULT_HUMAN.name,
      avatar: String(p.avatar || DEFAULT_HUMAN.avatar).trim() || DEFAULT_HUMAN.avatar,
      experience: EXP_KEYS.indexOf(String(p.experience || '').trim()) >= 0 ? String(p.experience).trim() : DEFAULT_HUMAN.experience,
      tags: ['真人玩家'],
      intro: '',
      persona: {
        personality: '没有剧本的真人玩家',
        tone: '',
        speechStyle: '',
        catchphrase: '',
        catchphraseRate: 'mid',
        values: '',
        background: ''
      }
    };
  }

  /* ---------------- 角色卡 ---------------- */
  function normalizeCard(raw) {
    const now = Date.now();
    const card = raw && typeof raw === 'object' ? raw : {};
    const persona = card.persona && typeof card.persona === 'object' ? card.persona : {};
    const exp = String(card.experience || '').trim();
    const rate = String(persona.catchphraseRate || '').trim();
    return {
      id: typeof card.id === 'string' && card.id ? card.id : uid('card'),
      name: String(card.name || '').trim() || '无名角色',
      avatar: String(card.avatar || '').trim(),
      intro: String(card.intro || '').trim(),
      experience: EXP_KEYS.indexOf(exp) >= 0 ? exp : 'skilled',
      tags: Array.isArray(card.tags)
        ? card.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 24)
        : String(card.tags || '').split(/[,，、\s]+/).map(t => t.trim()).filter(Boolean),
      persona: {
        personality: String(persona.personality || '').trim(),
        speechStyle: String(persona.speechStyle || '').trim(),
        tone: String(persona.tone || '').trim(),
        catchphrase: String(persona.catchphrase || '').trim(),
        catchphraseRate: CATCH_RATE_KEYS.indexOf(rate) >= 0 ? rate : 'mid',
        values: String(persona.values || '').trim(),
        background: String(persona.background || '').trim()
      },
      createdAt: Number(card.createdAt) || now,
      updatedAt: Number(card.updatedAt) || now
    };
  }

  function cards() {
    if (!_cards) {
      const stored = readJSON(KEY_CARDS, []);
      const list = Array.isArray(stored) ? stored : (stored && Array.isArray(stored.cards) ? stored.cards : []);
      _cards = list.map(normalizeCard);
    }
    return _cards;
  }

  /** 写入整份角色卡文件（list 中的每一项都会走一遍 normalizeCard） */
  function saveCards(list) {
    const arr = Array.isArray(list) ? list : [];
    _cards = arr.map(normalizeCard);
    writeJSON(KEY_CARDS, _cards);
    return _cards;
  }

  function getCard(id) {
    return cards().find(c => c.id === id) || null;
  }

  function upsertCard(card) {
    const c = normalizeCard(card);
    const list = cards().slice();
    const idx = list.findIndex(x => x.id === c.id);
    if (idx >= 0) {
      c.createdAt = list[idx].createdAt;
      c.updatedAt = Date.now();
      list[idx] = c;
    } else {
      c.createdAt = c.createdAt || Date.now();
      c.updatedAt = Date.now();
      list.unshift(c);
    }
    saveCards(list);
    return c;
  }

  function removeCard(id) {
    saveCards(cards().filter(c => c.id !== id));
  }

  /* ---------------- 角色卡文件：导入 / 导出 ---------------- */
  function buildBundle() {
    return {
      format: FILE_FORMAT,
      version: FILE_VERSION,
      exportedAt: new Date().toISOString(),
      count: cards().length,
      cards: cards()
    };
  }

  function exportFile() {
    const bundle = buildBundle();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `狼人杀角色卡-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return bundle;
  }

  /**
   * 导入角色卡（支持完整 bundle 或纯数组）
   * 同 id / 同名的角色卡会被覆盖更新，其余追加。
   */
  function importData(data) {
    let incoming = [];
    if (Array.isArray(data)) incoming = data;
    else if (data && typeof data === 'object' && Array.isArray(data.cards)) incoming = data.cards;
    else throw new Error('文件格式不正确：需要一个包含 cards 数组的 JSON 文件');

    const list = cards().slice();
    let added = 0, updated = 0;
    incoming.forEach(raw => {
      const c = normalizeCard(raw);
      const byId = list.findIndex(x => x.id === c.id);
      const byName = list.findIndex(x => x.name === c.name);
      const idx = byId >= 0 ? byId : byName;
      if (idx >= 0) {
        c.id = list[idx].id;
        c.createdAt = list[idx].createdAt;
        c.updatedAt = Date.now();
        list[idx] = c;
        updated++;
      } else {
        list.push(c);
        added++;
      }
    });
    saveCards(list);
    return { added, updated, total: list.length };
  }

  function importFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(importData(JSON.parse(String(reader.result || ''))));
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsText(file, 'utf-8');
    });
  }

  function loadDemoCards(demoList) {
    const list = cards().slice();
    let added = 0;
    (demoList || []).forEach(raw => {
      if (list.some(x => x.name === raw.name)) return;
      list.push(normalizeCard(raw));
      added++;
    });
    saveCards(list);
    return added;
  }

  return {
    DEFAULT_SETTINGS,
    EXPERIENCE: EXPERIENCE,
    CATCH_RATES: CATCH_RATES,
    expMeta: expMeta,
    expName: expName,
    catchRateMeta: catchRateMeta,
    settings: settings,
    saveSettings: saveSettings,
    resetSettings: resetSettings,
    DEFAULT_HUMAN: DEFAULT_HUMAN,
    humanPrefs: humanPrefs,
    saveHumanPrefs: saveHumanPrefs,
    humanCard: humanCard,
    cards: cards,
    saveCards: saveCards,
    getCard: getCard,
    upsertCard: upsertCard,
    removeCard: removeCard,
    exportFile: exportFile,
    importData: importData,
    importFile: importFile,
    buildBundle: buildBundle,
    loadDemoCards: loadDemoCards,
    normalizeCard: normalizeCard,
    uid: uid
  };
})();
