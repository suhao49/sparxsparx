/* Sparx Bookwork Logger - toolbar popup */
'use strict';

const STORAGE_KEY = 'sparxLog';
const SETTINGS_KEY = 'sparxSettings';

const $ = id => document.getElementById(id);

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function say(text, isError) {
  const m = $('msg');
  m.textContent = text;
  m.style.color = isError ? '#b91c1c' : '#15803d';
  if (text) setTimeout(() => { if (m.textContent === text) m.textContent = ''; }, 4000);
}

async function render() {
  const res = await browser.storage.local.get([STORAGE_KEY, SETTINGS_KEY]);
  const log = Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
  const settings = Object.assign({ overlay: true, timerEnabled: true, timerSeconds: 60 }, res[SETTINGS_KEY] || {});
  $('overlay').checked = !!settings.overlay;
  $('timerEnabled').checked = !!settings.timerEnabled;
  $('timerSeconds').value = settings.timerSeconds;
  $('count').textContent = `${log.length} entr${log.length === 1 ? 'y' : 'ies'}`;

  const rows = $('rows');
  rows.textContent = '';
  $('empty').hidden = log.length > 0;
  const recent = log.slice().sort((a, b) => b.ts - a.ts).slice(0, 300);
  for (const e of recent) {
    const tr = document.createElement('tr');
    const cells = [
      ['', fmtTime(e.ts)],
      ['code', e.code || '?'],
      ['ans', (e.answer && e.answer.text) || '(none captured)'],
      [e.result || '', e.result || ''],
      ['q', e.question || '']
    ];
    for (const [cls, text] of cells) {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = text;
      if (cls === 'q') td.title = text;
      tr.appendChild(td);
    }
    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Delete this entry';
    del.addEventListener('click', async () => {
      const cur = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
      await browser.storage.local.set({ [STORAGE_KEY]: cur.filter(x => x.id !== e.id) });
      render();
    });
    tdDel.appendChild(del);
    tr.appendChild(tdDel);
    rows.appendChild(tr);
  }
}

async function activeSparxTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !/sparx/i.test(tab.url || '')) {
    throw new Error('The active tab is not a Sparx Maths page.');
  }
  return tab;
}

async function askPage(type) {
  const tab = await activeSparxTab();
  const res = await browser.tabs.sendMessage(tab.id, { type });
  if (!res) throw new Error('No reply from the page - reload the Sparx tab and try again.');
  return res;
}

async function showState() {
  try {
    const s = await askPage('getState');
    const parts = [`Page: ${s.url}`];
    parts.push(`Detected question: ${s.currentCode || 'none'}`);
    if (s.draft && s.draft.answer && s.draft.answer.text) parts.push(`Current draft answer: ${s.draft.answer.text}`);
    $('state').textContent = parts.join('\n');
  } catch (e) {
    $('state').textContent = 'Open a Sparx Maths tab to see live status. ' + (e.message || '');
  }
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  return browser.downloads.download({ url, filename, saveAs: true })
    .finally(() => setTimeout(() => URL.revokeObjectURL(url), 30000));
}

$('export').addEventListener('click', async () => {
  const log = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  try {
    await download(`sparx-log-${stamp}.json`, JSON.stringify(log, null, 2), 'application/json');
    say('Export started.');
  } catch (e) { say('Export failed: ' + e.message, true); }
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Delete every logged answer?')) return;
  await browser.storage.local.set({ [STORAGE_KEY]: [] });
  render();
  say('Log cleared.');
});

$('copyHtml').addEventListener('click', async () => {
  try {
    const { html } = await askPage('getDebugHtml');
    await navigator.clipboard.writeText(html);
    say(`Copied ${Math.round(html.length / 1024)} KB of HTML. Paste it into the chat.`);
  } catch (e) { say('Copy failed: ' + e.message, true); }
});

$('saveHtml').addEventListener('click', async () => {
  try {
    const { html } = await askPage('getDebugHtml');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    await download(`sparx-page-${stamp}.html`, html, 'text/html');
    say('Save started.');
  } catch (e) { say('Save failed: ' + e.message, true); }
});

async function updateSettings(patch) {
  const res = await browser.storage.local.get(SETTINGS_KEY);
  const settings = Object.assign({ overlay: true, timerEnabled: true, timerSeconds: 60 }, res[SETTINGS_KEY] || {}, patch);
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}
$('overlay').addEventListener('change', ev => updateSettings({ overlay: ev.target.checked }));
$('timerEnabled').addEventListener('change', ev => updateSettings({ timerEnabled: ev.target.checked }));
$('timerSeconds').addEventListener('change', ev => {
  const n = Math.max(0, Math.min(3600, parseInt(ev.target.value, 10) || 0));
  ev.target.value = n;
  updateSettings({ timerSeconds: n });
});

browser.storage.onChanged.addListener(changes => { if (changes[STORAGE_KEY]) render(); });

render();
showState();
