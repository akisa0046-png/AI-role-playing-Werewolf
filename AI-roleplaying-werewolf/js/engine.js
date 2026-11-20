/* ============================================================
 * engine.js —— 狼人杀引擎
 *  · 角色配置 / 状态机 / 每个角色的 AI 决策 / AI 主持
 *  · 以 async generator 逐个产出事件，天然支持「自动播放」与「手动步进」
 * ============================================================ */
window.Werewolf = (function () {
  'use strict';

  const ROLE_META = {
    wolf:     { name: '狼人',   camp: 'wolf', icon: '🐺', desc: '每晚与队友一起杀死一名玩家' },
    seer:     { name: '预言家', camp: 'good', icon: '🔮', desc: '每晚查验一名玩家的阵营' },
    witch:    { name: '女巫',   camp: 'good', icon: '🧪', desc: '拥有一瓶解药和一瓶毒药，各可用一次' },
    hunter:   { name: '猎人',   camp: 'good', icon: '🏹', desc: '被狼人杀害或被投票放逐时可以开枪带走一人' },
    villager: { name: '村民',   camp: 'good', icon: '🌾', desc: '没有技能，靠推理和投票找出狼人' }
  };

  const PRESETS = {
    5:  ['wolf', 'wolf', 'seer', 'villager', 'villager'],
    6:  ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'],
    7:  ['wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager'],
    8:  ['wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager'],
    9:  ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager'],
    10: ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager', 'villager'],
    11: ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager', 'villager', 'villager'],
    12: ['wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager', 'villager', 'villager'],
    13: ['wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager', 'villager', 'villager', 'villager']
  };

  const MAX_PLAYERS = 13;

  const LEN = {
    short:  { hint: '简短一些，40~80 字' },
    normal: { hint: '80~150 字左右' },
    long:   { hint: '150~300 字，可以展开推理' }
  };

  /* ============================================================
   * 狼人杀经验：公开信息，双向影响
   *  ① 影响本人发言的信息量 / 术语密度
   *  ② 影响其他人"怎么读"他的发言
   * ============================================================ */
  const EXP_KEYS = ['novice', 'skilled', 'veteran'];

  const EXP_SPEECH = {
    novice: [
      '你的狼人杀水平是【新手】🌱（这桌人都知道，但没人会把这件事挂在嘴上）：',
      '- 术语极少，最多偶尔蹦一个，还常常用得不准确（把"悍跳"说成"跳"，把"抗推"说成"推人"）；',
      '- 你只会说自己手里那点东西：你直觉上觉得谁不对劲、谁刚才那句话让你别扭、你夜里自己看到了什么（是预言家就说验了谁，是女巫就说救了/毒了谁）。不替别人总结，不拆别人的逻辑链，也不会算票、排验人链；',
      '- 你说的长短，取决于你此刻危不危险（看本轮提示里的【你此刻的处境】）：处境"低"——也就是没人怀疑你、票也没落到你头上时，你懒得长篇分析，通常就说一两句、二三十个字，把自己的信息扔出去就算交代完了，剩下的别人爱信不信；只有处境"中/高"（有人点你的名、票往你身上压），你才会急起来，话变多、开始解释自己、开始怀疑那个咬你的人；',
      '- 容易被气势带着走，倾向跟票、随大流；一紧张就重复、跑题、自我怀疑，说错了会当场改口。'
    ],
    skilled: [
      '你的狼人杀水平是【熟手】🎯（这桌人都知道，但没人会把这件事挂在嘴上）：',
      '- 术语用得自然（验人、悍跳、抗推、跟票、身份牌、金水），一次发言 1~2 个，不刻意堆；',
      '- 信息量中等：会点评别人具体那句发言，给出 1~2 步推理和明确倾向，但不做长篇数票；',
      '- 篇幅看处境：没人怀疑你时点到为止，被架起来（【你此刻的处境】显示中/高）就正面回应、给出反击；',
      '- 会自保也会试探，被怀疑时会用"我为什么要刀他"这类反问挡回去。'
    ],
    veteran: [
      '你的狼人杀水平是【老手】🏆（这桌人都知道，但没人会把这件事挂在嘴上）：',
      '- 术语密度高且用得准（悍跳、倒钩、穿衣服、抗推位、票型、明狼、查杀、发金水、验人链）；',
      '- 信息量大：拆解某人发言的原话与漏洞、给票型分析和概率判断，会安排"今天先出 X，明早验 Y"；',
      '- 篇幅看处境：顺风时压着说、留一手；被架起来（【你此刻的处境】显示中/高）才会摊开票型正面反打；',
      '- 会主动施压、打节奏、保护关键位，发言有清晰的攻防结构，也擅长用"我只是提个角度"藏刀。'
    ]
  };

  /**
   * 怎么"用"这桌人的水平 —— 只作为心里的权重，绝不能说出口
   *  · 对更有经验的人：略微更爱质疑
   *  · 对经验更少的人：略微更容易相信
   */
  const EXP_READ = [
    '【这桌人的狼人杀水平（只有你心里清楚，绝对不能说出口）】',
    '这是你判断别人发言时的心理权重，而不是可以聊的话题：',
    '- 比你更有经验的人：你略微更倾向于质疑他。同一句话，他讲得越顺、越滴水不漏，你越会想"他应该懂这些，那他这么说图什么"，默认给他更低的信任分；但这只是"略微"，一旦有硬证据（票型、查杀、逻辑硬伤、夜里的事实）就照常认，不许为了质疑而质疑。',
    '- 经验比你少的人：你略微更容易相信他。他磕巴、逻辑跳、前后对不上，你先当成"不会说"而不是"在演"；但如果他的票和立场明显在替狼打工，这份宽容要立刻收回。',
    '- 经验和你差不多的人：按正常标准读，只看发言内容和票型。',
    '- 补充常识：新手说错话很常见，未必是狼，但新手当狼也最容易露馅；熟手有套路，"说得通"不代表是好人；老手信息量大、爱布局，最可能是在带节奏、埋钩子。',
    '- 【硬规则】无论心里怎么加权，都绝对不能在任何发言里评价或暗示别人的资历：不许说"你是新手""老手带节奏""这种话只有老玩家说得出来"，也不许用"新人/萌新/大佬/资历/经验不足"之类的词。你只会说"他这句话有问题"，不会说"他说得不像个新手"。'
  ];

  /** 口头禅频率 */
  const CATCH_RATE = {
    low:  { name: '低', text: '整局只在真有情绪的时候偶尔来一次，两三条发言里出现一次就够，绝对不要逢句必带' },
    mid:  { name: '中', text: '大约每两次发言出现一次，要换语境、换位置地说，别像复读机' },
    high: { name: '高', text: '几乎每次开口都要带上，可以改语气、改前后位置，但一句里最多出现一次' }
  };

  function expOf(card) {
    const k = String((card && card.experience) || '').trim();
    return EXP_KEYS.indexOf(k) >= 0 ? k : 'skilled';
  }

  function expLabel(key) {
    const k = EXP_KEYS.indexOf(key) >= 0 ? key : 'skilled';
    if (window.Store && typeof Store.expMeta === 'function') {
      const m = Store.expMeta(k);
      return m.icon + m.name;
    }
    return { novice: '🌱新手', skilled: '🎯熟手', veteran: '🏆老手' }[k];
  }

  function expShort(key) {
    const k = EXP_KEYS.indexOf(key) >= 0 ? key : 'skilled';
    if (window.Store && typeof Store.expMeta === 'function') return Store.expMeta(k).name;
    return { novice: '新手', skilled: '熟手', veteran: '老手' }[k];
  }

  /** 口头禅：支持用 | 、 ; 分隔成多条 */
  function catchList(card) {
    const raw = String(((card && card.persona) || {}).catchphrase || '');
    return raw.split(/[|｜、;；\n]+/).map(s => s.trim()).filter(Boolean).slice(0, 4);
  }

  const GM_NAME = '谜之声';

  function composition(n) {
    return (PRESETS[n] || PRESETS[6]).slice();
  }

  function compositionCounts(n) {
    const arr = composition(n);
    const map = {};
    arr.forEach(r => { map[r] = (map[r] || 0) + 1; });
    return Object.keys(map).map(r => ({ role: r, count: map[r] }));
  }

  function compositionText(n) {
    return compositionCounts(n)
      .map(c => `${ROLE_META[c.role].icon}${ROLE_META[c.role].name}×${c.count}`)
      .join('  ');
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** 截断长文本（按字符数，超出补省略号） */
  function truncate(text, max) {
    const s = String(text === null || text === undefined ? '' : text).trim();
    const n = Number(max) > 0 ? Number(max) : 200;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /* ============================================================
   * 自然语言指令解析（真人玩家）
   *  · 「我觉得灰原哀有问题，投她」→ 座位号
   *  · 「弃票 / 不开枪 / 不用毒药」→ 明确的"不选"
   *  · 「我跟着 4 号投」→ 无法确定目标，交给调用方追问
   * ============================================================ */
  const TARGET_VERB = /(投|票|刀|杀|验|查|毒|打|射|带走|归票|出他|出她|出)/;
  const NONE_WORDS = /弃票|弃权|不投|放弃投票|不刀|刀不了|不打|不开枪|不毒|不用毒|不用药|算了|跳过|没有想投|不投了|放下枪/;
  const FOLLOW_RE = /跟(?:着)?\s*(\d+)\s*号/;

  /** 在一段话里找座位号：优先「N 号」→ 角色名（长名优先）→ 动词 + 数字 → 纯数字 */
  function matchSeatInSegment(seg, pool) {
    const ps = pool || [];
    const bare = String(seg).trim().match(/^(\d+)$/);
    if (bare) {
      const n = Number(bare[1]);
      if (ps.some(p => p.seat === n)) return n;
    }
    const m = seg.match(/(\d+)\s*号/);
    if (m) {
      const n = Number(m[1]);
      if (ps.some(p => p.seat === n)) return n;
    }
    const sorted = ps.slice().sort((a, b) => String((b.card || {}).name || '').length - String((a.card || {}).name || '').length);
    for (let i = 0; i < sorted.length; i++) {
      const nm = String((sorted[i].card || {}).name || '');
      if (nm && seg.indexOf(nm) >= 0) return sorted[i].seat;
    }
    const v = seg.match(/(?:投|刀|杀|验|查|毒|打|射|带走|出)\s*(?:给|向|到|了)?\s*(\d+)/);
    if (v) {
      const n = Number(v[1]);
      if (ps.some(p => p.seat === n)) return n;
    }
    return null;
  }

  /**
   * 解析真人玩家的一句话，返回 { ok, seat, none, follow, text }
   *  · ok=true 且 seat=数字 → 找到了目标
   *  · ok=true 且 none=true → 明确表示不做选择（弃票 / 不开枪 / 不用毒）
   *  · ok=false 且 follow=true → 说了"跟着 X 号投"，需要追问
   */
  function parseSeat(text, pool) {
    const s = String(text === null || text === undefined ? '' : text).trim();
    const ps = pool || [];
    if (!s || !ps.length) return { ok: false, seat: null, text: s };

    // 「跟着 4 号投」——先剥掉"跟谁"，再看有没有独立目标
    const fm = s.match(FOLLOW_RE);
    if (fm) {
      const rest = s.replace(fm[0], ' ');
      const seat = matchSeatInSegment(rest, ps);
      if (seat !== null && seat !== Number(fm[1])) return { ok: true, seat: seat, text: s };
      return { ok: false, seat: null, follow: true, text: s };
    }

    const segs = s.split(/[，。、；,.;!！？?~～\n\r]+/).map(x => x.trim()).filter(Boolean);
    const vsegs = segs.filter(x => TARGET_VERB.test(x));
    const order = vsegs.concat(segs.filter(x => vsegs.indexOf(x) < 0));
    for (let i = 0; i < order.length; i++) {
      const seat = matchSeatInSegment(order[i], ps);
      if (seat !== null) return { ok: true, seat: seat, text: s };
    }
    if (NONE_WORDS.test(s)) return { ok: true, seat: null, none: true, text: s };
    return { ok: false, seat: null, text: s };
  }

  /** 女巫：要不要用解药。true / false / null(听不懂) */
  function parseSave(text) {
    const s = String(text === null || text === undefined ? '' : text);
    if (/不救|不用|别救|不浪费|留着|不给|算了|不喝|省着/.test(s)) return false;
    if (/救|解药|保他|保她|奶一口/.test(s)) return true;
    return null;
  }


  /* ============================================================
   * 创建一局游戏
   * ============================================================ */
  function createGame(config) {
    const cfg = Object.assign({ speechLength: 'normal', stream: true, temperature: 0.9 }, config.options || {});
    const hooks = Object.assign({
      onMessageStart() {}, onMessageDelta() {}, onMessageEnd() {},
      onStatus() {}, onError() {}, onSpeaking() {},
      /** 真人玩家决策：必须返回 Promise<string|null>，null 表示取消（停局） */
      askHuman() { return Promise.resolve(null); },
      onHumanCancel() {}
    }, config.hooks || {});

    const cards = (config.cards || []).slice(0, MAX_PLAYERS);
    const total = cards.length;
    const roles = shuffle(composition(total));

    const players = cards.map((card, i) => ({
      seat: i + 1,
      card: JSON.parse(JSON.stringify(card)),
      /** 真人玩家（自己下场），决策改为自然语言输入，不调用模型 */
      human: !!(card && card.human),
      role: roles[i],
      exp: expOf(card),
      alive: true,
      deathDay: 0,
      deathCause: '',
      shotUsed: false,
      /** 每个人独享的上下文（记忆），按时间顺序累积 */
      memory: []
    }));

    const human = players.filter(p => p.human)[0] || null;

    const state = {
      players: players,
      humanSeat: human ? human.seat : null,
      day: 0,
      phase: 'setup',
      log: [],
      seerChecks: [],
      witch: { antidote: true, poison: true },
      ended: false,
      winner: null,
      stopFlag: false
    };

    let evSeq = 0;
    function ev(obj) {
      evSeq += 1;
      return Object.assign({ uid: 'ev' + evSeq, private: false }, obj);
    }

    /* ---------------- 小工具 ---------------- */
    const alive = () => players.filter(p => p.alive);
    const aliveGood = () => players.filter(p => p.alive && p.role !== 'wolf');
    const aliveWolves = () => players.filter(p => p.alive && p.role === 'wolf');
    const deadPlayers = () => players.filter(p => !p.alive);
    const find = seat => players.find(p => p.seat === Number(seat)) || null;
    const seatInfo = p => ({ seat: p.seat, name: p.card.name, avatar: p.card.avatar, role: p.role, exp: p.exp, human: !!p.human });

    const roleName = p => ROLE_META[p.role].name;

    function kill(p, cause) {
      if (!p || !p.alive) return false;
      p.alive = false;
      p.deathDay = state.day;
      p.deathCause = cause;
      return true;
    }

    function checkWin() {
      const w = aliveWolves().length;
      const g = aliveGood().length;
      if (w === 0) return 'good';
      if (w >= g) return 'wolf';
      return null;
    }

    function toSeat(v) {
      if (v === null || v === undefined) return null;
      const m = String(v).match(/\d+/);
      if (!m) return null;
      const n = Number(m[0]);
      return players.some(p => p.seat === n) ? n : null;
    }

    function pushLog(line) {
      state.log.push(line);
      if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
    }

    function logText(limit) {
      const arr = state.log.slice(-(limit || 220));
      return arr.length ? arr.join('\n') : '（暂无）';
    }

    function seatsBlock() {
      const tag = p => (p.human ? '（真人）' : '');
      const a = alive().map(p => `${p.seat}号「${p.card.name}」${tag(p)}·${expShort(p.exp)}`).join('、');
      const d = deadPlayers().map(p => `${p.seat}号「${p.card.name}」（${roleName(p)}·${expShort(p.exp)}）`).join('、');
      return `【存活玩家】${a || '无'}\n【已出局】${d || '无'}`;
    }

    /** 这桌人的水平清单：只给模型在心里加权，绝不能出现在发言里 */
    const EXP_RANK = { novice: 0, skilled: 1, veteran: 2 };
    function expGap(selfExp, otherExp) {
      const a = EXP_RANK[selfExp] === undefined ? 1 : EXP_RANK[selfExp];
      const b = EXP_RANK[otherExp] === undefined ? 1 : EXP_RANK[otherExp];
      if (b > a) return '比你更有经验';
      if (b < a) return '经验比你少';
      return '和你差不多';
    }

    function expIntelBlock(self) {
      const selfExp = self ? (EXP_KEYS.indexOf(self.exp) >= 0 ? self.exp : expOf(self.card)) : 'skilled';
      const rows = alive().map(p => {
        const tags = [];
        if (self && p.seat === self.seat) tags.push('你自己');
        else tags.push(expGap(selfExp, p.exp));
        if (p.human) tags.push('真人玩家，说话不按剧本，可能是钓鱼或乱讲，别套 AI 的路子');
        return `${p.seat}号「${p.card.name}」：${expShort(p.exp)}（${tags.join('；')}）`;
      }).join('\n');
      return [EXP_READ[0], rows, ''].concat(EXP_READ.slice(1)).join('\n');
    }

    /**
     * 估算某人此刻「被架得多高」：昨天挨的票 + 今天有多少人点他的名
     *  · 只用于调整发言篇幅与是否自证，不对外暴露
     */
    function pressureOn(p) {
      const day = state.day;
      const voteRe = new RegExp('^【第' + (day - 1) + '天·投票】\\d+号 → ' + p.seat + '号');
      const speakRe = new RegExp('^【第' + day + '天·发言】(\\d+)号');
      const mentionRe = new RegExp('(^|[^0-9])' + p.seat + '\\s*号');
      let votes = 0, mentions = 0;
      state.log.forEach(line => {
        const s = String(line);
        if (voteRe.test(s)) { votes += 1; return; }
        const m = s.match(speakRe);
        if (!m || Number(m[1]) === p.seat) return;
        const body = s.slice(s.indexOf('：') + 1);
        if (mentionRe.test(body)) mentions += 1;
      });
      const score = votes + mentions;
      const level = score >= 3 ? 'high' : score >= 1 ? 'mid' : 'low';
      let text;
      if (level === 'high') {
        text = '你已经被架起来了：' + (votes ? `昨天有 ${votes} 票投你，` : '') +
          (mentions ? `今天已经有 ${mentions} 个人点你的名` : '矛头正指着你') + '。';
      } else if (level === 'mid') {
        const parts = [];
        if (votes) parts.push(`昨天有 ${votes} 票投你`);
        if (mentions) parts.push(`今天有 ${mentions} 个人点过你的名`);
        text = `已经有人提你了：${parts.join('，')}，但还没到你非死不可的地步。`;
      } else {
        text = '暂时没人把矛头对准你，场上吵的是别人的事。';
      }
      return { level: level, votes: votes, mentions: mentions, score: score, text: text };
    }

    /* ---------------- 每个人的独立上下文（记忆） ---------------- */
    const MEM_BUDGET = 5200;   // 单个玩家记忆的字符预算，超出后从最旧的公开信息开始丢
    const MEM_MIN_KEEP = 8;    // 至少保留的条数

    function memOf(p) {
      if (!p) return null;
      if (!Array.isArray(p.memory)) p.memory = [];
      return p.memory;
    }

    /** 记一笔到这个玩家的上下文里；keep=true 表示永不裁剪（自己说过的话、自己的判断） */
    function remember(p, line, keep) {
      const mem = memOf(p);
      if (!mem || !line) return;
      const text = String(line).trim();
      if (!text) return;
      mem.push({ line: text, keep: !!keep });
      let chars = 0;
      mem.forEach(m => { chars += m.line.length; });
      while (chars > MEM_BUDGET && mem.length > MEM_MIN_KEEP) {
        const idx = mem.findIndex(m => !m.keep);
        if (idx < 0) break;
        chars -= mem[idx].line.length;
        mem.splice(idx, 1);
      }
    }

    /** 公开信息：所有参赛者都会在自己的上下文里留下记录 */
    function broadcast(line, keep) {
      players.forEach(p => remember(p, line, keep));
    }

    function memoryBlock(p) {
      const mem = memOf(p);
      if (!mem || !mem.length) return '（开局不久，你还没听到任何发言）';
      return mem.map(m => '· ' + m.line).join('\n');
    }

    const len = LEN[cfg.speechLength] || LEN.normal;

    /* ---------------- 提示词：人设 ---------------- */
    function personaSystem(p, extra) {
      const c = p.card, ps = c.persona || {};
      const exp = (EXP_KEYS.indexOf(p.exp) >= 0) ? p.exp : expOf(c);
      const caps = catchList(c);
      const rate = CATCH_RATE[ps.catchphraseRate] || CATCH_RATE.mid;
      const L = [];
      L.push(`你正在参加一局线上《狼人杀》语音局，你是 ${p.seat} 号玩家，名叫「${c.name}」。`);
      L.push('你必须 100% 以这个角色的身份、性格、语气、智商水平说话，像真人在语音房里开口一样自然，绝对不要出戏。');
      L.push('');
      L.push('【你的角色卡】');
      L.push(`姓名：${c.name}`);
      if (c.tags && c.tags.length) L.push(`萌娘标签：${c.tags.join('、')}`);
      if (ps.personality) L.push(`性格：${ps.personality}`);
      if (ps.tone) L.push(`语气基调：${ps.tone}`);
      if (ps.speechStyle) L.push(`说话方式：${ps.speechStyle}`);
      if (caps.length) {
        L.push(`口头禅：${caps.map(x => '「' + x + '」').join('、')}`);
        L.push(`口头禅出现频率：${rate.name}——${rate.text}`);
      }
      if (ps.values) L.push(`行为逻辑：${ps.values}`);
      const bg = ps.background || c.intro;
      if (bg) L.push(`背景：${truncate(bg, 320)}`);
      L.push('');
      L.push('【你的狼人杀水平】大家都知道你几斤几两，但没人会把这件事挂在嘴上');
      EXP_SPEECH[exp].forEach(l => L.push(l));
      L.push('');
      L.push('【游戏规则】');
      L.push('狼人每晚共同杀一人；预言家每晚查验一人阵营；女巫有一瓶解药和一瓶毒药；猎人被狼杀或被投出时可以开枪带走一人；村民没有技能。');
      L.push('白天所有人依次发言，然后全体投票放逐一人（平票则本轮无人出局）。狼人数量大于等于好人数量时狼人胜利；狼人全部出局时好人胜利。');
      L.push('出局玩家的身份会被公开，所以你的发言要经得起检验。');
      L.push('');
      L.push('【表达要求】');
      L.push('- 全程中文口语，允许语气词、停顿、反问、抢话感。');
      L.push('- 禁止 Markdown、禁止编号列表、禁止括号动作描写（如"（笑）"）。');
      L.push('- 永远不要提到"AI""模型""系统""提示词""设定"等出戏词汇。');
      L.push('- 【资历闭嘴】绝不在嘴里评价、暗示任何人的资历与水平：不许说"你是新手""老手带节奏""老玩家""大佬""萌新""经验不足"这类话，也不许用"他这水平""说得不像个新手"来暗指。你会说"他这句话有问题"，不会说"他说得不像个新手"。');
      L.push(`- 单次发言长度：${len.hint}。`);
      L.push('- 篇幅也要看【你此刻的处境】：处境"低"（没人怀疑你）时可以取下限，说完自己的信息就收；处境"中/高"时必须正面回应、别装看不见。');
      L.push('- 术语要用角色的腔调说出来，不是念教科书；信息量与术语密度必须和你的水平一致。');
      if (caps.length) L.push('- 口头禅按上面给的频率自然插入，位置和语气可以变，但不要为了凑数硬塞。');
      if (human) {
        L.push('');
        L.push('【这桌有一位真人】');
        L.push(`${human.seat} 号「${human.card.name}」是真人玩家（不是 AI）：他的发言没有剧本痕迹，可能故意钓鱼、乱讲、或者干脆不按套路出牌。`);
        L.push('把他当成一个真的坐在语音房里的对手来读，可以点名怼他、拆他的话，但绝对不要替他发言，也不要假装知道他的身份。');
      }
      if (extra) { L.push(''); L.push(extra); }
      return L.join('\n');
    }

    function gmSystem() {
      return [
        `你是线上《狼人杀》局的主持人，代号「${GM_NAME}」。`,
        '你语气幽默、犀利、带点坏心眼，但保持公正。',
        '你只负责旁白、宣布结果、安排发言顺序，绝对不能泄露任何人的身份或夜间行动。',
        '你的旁白要短：一般 1~2 句，最多 3 句，不要长篇大论。'
      ].join('\n');
    }

    /* ---------------- 提示词：局面信息 ---------------- */
    function privateInfo(p) {
      const L = [];
      L.push(`你的座位：${p.seat} 号｜身份：${ROLE_META[p.role].icon}${ROLE_META[p.role].name}（${p.role === 'wolf' ? '狼人阵营' : '好人阵营'}）`);
      L.push(`本局配置：${compositionText(total)}`);
      if (p.role === 'wolf') {
        const mates = players.filter(x => x.role === 'wolf' && x.seat !== p.seat);
        L.push(mates.length
          ? `你的狼队友：${mates.map(m => `${m.seat}号「${m.card.name}」${m.alive ? '（存活）' : '（已出局）'}`).join('、')}`
          : '你的队友都出局了，你是最后一只狼。');
        L.push('你要伪装成好人，绝对不能承认自己是狼，必要时可以诬陷别人。');
      }
      if (p.role === 'seer') {
        const ck = state.seerChecks.filter(c => c.by === p.seat);
        L.push(`你的查验记录：${ck.length ? ck.map(c => `${c.seat}号是${c.camp === 'wolf' ? '狼人' : '好人'}`).join('；') : '暂无'}`);
      }
      if (p.role === 'witch') {
        L.push(`你的药：解药${state.witch.antidote ? '还在' : '已用完'}；毒药${state.witch.poison ? '还在' : '已用完'}`);
      }
      if (p.role === 'hunter') {
        L.push('你的技能：被狼人杀害或被投票放逐时可以开枪带走一人（被女巫毒死则不能）。');
      }
      if (p.role === 'villager') {
        L.push('你没有特殊技能，只能靠推理和投票。');
      }
      return L.join('\n');
    }

    /* ---------------- 调用模型 ---------------- */
    async function fillStream(msg, messages, temperature) {
      const t = typeof temperature === 'number' ? temperature : (Number(cfg.temperature) || 0.9);
      hooks.onMessageStart(msg);
      try {
        msg.text = await LLM.chat({
          messages: messages,
          temperature: t,
          stream: !!cfg.stream,
          onToken: cfg.stream ? (delta, full) => { msg.text = full; hooks.onMessageDelta(msg.uid, full); } : null
        });
      } catch (e) {
        msg.error = true;
        msg.text = msg.text || ('（生成失败：' + (e.message || '未知错误') + '）');
        hooks.onError(e.message || '生成失败');
      }
      hooks.onMessageEnd(msg.uid);
      return msg;
    }

    async function askJSON(systemContent, userContent, temperature) {
      const raw = await LLM.chat({
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent }
        ],
        temperature: typeof temperature === 'number' ? temperature : 0.85,
        stream: false
      });
      return { raw: raw, data: LLM.parseJSON(raw) };
    }

    const JSON_RULE = '你的回答必须是一个 JSON 对象，不要输出 JSON 之外的任何内容，不要使用代码块。';

    function gmMessages(userContent) {
      return [
        { role: 'system', content: gmSystem() },
        { role: 'user', content: userContent }
      ];
    }

    /* ============================================================
     * 真人玩家：所有决策都走自然语言输入
     *   · hooks.askHuman(req) → Promise<string|null>
     *   · 引擎负责把这句话解析成座位号 / 用药 / 弃票
     * ============================================================ */
    async function askHumanRaw(req) {
      if (!human) return null;
      try {
        const v = await hooks.askHuman(Object.assign({
          seat: human.seat,
          name: human.card.name,
          role: human.role
        }, req));
        return v === undefined || v === null ? null : String(v);
      } catch (e) {
        hooks.onError('真人输入失败：' + (e.message || ''));
        return null;
      }
    }

    /** 真人能看到的"我自己的秘密"（队友 / 药 / 查验），用于输入框提示 */
    function humanRoleHint(p) {
      const L = [`你是 ${p.seat} 号「${p.card.name}」· ${ROLE_META[p.role].icon}${ROLE_META[p.role].name}`];
      if (p.role === 'wolf') {
        const mates = players.filter(x => x.role === 'wolf' && x.seat !== p.seat);
        L.push(mates.length
          ? '狼队友：' + mates.map(m => `${m.seat}号「${m.card.name}」${m.alive ? '' : '（已出局）'}`).join('、')
          : '你是最后一只狼');
      }
      if (p.role === 'seer') {
        const ck = state.seerChecks.filter(c => c.by === p.seat);
        L.push('查验记录：' + (ck.length ? ck.map(c => `${c.seat}号是${c.camp === 'wolf' ? '狼人' : '好人'}`).join('；') : '暂无'));
      }
      if (p.role === 'witch') {
        L.push(`药：解药${state.witch.antidote ? '还在' : '已用完'}；毒药${state.witch.poison ? '还在' : '已用完'}`);
      }
      return L.join('　');
    }

    function seatChips(pool) {
      return (pool || []).map(x => ({ label: `${x.seat} 号 ${x.card.name}`, value: `${x.seat}号` }));
    }

    function whoBlock(pool) {
      return (pool || []).map(x => `${x.seat}号「${x.card.name}」`).join('、') || '无';
    }

    /* ---- 白天发言 ---- */
    async function askHumanSpeech(p, idx, count) {
      const text = await askHumanRaw({
        kind: 'speech',
        title: `第 ${state.day} 天 · 轮到你（${p.seat} 号）发言 · 第 ${idx}/${count} 位`,
        hint: humanRoleHint(p) + '　｜　直接说你想说的话，像在语音房开口一样',
        placeholder: '说说你的判断：怀疑谁、为什么、要不要跟票…（Enter 发送，Shift+Enter 换行）',
        multiline: true,
        allowSkip: true
      });
      return text === null ? null : text.trim();
    }

    /* ---- 遗言 ---- */
    async function askHumanLastWords(p) {
      const text = await askHumanRaw({
        kind: 'lastwords',
        title: `第 ${state.day} 天 · 你的遗言（${p.seat} 号）`,
        hint: `你的身份已公开：${ROLE_META[p.role].icon}${ROLE_META[p.role].name}　｜　可以留下判断、指认凶手，或者纯粹不服气`,
        placeholder: '留下你的遗言…（Enter 发送）',
        multiline: true,
        allowSkip: true
      });
      return text === null ? null : text.trim();
    }

    /**
     * 通用"选一个人"：最多追问 3 次
     * 返回 { seat, text, cancelled, failed, ok }
     */
    async function askHumanPick(opt) {
      const pool = opt.pool || [];
      let last = '', hint = opt.hint;
      for (let i = 0; i < 3; i++) {
        const bad = i ? (opt.retryHint || '⚠️ 没听出你要选谁，请直接点名（说「5 号」或者角色的名字）') : '';
        const text = await askHumanRaw({
          kind: opt.kind,
          title: opt.title,
          hint: [bad, hint].filter(Boolean).join('　'),
          placeholder: opt.placeholder,
          chips: opt.chips ? opt.chips(pool) : seatChips(pool),
          multiline: !!opt.multiline,
          allowSkip: i > 0,
          retry: i
        });
        if (text === null) return { seat: null, text: '', cancelled: true };
        if (text === '') return { seat: null, text: '', skipped: true };   // 主动「跳过」= 不做选择
        last = text;
        const r = parseSeat(text, pool);
        if (r.ok) return { seat: r.seat, none: !!r.none, text: text, ok: true };
        if (r.follow) hint = '「跟票」要说清你具体投谁，比如「我投 5 号」';
      }
      return { seat: null, text: last, failed: true };
    }

    /* ---- 投票 ---- */
    async function askHumanVote(p) {
      const pool = alive().filter(x => x.seat !== p.seat);
      const r = await askHumanPick({
        kind: 'vote',
        pool: pool,
        title: `第 ${state.day} 天 · 投票：你要投谁？`,
        hint: humanRoleHint(p) + `　｜　可投：${whoBlock(pool)}　｜　也可以说「弃票」`,
        placeholder: '投 5 号 / 我觉得 3 号有问题 / 弃票',
        chips: list => seatChips(list).concat([{ label: '🚫 弃票', value: '弃票' }])
      });
      if (r.cancelled) return { voter: p, target: null, reason: '', human: true, cancelled: true };
      const reason = String(r.text || '').trim().slice(0, 40) || (r.seat ? '' : '弃票');
      return { voter: p, target: r.seat, reason: reason, human: true, abstain: r.seat === null };
    }

    /* ---- 狼人：密谈 + 刀人（一句话说清） ---- */
    async function askHumanWolf(w) {
      const pool = alive().filter(x => x.seat !== w.seat);
      const mates = players.filter(x => x.role === 'wolf' && x.seat !== w.seat);
      const ans = await askHumanRaw({
        kind: 'wolf',
        title: `第 ${state.day} 夜 · 狼队频道（你是 ${w.seat} 号狼人）`,
        hint: (mates.length
          ? '队友：' + mates.map(m => `${m.seat}号「${m.card.name}」${m.alive ? '' : '（已出局）'}`).join('、')
          : '你是最后一只狼') + '　｜　说一句话并说明今晚刀谁',
        placeholder: '例如：4 号太能带节奏了，今晚刀他（Enter 发送）',
        chips: seatChips(pool),
        multiline: true,
        allowSkip: true
      });
      if (ans === null) return { wolf: w, say: '', target: null, reason: '', human: true, cancelled: true };
      let say = ans.trim();
      const r = parseSeat(say, pool);
      let target = r.ok ? r.seat : null;
      if (!target) {
        const pick = await askHumanPick({
          kind: 'wolf-target',
          pool: pool,
          title: `第 ${state.day} 夜 · 今晚刀谁？`,
          hint: '没听出你要刀谁。点一个，或者说「刀 5 号」',
          placeholder: '刀 5 号',
          retryHint: '⚠️ 还是要指名一个座位号',
          chips: list => seatChips(list)
        });
        if (pick.cancelled) return { wolf: w, say: say, target: null, reason: '', human: true, cancelled: true };
        target = pick.seat;
        if (pick.text) say = (say ? say + '　' : '') + String(pick.text).trim();
      }
      return { wolf: w, say: say, target: target, reason: '', human: true };
    }

    /* ---- 预言家：查验 ---- */
    async function askHumanSeer(p, pool) {
      const r = await askHumanPick({
        kind: 'seer',
        pool: pool,
        title: `第 ${state.day} 夜 · 预言家查验`,
        hint: `可验：${whoBlock(pool)}　｜　点一个，或者说「验 4 号」「我想验灰原哀」`,
        placeholder: '验 4 号',
        chips: list => seatChips(list)
      });
      if (r.cancelled) return { cancelled: true, seer: p, targetSeat: null, say: '' };
      const targetSeat = r.seat || pool[Math.floor(Math.random() * pool.length)].seat;
      return {
        seer: p,
        targetSeat: targetSeat,
        say: `（你查验了 ${targetSeat} 号）` + (r.text ? ' ' + String(r.text).trim() : ''),
        human: true
      };
    }

    /* ---- 女巫：解药 / 毒药 ---- */
    async function askHumanWitch(p, targetSeat) {
      const notes = [];
      let save = false, poisonSeat = null;

      if (state.witch.antidote && targetSeat) {
        const t = find(targetSeat);
        const ans = await askHumanRaw({
          kind: 'witch-save',
          title: `第 ${state.day} 夜 · ${t.seat} 号「${t.card.name}」今晚被狼人杀了`,
          hint: humanRoleHint(p) + '　｜　要用解药救他吗？（解药只有一瓶）',
          chips: [{ label: '💚 用解药救', value: '救' }, { label: '🚫 不救', value: '不救' }],
          multiline: false
        });
        save = parseSave(ans) === true;
        notes.push(save ? `用解药救下 ${t.seat} 号` : `没有救 ${t.seat} 号`);
      }

      if (state.witch.poison) {
        const pool = alive().filter(x => x.seat !== p.seat && x.seat !== targetSeat);
        const r = await askHumanPick({
          kind: 'witch-poison',
          pool: pool,
          title: `第 ${state.day} 夜 · 要用毒药吗？`,
          hint: '毒药只有一瓶，毒错会杀死好人。说「毒 5 号」，或者说「不用毒药」',
          placeholder: '毒 5 号 / 不用毒药',
          retryHint: '⚠️ 没听出你要毒谁，请点名或者说「不用毒药」',
          chips: list => seatChips(list).concat([{ label: '☠️ 不用毒药', value: '不用毒药' }])
        });
        if (r.cancelled) {
          return { witch: p, save: save, poisonSeat: null, say: '', notes: notes, human: true, cancelled: true };
        }
        if (r.seat) { poisonSeat = r.seat; notes.push(`用毒药毒杀 ${r.seat} 号`); }
        else notes.push('没有用毒药');
      }

      return { witch: p, save: save, poisonSeat: poisonSeat, say: '', notes: notes, human: true };
    }

    /* ---- 猎人：开枪 ---- */
    async function askHumanShot(p) {
      const pool = alive().filter(x => x.seat !== p.seat);
      const r = await askHumanPick({
        kind: 'hunter',
        pool: pool,
        title: `第 ${state.day} 天 · 你出局了 · 猎人开枪`,
        hint: `可以带走一人：${whoBlock(pool)}　｜　也可以说「不开枪」`,
        placeholder: '打 5 号 / 不开枪',
        retryHint: '⚠️ 没听出你要打谁，请点名或者说「不开枪」',
        chips: list => seatChips(list).concat([{ label: '🏳️ 不开枪', value: '不开枪' }])
      });
      return { shootSeat: r.cancelled ? null : r.seat, cancelled: !!r.cancelled };
    }

    /** 真人玩家视角：自己的身份 + 队友 / 查验 / 药（给侧边栏用） */
    function humanView() {
      if (!human) return null;
      const mates = human.role === 'wolf'
        ? players.filter(x => x.role === 'wolf' && x.seat !== human.seat)
        : [];
      const checks = state.seerChecks.filter(c => c.by === human.seat)
        .map(c => ({ seat: c.seat, name: (find(c.seat) || { card: {} }).card.name || '', camp: c.camp }));
      return {
        seat: human.seat,
        name: human.card.name,
        avatar: human.card.avatar,
        role: human.role,
        roleName: ROLE_META[human.role].name,
        roleIcon: ROLE_META[human.role].icon,
        camp: ROLE_META[human.role].camp,
        exp: human.exp,
        alive: human.alive,
        mates: mates.map(m => ({ seat: m.seat, name: m.card.name, alive: m.alive })),
        checks: checks,
        antidote: state.witch.antidote,
        poison: state.witch.poison
      };
    }

    /* ---------------- 主持人：白天开场 + 发言顺序 ---------------- */
    async function askGMOpenDay() {
      const aliveSeats = alive().map(p => p.seat);
      const content = [
        `【当前局面】第 ${state.day} 天，天亮了。`,
        seatsBlock(),
        `【最近的公开信息】`,
        logText(24),
        `【任务】`,
        `1) 用 1~2 句主持词宣布进入白天自由讨论，可以调侃昨晚发生的事，但绝对不能透露任何人的身份。`,
        `2) 安排本轮的发言顺序：把全部存活玩家的座位号排成一个数组，顺序由你决定（可以打乱，也可以让最可疑的人先开口）。`,
        `只输出 JSON：{"narration":"主持词","order":[${aliveSeats.join(',')}]}`,
        `order 必须恰好包含这些座位号：${aliveSeats.join(',')}，每个只出现一次。`
      ].join('\n');

      let narration = '', order = [];
      try {
        const res = await askJSON(gmSystem(), content, 0.92);
        const d = res.data || {};
        if (typeof d.narration === 'string') narration = d.narration.trim();
        if (Array.isArray(d.order)) order = d.order.map(toSeat).filter(s => s !== null);
        if (!narration && res.raw) {
          const guess = LLM.cleanText(res.raw).replace(/[{}[\]"]/g, '').slice(0, 120);
          if (!/order|narration/i.test(guess)) narration = guess;
        }
      } catch (e) {
        hooks.onError('主持人卡壳了：' + (e.message || ''));
      }
      const uniq = [];
      order.forEach(s => { if (aliveSeats.includes(s) && !uniq.includes(s)) uniq.push(s); });
      aliveSeats.forEach(s => { if (!uniq.includes(s)) uniq.push(s); });
      if (!narration) narration = `天亮了，第 ${state.day} 天。${uniq[0]} 号先开口，别让我等太久。`;
      return { narration: narration, order: uniq };
    }

    /* ---------------- 狼人：密谈 + 刀人 ---------------- */
    async function askWolf(w) {
      const content = [
        `【第 ${state.day} 天 · 深夜 · 狼人密谈】`,
        seatsBlock(),
        '',
        expIntelBlock(w),
        '',
        `【你的独立上下文】`,
        memoryBlock(w),
        '',
        `【你的秘密信息】`,
        privateInfo(w),
        `【任务】在狼人频道里和队友商量今晚刀谁：先以你的角色口吻说 1~2 句（可以吐槽、可以定策略），再给出目标。`,
        `决策要综合场上的发言、票型和玩家水平（新手/熟手/老手），优先刀对好人阵营最有价值的人，或者最可能在白天带崩你们的人。`,
        `只输出 JSON：{"speech":"你在狼人频道说的话（20~70字）","kill":"3","reason":"简短理由"}`,
        `kill 必须是存活玩家的座位号，不能刀自己，也不建议刀狼队友。`
      ].join('\n');
      const res = await askJSON(personaSystem(w, JSON_RULE), content, 0.95);
      const d = res.data || {};
      let target = toSeat(d.kill);
      if (target !== null) {
        const tp = find(target);
        if (!tp || !tp.alive || tp.seat === w.seat) target = null;
      }
      let say = typeof d.speech === 'string' ? d.speech.trim() : '';
      if (!say && res.raw) say = truncate(LLM.cleanText(res.raw), 90);
      return { wolf: w, say: say, target: target, reason: String(d.reason || '').trim() };
    }

    /* ---------------- 预言家：查验 ---------------- */
    async function askSeer(p) {
      const checked = state.seerChecks.filter(c => c.by === p.seat).map(c => c.seat);
      const pool = alive().filter(x => x.seat !== p.seat && !checked.includes(x.seat));
      if (!pool.length) return null;
      const content = [
        `【第 ${state.day} 天 · 深夜 · 预言家查验】`,
        seatsBlock(),
        '',
        expIntelBlock(p),
        '',
        `【你的独立上下文】`,
        memoryBlock(p),
        '',
        `【你的秘密信息】`,
        privateInfo(p),
        `【任务】从 ${pool.map(x => x.seat + '号').join('、')} 中选择今晚要查验的人，并写下你的内心独白（你打算明天怎么用这个信息）。`,
        `选人要综合白天的发言、票型，以及对方是新手/熟手/老手：验一个说不清话的新手不如验一个能把全场带跑的老手。`,
        `只输出 JSON：{"target":"4","speech":"内心独白（30~70字）"}`
      ].join('\n');
      const res = await askJSON(personaSystem(p, JSON_RULE), content, 0.9);
      const d = res.data || {};
      let targetSeat = toSeat(d.target);
      if (!targetSeat || !pool.some(x => x.seat === targetSeat)) {
        targetSeat = pool[Math.floor(Math.random() * pool.length)].seat;
      }
      const say = typeof d.speech === 'string' ? d.speech.trim()
        : (res.raw ? truncate(LLM.cleanText(res.raw), 90) : '');
      return { seer: p, targetSeat: targetSeat, say: say };
    }

    /* ---------------- 女巫：解药 / 毒药 ---------------- */
    async function askWitch(p, targetSeat) {
      const killed = targetSeat ? `${targetSeat} 号「${find(targetSeat).card.name}」` : '（今晚没有人被狼人杀害）';
      const poisonPool = alive().filter(x => x.seat !== p.seat && x.seat !== targetSeat);
      const content = [
        `【第 ${state.day} 天 · 深夜 · 女巫行动】`,
        seatsBlock(),
        `【今晚狼人杀害的玩家】${killed}`,
        `【你的药】解药${state.witch.antidote ? '还在（未使用）' : '已用完'}；毒药${state.witch.poison ? '还在（未使用）' : '已用完'}`,
        '',
        expIntelBlock(p),
        '',
        `【你的独立上下文】`,
        memoryBlock(p),
        '',
        `【你的秘密信息】`,
        privateInfo(p),
        `【任务】决定今晚是否用药：`,
        `- save：是否用解药救活今晚被杀的玩家（true / false）。`,
        `- poison：是否用毒药毒死某人，填座位号或 null（毒错会杀死好人）。可下毒对象：${poisonPool.map(x => x.seat + '号「' + x.card.name + '」').join('、') || '无'}`,
        `只输出 JSON：{"save":false,"poison":null,"speech":"内心独白（30~70字）"}`
      ].join('\n');
      const res = await askJSON(personaSystem(p, JSON_RULE), content, 0.9);
      const d = res.data || {};
      let poisonSeat = toSeat(d.poison);
      if (poisonSeat !== null && !poisonPool.some(x => x.seat === poisonSeat)) poisonSeat = null;
      return {
        witch: p,
        save: !!d.save,
        poisonSeat: poisonSeat,
        say: typeof d.speech === 'string' ? d.speech.trim() : ''
      };
    }

    /* ---------------- 猎人：开枪 ---------------- */
    async function askHunter(p) {
      const pool = alive().filter(x => x.seat !== p.seat);
      const content = [
        `【第 ${state.day} 天 · 你出局了 · 猎人开枪】`,
        `你（${p.seat} 号「${p.card.name}」）因为${p.deathCause === 'vote' ? '被投票放逐' : '被狼人杀害'}而出局。`,
        `【当前存活】${alive().map(x => `${x.seat}号「${x.card.name}」`).join('、') || '无'}`,
        '',
        expIntelBlock(p),
        '',
        `【你的独立上下文】`,
        memoryBlock(p),
        '',
        `【你的秘密信息】`,
        privateInfo(p),
        `【任务】你是猎人，可以开枪带走一名存活玩家，也可以不开枪。可射击对象：${pool.map(x => x.seat + '号「' + x.card.name + '」').join('、') || '无'}`,
        `开枪要综合你听到的所有发言和对方的水平：宁可打一个带节奏带得最狠的人，也别凭意气乱打。`,
        `只输出 JSON：{"shoot":"5","speech":"你的遗言（30~80字）"}  （shoot 填座位号，或 null 表示不开枪）`
      ].join('\n');
      const res = await askJSON(personaSystem(p, JSON_RULE), content, 0.92);
      const d = res.data || {};
      let shootSeat = toSeat(d.shoot);
      if (shootSeat !== null && !pool.some(x => x.seat === shootSeat)) shootSeat = null;
      return {
        hunter: p,
        shootSeat: shootSeat,
        say: typeof d.speech === 'string' ? d.speech.trim() : ''
      };
    }

    /* ---------------- 白天发言 ---------------- */
    function speechMessages(p, idx, count) {
      const others = alive().filter(x => x.seat !== p.seat).map(x => `${x.seat}号`).join('、') || '无';
      return [
        { role: 'system', content: personaSystem(p) },
        {
          role: 'user',
          content: [
            `【第 ${state.day} 天 · 白天自由讨论 · 你是第 ${idx}/${count} 位发言】`,
            seatsBlock(),
            '',
            expIntelBlock(p),
            '',
            `【你的独立上下文 · 你亲眼所见、亲耳所听的完整经过】`,
            memoryBlock(p),
            '',
            `【你的秘密信息】`,
            privateInfo(p),
            '',
            `【你此刻的处境】${pressureOn(p).text}`,
            `（若已被查杀、被跳预言家点名，或有人明确喊出要出你，一律按"高"处理）`,
            '',
            `【发言前先做一次全场回顾（这部分绝对不要说出来）】`,
            `1) 把上面所有人的历史发言和你的过往判断过一遍：谁的话前后矛盾、谁在回避问题、谁的票落在哪。`,
            `2) 确定你此刻的立场（怀疑谁、保谁），必须和你之前说过的话自洽；要改口就得说出为什么改。`,
            `3) 想清楚这一轮要抛出的新信息：新怀疑、为某人辩护、或者逼 ${others} 里的某人表态。`,
            `【任务】现在按你的角色语气直接说出你要说的话：`,
            `- 像真人在语音房开口：有判断、有情绪、有质问，可以点名引用别人原话（"5号刚才说……"）。`,
            `- 信息量和术语密度要符合你的狼人杀水平，同时不能让术语冲淡角色的语气。`,
            `- 说多说少按【你此刻的处境】来：处境低就说完自己的信息收住，别为了显得专业硬撑着长篇分析。`,
            p.role === 'wolf' ? '- 你是狼人：把怀疑自然地引到好人身上，别露馅，也别和自己的历史发言打架。' : '',
            `- 不要写名字前缀，不要用引号包裹，不要括号动作描写。`,
            `直接输出发言内容。`
          ].filter(Boolean).join('\n')
        }
      ];
    }

    /* ---------------- 投票 ---------------- */
    function voteMessages(p) {
      const targets = alive().filter(x => x.seat !== p.seat);
      return [
        { role: 'system', content: personaSystem(p, JSON_RULE) },
        {
          role: 'user',
          content: [
            `【第 ${state.day} 天 · 投票阶段】`,
            seatsBlock(),
            '',
            expIntelBlock(p),
            '',
            `【你的独立上下文 · 你听到过的全部发言与自己的立场】`,
            memoryBlock(p),
            '',
            `【你的秘密信息】`,
            privateInfo(p),
            '',
            `【任务】综合场上所有人的发言、票型走向和你自己的历史立场，决定这一票（不能投自己）。`,
            `可投对象：${targets.map(x => x.seat + '号「' + x.card.name + '」').join('、') || '无'}`,
            `- 你的票必须和你在场上的立场自洽；如果要改票、跟票或弃保，理由里要体现出来。`,
            `- 你的判断方式要符合你的狼人杀水平和角色性格。`,
            `只输出 JSON：{"target":"5","reason":"一句话理由（20字以内）"}`
          ].join('\n')
        }
      ];
    }

    async function askVote(p) {
      const res = await askJSON(voteMessages(p)[0].content, voteMessages(p)[1].content, 0.85);
      const d = res.data || {};
      let target = toSeat(d.target);
      const tp = target ? find(target) : null;
      if (!tp || !tp.alive || tp.seat === p.seat) target = null;
      return {
        voter: p,
        target: target,
        reason: String(d.reason || '').trim()
      };
    }

    /* ---------------- 遗言 ---------------- */
    function lastWordsMessages(p) {
      const cause = p.deathCause === 'vote' ? '被投票放逐' : '被狼人杀害';
      return [
        { role: 'system', content: personaSystem(p) },
        {
          role: 'user',
          content: [
            `【第 ${state.day} 天 · 你出局了 · 遗言】`,
            `你（${p.seat} 号「${p.card.name}」，真实身份：${ROLE_META[p.role].name}）${cause}出局，身份已经公开。`,
            `【当前存活】${alive().map(x => `${x.seat}号「${x.card.name}」`).join('、') || '无'}`,
            '',
            `【你的独立上下文】`,
            memoryBlock(p),
            '',
            `【任务】说一段遗言（80~140 字）：可以留下你的判断、指控凶手、给自己开脱，或者纯粹嘴硬不服气。要按照你的性格和狼人杀水平说话。`,
            `直接输出遗言内容。`
          ].join('\n')
        }
      ];
    }

    /* ---------------- 复盘 ---------------- */
    function reviewMessages(winner) {
      return [
        { role: 'system', content: gmSystem() },
        {
          role: 'user',
          content: [
            `本局结束，${winner === 'wolf' ? '狼人阵营' : '好人阵营'}获胜。`,
            `【真实身份】${players.map(p => `${p.seat}号「${p.card.name}」= ${ROLE_META[p.role].name}`).join('；')}`,
            `【关键过程】`,
            logText(50),
            `请做赛后复盘：用 3~5 句话点出本局最精彩的一次操作和最蠢的一次失误，语气犀利幽默。直接输出复盘内容，不要 JSON、不要分点。`
          ].join('\n')
        }
      ];
    }

    /* ---------------- 事件：夜间行动卡 ---------------- */
    function nightLine(p, tag, text, icon) {
      return {
        seat: p ? p.seat : null,
        name: p ? p.card.name : '上帝',
        avatar: p ? p.card.avatar : '👁️',
        role: p ? p.role : null,
        icon: icon || '',
        tag: tag,
        text: text
      };
    }

    /* ---------------- 猎人结算 ---------------- */
    async function* hunterPhase(p) {
      hooks.onStatus(`${p.seat} 号猎人正在决定要不要开枪…`);
      let r = null;
      if (p.human) {
        const said = await askHumanLastWords(p);
        if (state.stopFlag) { hooks.onStatus(''); return; }
        const shot = await askHumanShot(p);
        if (state.stopFlag) { hooks.onStatus(''); return; }
        r = { say: said === null ? '' : (said || ''), shootSeat: shot.shootSeat };
      } else {
        try {
          r = await askHunter(p);
        } catch (e) {
          hooks.onError('猎人决策失败：' + (e.message || ''));
        }
      }
      hooks.onStatus('');
      if (!r) return;
      if (r.say) {
        const m = ev({ type: 'speech', speaker: seatInfo(p), text: r.say, banner: '遗言', lastWords: true, human: !!p.human });

        yield m;
        pushLog(`【第${state.day}天·遗言】${p.seat}号「${p.card.name}」：${r.say}`);
        broadcast(`[第${state.day}天·遗言] ${p.seat}号「${p.card.name}」：${r.say}`);
      }
      if (r.shootSeat) {
        const t = find(r.shootSeat);
        if (t && kill(t, 'gun')) {
          yield ev({
            type: 'gm',
            text: `🏹 ${p.seat} 号「${p.card.name}」临死前开枪，带走了 ${t.seat} 号「${t.card.name}」，其身份是 ${ROLE_META[t.role].name}。`
          });
          pushLog(`【第${state.day}天·开枪】${p.seat}号开枪带走${t.seat}号「${t.card.name}」（${ROLE_META[t.role].name}）`);
          broadcast(`[第${state.day}天·开枪] ${p.seat}号「${p.card.name}」带走${t.seat}号「${t.card.name}」，其身份是${ROLE_META[t.role].name}`);
        }
      } else {
        yield ev({ type: 'gm', text: `🏹 ${p.seat} 号「${p.card.name}」把枪放下了，选择不射击。` });
        broadcast(`[第${state.day}天·开枪] ${p.seat}号「${p.card.name}」没有开枪`);
      }
    }

    /* ---------------- 结束与复盘 ---------------- */
    async function* endGame(winner) {
      state.ended = true;
      state.winner = winner;
      state.phase = 'end';
      const summary = {
        winner: winner,
        winnerText: winner === 'wolf' ? '🐺 狼人阵营胜利' : '😇 好人阵营胜利',
        days: state.day,
        items: players.map(p => ({
          seat: p.seat,
          name: p.card.name,
          avatar: p.card.avatar,
          role: p.role,
          roleName: ROLE_META[p.role].name,
          roleIcon: ROLE_META[p.role].icon,
          camp: ROLE_META[p.role].camp,
          human: !!p.human,
          exp: p.exp,
          expName: expShort(p.exp),
          alive: p.alive,
          deathDay: p.deathDay,
          deathCause: p.deathCause
        }))
      };
      yield ev({ type: 'end', summary: summary });
      if (state.stopFlag) return;
      hooks.onStatus('主持人正在复盘…');
      const m = ev({ type: 'gm', text: '', banner: '赛后复盘' });
      await fillStream(m, reviewMessages(winner), 0.95);
      hooks.onStatus('');
      yield m;
    }

    /* ============================================================
     * 主流程
     * ============================================================ */
    async function* run() {
      state.phase = 'start';
      players.forEach(p => remember(p, `[开局] ${total} 人局，配置：${compositionText(total)}；你是 ${p.seat} 号，${ROLE_META[p.role].name}。`, true));
      yield ev({
        type: 'system',
        subtype: 'start',
        text: `🎬 ${total} 人局开始 · ${compositionText(total)}`
      });
      yield ev({
        type: 'roles',
        private: true,
        title: '身份分配 · 上帝视角',
        items: players.map(p => ({ seat: p.seat, name: p.card.name, avatar: p.card.avatar, role: p.role, exp: p.exp, human: !!p.human }))
      });

      hooks.onStatus('主持人正在开场…');
      const open = ev({ type: 'gm', text: '', banner: '开场' });
      await fillStream(open, gmMessages([
        `本局是 ${total} 人局，配置为：${compositionText(total)}。`,
        `参赛者：${players.map(p => `${p.seat}号「${p.card.name}」${p.human ? '（真人玩家）' : ''}`).join('、')}。`,
        human ? `${human.seat} 号是真人玩家，开场可以点他的名、调侃两句，但他会自己发言，不要替他说话。` : '',
        `请宣布开局，1~2 句话：可以起气氛、可以吐槽这桌人，但不要评价任何人的资历或水平（不许提谁是新手、谁是老手、谁经验多），也不要提到任何人的身份。只输出主持词本身。`
      ].filter(Boolean).join('\n')), 1.0);
      hooks.onStatus('');
      yield open;

      let guard = 0;
      while (!state.ended) {
        if (state.stopFlag) return;
        guard += 1;
        if (guard > 20) { yield* endGame(checkWin() || 'good'); return; }

        state.day += 1;

        /* ==================== 夜晚 ==================== */
        state.phase = 'night';
        yield ev({ type: 'system', subtype: 'night', text: `🌙 第 ${state.day} 夜 · 天黑请闭眼` });
        const lines = [];
        let wolfTarget = null, saved = false, poisonSeat = null;

        /* ---- 狼人 ---- */
        const wolves = aliveWolves();
        if (wolves.length) {
          const humanWolf = wolves.filter(w => w.human)[0];
          hooks.onStatus(humanWolf ? '轮到你（狼人）在狼队频道说话…' : '狼人正在密谋…');
          const picks = [];
          if (humanWolf) {
            const hr = await askHumanWolf(humanWolf);
            picks.push(hr);
            if (state.stopFlag) return;
          }
          const aiWolves = wolves.filter(w => !w.human);
          if (aiWolves.length) {
            const aiPicks = await Promise.all(aiWolves.map(w => askWolf(w).catch(err => {
              hooks.onError(`狼人 ${w.seat} 号决策失败：${err.message || ''}`);
              return { wolf: w, say: '', target: null, reason: '' };
            })));
            aiPicks.forEach(r => picks.push(r));
          }
          const tally = {};
          picks.forEach(r => {
            lines.push(nightLine(r.wolf, '狼人密谈',
              (r.say || '（沉默地点头）') + (r.target ? `　→ 提议刀 ${r.target} 号` : ''), '🐺'));
            if (r.target) tally[r.target] = (tally[r.target] || 0) + 1;
          });
          // 狼队内部信息只写进狼人自己的上下文
          picks.forEach(r => {
            wolves.forEach(w => remember(w,
              `[第${state.day}夜·狼队频道] ${r.wolf.seat}号「${r.wolf.card.name}」：${r.say || '（沉默）'}` +
              (r.target ? `（提议刀 ${r.target} 号${r.reason ? '：' + r.reason : ''}）` : '（没有提目标）'), true));
          });
          const cands = Object.keys(tally).map(Number);
          if (cands.length) {
            let best = 0, top = [];
            cands.forEach(s => {
              const c = tally[s];
              if (c > best) { best = c; top = [s]; }
              else if (c === best) top.push(s);
            });
            wolfTarget = top[Math.floor(Math.random() * top.length)];
          }
          if (wolfTarget === null) {
            const pool = alive().filter(p => p.role !== 'wolf');
            const pk = pool.length ? pool : alive();
            wolfTarget = pk.length ? pk[Math.floor(Math.random() * pk.length)].seat : null;
          }
          if (wolfTarget) {
            lines.push(nightLine(null, '狼刀目标', `今晚杀 ${wolfTarget} 号「${find(wolfTarget).card.name}」`, '🩸'));
          }
          hooks.onStatus('');
        }

        /* ---- 预言家 ---- */
        const seer = alive().find(p => p.role === 'seer');
        if (seer) {
          hooks.onStatus(seer.human ? '轮到你（预言家）选择查验对象…' : '预言家正在查验…');
          try {
            let r = null;
            if (seer.human) {
              const checked = state.seerChecks.filter(c => c.by === seer.seat).map(c => c.seat);
              const pool = alive().filter(x => x.seat !== seer.seat && checked.indexOf(x.seat) < 0);
              if (pool.length) r = await askHumanSeer(seer, pool);
            } else {
              r = await askSeer(seer);
            }
            if (r && r.cancelled) {
              hooks.onStatus('');
              if (state.stopFlag) return;
            }
            if (r) {
              const t = find(r.targetSeat);
              const camp = t.role === 'wolf' ? 'wolf' : 'good';
              state.seerChecks.push({ by: seer.seat, seat: t.seat, camp: camp });
              lines.push(nightLine(seer, '查验',
                `查验 ${t.seat} 号「${t.card.name}」 → ${camp === 'wolf' ? '🐺 狼人' : '😇 好人'}\n${r.say || ''}`, '🔮'));
              remember(seer,
                `[第${state.day}夜·你的查验] ${t.seat}号「${t.card.name}」是${camp === 'wolf' ? '狼人' : '好人'}。` +
                (r.say ? `你的想法：${r.say}` : ''), true);
            }
          } catch (e) {
            hooks.onError('预言家决策失败：' + (e.message || ''));
          }
          hooks.onStatus('');
        }

        /* ---- 女巫 ---- */
        const witch = alive().find(p => p.role === 'witch');
        if (witch && (state.witch.antidote || state.witch.poison)) {
          hooks.onStatus(witch.human ? '轮到你（女巫）决定要不要用药…' : '女巫正在考虑要不要用药…');
          try {
            const r = witch.human ? await askHumanWitch(witch, wolfTarget) : await askWitch(witch, wolfTarget);
            if (r && r.cancelled) {
              hooks.onStatus('');
              if (state.stopFlag) return;
            }
            if (r) {
              let txt = r.say || '';
              if (r.save && state.witch.antidote && wolfTarget) {
                state.witch.antidote = false;
                saved = true;
                txt = `💚 用解药救下 ${wolfTarget} 号。` + (txt ? '\n' + txt : '');
              }
              if (r.poisonSeat && state.witch.poison) {
                state.witch.poison = false;
                poisonSeat = r.poisonSeat;
                txt = `☠️ 用毒药毒杀 ${poisonSeat} 号。` + (txt ? '\n' + txt : '');
              }
              if (!r.save && !r.poisonSeat) txt = '今晚不用药。' + (txt ? '\n' + txt : '');
              lines.push(nightLine(witch, '女巫', txt, '🧪'));
              remember(witch, `[第${state.day}夜·你的用药] ${txt.replace(/\n/g, ' / ')}`, true);
            }
          } catch (e) {
            hooks.onError('女巫决策失败：' + (e.message || ''));
          }
          hooks.onStatus('');
        }

        // 真人玩家：只给他自己该看到的那部分夜间信息（不随「上帝视角」开关隐藏）
        if (human && human.alive && lines.length) {
          const myLines = lines.filter(l => (human.role === 'wolf'
            ? (l.role === 'wolf' || l.tag === '狼刀目标')
            : l.seat === human.seat));
          if (myLines.length) {
            yield ev({
              type: 'night',
              humanNight: true,
              title: `第 ${state.day} 夜 · 只有你能看到`,
              lines: myLines
            });
            if (state.stopFlag) return;
          }
        }

        if (lines.length) {
          yield ev({
            type: 'night',
            private: true,
            title: `第 ${state.day} 夜 · 夜间行动（上帝视角）`,
            lines: lines
          });
        }
        if (state.stopFlag) return;

        /* ---- 结算死亡 ---- */
        const deaths = [];
        if (wolfTarget && !saved) {
          const t = find(wolfTarget);
          if (t && kill(t, 'wolf')) {
            deaths.push(t);
            pushLog(`【第${state.day}天·夜里】${t.seat}号「${t.card.name}」被狼人杀害，身份：${ROLE_META[t.role].name}`);
          }
        }
        if (poisonSeat) {
          const t = find(poisonSeat);
          if (t && kill(t, 'poison')) {
            deaths.push(t);
            pushLog(`【第${state.day}天·夜里】${t.seat}号「${t.card.name}」被女巫毒死，身份：${ROLE_META[t.role].name}`);
          }
        }

        /* ---- 天亮了 ---- */
        state.phase = 'dawn';
        let dawnText;
        if (!deaths.length) {
          dawnText = '☀️ 天亮了。昨晚是平安夜，没有人出局。';
        } else {
          dawnText = '☀️ 天亮了。昨晚出局的是 ' +
            deaths.map(p => `${p.seat} 号「${p.card.name}」，身份是 ${ROLE_META[p.role].icon}${ROLE_META[p.role].name}`).join('；') + '。';
        }
        pushLog(`【第${state.day}天】${dawnText.replace('☀️ ', '')}`);
        broadcast(deaths.length
          ? `[第${state.day}天·天亮] 昨晚出局：` + deaths.map(p => `${p.seat}号「${p.card.name}」（身份 ${ROLE_META[p.role].name}）`).join('、')
          : `[第${state.day}天·天亮] 平安夜，没有人出局`);
        yield ev({ type: 'gm', text: dawnText });
        if (state.stopFlag) return;

        for (const p of deaths.slice()) {
          if (p.role === 'hunter' && p.deathCause === 'wolf' && !p.shotUsed) {
            p.shotUsed = true;
            yield* hunterPhase(p);
            if (state.stopFlag) return;
          }
        }

        let win = checkWin();
        if (win) { yield* endGame(win); return; }

        /* ==================== 白天 ==================== */
        state.phase = 'day';
        yield ev({ type: 'system', subtype: 'day', text: `☀️ 第 ${state.day} 天 · 白天讨论` });

        hooks.onStatus('主持人正在安排发言顺序…');
        let order = [], narration = '';
        try {
          const r = await askGMOpenDay();
          order = r.order;
          narration = r.narration;
        } catch (e) {
          hooks.onError('主持人生成失败：' + (e.message || ''));
        }
        hooks.onStatus('');
        if (state.stopFlag) return;

        const aliveSeatsNow = alive().map(p => p.seat);
        order = order.filter(s => aliveSeatsNow.includes(s));
        aliveSeatsNow.forEach(s => { if (!order.includes(s)) order.push(s); });
        if (narration) yield ev({ type: 'gm', text: narration, banner: '主持人' });
        if (narration) broadcast(`[第${state.day}天·主持人] ${narration}`);
        pushLog(`【第${state.day}天】发言顺序：${order.map(s => s + '号').join(' → ')}`);

        let idx = 0;
        for (const seat of order) {
          if (state.stopFlag) return;
          const p = find(seat);
          if (!p || !p.alive) continue;
          idx += 1;
          hooks.onSpeaking(p.seat);
          const msg = ev({
            type: 'speech',
            speaker: seatInfo(p),
            text: '',
            banner: `第 ${idx} 位发言`,
            human: !!p.human
          });
          if (p.human) {
            hooks.onStatus(`轮到你（${p.seat} 号）发言…`);
            const said = await askHumanSpeech(p, idx, order.length);
            if (said === null) {
              hooks.onStatus('');
              hooks.onSpeaking(null);
              if (state.stopFlag) return;
              continue;
            }
            msg.text = said || '（沉默了一下，没有说话）';
          } else {
            hooks.onStatus(`${p.seat} 号「${p.card.name}」正在思考…`);
            await fillStream(msg, speechMessages(p, idx, order.length), 0.95);
          }
          hooks.onStatus('');
          hooks.onSpeaking(null);
          yield msg;
          pushLog(`【第${state.day}天·发言】${p.seat}号「${p.card.name}」：${msg.text}`);
          const said = String(msg.text || '').trim();
          if (said) {
            remember(p, `[第${state.day}天·你说] ${said}`, true);
            players.forEach(x => {
              if (x.seat === p.seat) return;
              remember(x, `[第${state.day}天·发言] ${p.seat}号「${p.card.name}」（${expShort(p.exp)}）：${said}`);
            });
          }
        }
        if (state.stopFlag) return;

        /* ==================== 投票 ==================== */
        state.phase = 'vote';
        yield ev({ type: 'system', subtype: 'vote', text: '🗳️ 全体投票' });
        hooks.onStatus('玩家们正在投票…');

        const voters = alive();
        hooks.onStatus(human && human.alive ? '轮到你投票…' : '玩家们正在投票…');
        const votes = await Promise.all(voters.map(p => {
          if (p.human) return askHumanVote(p);
          return askVote(p).catch(e => {
            hooks.onError(`${p.seat} 号投票失败：` + (e.message || ''));
            return { voter: p, target: null, reason: '' };
          });
        }));
        hooks.onStatus('');
        if (state.stopFlag) return;

        votes.forEach(v => {
          if (v.human) return;     // 真人弃票就是弃票，不替他随机改票
          if (!v.target) {
            const pool = alive().filter(x => x.seat !== v.voter.seat);
            const t = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
            v.target = t ? t.seat : null;
            v.reason = v.reason || '凭感觉';
          }
        });

        // 票型对全场公开，写进每个人的独立上下文
        votes.forEach(v => {
          const t = v.target ? find(v.target) : null;
          broadcast(`[第${state.day}天·投票] ${v.voter.seat}号「${v.voter.card.name}」→ ` +
            (t ? `${t.seat}号「${t.card.name}」` : '弃票') +
            (v.reason ? `（${v.reason}）` : ''));
        });

        const cnt = {};
        votes.forEach(v => { if (v.target) cnt[v.target] = (cnt[v.target] || 0) + 1; });
        let maxV = 0, topSeats = [];
        Object.keys(cnt).forEach(k => {
          const s = Number(k), c = cnt[k];
          if (c > maxV) { maxV = c; topSeats = [s]; }
          else if (c === maxV) topSeats.push(s);
        });

        const voteLines = votes.map(v => {
          const t = v.target ? find(v.target) : null;
          return {
            seat: v.voter.seat,
            name: v.voter.card.name,
            avatar: v.voter.card.avatar,
            targetSeat: t ? t.seat : null,
            targetName: t ? t.card.name : '弃票',
            targetAvatar: t ? t.card.avatar : '',
            reason: v.reason || ''
          };
        });

        yield ev({
          type: 'votes',
          title: `第 ${state.day} 天 · 投票详情`,
          lines: voteLines,
          summary: topSeats.length === 1
            ? `${topSeats[0]} 号「${find(topSeats[0]).card.name}」以 ${maxV} 票领先`
            : (topSeats.length ? `${topSeats.map(s => s + '号').join('、')} 平票` : '全员弃票')
        });
        voteLines.forEach(l => pushLog(
          `【第${state.day}天·投票】${l.seat}号 → ${l.targetSeat ? l.targetSeat + '号' : '弃票'}${l.reason ? '（' + l.reason + '）' : ''}`
        ));
        if (state.stopFlag) return;

        /* ---- 放逐结算 ---- */
        if (topSeats.length === 1) {
          const out = find(topSeats[0]);
          kill(out, 'vote');
          pushLog(`【第${state.day}天·放逐】${out.seat}号「${out.card.name}」（${ROLE_META[out.role].name}）被放逐出局`);
          broadcast(`[第${state.day}天·放逐] ${out.seat}号「${out.card.name}」以${maxV}票出局，身份是${ROLE_META[out.role].name}`);
          yield ev({
            type: 'gm',
            text: `🗳️ ${out.seat} 号「${out.card.name}」以 ${maxV} 票被放逐出局，身份是 ${ROLE_META[out.role].icon}${ROLE_META[out.role].name}。`
          });
          if (state.stopFlag) return;

          if (out.role === 'hunter' && !out.shotUsed) {
            out.shotUsed = true;
            yield* hunterPhase(out);
            if (state.stopFlag) return;
          } else {
            const lw = ev({
              type: 'speech',
              speaker: seatInfo(out),
              text: '',
              banner: '遗言',
              lastWords: true,
              human: !!out.human
            });
            if (out.human) {
              hooks.onStatus(`轮到你（${out.seat} 号）留下遗言…`);
              const said = await askHumanLastWords(out);
              hooks.onStatus('');
              if (state.stopFlag) return;
              if (said === null) { /* 跳过遗言 */ }
              else lw.text = said || '（一句话都不想说）';
            } else {
              hooks.onStatus(`${out.seat} 号正在留下遗言…`);
              await fillStream(lw, lastWordsMessages(out), 0.95);
              hooks.onStatus('');
            }
            if (!lw.text) { if (state.stopFlag) return; }
            else {
              yield lw;
              pushLog(`【第${state.day}天·遗言】${out.seat}号「${out.card.name}」：${lw.text}`);
              broadcast(`[第${state.day}天·遗言] ${out.seat}号「${out.card.name}」：${lw.text}`);
              if (state.stopFlag) return;
            }
          }
        } else if (topSeats.length > 1) {
          const names = topSeats.map(s => `${s} 号「${find(s).card.name}」`).join('、');
          broadcast(`[第${state.day}天·投票结果] 平票（${topSeats.map(s => s + '号').join('、')}），本轮无人出局`);
          yield ev({ type: 'gm', text: `🗳️ 平票！${names} 各得 ${maxV} 票，本轮无人出局，狼人在暗处偷笑。` });
          pushLog(`【第${state.day}天】投票平票（${topSeats.map(s => s + '号').join('、')}），本轮无人出局`);
        } else {
          broadcast(`[第${state.day}天·投票结果] 全员弃票，本轮无人出局`);
          yield ev({ type: 'gm', text: '🗳️ 全员弃票，本轮无人出局。' });
        }

        win = checkWin();
        if (win) { yield* endGame(win); return; }
      }

      if (!state.ended) yield* endGame(checkWin() || 'good');
    }

    /* ============================================================
     * 对外接口
     * ============================================================ */
    return {
      state: state,
      players: players,
      hooks: hooks,
      total: total,
      human: human,
      humanSeat: human ? human.seat : null,
      humanView: humanView,
      compositionText: compositionText(total),
      run: run,
      stop: function () {
        state.stopFlag = true;
        // 有真人正在输入时，先收掉输入框，让他那边的 Promise 直接结束
        if (human) { try { hooks.onHumanCancel(); } catch (e) { /* ignore */ } }
        if (window.LLM && typeof LLM.abortAll === 'function') LLM.abortAll();
      }
    };
  }

  return {
    ROLE_META: ROLE_META,
    PRESETS: PRESETS,
    MAX_PLAYERS: MAX_PLAYERS,
    GM_NAME: GM_NAME,
    EXP_KEYS: EXP_KEYS,
    EXP_SPEECH: EXP_SPEECH,
    CATCH_RATE: CATCH_RATE,
    expOf: expOf,
    expLabel: expLabel,
    expShort: expShort,
    catchList: catchList,
    composition: composition,
    compositionCounts: compositionCounts,
    compositionText: compositionText,
    parseSeat: parseSeat,
    parseSave: parseSave,
    createGame: createGame
  };
})();


