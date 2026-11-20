/* ============================================================
 * characters.js —— 角色卡库：网格 / 编辑弹窗 / AI 人设总结 / 导入导出
 * ============================================================ */
window.Characters = (function () {
  'use strict';

  const esc = s => UI.esc(s);

  const TAG_SUGGEST = [
    '傲娇', '腹黑', '天然呆', '毒舌', '三无', '元气', '病娇', '大小姐', '青梅竹马',
    '学姐', '妹妹', '中二', '冷静', '弱气', '热血', '高冷', '温柔', '爱笑', '御姐',
    '社恐', '话痨', '小恶魔', '正义感', '沉默寡言', '冒失', '理智'
  ];

  const MAX_TAGS = 20;
  /** TAG 分隔符：顿号 / 逗号 / 分号 / 竖线 / 斜杠 / 空白（萌百复制出来的都是这些） */
  const TAG_SPLIT = /[\s\u3000、,，;；|｜\/／\\]+/;

  const MAX_AVATAR_BYTES = 800 * 1024;   // 原图上限（存进去的是压缩后的图，小得多）
  const AVATAR_MAX_EDGE = 320;           // 压缩后最长边

  /** 经验水平对说话方式的影响（写进 AI 生成人设的提示词） */
  const EXP_HINT = {
    novice: '术语极少、逻辑浅；没被怀疑时只说自己的信息、不做长篇分析，被怀疑了才会急起来解释；容易跟风改口，偶尔把术语用错',
    skilled: '术语自然（验人/悍跳/抗推/跟票），一次发言 1~2 个，有一两步推理和明确倾向',
    veteran: '术语密度高且准确（倒钩/穿衣服/抗推位/票型/金水），会拆发言、算票、安排验人链'
  };

  const el = {};
  let editingId = null;
  let tags = [];
  let avatarValue = '';
  let onChange = function () {};

  /* ---------------- 网格 ---------------- */
  function render() {
    if (!el.grid) return;
    const list = Store.cards();
    if (!list.length) {
      el.grid.innerHTML = '<div class="empty-hint">还没有角色卡。<br>' +
        '点击右上角「＋ 新建角色卡」创建，或者「载入示例角色」快速开始。</div>';
      return;
    }
    el.grid.innerHTML = list.map(function (c) {
      const ps = c.persona || {};
      const ready = !!(ps.personality || ps.speechStyle);
      const exp = Store.expMeta(c.experience);
      const caps = catchList(c);
      const rate = Store.catchRateMeta(ps.catchphraseRate);
      const tagHtml = (c.tags || []).slice(0, 8).map(t => '<span class="tag">' + esc(t) + '</span>').join('');
      return '<div class="card-item" data-id="' + esc(c.id) + '">' +
        '<div class="ci-top">' + UI.avatarHtml(c.avatar, c.name, 'lg') +
          '<div>' +
            '<div class="ci-name">' + esc(c.name) + '</div>' +
            '<div class="ci-exp exp-' + exp.key + '" title="' + esc(exp.desc) + '">' +
              exp.icon + ' ' + exp.name + '</div>' +
            '<div class="ci-sub">' + (ready ? '✅ 人设已就绪' : '⚠️ 还没生成人设') + '</div>' +
          '</div>' +
        '</div>' +
        (caps.length
          ? '<div class="ci-catch">💬 ' + esc(caps.join(' / ')) +
            ' <span class="muted">· ' + rate.name + '频</span></div>'
          : '') +
        (tagHtml ? '<div class="ci-tags">' + tagHtml + '</div>' : '') +
        '<div class="ci-intro">' + esc(c.intro || '（没有填写介绍）') + '</div>' +
        '<div class="ci-actions">' +
          '<button class="btn tiny" data-act="edit">编辑</button>' +
          '<button class="btn tiny" data-act="regen" title="基于这张卡重新生成一套人设语气，另存为新卡">🎲 重生成</button>' +
          '<button class="btn tiny ghost" data-act="del">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  /** 口头禅列表（支持 | 、 ; 分隔） */
  function catchList(card) {
    if (window.Werewolf && typeof Werewolf.catchList === 'function') return Werewolf.catchList(card);
    const raw = String(((card && card.persona) || {}).catchphrase || '');
    return raw.split(/[|｜、;；\n]+/).map(s => s.trim()).filter(Boolean).slice(0, 4);
  }

  /* ---------------- 头像：上传 / 粘贴图片 ---------------- */

  /** 图片文件 → 压缩后的 dataURL（粘贴的截图动辄几 MB，压完只剩几十 KB） */
  function fileToAvatar(file, done) {
    const reader = new FileReader();
    reader.onerror = function () { done(''); };
    reader.onload = function () {
      const raw = String(reader.result || '');
      const img = new Image();
      img.onerror = function () { done(raw); };
      img.onload = function () {
        try {
          const w0 = img.naturalWidth || img.width || 0;
          const h0 = img.naturalHeight || img.height || 0;
          if (!w0 || !h0) { done(raw); return; }
          const scale = Math.min(1, AVATAR_MAX_EDGE / Math.max(w0, h0));
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(w0 * scale));
          cv.height = Math.max(1, Math.round(h0 * scale));
          const ctx = cv.getContext('2d');
          if (!ctx) { done(raw); return; }
          ctx.drawImage(img, 0, 0, cv.width, cv.height);
          let out = '';
          try { out = cv.toDataURL('image/webp', 0.9); } catch (e) { out = ''; }
          if (!out || out.indexOf('data:image/webp') !== 0) {
            try { out = cv.toDataURL('image/jpeg', 0.9); } catch (e2) { out = ''; }
          }
          done(out && out.length < raw.length ? out : raw);
        } catch (e) {
          done(raw);
        }
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
  }

  function setAvatarData(dataUrl) {
    avatarValue = 'url:' + dataUrl;
    if (el.avatarInput) el.avatarInput.value = avatarValue;
    setPreview();
  }

  /** 统一的「用这个图片文件当头像」入口：上传和粘贴都走这里 */
  function applyAvatarFile(file) {
    if (!file) return false;
    if (!/^image\//i.test(file.type || '')) { UI.toast('这不是图片文件', true); return false; }
    if (file.size > MAX_AVATAR_BYTES) {
      UI.toast('图片太大了（' + Math.round(MAX_AVATAR_BYTES / 1024) + 'KB 以内）', true);
      return false;
    }
    fileToAvatar(file, function (dataUrl) {
      if (!dataUrl) { UI.toast('图片读取失败', true); return; }
      setAvatarData(dataUrl);
      UI.toast('头像已更新');
    });
    return true;
  }

  /** 从剪贴板数据里取出第一张图片 */
  function clipboardImage(dt) {
    if (!dt) return null;
    const items = dt.items ? Array.prototype.slice.call(dt.items) : [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && /^image\//i.test(it.type || '')) {
        const f = it.getAsFile();
        if (f) return f;
      }
    }
    return null;
  }

  /** 弹窗里按 Ctrl+V：剪贴板有图片就当头像；在文本框里且同时带文字时不抢文字粘贴 */
  function onModalPaste(e) {
    if (!el.modal || el.modal.hidden) return;
    const dt = e.clipboardData || window.clipboardData;
    const file = clipboardImage(dt);
    if (!file) return;
    const t = e.target;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    let hasText = false;
    try { hasText = !!(dt && dt.getData && dt.getData('text/plain')); } catch (err) { hasText = false; }
    if (typing && hasText) return;
    e.preventDefault();
    applyAvatarFile(file);
  }

  /** 「📋 粘贴图片」按钮：剪贴板 API 不可用时提示用 Ctrl+V */
  function pasteAvatarFromClipboard() {
    const clip = navigator.clipboard;
    if (!clip || typeof clip.read !== 'function') {
      UI.toast('这个浏览器不允许按钮读剪贴板，请在弹窗里直接按 Ctrl+V', true);
      return;
    }
    clip.read().then(function (items) {
      const list = Array.prototype.slice.call(items || []);
      for (let i = 0; i < list.length; i++) {
        const types = list[i].types || [];
        const type = types.filter(function (x) { return /^image\//i.test(x); })[0];
        if (!type) continue;
        return list[i].getType(type).then(function (blob) {
          applyAvatarFile(new File([blob], 'paste.png', { type: type }));
        });
      }
      UI.toast('剪贴板里没有图片', true);
    }).catch(function () {
      UI.toast('浏览器拒绝了剪贴板访问，请直接按 Ctrl+V 粘贴', true);
    });
  }


  /* ---------------- 弹窗 ---------------- */
  function setPreview() {
    if (!el.preview) return;
    const p = UI.parseAvatar(avatarValue);
    if (p.type === 'img') {
      el.preview.innerHTML = '<img src="' + esc(p.value) + '" alt="">';
    } else if (p.type === 'emoji') {
      el.preview.textContent = p.value;
    } else {
      const n = (el.name.value || '?').trim().charAt(0) || '?';
      el.preview.textContent = n.toUpperCase();
    }
  }

  function renderTags() {
    if (!el.chips) return;
    el.chips.innerHTML = tags.map(function (t, i) {
      return '<span class="tag-chip">' + esc(t) +
        '<button type="button" data-i="' + i + '" title="移除">✕</button></span>';
    }).join('');
  }

  function renderTagSuggest() {
    if (!el.suggest) return;
    el.suggest.innerHTML = TAG_SUGGEST
      .filter(t => tags.indexOf(t) < 0)
      .slice(0, 14)
      .map(t => '<button type="button" data-tag="' + esc(t) + '">＋' + esc(t) + '</button>')
      .join('');
  }

  /** 单个 TAG 清洗：去掉包裹符号、萌百的「分类:」前缀、井号与多余空白 */
  function cleanTag(raw) {
    return String(raw === null || raw === undefined ? '' : raw)
      .replace(/^[\s\u3000\[\]【】()（）<>《》"'“”‘’]+/, '')
      .replace(/[\s\u3000\[\]【】()（）<>《》"'“”‘’]+$/, '')
      .replace(/^(分类|category|tag|标签)\s*[:：]/i, '')
      .replace(/^#+/, '')
      .replace(/[\s\u3000]+/g, ' ')
      .trim();
  }

  /** 内部：只入栈不刷 UI，返回是否真的加进去了 */
  function pushTag(raw, silent) {
    const t = cleanTag(raw);
    if (!t) return false;
    if (t.length > 12) { if (!silent) UI.toast('单个 TAG 不要太长（12 字以内）', true); return false; }
    if (tags.some(function (x) { return x === t; })) return false;
    if (tags.length >= MAX_TAGS) { if (!silent) UI.toast('TAG 最多 ' + MAX_TAGS + ' 个', true); return false; }
    tags.push(t);
    return true;
  }

  /** 加一个 TAG（建议标签按钮等） */
  function addTag(raw) {
    const ok = pushTag(raw, false);
    renderTags();
    renderTagSuggest();
    return ok;
  }

  /** 批量识别：「傲娇、腹黑、天然呆」「傲娇 腹黑」「分类:傲娇 [[分类:腹黑]]」都能拆开 */
  function addTags(text) {
    const parts = String(text || '').split(TAG_SPLIT).filter(function (p) { return !!cleanTag(p); });
    if (!parts.length) { renderTags(); renderTagSuggest(); return 0; }
    const many = parts.length > 1;
    let added = 0;
    parts.forEach(function (p) { if (pushTag(p, many)) added++; });
    renderTags();
    renderTagSuggest();
    if (many) {
      if (added) UI.toast('已识别 ' + added + ' 个 TAG' + (added < parts.length ? '（其余重复或过长）' : ''));
      else UI.toast('这些 TAG 已经加过了', true);
    }
    return added;
  }

  function openModal(card) {
    const c = card ? Store.normalizeCard(card) : null;
    editingId = c ? c.id : null;
    tags = c ? (c.tags || []).slice() : [];
    avatarValue = c ? (c.avatar || '') : '';

    el.modalTitle.textContent = c ? '编辑角色卡' : '新建角色卡';
    el.name.value = c ? c.name : '';
    el.exp.value = c ? c.experience : 'skilled';
    el.intro.value = c ? c.intro : '';
    el.avatarInput.value = avatarValue;
    const ps = (c && c.persona) || {};
    el.personality.value = ps.personality || '';
    el.tone.value = ps.tone || '';
    el.speech.value = ps.speechStyle || '';
    el.catch.value = ps.catchphrase || '';
    el.catchRate.value = ps.catchphraseRate || 'mid';
    el.values.value = ps.values || '';
    el.background.value = ps.background || '';
    el.deleteBtn.style.display = c ? '' : 'none';

    renderTags();
    renderTagSuggest();
    setPreview();
    el.modal.hidden = false;
    setTimeout(() => { el.name.focus(); }, 30);
  }

  function closeModal() {
    el.modal.hidden = true;
    editingId = null;
  }

  function collect() {
    return {
      id: editingId || undefined,
      name: el.name.value.trim(),
      avatar: avatarValue.trim(),
      intro: el.intro.value.trim(),
      experience: el.exp.value || 'skilled',
      tags: tags.slice(),
      persona: {
        personality: el.personality.value.trim(),
        tone: el.tone.value.trim(),
        speechStyle: el.speech.value.trim(),
        catchphrase: el.catch.value.trim(),
        catchphraseRate: el.catchRate.value || 'mid',
        values: el.values.value.trim(),
        background: el.background.value.trim()
      }
    };
  }

  function save() {
    const data = collect();
    if (!data.name) { UI.toast('请填写角色名称', true); el.name.focus(); return; }
    if (!data.persona.personality && !data.intro) {
      UI.toast('建议至少填写「角色介绍」或「AI 生成人设」，否则 AI 很难扮演', true);
    }
    Store.upsertCard(data);
    closeModal();
    render();
    onChange();
    UI.toast('已保存角色卡：' + data.name);
  }

  /** 真正执行删除（已确认后调用） */
  function doRemove(id) {
    const c = Store.getCard(id);
    if (!c) return;
    Store.removeCard(id);
    render();
    onChange();
    UI.toast('已删除：' + c.name);
  }

  /** 询问删除：返回 Promise<boolean> */
  function askRemove(id) {
    const c = Store.getCard(id);
    if (!c) return Promise.resolve(false);
    return UI.confirm({
      title: '删除角色卡',
      text: '确定删除「' + c.name + '」吗？此操作不可撤销。',
      okText: '删除'
    });
  }

  async function remove(id) {
    if (!(await askRemove(id))) return;
    doRemove(id);
  }


  /* ---------------- AI 生成人设 ---------------- */
  const SYS_PERSONA = [
    '你是一位资深的角色设定师，擅长把零散的角色资料整理成「AI 角色扮演」用的人设卡。',
    '你的输出必须严格依据用户提供的资料与 TAG，不要编造与原作冲突的设定。',
    '你对「怎么说话」的描写极其具体：句式、语气词、称呼、情绪上头时的变化，都要能直接演出来。',
    '所有文字都用中文，具体、可表演、避免空话套话。'
  ].join('\n');

  /** 组织「生成人设」的提示词。o = { name, intro, tags, experience, variant } */
  function personaPrompt(o) {
    const exp = o.experience || 'skilled';
    const meta = Store.expMeta(exp);
    const payload = [
      '【名称】' + o.name,
      '【狼人杀经验】' + meta.name + '——' + (EXP_HINT[exp] || EXP_HINT.skilled),
      '【TAG】' + (o.tags && o.tags.length ? o.tags.join('、') : '（未填写）'),
      '【角色介绍】' + (o.intro || '（未填写，请依据名称与 TAG 合理推断，不要引入无关的名作设定）')
    ].join('\n');

    const lines = [
      '请根据下面的角色信息，总结一份用于「AI 狼人杀」角色扮演的人设。',
      '',
      payload,
      '',
      '【硬性要求】',
      '1) 语气细节必须具体到"怎么开口"：句长与断句、常用语气词与口癖、怎么称呼别人（喂 / 前辈 / 某某同学 / 直呼全名）、情绪上头时会有什么变化（语速、音量、结巴、叠字）。',
      '2) 口头禅给 4 条，分别对应不同情绪（疑惑 / 得意 / 不耐烦 / 紧张），每条 15 字以内，用 | 分隔。',
      '3) 说话的信息量与术语密度必须和上面的【狼人杀经验】匹配：新手词少、逻辑浅，没被怀疑时只说自己的信息、不做长篇分析；熟手术语自然、有一两步推理；老手术语密集、会拆发言和算票。',
      '4) values 要写清他在狼人杀里的具体行为：是否多疑、爱不爱带节奏、被怀疑时怎么反应、会不会撒谎。但任何一条都不许写成"会评价别人的资历/水平"——桌面上的规矩是没人把资历挂在嘴上。'
    ];
    if (o.variant) {
      lines.push('5) 这是「重新生成」：保持同一个角色、同样的 TAG 与介绍、同样的经验水平，但换一个情绪底色和一套说话节奏，让人一听就知道和之前那版不同。不要改名，也不要改变经验水平。');
    }
    lines.push(
      '',
      '只输出 JSON，不要代码块，字段如下：',
      '{',
      '  "personality": "性格，40~80 字，包含优点与致命弱点",',
      '  "tone": "语气基调，15~30 字，例如：慵懒带刺，越到关键处越慢",',
      '  "speechStyle": "说话方式，60~110 字，必须包含：①句长与断句 ②常用语气词/口癖 ③称呼别人的方式 ④情绪上头时的变化",',
      '  "catchphrase": "4 条口头禅，用 | 分隔，每条 15 字以内",',
      '  "catchphraseRate": "low 或 mid 或 high，选一个最贴合这个角色的",',
      '  "values": "行为逻辑，40~80 字：在狼人杀里是否多疑、爱不爱带节奏、被怀疑时怎么反应、会不会撒谎",',
      '  "background": "背景摘要，60~120 字"',
      '}'
    );
    return lines.join('\n');
  }

  const RATE_KEYS = ['low', 'mid', 'high'];

  /** 把模型返回的人设写进弹窗表单 */
  function applyPersona(d) {
    if (d.personality) el.personality.value = String(d.personality).trim();
    if (d.tone) el.tone.value = String(d.tone).trim();
    if (d.speechStyle) el.speech.value = String(d.speechStyle).trim();
    if (d.catchphrase) el.catch.value = String(d.catchphrase).trim();
    const rate = String(d.catchphraseRate || '').trim();
    if (RATE_KEYS.indexOf(rate) >= 0) el.catchRate.value = rate;
    if (d.values) el.values.value = String(d.values).trim();
    if (d.background) el.background.value = String(d.background).trim();
  }

  async function generatePersona() {
    const name = el.name.value.trim();
    if (!name) { UI.toast('先填一下角色名称', true); el.name.focus(); return; }
    const s = Store.settings();
    if (!s.apiKey) {
      UI.toast('请先在「设置」页填写 API Key', true);
      return;
    }

    const btn = el.genBtn;
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '✨ 生成中…';
    try {
      const text = await LLM.chat({
        messages: [
          { role: 'system', content: SYS_PERSONA },
          {
            role: 'user',
            content: personaPrompt({
              name: name,
              intro: el.intro.value.trim(),
              tags: tags,
              experience: el.exp.value || 'skilled',
              variant: false
            })
          }
        ],
        temperature: 0.8,
        stream: false
      });
      const d = LLM.parseJSON(text) || {};
      if (!d.personality && !d.speechStyle) throw new Error('模型没有返回可解析的人设 JSON，请重试');
      applyPersona(d);
      UI.toast('人设已生成，记得点「保存角色卡」');
    } catch (e) {
      UI.toast('生成失败：' + (e.message || '未知错误'), true);
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  /* ---------------- 重新生成：另存为新卡 ---------------- */
  let regenBusy = false;

  /** 生成一个不重名的新名字：星野结衣 → 星野结衣 (2) */
  function uniqueName(base) {
    const clean = String(base || '').trim() || '无名角色';
    const names = Store.cards().map(function (c) { return c.name; });
    if (names.indexOf(clean) < 0) return clean;
    for (let i = 2; i < 200; i++) {
      const cand = clean + ' (' + i + ')';
      if (names.indexOf(cand) < 0) return cand;
    }
    return clean + ' (' + Date.now().toString(36) + ')';
  }

  /**
   * 基于 base 重新生成一套人设，并保存为一张新角色卡（原卡不动）
   * base = { name, avatar, intro, tags, experience }
   */
  async function regenerateAsNew(base) {
    if (regenBusy) return null;
    const name = String((base && base.name) || '').trim();
    if (!name) { UI.toast('先填一下角色名称', true); return null; }
    const s = Store.settings();
    if (!s.apiKey) { UI.toast('请先在「设置」页填写 API Key', true); return null; }

    regenBusy = true;
    const btn = el.regenBtn;
    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '🎲 生成中…'; }
    try {
      const text = await LLM.chat({
        messages: [
          { role: 'system', content: SYS_PERSONA },
          {
            role: 'user',
            content: personaPrompt({
              name: name,
              intro: base.intro || '',
              tags: base.tags || [],
              experience: base.experience || 'skilled',
              variant: true
            })
          }
        ],
        temperature: 0.95,
        stream: false
      });
      const d = LLM.parseJSON(text) || {};
      if (!d.personality && !d.speechStyle) throw new Error('模型没有返回可解析的人设 JSON，请重试');
      const rate = String(d.catchphraseRate || '').trim();
      const card = Store.upsertCard({
        name: uniqueName(name),
        avatar: base.avatar || '',
        intro: base.intro || '',
        experience: base.experience || 'skilled',
        tags: (base.tags || []).slice(),
        persona: {
          personality: String(d.personality || '').trim(),
          tone: String(d.tone || '').trim(),
          speechStyle: String(d.speechStyle || '').trim(),
          catchphrase: String(d.catchphrase || '').trim(),
          catchphraseRate: RATE_KEYS.indexOf(rate) >= 0 ? rate : 'mid',
          values: String(d.values || '').trim(),
          background: String(d.background || '').trim()
        }
      });
      render();
      onChange();
      UI.toast('已重新生成并保存为新卡：' + card.name);
      return card;
    } catch (e) {
      UI.toast('重新生成失败：' + (e.message || '未知错误'), true);
      return null;
    } finally {
      regenBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  }

  /** 弹窗底部的「重新生成为新卡」：用当前表单内容生成，成功后弹窗切到新卡 */
  async function regenerateFromModal() {
    const data = collect();
    if (!data.name) { UI.toast('请填写角色名称', true); el.name.focus(); return; }
    const card = await regenerateAsNew({
      name: data.name,
      avatar: data.avatar,
      intro: data.intro,
      tags: data.tags,
      experience: data.experience
    });
    if (!card) return;
    el.modal.hidden = true;
    openModal(card);
  }

  /** 网格里的「🎲 重生成」：确认后基于该卡生成新卡，原卡保留 */
  function regenerateFromGrid(id) {
    const c = Store.getCard(id);
    if (!c) return;
    UI.confirm({
      title: '重新生成为新卡',
      text: '会保留「' + c.name + '」的名称、TAG 与介绍，重新生成一套不同的人设与语气，并另存为一张新角色卡（原卡不动）。',
      okText: '开始生成',
      safe: true
    }).then(function (ok) {
      if (!ok) return;
      regenerateAsNew({
        name: c.name,
        avatar: c.avatar,
        intro: c.intro,
        tags: (c.tags || []).slice(),
        experience: c.experience
      });
    });
  }

  /* ---------------- 导入 / 导出 ---------------- */
  function exportAll() {
    const list = Store.cards();
    if (!list.length) { UI.toast('还没有角色卡可以导出', true); return; }
    Store.exportFile();
    UI.toast('已导出 ' + list.length + ' 张角色卡');
  }

  function importFile(file) {
    if (!file) return;
    Store.importFile(file)
      .then(function (r) {
        render();
        onChange();
        UI.toast('导入完成：新增 ' + r.added + ' 张，更新 ' + r.updated + ' 张，共 ' + r.total + ' 张');
      })
      .catch(function (e) {
        UI.toast('导入失败：' + (e.message || '文件无法解析'), true);
      });
  }

  function loadDemo() {
    const added = Store.loadDemoCards(window.DEMO_CARDS || []);
    render();
    onChange();
    UI.toast(added ? ('已载入 ' + added + ' 张示例角色卡') : '示例角色卡都已经在库里了');
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    el.grid = document.getElementById('cards-grid');
    el.modal = document.getElementById('card-modal');
    el.modalTitle = document.getElementById('card-modal-title');
    el.preview = document.getElementById('avatar-preview');
    el.avatarInput = document.getElementById('card-avatar');
    el.avatarFile = document.getElementById('avatar-file');
    el.name = document.getElementById('card-name');
    el.exp = document.getElementById('card-exp');
    el.intro = document.getElementById('card-intro');
    el.chips = document.getElementById('tag-chips');
    el.tagInput = document.getElementById('tag-input');
    el.suggest = document.getElementById('tag-suggest');
    el.personality = document.getElementById('p-personality');
    el.tone = document.getElementById('p-tone');
    el.speech = document.getElementById('p-speech');
    el.catch = document.getElementById('p-catch');
    el.catchRate = document.getElementById('p-catch-rate');
    el.values = document.getElementById('p-values');
    el.background = document.getElementById('p-background');
    el.genBtn = document.getElementById('btn-gen-persona');
    el.regenBtn = document.getElementById('btn-regen-card');
    el.saveBtn = document.getElementById('btn-save-card');
    el.deleteBtn = document.getElementById('btn-delete-card');
    el.fileImport = document.getElementById('file-import');

    const on = function (id, ev, fn) {
      const node = document.getElementById(id);
      if (node) node.addEventListener(ev, fn);
    };

    on('btn-new-card', 'click', function () { openModal(null); });
    on('btn-export', 'click', exportAll);
    on('btn-demo', 'click', loadDemo);
    on('btn-import', 'click', function () { if (el.fileImport) el.fileImport.click(); });
    if (el.fileImport) {
      el.fileImport.addEventListener('change', function () {
        importFile(this.files && this.files[0]);
        this.value = '';
      });
    }

    // 网格：编辑 / 重生成 / 删除
    if (el.grid) {
      el.grid.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const cardItem = e.target.closest('.card-item');
        if (!cardItem) return;
        const id = cardItem.dataset.id;
        if (btn.dataset.act === 'edit') openModal(Store.getCard(id));
        else if (btn.dataset.act === 'del') remove(id);
        else if (btn.dataset.act === 'regen') regenerateFromGrid(id);
      });
    }

    // 弹窗按钮
    on('card-modal-close', 'click', closeModal);
    on('card-modal-cancel', 'click', closeModal);
    on('btn-regen-card', 'click', regenerateFromModal);
    if (el.saveBtn) el.saveBtn.addEventListener('click', save);
    if (el.deleteBtn) {
      el.deleteBtn.addEventListener('click', async function () {
        if (!editingId) return;
        const id = editingId;
        if (!(await askRemove(id))) return;
        closeModal();
        doRemove(id);
      });
    }
    if (el.modal) {
      el.modal.addEventListener('click', function (e) {
        if (e.target === el.modal) closeModal();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && el.modal && !el.modal.hidden) closeModal();
    });

    // 头像
    if (el.avatarInput) {
      el.avatarInput.addEventListener('input', function () {
        avatarValue = this.value;
        setPreview();
      });
    }
    if (el.avatarFile) {
      el.avatarFile.addEventListener('change', function () {
        const file = this.files && this.files[0];
        this.value = '';
        applyAvatarFile(file);
      });
    }
    on('btn-paste-avatar', 'click', pasteAvatarFromClipboard);
    document.addEventListener('paste', onModalPaste);
    on('btn-clear-avatar', 'click', function () {
      avatarValue = '';
      el.avatarInput.value = '';
      setPreview();
    });
    if (el.name) el.name.addEventListener('input', setPreview);

    // TAG：回车 / 逗号逐个添加，粘贴一串自动拆分
    if (el.tagInput) {
      el.tagInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
          e.preventDefault();
          addTags(this.value);
          this.value = '';
        } else if (e.key === 'Backspace' && !this.value && tags.length) {
          tags.pop();
          renderTags();
          renderTagSuggest();
        }
      });
      el.tagInput.addEventListener('blur', function () {
        if (this.value.trim()) { addTags(this.value); this.value = ''; }
      });
      // 从萌娘百科复制「傲娇、腹黑、天然呆」直接粘贴 → 自动拆成多个 TAG
      el.tagInput.addEventListener('paste', function (e) {
        const dt = e.clipboardData || window.clipboardData;
        let text = '';
        try { text = dt ? String(dt.getData('text/plain') || dt.getData('text') || '') : ''; } catch (err) { text = ''; }
        if (!text || !TAG_SPLIT.test(text)) return;   // 单个 TAG 走浏览器默认粘贴
        e.preventDefault();
        const base = this.value.trim();
        addTags(base ? (base + '、' + text) : text);
        this.value = '';
      });
    }
    if (el.chips) {
      el.chips.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-i]');
        if (!btn) return;
        tags.splice(Number(btn.dataset.i), 1);
        renderTags();
        renderTagSuggest();
      });
    }
    if (el.suggest) {
      el.suggest.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-tag]');
        if (!btn) return;
        addTag(btn.dataset.tag);
      });
    }

    if (el.genBtn) el.genBtn.addEventListener('click', generatePersona);
  }

  function init(options) {
    if (options && typeof options.onChange === 'function') onChange = options.onChange;
    bind();
    render();
  }

  return {
    init: init,
    render: render,
    openModal: function (card) { openModal(card); },
    TAG_SUGGEST: TAG_SUGGEST
  };
})();

