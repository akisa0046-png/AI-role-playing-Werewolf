/* ============================================================
 * app.js —— 启动装配：Tab / 设置 / 开局座位 / 游戏播放驱动
 * ============================================================ */
window.App = (function () {
  'use strict';

  const el = {};
  let game = null;
  let gen = null;
  let playing = false;
  let pending = false;
  let timerId = null;
  let finished = false;
  let runId = 0;
  let seatSelection = [];

  const PRESET_URL = {
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' }
  };

  /* ---------------- Tab ---------------- */
  function bindTabs() {
    const tabs = document.querySelectorAll('.tab');
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener('click', function () {
        const name = tab.dataset.tab;
        Array.prototype.forEach.call(tabs, function (t) { t.classList.toggle('active', t === tab); });
        Array.prototype.forEach.call(document.querySelectorAll('.tab-panel'), function (p) {
          p.classList.toggle('active', p.id === 'tab-' + name);
        });
        // 切到「角色卡」页时刷新网格，避免数据变化后显示过期内容
        if (name === 'cards' && window.Characters && typeof Characters.render === 'function') Characters.render();
      });
    });
  }

  function switchTab(name) {
    const tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (tab) tab.click();
  }

  /* ---------------- 设置页 ---------------- */
  function loadSettingsForm() {
    const s = Store.settings();
    el.provider.value = s.provider;
    el.baseUrl.value = s.baseUrl;
    el.apiKey.value = s.apiKey;
    el.model.value = s.model;
    el.temp.value = s.temperature;
    el.length.value = s.speechLength;
    el.streamSel.value = s.stream ? '1' : '0';
  }

  function saveSettings(silent) {
    const s = Store.saveSettings({
      provider: el.provider.value,
      baseUrl: el.baseUrl.value.trim(),
      apiKey: el.apiKey.value.trim(),
      model: el.model.value.trim(),
      temperature: Math.min(2, Math.max(0, Number(el.temp.value) || 0.9)),
      speechLength: el.length.value,
      stream: el.streamSel.value === '1'
    });
    if (!silent) UI.toast('设置已保存');
    return s;
  }

  /** 判断某个值是否等于任意接口的默认值（用于切换接口时自动带出默认 Base URL / 模型） */
  function isPresetValue(key, value) {
    const v = String(value || '').trim();
    if (!v) return true;
    return Object.keys(PRESET_URL).some(function (k) { return PRESET_URL[k][key] === v; });
  }

  function bindSettings() {
    if (el.provider) {
      el.provider.addEventListener('change', function () {
        const p = PRESET_URL[this.value];
        if (!p) return;
        if (isPresetValue('baseUrl', el.baseUrl.value)) el.baseUrl.value = p.baseUrl;
        if (isPresetValue('model', el.model.value)) el.model.value = p.model;
      });
    }
    if (el.toggleKey) {
      el.toggleKey.addEventListener('click', function () {
        const on = el.apiKey.type === 'password';
        el.apiKey.type = on ? 'text' : 'password';
        this.textContent = on ? '隐藏' : '显示';
      });
    }
    if (el.saveSettings) {
      el.saveSettings.addEventListener('click', function () {
        saveSettings(false);
      });
    }
    if (el.resetSettings) {
      el.resetSettings.addEventListener('click', function () {
        Store.resetSettings();
        loadSettingsForm();
        UI.toast('已恢复默认设置');
      });
    }
    if (el.testBtn) {
      el.testBtn.addEventListener('click', async function () {
        const btn = this;
        saveSettings(true);
        btn.disabled = true;
        el.testResult.className = 'test-result';
        el.testResult.textContent = '⏳ 正在测试连接…';
        try {
          const reply = await LLM.test();
          el.testResult.className = 'test-result ok';
          el.testResult.textContent = '✅ 连接成功！模型回复：' + reply;
        } catch (e) {
          el.testResult.className = 'test-result bad';
          el.testResult.textContent = '❌ 连接失败：' + (e.message || '未知错误');
        } finally {
          btn.disabled = false;
        }
      });
    }
  }

  /* ---------------- 开局：角色配置 + 座位 ---------------- */
  /** 真人玩家是否下场（占用最后一个座位） */
  function humanOn() {
    return !!(el.humanJoin && el.humanJoin.checked);
  }

  function humanPrefs() {
    return Store.saveHumanPrefs({
      join: humanOn(),
      name: el.humanName ? el.humanName.value : undefined,
      avatar: el.humanAvatar ? el.humanAvatar.value : undefined,
      experience: el.humanExp ? el.humanExp.value : undefined
    });
  }

  function loadHumanForm() {
    const p = Store.humanPrefs();
    if (el.humanJoin) el.humanJoin.checked = !!p.join;
    if (el.humanName) el.humanName.value = p.name;
    if (el.humanAvatar) el.humanAvatar.value = p.avatar;
    if (el.humanExp) el.humanExp.value = p.experience;
    toggleHumanFields();
  }

  function toggleHumanFields() {
    const on = humanOn();
    if (el.humanFields) el.humanFields.classList.toggle('hidden', !on);
  }

  function bindHumanSetup() {
    if (el.humanJoin) {
      el.humanJoin.addEventListener('change', function () {
        Store.saveHumanPrefs({ join: this.checked });
        toggleHumanFields();
        const n = Number(el.count.value);
        seatSelection = seatSelection.slice(0, humanOn() ? n - 1 : n);
        fillSeats(false);
        UI.toast(this.checked ? '已加入：最后一个座位留给你，其余 ' + (n - 1) + ' 个是 AI' : '已退出：本局全部由 AI 出演');
      });
    }
    ['humanName', 'humanAvatar', 'humanExp'].forEach(function (k) {
      if (!el[k]) return;
      el[k].addEventListener('change', function () {
        humanPrefs();
        fillSeats(true);
      });
    });
  }

  function renderComposition() {
    if (!el.composition) return;
    const n = Number(el.count.value);
    el.composition.innerHTML = Werewolf.compositionCounts(n).map(function (c) {
      const meta = Werewolf.ROLE_META[c.role] || { name: c.role, icon: '', camp: 'good', desc: '' };
      return '<span class="role-chip' + (meta.camp === 'wolf' ? ' wolf' : '') + '" title="' +
        UI.esc(meta.desc) + '">' + meta.icon + ' ' + meta.name + ' ×' + c.count + '</span>';
    }).join('');
  }

  function fillSeats(keepSelection) {
    if (!el.seatList) return;
    const n = Number(el.count.value);
    const withHuman = humanOn();
    const need = withHuman ? n - 1 : n;      // 真人占最后一个座位
    const cards = Store.cards();
    const validIds = cards.map(function (c) { return c.id; });

    if (!keepSelection) seatSelection = seatSelection.slice(0, need);
    while (seatSelection.length < need) seatSelection.push('');
    seatSelection = seatSelection.slice(0, need).map(function (id) {
      return validIds.indexOf(id) >= 0 ? id : '';
    });

    if (!cards.length) {
      el.seatList.innerHTML = '<div class="empty-hint">角色卡库是空的，先去「🎭 角色卡」页新建或载入示例角色。</div>';
      return;
    }

    el.seatList.innerHTML = '';
    for (let i = 0; i < need; i++) {
      const row = document.createElement('div');
      row.className = 'seat-row';
      const options = ['<option value="">— 选择角色 —</option>'].concat(cards.map(function (c) {
        const usedByOther = seatSelection.some(function (x, j) { return j !== i && x === c.id; });
        const sel = seatSelection[i] === c.id ? ' selected' : '';
        const exp = Store.expMeta(c.experience);
        return '<option value="' + UI.esc(c.id) + '"' + sel + (usedByOther ? ' disabled' : '') + '>' +
          UI.esc(c.name) + ' · ' + exp.icon + exp.name + (usedByOther ? '（已上场）' : '') + '</option>';
      })).join('');
      row.innerHTML = '<span class="seat-no">' + (i + 1) + '</span><select data-seat="' + i + '">' + options + '</select>';
      el.seatList.appendChild(row);
    }

    if (withHuman) {
      const p = Store.humanPrefs();
      const exp = Store.expMeta(p.experience);
      const row = document.createElement('div');
      row.className = 'seat-row seat-human';
      row.innerHTML =
        '<span class="seat-no">' + n + '</span>' +
        '<div class="seat-human-body">' +
          '<span class="sh-avatar">' + UI.esc(p.avatar || '😎') + '</span>' +
          '<span class="sh-name">' + UI.esc(p.name || '你') + '</span>' +
          '<span class="exp-badge exp-' + exp.key + '">' + exp.icon + ' ' + exp.name + '</span>' +
          '<span class="sh-tag">你 · 真人玩家</span>' +
        '</div>';
      el.seatList.appendChild(row);
    }
  }

  function randomFill() {
    const n = Number(el.count.value);
    const need = humanOn() ? n - 1 : n;
    const cards = Store.cards();
    if (!cards.length) { UI.toast('还没有角色卡，先去「角色卡」页创建或载入示例', true); return; }
    if (cards.length < need) { UI.toast('角色卡不够：' + n + ' 人局需要 ' + need + ' 张角色卡' + (humanOn() ? '（你自己占一个座位）' : ''), true); return; }
    const pool = cards.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    seatSelection = pool.slice(0, need).map(function (c) { return c.id; });
    fillSeats(true);
    UI.toast('已随机填入 ' + need + ' 名 AI 角色' + (humanOn() ? '（加上你共 ' + n + ' 人）' : ''));
  }

  function bindSetup() {
    if (el.count) {
      el.count.addEventListener('change', function () {
        seatSelection = [];
        renderComposition();
        fillSeats(false);
      });
    }
    if (el.seatList) {
      el.seatList.addEventListener('change', function (e) {
        const sel = e.target.closest('select[data-seat]');
        if (!sel) return;
        const i = Number(sel.dataset.seat);
        seatSelection[i] = sel.value;
        fillSeats(true);
      });
    }
    if (el.randomFill) el.randomFill.addEventListener('click', randomFill);
    if (el.clearSeats) {
      el.clearSeats.addEventListener('click', function () {
        const n = Number(el.count.value);
        const need = humanOn() ? n - 1 : n;
        seatSelection = new Array(need).fill('');
        fillSeats(true);
        UI.toast('已清空座位');
      });
    }
    if (el.startBtn) el.startBtn.addEventListener('click', startGame);
  }

  function collectCards() {
    const n = Number(el.count.value);
    const withHuman = humanOn();
    const need = withHuman ? n - 1 : n;
    const ids = seatSelection.slice(0, need);
    const cards = [];
    for (let i = 0; i < need; i++) {
      const c = ids[i] ? Store.getCard(ids[i]) : null;
      if (!c) return { error: '请为 ' + (i + 1) + ' 号座位选择角色' };
      cards.push(c);
    }
    const uniq = cards.map(function (c) { return c.id; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (uniq.length !== cards.length) return { error: '同一张角色卡不能重复上场' };
    if (withHuman) {
      const prefs = humanPrefs();
      cards.push(Store.humanCard(prefs));
    }
    return { cards: cards, human: withHuman };
  }


  /* ---------------- 游戏启动与播放 ---------------- */
  function startGame() {
    const picked = collectCards();
    if (picked.error) { UI.toast(picked.error, true); return; }

    const s = Store.settings();
    if (!s.apiKey) {
      UI.toast('请先在「设置」页填写 API Key', true);
      switchTab('settings');
      if (el.apiKey) el.apiKey.focus();
      return;
    }
    if (!s.model) {
      UI.toast('请先在「设置」页填写模型名称', true);
      switchTab('settings');
      return;
    }

    runId += 1;
    const myRun = runId;
    finished = false;
    pending = false;
    if (timerId) { clearTimeout(timerId); timerId = null; }

    game = Werewolf.createGame({
      cards: picked.cards,
      options: {
        speechLength: s.speechLength,
        stream: s.stream,
        temperature: s.temperature
      },
      hooks: {
        onMessageStart: function (msg) { if (myRun === runId) UI.onMessageStart(msg); },
        onMessageDelta: function (uid, text) { if (myRun === runId) UI.onMessageDelta(uid, text); },
        onMessageEnd: function (uid) { if (myRun === runId) UI.onMessageEnd(uid); },
        onStatus: function (text) { if (myRun === runId) UI.setStatus(text); },
        onSpeaking: function (seat) { if (myRun === runId) UI.setSpeaking(seat); },
        onError: function (text) { if (myRun === runId) UI.toast(text, true); },
        // 轮到你自己：弹出输入条，用自然语言说话 / 投票 / 刀人…
        askHuman: function (req) {
          if (myRun !== runId) return Promise.resolve(null);
          if (!playing && !finished) { playing = true; updateButtons(); }
          return UI.askHuman(req);
        },
        onHumanCancel: function () { if (myRun === runId) UI.cancelHuman(); }
      }
    });

    el.setup.classList.add('hidden');
    el.board.classList.remove('hidden');
    UI.clearChat();
    UI.renderPlayers(game);
    UI.setPhase(game);
    UI.setStatus('准备开局…');

    if (picked.human) {
      // 自己下场：默认切到「玩家视角」，避免看见全局身份把牌打飞
      UI.setPrivate(false);
      UI.toast('你已加入本局（' + game.humanSeat + ' 号）· 已切到玩家视角');
    }

    gen = game.run();
    setPlaying(true);
  }

  /** 事件读完后停留多久（毫秒，基准值） */
  function delayFor(ev) {
    switch (ev.type) {
      case 'system': return 600;
      case 'gm': return 1300;
      case 'speech': return 900 + Math.min(4200, String(ev.text || '').length * 42);
      case 'night': return 3200;
      case 'votes': return 3000;
      case 'roles': return 3800;
      case 'end': return 1200;
      default: return 800;
    }
  }

  async function step() {
    if (!gen || pending) return;
    const myRun = runId;
    pending = true;
    updateButtons();

    let ev = null;
    let done = false;
    try {
      const r = await gen.next();
      done = !!r.done;
      ev = r.value;
    } catch (e) {
      pending = false;
      if (myRun !== runId) return;
      UI.toast('运行出错：' + (e.message || '未知错误'), true);
      finishGame();
      return;
    }

    pending = false;
    if (myRun !== runId) return;

    if (done || !ev) { finishGame(); return; }

    UI.renderEvent(ev);
    UI.renderPlayers(game);
    UI.setPhase(game);
    UI.setStatus('');

    if (playing) {
      const wait = Math.max(140, delayFor(ev) / (UI.getSpeed() || 1));
      timerId = setTimeout(function () {
        timerId = null;
        if (myRun === runId) step();
      }, wait);
    } else {
      updateButtons();
    }
  }

  function finishGame() {
    finished = true;
    playing = false;
    pending = false;
    gen = null;
    if (timerId) { clearTimeout(timerId); timerId = null; }
    UI.cancelHuman();
    UI.setSpeaking(null);
    UI.setStatus('本局结束');
    if (game) UI.setPhase(game);
    updateButtons();
  }

  function updateButtons() {
    if (!el.play) return;
    el.play.textContent = finished ? '🔁 再来一局' : (playing ? '⏸ 暂停' : '▶ 自动播放');
    el.play.classList.toggle('primary', !playing || finished);
    el.play.disabled = false;
    if (el.step) el.step.disabled = finished;
    if (el.stop) el.stop.textContent = finished ? '⬅ 返回开局' : '⏹ 结束本局';
  }

  function setPlaying(v) {
    playing = v;
    if (!v && timerId) { clearTimeout(timerId); timerId = null; }
    updateButtons();
    if (v && gen && !pending && !finished) step();
  }

  /** 回到「开局设置」页（保留座位选择，不丢角色卡） */
  function backToSetup() {
    runId += 1;                      // 作废所有进行中的回调与事件
    playing = false;
    pending = false;
    finished = false;
    if (timerId) { clearTimeout(timerId); timerId = null; }
    if (game) { try { game.stop(); } catch (e) { /* ignore */ } }
    game = null;
    gen = null;
    UI.cancelHuman();
    UI.setHumanView(null);
    UI.setSpeaking(null);
    UI.setStatus('');
    el.board.classList.add('hidden');
    el.setup.classList.remove('hidden');
    renderComposition();
    fillSeats(true);
    updateButtons();
  }

  async function endGameManually() {
    // 已经没有对局 / 已经结束：直接回到开局页
    if (!game || finished) { backToSetup(); return; }

    const ok = await UI.confirm({
      title: '结束本局',
      text: '确定要结束本局吗？当前对局的聊天记录会被丢弃。',
      okText: '结束本局'
    });
    if (!ok) return;

    backToSetup();
    UI.clearChat();
    UI.toast('已结束本局');
  }

  function bindControls() {
    if (el.play) {
      el.play.addEventListener('click', function () {
        if (finished) { backToSetup(); return; }
        setPlaying(!playing);
      });
      el.play.title = '自动播放 / 暂停（快捷键：空格）';
    }
    if (el.step) {
      el.step.addEventListener('click', function () {
        if (finished) return;
        setPlaying(false);
        step();
      });
      el.step.title = '手动推进一步（快捷键：→）';
    }
    if (el.stop) el.stop.addEventListener('click', endGameManually);
  }

  /** 打字时不抢快捷键 */
  function isTypingTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
  }

  function bindHotkeys() {
    document.addEventListener('keydown', function (e) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('.modal:not([hidden])')) return;
      if (!el.board || el.board.classList.contains('hidden')) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (!finished) setPlaying(!playing);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (!finished) { setPlaying(false); step(); }
      }
    });
  }


  /* ---------------- 启动 ---------------- */
  function cacheDom() {
    el.setup = document.getElementById('game-setup');
    el.board = document.getElementById('game-board');
    el.count = document.getElementById('player-count');
    el.composition = document.getElementById('role-composition');
    el.seatList = document.getElementById('seat-list');
    el.randomFill = document.getElementById('btn-random-fill');
    el.clearSeats = document.getElementById('btn-clear-seats');
    el.startBtn = document.getElementById('btn-start');
    el.humanJoin = document.getElementById('human-join');
    el.humanFields = document.getElementById('human-fields');
    el.humanName = document.getElementById('human-name');
    el.humanAvatar = document.getElementById('human-avatar');
    el.humanExp = document.getElementById('human-exp');

    el.play = document.getElementById('btn-play');
    el.step = document.getElementById('btn-step');
    el.stop = document.getElementById('btn-stop');

    el.provider = document.getElementById('set-provider');
    el.baseUrl = document.getElementById('set-baseurl');
    el.apiKey = document.getElementById('set-apikey');
    el.toggleKey = document.getElementById('btn-toggle-key');
    el.model = document.getElementById('set-model');
    el.temp = document.getElementById('set-temp');
    el.length = document.getElementById('set-length');
    el.streamSel = document.getElementById('set-stream');
    el.testBtn = document.getElementById('btn-test');
    el.testResult = document.getElementById('test-result');
    el.saveSettings = document.getElementById('btn-save-settings');
    el.resetSettings = document.getElementById('btn-reset-settings');
  }

  function init() {
    cacheDom();
    UI.init();
    bindTabs();
    loadSettingsForm();
    bindSettings();

    Characters.init({
      onChange: function () { fillSeats(true); }
    });

    bindSetup();
    bindHumanSetup();
    loadHumanForm();
    renderComposition();
    fillSeats(false);
    bindControls();
    bindHotkeys();
    updateButtons();

    // 兜底：把未捕获异常显示成 toast，避免静默失败
    window.addEventListener('error', function (e) {
      if (e && e.message) UI.toast('脚本错误：' + e.message, true);
    });
    window.addEventListener('unhandledrejection', function (e) {
      const r = e && e.reason;
      const m = r && (r.message || r);
      if (m) UI.toast('请求异常：' + m, true);
    });
  }

  return {
    init: init,
    switchTab: switchTab
  };
})();

document.addEventListener('DOMContentLoaded', function () {
  try {
    App.init();
  } catch (e) {
    const t = document.getElementById('toast');
    if (t) {
      t.textContent = '初始化失败：' + (e.message || e);
      t.className = 'toast show bad';
    }
    throw e;
  }
});

