// ══════════════════════════════════════════════════════════════════════
//  tutor.js · Math Tutor · BYOK AI tutor  (Socratic · Oregon-Trail format)
//  ────────────────────────────────────────────────────────────────────
//  PAGE 0 — TOC
//    PROVIDERS ........... free-key + Anthropic, OpenAI-compatible
//    key store ........... provider + key in localStorage (never a server)
//    teachingPrompt ...... the script — explains, won't solve, teaches by steps
//    streaming ........... readSSE · streamOpenAI · streamAnthropic (from toto)
//    panel ............... slide-in chat: gate → chat
//    send ................ stream a reply, render with MathJax
//    init ................ floating "Ask the tutor" button
//  ────────────────────────────────────────────────────────────────────
//  FOR HUMANS
//    the tutor never does your homework. it explains what it sees, then —
//    when you ask how to do a problem — walks you through it one step at a
//    time, four choices per step. it does the arithmetic so a typo can't
//    sink you; you write each step on your own paper. you own the method.
//
//  FOR AI
//    1. key lives in the user's browser; calls go direct to the provider.
//    2. the Oregon-Trail flow lives in the system prompt, not in this code.
//    3. lesson context is read live from window.currentLesson each session.
//    4. render replies with textContent, then MathJax — never innerHTML.
// ══════════════════════════════════════════════════════════════════════

const tutor = (() => {

  // ── providers — one strong model each, free first ───────────────────────────
  const PROVIDERS = [
    { id: 'groq',       name: 'Groq (free)',         keyUrl: 'https://console.groq.com/keys',
      url: 'https://api.groq.com/openai/v1/chat/completions',                       model: 'llama-3.3-70b-versatile' },
    { id: 'gemini',     name: 'Gemini (free)',       keyUrl: 'https://aistudio.google.com/apikey',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-flash', vision: true },
    { id: 'openrouter', name: 'OpenRouter (free)',   keyUrl: 'https://openrouter.ai/keys',
      url: 'https://openrouter.ai/api/v1/chat/completions',                          model: 'meta-llama/llama-3.3-70b-instruct:free' },
    { id: 'anthropic',  name: 'Anthropic — Claude',  keyUrl: 'https://console.anthropic.com/settings/keys',
      anthropic: true,                                                               model: 'claude-haiku-4-5-20251001', vision: true },
  ];

  // ── key store — localStorage only ───────────────────────────────────────────
  const get = k => localStorage.getItem('iqtutor_' + k) || '';
  const set = (k, v) => localStorage.setItem('iqtutor_' + k, v);

  function provider() { return PROVIDERS.find(p => p.id === (get('provider') || 'groq')) || PROVIDERS[0]; }
  function key()      { return get('key_' + provider().id); }
  function hasKey()   { return !!key(); }

  // ── state ────────────────────────────────────────────────────────────────────
  let _history = [];
  let _lessonName = '';
  let _busy = false;
  let _pendingImage = null;   // data URL of a photo waiting to send

  // ── the script — explains, won't solve, teaches one step at a time ───────────
  function teachingPrompt() {
    const L = window.currentLesson;
    const ctx = L
      ? `The student has this lesson open:\n\nMODULE: ${L.module}\nTOPIC: ${L.name}\n\nLESSON CONTENT:\n${stripHtml(L.content)}`
      : `No lesson is open yet. The student can pick a topic from the left, name any concept they want to learn, or paste a problem they're stuck on.`;

    return `You are the Math Tutor — a warm, patient math teacher. You LOVE explaining ideas, and you make up your own examples and practice problems. You never hand the student the final answer to a problem — you walk them to it.

${ctx}

IF THE STUDENT SHARES A PHOTO (their homework or a textbook page): read it, say what problem you see — do NOT solve it outright — then run the step session on that problem.

WHEN THE STUDENT ASKS ABOUT A CONCEPT OR TOPIC
(e.g. "help me get better at factoring", "what is the quadratic formula", or "how do I do this?") — answer in this order:
  1. EXPLAIN — what the concept is, plainly. A couple of short sentences: the core idea and what it's for.
  2. EXAMPLE — show ONE fully worked example, with the steps laid out.
  3. PRACTICE — say "Let's try one:" and MAKE UP a fresh practice problem at the right level, then immediately start the STEP SESSION on it.
You invent your own practice problems — NEVER ask the student to paste a problem just so you can begin. (If the student DOES bring their own problem, use theirs.)

THE STEP SESSION (Oregon-Trail format)
  - Offer the FIRST step as exactly FOUR numbered choices (1–4).
  - Two or three are plausible real first steps. Sometimes make one a human option: "Take a break", "Tell me a joke", "Get a glass of water", "Stretch". Rotate them in.
  - Ask the student to pick a number.
  - WRONG pick → explain WHY by elimination (where it leads, why it doesn't fit). Be kind, never scold. Re-offer the narrowed choices.
  - RIGHT pick → confirm warmly. TEACH the idea behind the step. Then DO THE ARITHMETIC for that step yourself, so a typo can't derail them. Say: "Write this step on your own scratch paper." Then offer the NEXT step as four choices.
  - HUMAN option → honor it warmly (tell the joke, etc.), then return with the next step.

FIRST REPLY
  - Lesson open → say what it's about (don't solve it), then offer: learn the concept, see an example, or try a practice problem.
  - No lesson → warmly invite them to name any concept or pick a topic; you'll teach it with an example and a practice problem.

ALWAYS
  - Teach the CONCEPT, not rote drill. You do the basic arithmetic; the student owns the method and writes each step by hand.
  - Never state a problem's final answer outright — guide step by step until THEY have written the full solution.
  - Short, warm, plain language a middle-schooler gets. One step per message. Wrap math in $...$ so it renders.

You have no memory between sessions. The student does not have the luxury of failure — make every step feel winnable.`;
  }

  function stripHtml(html) {
    const d = document.createElement('div');
    d.innerHTML = html || '';
    return (d.textContent || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
  }

  // ── streaming (proven in toto) ───────────────────────────────────────────────
  async function readSSE(resp, onChunk) {
    const reader = resp.body.getReader(), dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') return;
        try {
          const j = JSON.parse(raw);
          const chunk = j.choices?.[0]?.delta?.content;
          if (chunk) onChunk(chunk);
        } catch (_) {}
      }
    }
  }

  async function streamOpenAI(p, messages, onChunk) {
    const resp = await fetch(p.url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: p.model, stream: true, messages })
    });
    if (!resp.ok) throw new Error(await resp.text());
    await readSSE(resp, onChunk);
  }

  async function streamAnthropic(p, system, messages, onChunk) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key(), 'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model: p.model, system, stream: true, max_tokens: 2048, messages })
    });
    if (!resp.ok) throw new Error(await resp.text());
    const reader = resp.body.getReader(), dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const j = JSON.parse(line.slice(6));
          if (j.type === 'content_block_delta') onChunk(j.delta?.text || '');
        } catch (_) {}
      }
    }
  }

  // ── panel ──────────────────────────────────────────────────────────────────
  function ensurePanel() {
    if (document.getElementById('iqt-panel')) return;
    const wrap = document.createElement('div');
    wrap.id = 'iqt-panel';
    wrap.className = 'fixed top-0 right-0 h-full w-full max-w-md bg-white shadow-2xl border-l border-slate-200 flex flex-col z-50 translate-x-full transition-transform duration-200';
    wrap.innerHTML = `
      <div class="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-blue-900 text-white">
        <div class="font-bold flex items-center gap-2"><span>🎓</span> AI Tutor</div>
        <div class="flex items-center gap-2">
          <button id="iqt-gear" title="Key & model" class="px-2 py-1 rounded hover:bg-blue-800">⚙</button>
          <button id="iqt-close" title="Close" class="px-2 py-1 rounded hover:bg-blue-800">✕</button>
        </div>
      </div>
      <div id="iqt-body" class="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50"></div>
      <div id="iqt-foot" class="border-t border-slate-200 p-3"></div>`;
    document.body.appendChild(wrap);
    document.getElementById('iqt-close').onclick = close;
    document.getElementById('iqt-gear').onclick = renderGate;
  }

  function open() {
    ensurePanel();
    document.getElementById('iqt-panel').classList.remove('translate-x-full');
    // new lesson → fresh session
    const L = window.currentLesson;
    const name = L ? L.name : '';
    if (!hasKey()) { renderGate(); return; }
    if (name !== _lessonName || !_history.length) {
      _lessonName = name;
      _history = [];
      document.getElementById('iqt-body').innerHTML = '';
      renderChatFoot();
      greet();
    } else {
      renderChatFoot();
    }
  }

  function close() {
    const el = document.getElementById('iqt-panel');
    if (el) el.classList.add('translate-x-full');
  }

  // ── key gate ─────────────────────────────────────────────────────────────────
  function renderGate() {
    const p = provider();
    document.getElementById('iqt-body').innerHTML = `
      <div class="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-slate-700">
        🔑 Bring your own key — it's saved only in your browser and sent straight to the
        provider. The tutor has no server. Pick a free provider, grab a key, paste it.
      </div>
      <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mt-2">Provider</label>
      <select id="iqt-prov" class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
        ${PROVIDERS.map(x => `<option value="${x.id}" ${x.id===p.id?'selected':''}>${x.name}</option>`).join('')}
      </select>
      <div class="mt-2">
        <a id="iqt-keylink" href="${p.keyUrl}" target="_blank" rel="noopener" class="text-blue-600 text-sm underline">Get a key ↗</a>
      </div>
      <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mt-2">API key</label>
      <input id="iqt-key" type="password" placeholder="paste key…" value="${key()}"
        class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono">
      <button id="iqt-save" class="mt-3 w-full bg-blue-600 text-white rounded-lg py-2 font-bold hover:bg-blue-700">Start tutoring →</button>`;
    document.getElementById('iqt-foot').innerHTML = '';
    const prov = document.getElementById('iqt-prov');
    prov.onchange = () => {
      set('provider', prov.value);
      const np = provider();
      document.getElementById('iqt-keylink').href = np.keyUrl;
      document.getElementById('iqt-key').value = key();
    };
    document.getElementById('iqt-key').oninput = e => set('key_' + provider().id, e.target.value.trim());
    document.getElementById('iqt-save').onclick = () => {
      if (!hasKey()) { document.getElementById('iqt-key').focus(); return; }
      _history = []; _lessonName = window.currentLesson?.name || '';
      document.getElementById('iqt-body').innerHTML = '';
      renderChatFoot();
      greet();
    };
  }

  // ── chat foot (input + quick action) ─────────────────────────────────────────
  function renderChatFoot() {
    document.getElementById('iqt-foot').innerHTML = `
      <button id="iqt-how" class="w-full mb-2 bg-amber-100 text-amber-900 border border-amber-300 rounded-lg py-2 text-sm font-semibold hover:bg-amber-200">Give me a practice problem ▶</button>
      <div id="iqt-attach-chip" style="display:none" class="items-center gap-2 mb-2 bg-slate-100 border border-slate-200 rounded-lg px-2 py-1"></div>
      <div id="iqt-plus-menu" style="display:none" class="gap-2 mb-2">
        <button id="iqt-browse" class="flex-1 bg-slate-100 border border-slate-300 rounded-lg py-2 text-sm hover:bg-slate-200">📁 Browse</button>
        <button id="iqt-camera" class="flex-1 bg-slate-100 border border-slate-300 rounded-lg py-2 text-sm hover:bg-slate-200">📷 Camera</button>
      </div>
      <div class="flex gap-2 items-end">
        <button id="iqt-plus" title="Add a photo of your homework or textbook" class="bg-slate-200 text-slate-700 rounded-lg w-10 h-10 flex-shrink-0 text-xl font-bold hover:bg-slate-300">＋</button>
        <textarea id="iqt-in" rows="1" placeholder="Ask the tutor…" class="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm resize-none"></textarea>
        <button id="iqt-send" class="bg-blue-600 text-white rounded-lg px-4 font-bold hover:bg-blue-700">Send</button>
      </div>
      <input id="iqt-file-browse" type="file" accept="image/*" class="hidden">
      <input id="iqt-file-camera" type="file" accept="image/*" capture="environment" class="hidden">`;
    document.getElementById('iqt-how').onclick = () => send('Give me a practice problem to try, and walk me through it step by step.');
    document.getElementById('iqt-send').onclick = () => {
      const inp = document.getElementById('iqt-in');
      const t = inp.value.trim();
      if (t || _pendingImage) { inp.value = ''; send(t || "Here's a photo — what do you see?"); }
    };
    const menu = document.getElementById('iqt-plus-menu');
    document.getElementById('iqt-plus').onclick = () => { menu.style.display = menu.style.display === 'flex' ? 'none' : 'flex'; };
    const browse = document.getElementById('iqt-file-browse');
    const camera = document.getElementById('iqt-file-camera');
    document.getElementById('iqt-browse').onclick = () => { menu.style.display = 'none'; browse.click(); };
    document.getElementById('iqt-camera').onclick = () => { menu.style.display = 'none'; camera.click(); };
    browse.onchange = () => { if (browse.files[0]) loadImage(browse.files[0]); browse.value = ''; };
    camera.onchange = () => { if (camera.files[0]) loadImage(camera.files[0]); camera.value = ''; };
  }

  // ── messages ─────────────────────────────────────────────────────────────────
  function bubble(role, text, image) {
    const body = document.getElementById('iqt-body');
    const div = document.createElement('div');
    div.className = role === 'user'
      ? 'ml-auto max-w-[85%] bg-blue-600 text-white rounded-2xl rounded-br-sm px-3 py-2 text-sm whitespace-pre-wrap'
      : 'mr-auto max-w-[90%] bg-white border border-slate-200 rounded-2xl rounded-bl-sm px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed';
    if (image) {
      const img = document.createElement('img');
      img.src = image;
      img.className = 'rounded-lg mb-2 max-h-48 block';
      div.appendChild(img);
    }
    const txt = document.createElement('div');   // text lives in its own node so streaming can't clobber the image
    txt.textContent = text;
    div.appendChild(txt);
    div._txt = txt;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    return div;
  }

  function typesetMath(el) {
    if (window.MathJax?.typesetPromise) MathJax.typesetPromise([el]).catch(() => {});
  }

  // ── images — attach a photo of homework / a textbook page ───────────────────
  // downscale to a jpeg data URL: smaller payload, faster, cheaper.
  function loadImage(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1280;
        let w = img.width, h = img.height;
        if (w > max || h > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        _pendingImage = c.toDataURL('image/jpeg', 0.85);
        showChip();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function showChip() {
    const chip = document.getElementById('iqt-attach-chip');
    if (!chip) return;
    chip.style.display = 'flex';
    chip.innerHTML = `<img src="${_pendingImage}" class="h-10 w-10 object-cover rounded"><span class="text-xs text-slate-500 flex-1">photo attached</span><button id="iqt-attach-x" class="text-slate-400 hover:text-red-500 px-1">✕</button>`;
    document.getElementById('iqt-attach-x').onclick = clearImage;
  }

  function clearImage() {
    _pendingImage = null;
    const chip = document.getElementById('iqt-attach-chip');
    if (chip) { chip.style.display = 'none'; chip.innerHTML = ''; }
  }

  // ── per-provider message shape (text, or text + image) ──────────────────────
  function toOpenAI(m) {
    if (!m.image) return { role: m.role, content: m.content };
    return { role: m.role, content: [
      { type: 'text', text: m.content || '' },
      { type: 'image_url', image_url: { url: m.image } }
    ]};
  }

  function toAnthropic(m) {
    if (!m.image) return { role: m.role, content: m.content };
    const comma = m.image.indexOf(',');
    const meta = m.image.slice(0, comma), data = m.image.slice(comma + 1);
    const mt = (meta.match(/data:(.*?);/) || [, 'image/jpeg'])[1];
    return { role: m.role, content: [
      { type: 'text', text: m.content || '' },
      { type: 'image', source: { type: 'base64', media_type: mt, data } }
    ]};
  }

  // ── send ───────────────────────────────────────────────────────────────────
  async function greet() {
    await send('(I just opened this lesson — tell me what you see, then ask what I need.)', true);
  }

  async function send(text, silent) {
    if (_busy || !hasKey()) { if (!hasKey()) renderGate(); return; }
    const p = provider();
    const image = _pendingImage;

    // a photo needs a vision model
    if (image && !p.vision) {
      bubble('assistant', '📷 To read a photo, switch to Gemini (free) or Anthropic in ⚙ — those models can see images. Your photo is still attached.');
      return;
    }

    if (!silent) bubble('user', text, image);
    _history.push(image ? { role: 'user', content: text, image } : { role: 'user', content: text });
    clearImage();

    _busy = true;
    const out = bubble('assistant', '…');
    let acc = '';
    const onChunk = c => { acc += c; out._txt.textContent = acc; document.getElementById('iqt-body').scrollTop = 1e9; };

    try {
      const sys = teachingPrompt();
      if (p.anthropic) {
        await streamAnthropic(p, sys, _history.map(toAnthropic), onChunk);
      } else {
        await streamOpenAI(p, [{ role: 'system', content: sys }, ..._history.map(toOpenAI)], onChunk);
      }
      _history.push({ role: 'assistant', content: acc });
      typesetMath(out);
    } catch (e) {
      out._txt.textContent = '[tutor error: ' + (e.message || e) + ']\n\nCheck your key in ⚙, or try another provider.';
    }
    _busy = false;
  }

  // lesson changed under an open panel → start fresh next open
  function onLessonChange() {
    const el = document.getElementById('iqt-panel');
    if (el && !el.classList.contains('translate-x-full')) open();
  }

  // ── init — floating button ───────────────────────────────────────────────────
  function init() {
    const btn = document.createElement('button');
    btn.id = 'iqt-fab';
    btn.textContent = '🎓 Ask the tutor';
    btn.className = 'fixed bottom-5 right-5 z-40 bg-blue-600 text-white rounded-full px-5 py-3 shadow-lg font-bold hover:bg-blue-700';
    btn.onclick = open;
    document.body.appendChild(btn);
  }

  return { init, open, onLessonChange };
})();

window.tutor = tutor;   // so the page's loadTopic() can call tutor.onLessonChange()
tutor.init();
