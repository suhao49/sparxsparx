/*
 * Sparx Bookwork Logger - content script
 *
 * Runs on every Sparx Maths page. It has two jobs:
 *
 *  1. QUESTION MODE - work out which question is open (the dark tab at the
 *     top, e.g. "1A"), read whatever you type into the answer boxes, and when
 *     Sparx says "Correct!" save a log entry (wrong answers are discarded):
 *        { code: "1A", answer: "9.725 | 9.735", result: "correct", ... }
 *
 *  2. BOOKWORK MODE - when the "Bookwork check" box appears, read the code it
 *     asks about ("Bookwork 1C"), look up the logged answer for that code and
 *     draw a green outline around the option that matches it.
 *
 * The Sparx page structure is not documented, so everything here is found by
 * TEXT (e.g. a leaf element whose text is exactly "Zoom") and by COLOUR (the
 * active tab is the darkest one) rather than by CSS class names.  If Sparx
 * changes its layout the logic in findActiveCode / findOptions is the part to
 * adjust - use the "Copy HTML" button to grab the real page markup.
 */
(() => {
  'use strict';
  if (window.__sparxLoggerLoaded) return;
  window.__sparxLoggerLoaded = true;

  const CODE_RE = /^\s*(\d{1,2}[A-Z])\s*$/;                  // "1A", "12C"
  const BOOKWORK_CODE_RE = /^\s*Bookwork\s*(\d{1,2}[A-Z])\s*$/i;
  const BOOKWORK_HEADING_RE = /^\s*Bookwork\s+check\s*$/i;
  const ZOOM_RE = /^\s*Zoom\s*$/i;
  const CORRECT_RE = /^\s*Correct!?\s*$/i;
  const INCORRECT_RE = /^\s*(Incorrect|Not quite|Not correct|Wrong|Try again)\b/i;
  const SUBMIT_RE = /^\s*Submit answer\s*$/i;
  const UI_BUTTON_RE = /^\s*(Answer|Back|Continue|Watch video|Zoom|Menu|Submit|Submit answer|I didn't write this down|Next|Skip|Hint)\s*$/i;
  const UI_NOISE_RE = /\b(Calculator not allowed|Calculator allowed|Watch video|Enter number|Zoom|Submit answer|Answer|Back|Continue|Incorrect)\b|Correct!?|Good work,?[^!.]*!?/g;

  // Elements whose text must never be read: KaTeX keeps an invisible MathML
  // copy of every formula (would double every number) and our own overlay.
  const SKIP_SEL = '.katex-mathml, script, style, noscript, [data-sparxlog], [class*="_EmptySlotContent_"]';

  // Sparx-specific hooks, taken from the real page markup. Class names carry a
  // hashed suffix (e.g. _Selected_1t8sa_85) so they are matched by prefix.
  const SEL = {
    activeTab: '[class*="_TaskItemLink_"][class*="_Selected_"]',
    panel: '[class*="_QuestionContainer_"], [class*="_Activity_"]',
    answerContent: '[data-stack="answer-content"]',
    selectedCard: '[class*="_CardContentSelected_"], [class*="_Selected_"], [class*="selected" i], ' +
                  '[class*="chosen" i], [aria-checked="true"], [aria-selected="true"], [aria-pressed="true"]',
    card: '[data-scale-target="card-content"], [class*="_CardContent_"]',
    // Pickers that fill a slot inside the answer row: their selected card is
    // already reflected in the answer row, so it must not be counted twice.
    picker: '[data-slot-options], [class*="_SlotsBelow_"], [class*="_InlineSlotOptions_"]',
    // Bookwork check dialog
    dialog: '[role="dialog"]',
    bookworkChip: '[class*="_Bookwork_"]',
    gridOption: '[class*="_GridOption_"]',
    gridItem: '[class*="_Item_"]',
    optionAnswer: '.answer, [class*="_Answer_"]',
    answerBlock: '.answer-block, [class*="_AnswerBlock_"]'
  };

  const STORAGE_KEY = 'sparxLog';
  const SETTINGS_KEY = 'sparxSettings';
  const MAX_ENTRIES = 3000;
  const IS_TOP = window.top === window;

  // ------------------------------------------------------------------ state
  let log = [];                 // persisted entries (see makeEntry)
  const DEFAULT_SETTINGS = { overlay: true, timerEnabled: true, timerSeconds: 60 };
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  const questionStart = new Map();   // code -> timestamp the question was first seen
  const vetoed = new Set();          // codes where the wait was bypassed
  let pendingSubmitBtn = null;       // button whose click was blocked by the timer
  let currentCode = null;       // code of the question currently open
  let draft = null;             // { code, question, answer } being built
  let pendingId = null;         // entry created on "Submit answer", awaiting result
  let resultSeen = false;       // true while a Correct/Incorrect banner is showing
  let lastClickedChoice = null; // last option-like element clicked in the question
  let highlighted = [];         // elements we outlined in the bookwork check
  let saveTimer = null;
  let tickTimer = null;

  // -------------------------------------------------------------- utilities
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Turn KaTeX's TeX source into readable text: "{\\frac{1}{3}}" -> "1/3",
   * "{\\leq n \\lt}" -> "≤ n <".  Reading the TeX is more reliable than the
   * rendered HTML, whose DOM order puts a fraction's denominator first.
   */
  function texToText(tex) {
    let t = tex;
    for (let i = 0; i < 6 && /\\[dt]?frac/.test(t); i++) {
      t = t.replace(/(\d)\s*\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1 $2/$3')   // mixed number: 2 3/4
           .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2');
    }
    t = t.replace(/\\text(?:rm|bf|it|sf|tt)?\{([^{}]*)\}/g, '$1')
      .replace(/\\math(?:rm|bf|it|cal|bb)\{([^{}]*)\}/g, '$1')
      .replace(/\\sqrt\[([^\]]*)\]\{([^{}]*)\}/g, '$1√$2')
      .replace(/\\sqrt\{([^{}]*)\}/g, '√$1')
      .replace(/\\left|\\right|\\displaystyle/g, '')
      .replace(/\\(?:leq|le|leqslant)\b/g, '≤').replace(/\\(?:geq|ge|geqslant)\b/g, '≥')
      .replace(/\\lt\b/g, '<').replace(/\\gt\b/g, '>').replace(/\\neq?\b/g, '≠')
      .replace(/\\times\b/g, '×').replace(/\\div\b/g, '÷').replace(/\\pm\b/g, '±').replace(/\\cdot\b/g, '·')
      .replace(/\\pi\b/g, 'π').replace(/\\infty\b/g, '∞').replace(/\\degree\b|\^\{?\\circ\}?/g, '°')
      .replace(/\\%/g, '%').replace(/\\\$/g, '$').replace(/\\pounds\b/g, '£')
      .replace(/\\(?:,|;|:|!|quad|qquad| \s)/g, ' ')
      .replace(/\\[a-zA-Z]+/g, m => m.slice(1))
      .replace(/[{}]/g, '')
      .replace(/\s+/g, ' ').trim();
    return t;
  }

  function katexText(el) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    if (ann && ann.textContent.trim()) return texToText(ann.textContent);
    const html = el.querySelector('.katex-html');
    return (html ? html.textContent : el.textContent).replace(/\s+/g, ' ').trim();
  }

  /** Visible text of a subtree (KaTeX read from its TeX source, includes input values). */
  function visibleText(root) {
    if (!root) return '';
    if (root.nodeType === Node.TEXT_NODE) return root.textContent.replace(/\s+/g, ' ').trim();
    if (root.matches && root.matches(SKIP_SEL)) return '';
    if (root.classList && root.classList.contains('katex')) return katexText(root);
    const parts = [];
    if (root.tagName === 'INPUT' || root.tagName === 'TEXTAREA') parts.push(root.value || '');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (n.matches(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
          if (n.classList.contains('katex')) { parts.push(katexText(n)); return NodeFilter.FILTER_REJECT; }
          return (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA')
            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      parts.push(n.nodeType === Node.TEXT_NODE ? n.textContent : (n.value || ''));
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  /** Parent elements of text nodes whose text matches `re`. Cheap and layout-independent. */
  function findLeaves(re, root) {
    root = root || document.body;
    const out = [];
    if (!root) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
        return re.test(n.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let n;
    while ((n = walker.nextNode())) out.push(n.parentElement);
    return out;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function parseRgb(s) {
    const m = s && s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function luminance(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }

  /** Luminance (0 dark .. 1 light) of the first non-transparent background behind `el`. */
  function bgLuminance(el) {
    let e = el;
    while (e && e !== document.documentElement) {
      const c = parseRgb(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0.1) return luminance(c);
      e = e.parentElement;
    }
    return 1;
  }
  function textLuminance(el) {
    const c = parseRgb(getComputedStyle(el).color);
    return c ? luminance(c) : 0;
  }

  function isMarkedActive(el) {
    if (!el) return false;
    if (el.getAttribute('aria-selected') === 'true') return true;
    if (el.hasAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') return true;
    return /(^|[\s_-])(active|selected|current)([\s_-]|$)/i.test(el.className || '');
  }

  /** Numbers in a string, as strings. Handles unicode minus and "1,000". */
  function numberTokens(s) {
    s = (s || '').replace(/[−–]/g, '-').replace(/(\d),(?=\d{3}\b)/g, '$1');
    return s.match(/-?\d+(?:\.\d+)?(?:\/\d+)?/g) || [];
  }
  function sameNumbers(a, b) {
    if (a.length !== b.length || !a.length) return false;
    const val = x => { const f = x.split('/'); return f.length === 2 ? parseFloat(f[0]) / parseFloat(f[1]) : parseFloat(x); };
    return a.every((x, i) => Math.abs(val(x) - val(b[i])) < 1e-9);
  }
  function normText(s) {
    return (s || '').toLowerCase().replace(/[−–]/g, '-').replace(/[\s,|]+/g, '');
  }

  // ---------------------------------------------------------------- storage
  function load() {
    return browser.storage.local.get([STORAGE_KEY, SETTINGS_KEY]).then(res => {
      log = Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
      settings = Object.assign({}, DEFAULT_SETTINGS, res[SETTINGS_KEY] || {});
    }).catch(() => {});
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (log.length > MAX_ENTRIES) log = log.slice(log.length - MAX_ENTRIES);
      saveTimer = null;
      browser.storage.local.set({ [STORAGE_KEY]: log }).catch(() => {});
    }, 150);
  }
  browser.storage.onChanged.addListener(changes => {
    if (changes[STORAGE_KEY] && !saveTimer) {
      log = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
    }
    if (changes[SETTINGS_KEY]) {
      settings = Object.assign({}, DEFAULT_SETTINGS, changes[SETTINGS_KEY].newValue || {});
      renderOverlay(true);
      renderTimer();
    }
  });

  // ---------------------------------------------------------- question mode
  /**
   * The question code is the dark tab in the tab strip at the top ("1A" in the
   * screenshots).  Strategy: find every small text node matching "1A"-style
   * text near the top of the page, then prefer (1) anything Sparx explicitly
   * marks active, (2) the one on the darkest background, (3) the one with the
   * lightest text.
   */
  function findActiveCode() {
    for (const tab of document.querySelectorAll(SEL.activeTab)) {
      const m = visibleText(tab).match(CODE_RE);
      if (m) return m[1];
    }
    const leaves = findLeaves(CODE_RE).filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top < 250 && r.width < 200;
    });
    if (!leaves.length) return null;
    const tabs = leaves.map(el => ({
      el,
      tab: el.closest('a, button, li, [role="tab"], [role="button"]') || el,
      code: el.textContent.match(CODE_RE)[1]
    }));
    if (tabs.length === 1) return tabs[0].code;

    for (const t of tabs) {
      if (isMarkedActive(t.tab) || isMarkedActive(t.tab.parentElement) || isMarkedActive(t.el)) return t.code;
    }

    let best = null, bestLum = Infinity;
    for (const t of tabs) {
      const l = bgLuminance(t.el);
      if (l < bestLum) { bestLum = l; best = t; }
    }
    const others = tabs.filter(t => t !== best).map(t => bgLuminance(t.el));
    if (best && bestLum < 0.5 && others.every(l => l > bestLum + 0.15)) return best.code;

    best = null; bestLum = -1;
    for (const t of tabs) {
      const l = textLuminance(t.el);
      if (l > bestLum) { bestLum = l; best = t; }
    }
    return best && bestLum > 0.85 ? best.code : null;
  }

  function findActionButton() {
    const leaves = findLeaves(/^\s*(Answer|Submit answer|Continue)\s*$/i).filter(isVisible);
    if (!leaves.length) return null;
    return leaves[0].closest('button, a, [role="button"]') || leaves[0];
  }

  /** The white card holding the question. */
  function findQuestionPanel() {
    const btn = findActionButton();
    if (btn) {
      const sparx = btn.closest(SEL.panel);
      if (sparx) return sparx;
    }
    for (const el of document.querySelectorAll(SEL.panel)) {
      if (isVisible(el)) return el;
    }
    if (!btn) return null;
    let e = btn.parentElement;
    while (e && e !== document.body) {
      const r = e.getBoundingClientRect();
      if (e.querySelector('input, textarea, [contenteditable="true"], [role="radio"], [role="checkbox"], [aria-pressed]') ||
          r.height >= window.innerHeight * 0.4) {
        return e;
      }
      e = e.parentElement;
    }
    return btn.parentElement;
  }

  function questionTextOf(panel) {
    let t = visibleText(panel);
    panel.querySelectorAll('input, textarea').forEach(f => { if (f.value) t = t.replace(f.value, ''); });
    t = t.replace(UI_NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
    return t.slice(0, 600);
  }

  /**
   * Read everything the student has entered / selected in the panel.
   *
   * Sparx puts the whole answer row in [data-stack="answer-content"]: typed
   * numbers, symbol slots that were filled from a picker, fixed text like the
   * variable name.  Reading that container in DOM order gives the answer as it
   * will later appear in the bookwork check, e.g. "18.15 ≤ f < 18.25".
   * Multi-part questions have several such containers.
   *
   * Choice questions ("select answer", "select answer(s)") mark the chosen
   * card(s) with a *Selected* class; those texts are collected as choices.
   */
  function captureAnswer(panel) {
    const values = [];
    const blocks = [...panel.querySelectorAll(SEL.answerContent)].filter(b => !b.closest(SKIP_SEL) && isVisible(b));
    const parts = [];
    for (const b of blocks) {
      if (blocks.some(other => other !== b && other.contains(b))) continue; // nested: keep outer
      const t = visibleText(b);
      if (t) values.push(t);
      b.querySelectorAll('input, textarea, [data-slot] ' + SEL.card.split(', ').join(', [data-slot] ')).forEach(f => {
        if (f.closest(SKIP_SEL) || !isVisible(f)) return;
        const v = (f.tagName === 'INPUT' || f.tagName === 'TEXTAREA') ? String(f.value || '') : visibleText(f);
        if (v.trim()) parts.push(v.trim());
      });
    }

    if (!values.length) {
      panel.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(f => {
        if (f.closest(SKIP_SEL) || !isVisible(f)) return;
        const type = (f.getAttribute('type') || '').toLowerCase();
        if (type === 'hidden' || type === 'button' || type === 'submit') return;
        if (type === 'checkbox' || type === 'radio') {
          if (f.checked) {
            const lab = (f.id && panel.querySelector(`label[for="${f.id}"]`)) || f.closest('label');
            values.push(lab ? visibleText(lab) : (f.value || 'checked'));
          }
          return;
        }
        const v = (f.value !== undefined && f.value !== null ? String(f.value) : visibleText(f)).trim();
        if (v) values.push(v);
      });
    }

    const choices = [];
    const answerBlocks = [...panel.querySelectorAll(SEL.answerContent)];
    panel.querySelectorAll(SEL.selectedCard).forEach(c => {
      if (c.closest(SKIP_SEL)) return;
      if (!isVisible(c)) return;
      if (c.matches(SEL.activeTab) || c.closest(SEL.activeTab)) return;      // tab strip
      if (c.closest(SEL.picker)) return;                                    // slot picker
      if (answerBlocks.some(b => b.contains(c))) return;                    // already in values
      const t = visibleText(c);
      if (t && t.length <= 200 && !choices.includes(t)) choices.push(t);
    });
    // Only fall back to the last clicked card when nothing is marked selected.
    if (!values.length && !choices.length && lastClickedChoice) choices.push(lastClickedChoice);

    const all = values.length && choices.length ? [...values, ...choices] : (values.length ? values : choices);
    return { values, choices, parts: parts.concat(choices), text: all.join(' | ') };
  }

  function detectResult() {
    // Sparx: <div id="RESULT_POPOVER" class="_ResultFullWidth_... _Incorrect_...">
    const pop = document.getElementById('RESULT_POPOVER');
    if (pop && isVisible(pop)) {
      if (/_Incorrect_/.test(pop.className)) return 'incorrect';
      if (/_Correct_/.test(pop.className)) return 'correct';
      const msg = pop.querySelector('[class*="_ResultMessage_"]');
      if (msg && INCORRECT_RE.test(visibleText(msg))) return 'incorrect';
      if (msg && CORRECT_RE.test(visibleText(msg))) return 'correct';
    }
    if (findLeaves(CORRECT_RE).some(isVisible)) return 'correct';
    if (findLeaves(INCORRECT_RE).some(isVisible)) return 'incorrect';
    return null;
  }

  function makeEntry(result) {
    return {
      id: uid(),
      ts: Date.now(),
      url: location.href,
      code: draft.code,
      question: draft.question || '',
      answer: draft.answer || { values: [], choices: [], text: '' },
      result
    };
  }

  function onSubmitClicked() {
    if (!draft) return;
    const panel = findQuestionPanel();
    if (panel) {
      const a = captureAnswer(panel);
      if (a.text) draft.answer = a;
    }
    const entry = makeEntry('submitted');
    log.push(entry);
    pendingId = entry.id;
    resultSeen = false;
    save();
  }

  function commitResult(result) {
    if (!draft) return;
    let entry = pendingId ? log.find(e => e.id === pendingId) : null;
    if (result === 'incorrect') {
      // Wrong answers are not kept: drop the entry created on "Submit answer".
      if (entry) log = log.filter(e => e !== entry);
      pendingId = null;
      save();
      return;
    }
    if (!entry) {
      entry = makeEntry(result);
      log.push(entry);
    }
    entry.result = result;
    entry.ts = Date.now();
    if (draft.answer && draft.answer.text && (!entry.answer || !entry.answer.text)) entry.answer = draft.answer;
    if (draft.question && draft.question.length > (entry.question || '').length) entry.question = draft.question;
    pendingId = null;
    save();
  }

  function tickQuestion() {
    const code = findActiveCode();
    if (code && code !== currentCode) {
      currentCode = code;
      if (!questionStart.has(code)) questionStart.set(code, Date.now());
      hideWait();
      draft = { code, question: '', answer: null };
      pendingId = null;
      resultSeen = false;
      lastClickedChoice = null;
    }
    if (!draft) return;

    const panel = findQuestionPanel();
    if (panel) {
      const q = questionTextOf(panel);
      if (q.length > draft.question.length) draft.question = q;
      const a = captureAnswer(panel);
      if (a.text) draft.answer = a;
    }

    const result = detectResult();
    if (result && !resultSeen) {
      resultSeen = true;
      commitResult(result);
    } else if (!result) {
      resultSeen = false;
    }
  }

  // Clicks: "Submit answer" creates the log entry; clicks on option-like
  // things are remembered for multiple-choice questions.
  document.addEventListener('click', ev => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t || t.closest('[data-sparxlog]') || t.closest('input, textarea')) return;
    const btn = t.closest('button, a, [role="button"], [role="radio"], [role="checkbox"], [role="option"], label, li, ' + SEL.card);
    if (!btn) return;
    const txt = visibleText(btn);
    if (SUBMIT_RE.test(txt)) {
      if (submitLocked()) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        pendingSubmitBtn = btn;
        showWait();
        return;
      }
      onSubmitClicked();
      return;
    }
    if (!txt || UI_BUTTON_RE.test(txt) || CODE_RE.test(txt)) return;
    // Only cards inside the question count; navigation links and the tab strip do not.
    if (btn.matches('a[href]') || btn.closest(SEL.activeTab) || btn.closest('[class*="_TaskItemLink_"]')) return;
    if (!btn.closest(SEL.panel)) return;
    if (txt.length <= 120 && draft) lastClickedChoice = txt;
  }, true);

  // ---------------------------------------------------------- bookwork mode
  function findModal(heading) {
    const dialog = heading.closest(SEL.dialog);
    if (dialog) return dialog;
    let e = heading;
    while (e && e !== document.body) {
      if (findLeaves(ZOOM_RE, e).length >= 2 || findLeaves(/^\s*Submit\s*$/i, e).length) return e;
      e = e.parentElement;
    }
    return document.body;
  }

  function findBookworkCode(modal) {
    for (const chip of modal.querySelectorAll(SEL.bookworkChip)) {
      const m = visibleText(chip).match(BOOKWORK_CODE_RE);
      if (m) return m[1];
    }
    const leaf = findLeaves(BOOKWORK_CODE_RE, modal)[0];
    if (leaf) return leaf.textContent.match(BOOKWORK_CODE_RE)[1];
    for (const el of modal.querySelectorAll('button, a, span, div, p, h1, h2, h3, h4')) {
      const m = visibleText(el).match(BOOKWORK_CODE_RE);
      if (m) return m[1];
    }
    return null;
  }

  /**
   * Each option in the bookwork check has a "Zoom" link under it.  Walk up from
   * every "Zoom" until we reach the wrapper that also contains the option
   * content - that wrapper is the option card.
   */
  function findOptions(modal) {
    // Sparx markup: each option is a _GridOption_ holding an _Item_ (outlined)
    // with an .answer whose values sit in .answer-block spans.
    const grid = [...modal.querySelectorAll(SEL.gridOption)].filter(isVisible);
    if (grid.length) {
      const opts = grid.map(g => {
        const el = g.querySelector(SEL.gridItem) || g;
        const ans = g.querySelector(SEL.optionAnswer) || g.querySelector('[role="radio"]') || el;
        const blocks = [...g.querySelectorAll(SEL.answerBlock)].map(visibleText).filter(Boolean);
        return { el, text: visibleText(ans).replace(/\bZoom\b/gi, '').trim(), blocks };
      }).filter(o => o.text);
      if (opts.length) return opts;
    }

    const zooms = findLeaves(ZOOM_RE, modal);
    const options = [];
    const seen = new Set();
    for (const z of zooms) {
      let e = z, prev = z;
      while (e && e !== modal) {
        if (findLeaves(ZOOM_RE, e).length > 1) {
          // Overshot into the grid: the card is the sibling before this Zoom block.
          const sib = prev.previousElementSibling;
          if (sib) pushOption(sib);
          break;
        }
        const text = visibleText(e).replace(/\bZoom\b/gi, '').trim();
        if (text) { pushOption(e, text); break; }
        prev = e;
        e = e.parentElement;
      }
    }
    if (!options.length) {
      modal.querySelectorAll('button, [role="button"], [role="radio"], [role="option"], label, li').forEach(el => {
        const text = visibleText(el);
        if (text && !UI_BUTTON_RE.test(text) && !BOOKWORK_CODE_RE.test(text)) pushOption(el, text);
      });
    }
    return options;

    function pushOption(el, text) {
      if (seen.has(el)) return;
      seen.add(el);
      text = text || visibleText(el).replace(/\bZoom\b/gi, '').trim();
      if (text) options.push({ el, text, blocks: [] });
    }
  }

  function entriesFor(code) {
    if (!code) return [];
    const list = log.filter(e => e.code === code && e.result !== 'incorrect' && e.answer && e.answer.text);
    const rank = r => (r === 'correct' ? 0 : r === 'submitted' ? 1 : 2);
    return list.sort((a, b) => rank(a.result) - rank(b.result) || b.ts - a.ts);
  }

  function answerStrings(entry) {
    const a = entry.answer || {};
    const strs = [...(a.values || []), ...(a.choices || [])];
    return strs.filter(Boolean);
  }

  /**
   * Score how well each option matches an entry.
   *   3   exact text match (whitespace/case-insensitive), e.g. "18.15 ≤ f < 18.25"
   *   2.5 same numbers in the same order (symbols may differ)
   *   2   every answer part appears in the option text (amber)
   *   1   partial (some numbers / some text) - amber
   * Green needs a single option scoring 2.5 or more.
   */
  function matchOptions(entry, options) {
    const strs = answerStrings(entry);
    if (!strs.length) return null;
    const ansTokens = numberTokens(strs.join(' '));
    const ansNorm = strs.map(normText).filter(Boolean);
    const full = normText(strs.join(' '));
    const parts = ((entry.answer && entry.answer.parts) || []).map(normText).filter(Boolean);
    let best = null;
    for (const o of options) {
      const oTokens = numberTokens(o.text);
      const oNorm = normText(o.text);
      const blocks = (o.blocks || []).map(normText).filter(Boolean);
      let score = 0;
      if (full && oNorm === full) score = 3;
      else if (parts.length && blocks.length && parts.join('\u0001') === blocks.join('\u0001')) score = 3;
      else if (ansTokens.length && sameNumbers(ansTokens, oTokens)) score = 2.5;
      else if (ansNorm.length && ansNorm.every(s => oNorm.includes(s))) score = 2;
      else if (ansTokens.length && oTokens.length && ansTokens.every(t => oTokens.some(x => parseFloat(x) === parseFloat(t)))) score = 1;
      else if (ansNorm.some(s => s.length >= 3 && oNorm.includes(s))) score = 1;
      if (!score) continue;
      if (!best || score > best.score) best = { score, ties: [o] };
      else if (score === best.score) best.ties.push(o);
    }
    return best;
  }

  function clearHighlights() {
    for (const el of highlighted) {
      el.style.outline = el.__sparxOutline || '';
      el.style.outlineOffset = el.__sparxOutlineOffset || '';
      el.style.boxShadow = el.__sparxBoxShadow || '';
      delete el.__sparxOutline; delete el.__sparxOutlineOffset; delete el.__sparxBoxShadow;
      el.removeAttribute('data-sparxlog-hl');
    }
    highlighted = [];
    const banner = document.getElementById('sparxlog-banner');
    if (banner) banner.remove();
  }

  function highlight(el, colour) {
    if (el.hasAttribute('data-sparxlog-hl')) return;
    el.__sparxOutline = el.style.outline;
    el.__sparxOutlineOffset = el.style.outlineOffset;
    el.__sparxBoxShadow = el.style.boxShadow;
    el.style.outline = `5px solid ${colour}`;
    el.style.outlineOffset = '3px';
    el.style.boxShadow = `0 0 0 9px ${colour}55`;
    el.setAttribute('data-sparxlog-hl', '1');
    highlighted.push(el);
  }

  function showBanner(text, colour) {
    if (!IS_TOP) return;
    let b = document.getElementById('sparxlog-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'sparxlog-banner';
      b.setAttribute('data-sparxlog', '1');
      b.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'max-width:80vw;padding:10px 16px;border-radius:10px;font:14px/1.4 system-ui,sans-serif;' +
        'color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none;white-space:pre-wrap';
      document.documentElement.appendChild(b);
    }
    if (b.textContent !== text) b.textContent = text;
    b.style.background = colour;
  }

  function ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  /** @returns true when the bookwork check is on screen. */
  function tickBookwork() {
    const heading = findLeaves(BOOKWORK_HEADING_RE).find(isVisible);
    if (!heading) {
      if (highlighted.length || document.getElementById('sparxlog-banner')) clearHighlights();
      return false;
    }
    const modal = findModal(heading);
    const code = findBookworkCode(modal) || currentCode;
    const options = findOptions(modal);
    const entries = entriesFor(code);

    let best = null, bestEntry = null;
    for (const entry of entries.slice(0, 15)) {
      const m = matchOptions(entry, options);
      if (m && (!best || m.score > best.score)) { best = m; bestEntry = entry; }
      if (best && best.score >= 3) break;
    }

    // Re-apply (Sparx may re-render the modal, dropping our styles).
    const wanted = best ? best.ties.map(t => t.el) : [];
    if (highlighted.some(el => !wanted.includes(el)) || wanted.some(el => !highlighted.includes(el))) {
      clearHighlights();
    }
    const confident = !!best && best.score >= 2.5 && best.ties.length === 1;
    const colour = confident ? '#16a34a' : '#f59e0b';
    for (const el of wanted) highlight(el, colour);

    if (!code) {
      showBanner('Sparx Logger: could not read the bookwork code (use "Copy HTML" and send it for debugging).', '#dc2626');
    } else if (!entries.length) {
      showBanner(`Sparx Logger: no logged answer for ${code}.`, '#dc2626');
    } else {
      const e = bestEntry || entries[0];
      const status = best ? (confident ? 'match highlighted in green'
                                       : `${best.ties.length} possible match${best.ties.length > 1 ? 'es' : ''} in amber`)
                          : 'no option matched - compare by eye';
      showBanner(`Sparx Logger - Bookwork ${code}\nYour answer: ${e.answer.text}   (${e.result}, ${ago(e.ts)})\n${status}`,
                 best ? (confident ? '#15803d' : '#b45309') : '#dc2626');
    }
    return true;
  }

  // ------------------------------------------------------------ wait timer
  function secondsLeft() {
    if (!settings.timerEnabled || !currentCode) return 0;
    const start = questionStart.get(currentCode);
    if (!start) return 0;
    const total = Math.max(0, Number(settings.timerSeconds) || 0);
    return Math.max(0, Math.ceil(total - (Date.now() - start) / 1000));
  }
  function submitLocked() {
    return !!currentCode && !vetoed.has(currentCode) && secondsLeft() > 0;
  }
  function fmt(sec) {
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  let timerEl = null;
  function renderTimer() {
    if (!IS_TOP) return;
    const show = settings.timerEnabled && currentCode && questionStart.has(currentCode) &&
                 !document.getElementById('sparxlog-banner');
    if (!show) { if (timerEl) { timerEl.remove(); timerEl = null; } return; }
    if (!timerEl || !timerEl.isConnected) {
      timerEl = document.createElement('div');
      timerEl.id = 'sparxlog-timer';
      timerEl.setAttribute('data-sparxlog', '1');
      timerEl.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483646;' +
        'padding:6px 14px;border-radius:999px;font:600 15px/1.2 system-ui,sans-serif;color:#fff;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none;letter-spacing:.5px';
      document.documentElement.appendChild(timerEl);
    }
    const left = secondsLeft();
    const veto = vetoed.has(currentCode);
    const text = veto ? `${currentCode} · vetoed` : left > 0 ? `${currentCode} · wait ${fmt(left)}` : `${currentCode} · ready`;
    if (timerEl.textContent !== text) timerEl.textContent = text;
    timerEl.style.background = veto ? '#6b7280' : left > 0 ? '#dc2626' : '#16a34a';
  }

  let waitEl = null;
  function showWait() {
    if (!IS_TOP) return;
    if (!waitEl || !waitEl.isConnected) {
      waitEl = document.createElement('div');
      waitEl.id = 'sparxlog-wait';
      waitEl.setAttribute('data-sparxlog', '1');
      waitEl.style.cssText = 'position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'min-width:320px;max-width:80vw;padding:14px 18px;border-radius:12px;background:#fff7ed;color:#7c2d12;' +
        'border:2px solid #f97316;font:15px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)';
      const msg = document.createElement('div');
      msg.id = 'sparxlog-wait-msg';
      msg.style.cssText = 'font-weight:600;margin-bottom:10px';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
      const ok = document.createElement('button');
      ok.textContent = 'OK, I\'ll wait';
      ok.style.cssText = 'all:unset;cursor:pointer;padding:6px 12px;border-radius:6px;background:#2f6fe4;color:#fff;font:600 14px system-ui,sans-serif';
      ok.addEventListener('click', hideWait);
      const veto = document.createElement('button');
      veto.textContent = 'Veto - submit anyway';
      veto.style.cssText = 'all:unset;cursor:pointer;padding:6px 12px;border-radius:6px;background:#fff;color:#7c2d12;' +
        'border:1px solid #f97316;font:600 14px system-ui,sans-serif';
      veto.addEventListener('click', () => {
        const btn = pendingSubmitBtn;
        if (currentCode) vetoed.add(currentCode);
        hideWait();
        renderTimer();
        if (btn && btn.isConnected) btn.click();   // goes through the click handler again, now unlocked
      });
      row.append(ok, veto);
      waitEl.append(msg, row);
      document.documentElement.appendChild(waitEl);
    }
    const total = Math.max(0, Number(settings.timerSeconds) || 0);
    const totalText = total === 60 ? 'one minute' : fmt(total);
    waitEl.querySelector('#sparxlog-wait-msg').textContent =
      `Hold up - wait ${totalText} in total before submitting (${fmt(secondsLeft())} left).`;
  }
  function hideWait() {
    if (waitEl) { waitEl.remove(); waitEl = null; }
    pendingSubmitBtn = null;
  }

  // Enter can also submit; block it the same way while locked.
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' || !submitLocked()) return;
    if (ev.target instanceof Element && ev.target.closest('[data-sparxlog]')) return;
    if (document.getElementById('sparxlog-banner')) return;   // bookwork check open
    const submit = [...document.querySelectorAll('button')]
      .find(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true' && isVisible(b) && SUBMIT_RE.test(visibleText(b)));
    if (!submit) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    pendingSubmitBtn = submit;
    showWait();
  }, true);

  // ---------------------------------------------------------------- overlay
  let overlayEl = null;
  function renderOverlay(force) {
    if (!IS_TOP) return;
    if (!settings.overlay) { if (overlayEl) { overlayEl.remove(); overlayEl = null; } return; }
    if (!overlayEl || !overlayEl.isConnected) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'sparxlog-overlay';
      overlayEl.setAttribute('data-sparxlog', '1');
      overlayEl.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483646;display:flex;gap:8px;' +
        'align-items:center;padding:6px 10px;border-radius:8px;background:rgba(20,30,50,.88);color:#fff;' +
        'font:12px/1.3 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);max-width:60vw';
      const status = document.createElement('span');
      status.id = 'sparxlog-status';
      status.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      const copyBtn = mkBtn('Copy HTML', 'Copy this page\'s HTML to the clipboard so it can be sent for debugging');
      copyBtn.addEventListener('click', () => copyDebugHtml(copyBtn));
      const hideBtn = mkBtn('×', 'Hide this bar (re-enable from the toolbar popup)');
      hideBtn.addEventListener('click', () => {
        settings.overlay = false;
        browser.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => {});
        renderOverlay(true);
      });
      overlayEl.append(status, copyBtn, hideBtn);
      document.documentElement.appendChild(overlayEl);
    }
    const st = overlayEl.querySelector('#sparxlog-status');
    const parts = ['Sparx Logger'];
    parts.push(currentCode ? `Q ${currentCode}` : 'no question detected');
    if (draft && draft.answer && draft.answer.text) parts.push(`draft: ${draft.answer.text}`);
    parts.push(`${log.length} saved`);
    const text = parts.join('  ·  ');
    if (force || st.textContent !== text) st.textContent = text;

    function mkBtn(label, title) {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.style.cssText = 'all:unset;cursor:pointer;padding:3px 8px;border-radius:5px;background:#2f6fe4;color:#fff;font:12px system-ui,sans-serif';
      return b;
    }
  }

  // -------------------------------------------------------------- debugging
  function debugHtml() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script, style, link[rel="stylesheet"], noscript, [data-sparxlog]').forEach(n => n.remove());
    clone.querySelectorAll('input, textarea').forEach(f => { if (f.value) f.setAttribute('data-current-value', f.value); });
    let html = clone.outerHTML;
    if (html.length > 1500000) html = html.slice(0, 1500000) + '\n<!-- truncated -->';
    return `<!-- Sparx Bookwork Logger snapshot\n     url: ${location.href}\n     time: ${new Date().toISOString()}\n     detected code: ${currentCode}\n-->\n` + html;
  }

  async function copyDebugHtml(btn) {
    const html = debugHtml();
    let ok = false;
    try { await navigator.clipboard.writeText(html); ok = true; } catch (e) { /* fall through */ }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.setAttribute('data-sparxlog', '1');
      ta.value = html;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.documentElement.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = ok ? 'Copied!' : 'Copy failed - use popup';
    setTimeout(() => { btn.textContent = old; }, 2500);
  }

  browser.runtime.onMessage.addListener(msg => {
    if (!msg || typeof msg !== 'object') return undefined;
    if (msg.type === 'getDebugHtml') return Promise.resolve({ url: location.href, html: debugHtml() });
    if (msg.type === 'getState') {
      return Promise.resolve({ url: location.href, currentCode, draft, pendingId, entries: log.length });
    }
    return undefined;
  });

  // ------------------------------------------------------------------ loop
  function tick() {
    tickTimer = null;
    try {
      if (!document.body) return;
      if (!tickBookwork()) tickQuestion();
      renderOverlay(false);
      renderTimer();
      if (waitEl && waitEl.isConnected) {
        if (!submitLocked()) hideWait(); else showWait();
      }
    } catch (e) {
      // Never let a heuristic failure break the page.
      console.debug('[sparx-logger]', e);
    }
  }
  function scheduleTick() {
    if (tickTimer) return;
    tickTimer = setTimeout(tick, 150);
  }

  load().then(() => {
    tick();
    setInterval(tick, 800);
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        const t = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
        if (t && t.closest('[data-sparxlog]')) continue;
        scheduleTick();
        return;
      }
    });
    mo.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-checked', 'aria-pressed', 'value', 'style']
    });
    document.addEventListener('input', scheduleTick, true);
  });
})();
