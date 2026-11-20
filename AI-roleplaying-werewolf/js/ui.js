/* ============================================================
 * ui.js —— 界面渲染：聊天气泡 / 玩家列表 / 播放控制条
 *  · 与引擎通过 hooks 协作，支持流式打字机效果
 * ============================================================ */
window.UI = (function () {
  'use strict';

  const nodes = {};          // uid -> { el, bubble }
  let chatEl = null, listEl = null, phaseEl = null, dayEl = null, statusEl = null;
  let myPanel = null;
  let toastEl = null, timer = null;
  let speed = 1;
  /** 真人输入条 */
  const human = { bar: null, title: null, hint: null, chips: null, input: null, send: null, skip: null, avatar: null };
  let humanResolve = null;
  let humanReq = null;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 支持 emoji:🌟 / url:https://… / 纯 URL / 纯 emoji 四种写法 */
  function parseAvatar(avatar) {
    const raw = String(avatar || '').trim();
    if (/^url:/i.test(raw)) return { type: 'img', value: raw.replace(/^url:/i, '').trim() };
    if (/^emoji:/i.test(raw)) return { type: 'emoji', value: raw.replace(/^emoji:/i, '').trim() };
    if (/^(https?:\/\/|data:image\/)/i.test(raw)) return { type: 'img', value: raw };
    return raw ? { type: 'emoji', value: raw } : { type: 'none', value: '' };
  }

  /** 头像：URL / emoji / 名字首字 */
  function avatarHtml(avatar, name, extraClass) {
    const cls = 'avatar' + (extraClass ? ' ' + extraClass : '');
    const parsed = parseAvatar(avatar);
    const a = parsed.value;
    if (parsed.type === 'none') {
      const ch = String(name || '?').trim().charAt(0) || '?';
      return '<div class="' + cls + '">' + esc(ch.toUpperCase()) + '</div>';
    }
    if (parsed.type === 'img') {
      return '<div class="' + cls + '"><img src="' + esc(a) + '" alt=""></div>';
    }
    return '<div class="' + cls + '">' + esc(a) + '</div>';
  }

  /** 狼人杀经验徽章：公开信息，所有界面统一用它渲染 */
  function expBadge(exp, extraClass) {
    if (!exp) return '';
    const meta = (window.Store && typeof Store.expMeta === 'function') ? Store.expMeta(exp) : null;
    if (!meta) return '';
    return '<span class="exp-badge exp-' + meta.key + (extraClass ? ' ' + extraClass : '') +
      '" title="' + esc(meta.desc) + '">' + meta.icon + ' ' + meta.name + '</span>';
  }

  function init() {
    chatEl = document.getElementById('chat');
    listEl = document.getElementById('player-list');
    phaseEl = document.getElementById('phase-label');
    dayEl = document.getElementById('day-label');
    statusEl = document.getElementById('status');
    toastEl = document.getElementById('toast');
    myPanel = document.getElementById('my-panel');

    const speedInput = document.getElementById('speed');
    if (speedInput) {
      speed = Number(speedInput.value) || 1;
      speedInput.addEventListener('input', function () { speed = Number(this.value) || 1; });
    }
    const priv = document.getElementById('toggle-private');
    if (priv) {
      document.body.classList.toggle('hide-private', !priv.checked);
      priv.addEventListener('change', function () {
        document.body.classList.toggle('hide-private', !this.checked);
      });
    }
    bindHuman();
  }

  /** 切换「上帝视角」（false = 只显示公开信息 / 玩家视角） */
  function setPrivate(on) {
    const priv = document.getElementById('toggle-private');
    if (priv) priv.checked = !!on;
    document.body.classList.toggle('hide-private', !on);
  }

  function getSpeed() { return speed || 1; }

  /* ---------------- 滚动 ---------------- */
  function nearBottom() {
    if (!chatEl) return true;
    return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 220;
  }
  function scrollDown(force) {
    if (!chatEl) return;
    if (force) { chatEl.scrollTop = chatEl.scrollHeight; return; }
    if (nearBottom()) chatEl.scrollTop = chatEl.scrollHeight;
  }

  function clearChat() {
    Object.keys(nodes).forEach(function (k) { delete nodes[k]; });
    if (chatEl) chatEl.innerHTML = '';
  }

  /* ---------------- 气泡文本 ---------------- */
  function setBubble(bubble, text, typing) {
    if (!bubble) return;
    bubble.textContent = text || '';
    if (typing) {
      const c = document.createElement('span');
      c.className = 'typing-caret';
      bubble.appendChild(c);
    }
  }

  /* ============================================================
   * 真人玩家输入条
   *   UI.askHuman(req) → Promise<string|null>
   * ============================================================ */
  function bindHuman() {
    human.bar = document.getElementById('human-bar');
    human.title = document.getElementById('hb-title');
    human.hint = document.getElementById('hb-hint');
    human.chips = document.getElementById('hb-chips');
    human.input = document.getElementById('hb-input');
    human.send = document.getElementById('hb-send');
    human.skip = document.getElementById('hb-skip');
    human.avatar = document.getElementById('hb-avatar');
    if (!human.bar) return;

    if (human.send) human.send.addEventListener('click', function () { submitHuman(); });
    if (human.skip) human.skip.addEventListener('click', function () { submitHuman(''); });
    if (human.chips) {
      human.chips.addEventListener('click', function (e) {
        const chip = e.target.closest('.hb-chip');
        if (!chip) return;
        submitHuman(chip.dataset.value || '');
      });
    }
    if (human.input) {
      human.input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          submitHuman();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          submitHuman('');
        }
      });
    }
  }

  function humanVisible(on) {
    if (!human.bar) return;
    human.bar.classList.toggle('hidden', !on);
  }

  function askHuman(req) {
    if (!human.bar) return Promise.resolve(null);
    const r = req || {};
    humanReq = r;
    humanVisible(true);
    if (human.title) human.title.textContent = r.title || '轮到你';
    if (human.hint) human.hint.textContent = r.hint || '';
    if (human.avatar) human.avatar.textContent = r.avatar || '🙋';
    if (human.input) {
      human.input.value = '';
      human.input.placeholder = r.placeholder || '用自然语言说…';
      human.input.rows = r.multiline ? 3 : 2;
    }
    if (human.skip) human.skip.classList.toggle('hidden', !r.allowSkip);
    if (human.chips) {
      const chips = Array.isArray(r.chips) ? r.chips : [];
      human.chips.innerHTML = chips.map(function (c) {
        const value = (c && c.value !== undefined) ? c.value : c;
        const label = (c && c.label) ? c.label : value;
        return '<button type="button" class="hb-chip" data-value="' + esc(value) + '">' + esc(label) + '</button>';
      }).join('');
      human.chips.classList.toggle('hidden', !chips.length);
    }
    scrollDown(true);
    setTimeout(function () { try { human.input.focus(); } catch (e) { /* ignore */ } }, 40);
    return new Promise(function (resolve) { humanResolve = resolve; });
  }

  function submitHuman(value) {
    if (!humanResolve) return;
    const req = humanReq || {};
    const v = (value === undefined)
      ? String(human.input ? human.input.value : '').trim()
      : value;
    if (v === '' && !req.allowSkip && !req.allowEmpty) {
      toast('说一句话吧，引擎需要知道你的选择');
      if (human.input) human.input.focus();
      return;
    }
    const resolve = humanResolve;
    humanResolve = null;
    humanReq = null;
    humanVisible(false);
    if (human.chips) human.chips.innerHTML = '';
    resolve(v === null ? null : String(v));
  }

  /** 引擎停局时调用：收掉输入框，让等待中的 Promise 结束 */
  function cancelHuman() {
    if (!humanResolve) { humanVisible(false); return; }
    const resolve = humanResolve;
    humanResolve = null;
    humanReq = null;
    humanVisible(false);
    if (human.chips) human.chips.innerHTML = '';
    resolve(null);
  }

  /* ---------------- 我的身份（真人玩家侧边栏） ---------------- */
  function setHumanView(view) {
    if (!myPanel) return;
    if (!view) {
      myPanel.classList.add('hidden');
      myPanel.innerHTML = '';
      return;
    }
    const meta = (window.Werewolf && Werewolf.ROLE_META[view.role]) || { camp: 'good', icon: '', name: view.role };
    const lines = [];
    if (view.mates && view.mates.length) {
      lines.push('<div class="mp-line"><b>狼队友</b>：' +
        view.mates.map(function (m) {
          return esc(m.seat + ' 号 ' + m.name) + (m.alive ? '' : '<span class="muted">（出局）</span>');
        }).join('、') + '</div>');
    }
    if (view.role === 'seer') {
      lines.push('<div class="mp-line"><b>查验</b>：' + (view.checks && view.checks.length
        ? view.checks.map(function (c) {
          return esc(c.seat + ' 号 ' + c.name) + ' ' + (c.camp === 'wolf' ? '🐺狼' : '😇好人');
        }).join('；')
        : '<span class="muted">还没验过人</span>') + '</div>');
    }
    if (view.role === 'witch') {
      lines.push('<div class="mp-line"><b>药</b>：解药' + (view.antidote ? '在' : '已用完') +
        '；毒药' + (view.poison ? '在' : '已用完') + '</div>');
    }
    if (!view.alive) lines.push('<div class="mp-line dead">你已出局，可以继续观战</div>');
    myPanel.classList.remove('hidden');
    myPanel.innerHTML =
      '<div class="mp-head">' +
        avatarHtml(view.avatar, view.name, 'xs') +
        '<div class="mp-title">' + esc(view.seat) + ' 号 · ' + esc(view.name) +
          '<span class="mp-you">你</span></div>' +
        expBadge(view.exp) +
      '</div>' +
      '<div class="mp-role ' + meta.camp + '">' + meta.icon + ' ' + esc(view.roleName || meta.name) +
        '<span class="mp-camp">' + (meta.camp === 'wolf' ? '狼人阵营' : '好人阵营') + '</span></div>' +
      lines.join('');
  }

  /* ---------------- 各类消息 ---------------- */
  function createGM(ev) {
    const el = document.createElement('div');
    el.className = 'msg gm' + (ev.error ? ' error' : '');
    el.innerHTML =
      '<div class="msg-main" style="align-items:center">' +
        '<div class="gm-label">🎩 谜之声 · 主持人' + (ev.banner ? ' · ' + esc(ev.banner) : '') + '</div>' +
        '<div class="bubble"></div>' +
      '</div>';
    const bubble = el.querySelector('.bubble');
    setBubble(bubble, ev.text || '', false);
    return { el: el, bubble: bubble };
  }

  function createSpeech(ev) {
    const sp = ev.speaker || {};
    const isHuman = !!(ev.human || sp.human);
    const meta = (window.Werewolf && Werewolf.ROLE_META[sp.role]) || null;
    const badge = meta
      ? '<span class="msg-role-badge ' + meta.camp + '">' + meta.icon + meta.name + '</span>' : '';
    const banner = ev.banner ? '<span class="msg-role-badge">' + esc(ev.banner) + '</span>' : '';
    const pv = ev.private ? '<span class="msg-private-tag">私密</span>' : '';
    const you = isHuman ? '<span class="msg-role-badge you">你</span>' : '';

    const el = document.createElement('div');
    el.className = 'msg' + (ev.private ? ' private' : '') + (ev.error ? ' error' : '') + (isHuman ? ' human' : '');
    el.innerHTML =
      avatarHtml(sp.avatar, sp.name) +
      '<div class="msg-main">' +
        '<div class="msg-head">' +
          '<span class="msg-name">' + sp.seat + ' 号 · ' + esc(sp.name) + '</span>' +
          expBadge(sp.exp, 'msg-exp') + you + banner + badge + pv +
        '</div>' +
        '<div class="bubble"></div>' +
      '</div>';
    const bubble = el.querySelector('.bubble');
    setBubble(bubble, ev.text || '', false);
    return { el: el, bubble: bubble };
  }

  function createSystem(ev) {
    const el = document.createElement('div');
    el.className = 'msg system';
    const cls = ev.subtype === 'night' ? ' night' : (ev.subtype === 'day' ? ' day' : '');
    el.innerHTML = '<div class="sys-pill' + cls + '">' + esc(ev.text) + '</div>';
    return { el: el };
  }

  function createRoles(ev) {
    const items = (ev.items || []).map(function (it) {
      const meta = (window.Werewolf && Werewolf.ROLE_META[it.role]) || { name: it.role, icon: '', camp: 'good' };
      return '<div class="role-item">' + avatarHtml(it.avatar, it.name) +
        '<span>' + it.seat + ' 号 · ' + esc(it.name) + '</span>' +
        expBadge(it.exp) +
        (it.human ? '<span class="msg-role-badge you">你</span>' : '') +
        '<span class="r-role ' + meta.camp + '">' + meta.icon + meta.name + '</span></div>';
    }).join('');
    const el = document.createElement('div');
    el.className = 'msg private';
    el.innerHTML = '<div class="role-card"><div class="rc-title">👁️ ' + esc(ev.title || '身份分配') +
      '</div><div class="role-grid">' + items + '</div></div>';
    return { el: el };
  }

  function createNight(ev) {
    const lines = (ev.lines || []).map(function (l) {
      const meta = l.role ? Werewolf.ROLE_META[l.role] : null;
      const head = l.seat
        ? l.seat + ' 号 · ' + esc(l.name) + (meta ? '（' + meta.icon + meta.name + '）' : '')
        : esc(l.name || '上帝');
      return '<div class="night-line">' + avatarHtml(l.avatar, l.name) +
        '<div class="nl-body">' +
          '<div class="nl-head">' + head +
            '<span class="nl-tag">' + esc(l.icon || '') + ' ' + esc(l.tag || '') + '</span></div>' +
          '<div style="white-space:pre-wrap">' + esc(l.text || '') + '</div>' +
        '</div></div>';
    }).join('');
    const el = document.createElement('div');
    el.className = 'msg night-card-wrap' + (ev.private ? ' private' : '') + (ev.humanNight ? ' human-night' : '');
    el.innerHTML = '<div class="night-card"><div class="night-card-title">🌙 ' + esc(ev.title || '夜间行动') +
      '</div>' + lines + '</div>';
    return { el: el };
  }

  function createVotes(ev) {
    const lines = (ev.lines || []).map(function (l) {
      return '<div class="vote-item">' + avatarHtml(l.avatar, l.name, 'xs') +
        '<span>' + l.seat + ' 号 ' + esc(l.name) + '</span>' +
        '<span class="vote-arrow">→</span>' +
        '<span class="vote-target">' + (l.targetSeat ? l.targetSeat + ' 号 ' + esc(l.targetName) : '弃票') + '</span>' +
        (l.reason ? '<span class="vote-reason">' + esc(l.reason) + '</span>' : '') +
        '</div>';
    }).join('');
    const el = document.createElement('div');
    el.className = 'msg';
    el.innerHTML = '<div class="vote-card"><div class="vote-title">🗳️ ' + esc(ev.title || '投票详情') +
      '</div><div class="vote-grid">' + lines + '</div>' +
      (ev.summary ? '<div class="vote-summary">' + esc(ev.summary) + '</div>' : '') +
      '</div>';
    return { el: el };
  }

  function createEnd(ev) {
    const s = ev.summary || {};
    const rows = (s.items || []).map(function (it) {
      const meta = Werewolf.ROLE_META[it.role] || { camp: 'good', icon: '' };
      const st = it.alive
        ? '<span class="muted small">存活</span>'
        : '<span class="muted small">第 ' + it.deathDay + ' 天出局</span>';
      return '<div class="ec-role-row">' + avatarHtml(it.avatar, it.name, 'xs') +
        '<span>' + it.seat + ' 号 · ' + esc(it.name) + '</span>' +
        expBadge(it.exp) +
        (it.human ? '<span class="msg-role-badge you">你</span>' : '') +
        '<span class="msg-role-badge ' + meta.camp + '">' + meta.icon + esc(it.roleName) + '</span>' +
        st + '</div>';
    }).join('');
    const el = document.createElement('div');
    el.className = 'msg';
    el.innerHTML = '<div class="end-card">' +
      '<div class="ec-banner ' + (s.winner === 'wolf' ? 'wolf' : 'good') + '">' + esc(s.winnerText) + '</div>' +
      '<div class="ec-sub">共进行 ' + (s.days || 0) + ' 天 · 全部身份公开</div>' +
      '<div class="ec-roles">' + rows + '</div></div>';
    return { el: el };
  }

  /** 把引擎产出的事件画到聊天区；重复 uid 只更新内容 */
  function renderEvent(ev) {
    if (!chatEl || !ev) return null;
    const exist = nodes[ev.uid];
    if (exist) {
      if (exist.bubble) setBubble(exist.bubble, ev.text, false);
      if (ev.error) exist.el.classList.add('error');
      return exist.el;
    }
    const node = createNode(ev);
    if (!node) return null;
    nodes[ev.uid] = node;
    chatEl.appendChild(node.el);
    scrollDown(false);
    return node.el;
  }

  /* ---------------- 流式回调 ---------------- */
  function onMessageStart(msg) {
    if (!chatEl || !msg) return;
    if (msg.type !== 'gm' && msg.type !== 'speech') return;
    if (nodes[msg.uid]) return;
    const node = createNode(msg);
    if (!node) return;
    nodes[msg.uid] = node;
    chatEl.appendChild(node.el);
    if (node.bubble) setBubble(node.bubble, '', true);
    scrollDown(true);
  }

  function onMessageDelta(uid, fullText) {
    const node = nodes[uid];
    if (!node || !node.bubble) return;
    const stick = nearBottom();
    setBubble(node.bubble, fullText, true);
    if (stick) scrollDown(true);
  }

  function onMessageEnd(uid) {
    const node = nodes[uid];
    if (!node || !node.bubble) return;
    setBubble(node.bubble, bubbleText(node.bubble), false);
  }

  /* ---------------- 侧边栏 ---------------- */
  function renderPlayers(game) {
    if (!listEl || !game) return;
    listEl.innerHTML = game.players.map(function (p) {
      const meta = Werewolf.ROLE_META[p.role] || { name: p.role, icon: '', camp: 'good' };
      return '<div class="player-item' + (p.alive ? '' : ' dead') + (p.human ? ' is-human' : '') + '" data-seat="' + p.seat + '">' +
        avatarHtml(p.card.avatar, p.card.name, 'xs') +
        '<div class="p-meta">' +
          '<span class="p-name">' + esc(p.card.name) + '</span>' +
          '<span class="p-tags">' + expBadge(p.exp || p.card.experience) +
            '<span class="p-role ' + meta.camp + '">' + meta.icon + meta.name + '</span></span>' +
        '</div>' +
        '<span class="seat-tag">' + p.seat + '号</span>' +
        (p.human ? '<span class="seat-tag you">你</span>' : '') +
        (p.alive ? '' : '<span class="dead-mark">✝</span>') +
        '</div>';
    }).join('');
    setDayLabel(game);
    if (typeof game.humanView === 'function') setHumanView(game.humanView());
  }

  function setSpeaking(seat) {
    if (!listEl) return;
    Array.prototype.forEach.call(listEl.querySelectorAll('.player-item'), function (el) {
      el.classList.toggle('speaking', seat !== null && Number(el.dataset.seat) === Number(seat));
    });
  }

  const PHASE_TEXT = {
    setup: '准备中', start: '开局', night: '🌙 夜晚', dawn: '🌅 天亮',
    day: '☀️ 白天', vote: '🗳️ 投票', end: '🏁 结束'
  };

  function setPhase(game) {
    if (!phaseEl || !game) return;
    const phase = game.state.phase;
    let cls = '';
    if (phase === 'night') cls = ' night';
    else if (phase === 'day' || phase === 'vote' || phase === 'dawn') cls = ' day';
    phaseEl.className = 'phase-pill' + cls;
    phaseEl.textContent = PHASE_TEXT[phase] || phase;
    setDayLabel(game);
  }

  function setDayLabel(game) {
    if (!dayEl || !game) return;
    const aliveCount = game.players.filter(function (p) { return p.alive; }).length;
    dayEl.textContent = game.state.day ? '第 ' + game.state.day + ' 天 · 存活 ' + aliveCount : '存活 ' + aliveCount;
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  /* ---------------- Toast ---------------- */
  function toast(msg, bad) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (bad ? ' bad' : '');
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { toastEl.className = 'toast'; }, 2600);
  }

  /* ---------------- 应用内确认框（替代阻塞的 window.confirm） ----------------
   * UI.confirm('要删除吗？')  → Promise<boolean>
   * UI.confirm({ title, text, okText, cancelText, safe }) → Promise<boolean>
   */
  let confirmEls = null;
  let confirmResolve = null;

  function confirmEnsure() {
    if (confirmEls) return confirmEls;
    const box = document.getElementById('confirm-modal');
    if (!box) return null;
    confirmEls = {
      box: box,
      title: document.getElementById('confirm-title'),
      text: document.getElementById('confirm-text'),
      ok: document.getElementById('confirm-ok'),
      cancel: document.getElementById('confirm-cancel')
    };
    function done(value) {
      if (!confirmResolve) return;
      const resolve = confirmResolve;
      confirmResolve = null;
      confirmEls.box.hidden = true;
      resolve(value);
    }
    confirmEls.settle = done;
    confirmEls.ok.addEventListener('click', function () { done(true); });
    confirmEls.cancel.addEventListener('click', function () { done(false); });
    confirmEls.box.addEventListener('click', function (e) {
      if (e.target === confirmEls.box) done(false);
    });
    document.addEventListener('keydown', function (e) {
      if (!confirmEls || confirmEls.box.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    });
    return confirmEls;
  }

  function confirmAction(opts) {
    const o = typeof opts === 'string' ? { text: opts } : (opts || {});
    const els = confirmEnsure();
    if (!els) return Promise.resolve(window.confirm(o.text || '确定吗？'));

    // 上一个确认框还开着：先按「取消」收尾，避免 Promise 泄漏
    if (confirmResolve) { const prev = confirmResolve; confirmResolve = null; prev(false); }

    els.title.textContent = o.title || '请确认';
    els.text.textContent = o.text || '确定吗？';
    els.ok.textContent = o.okText || '确定';
    els.ok.className = 'btn ' + (o.safe ? 'primary' : 'danger');
    els.cancel.textContent = o.cancelText || '取消';
    els.box.hidden = false;
    setTimeout(function () { try { els.ok.focus(); } catch (e) { /* ignore */ } }, 30);

    return new Promise(function (resolve) { confirmResolve = resolve; });
  }


  function createNode(ev) {
    switch (ev.type) {
      case 'gm': return createGM(ev);
      case 'speech': return createSpeech(ev);
      case 'system': return createSystem(ev);
      case 'roles': return createRoles(ev);
      case 'night': return createNight(ev);
      case 'votes': return createVotes(ev);
      case 'end': return createEnd(ev);
      default: return null;
    }
  }

  function bubbleText(bubble) {
    return bubble ? String(bubble.textContent || '') : '';
  }

  return {
    init: init,
    getSpeed: getSpeed,
    clearChat: clearChat,
    renderEvent: renderEvent,
    onMessageStart: onMessageStart,
    onMessageDelta: onMessageDelta,
    onMessageEnd: onMessageEnd,
    renderPlayers: renderPlayers,
    setSpeaking: setSpeaking,
    setPhase: setPhase,
    setDayLabel: setDayLabel,
    setStatus: setStatus,
    setPrivate: setPrivate,
    setHumanView: setHumanView,
    askHuman: askHuman,
    cancelHuman: cancelHuman,
    toast: toast,
    confirm: confirmAction,
    avatarHtml: avatarHtml,
    expBadge: expBadge,
    parseAvatar: parseAvatar,
    esc: esc
  };
})();

