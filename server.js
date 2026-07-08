#!/usr/bin/env node
'use strict';

/*
 * cc-agent-monitor — bureau virtuel live des agents Claude Code.
 * Zéro dépendance, un seul fichier, Node >= 18.
 *
 *   node server.js           → http://localhost:4519
 *   PORT=8080 node server.js → http://localhost:8080
 *
 * État en mémoire uniquement (redémarrer = reset).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
// on masque le warning "SQLite is experimental" pour garder la console propre
process.removeAllListeners('warning');
process.on('warning', (w) => { if (!/SQLite is an experimental/.test(String(w && w.message))) console.warn(w); });
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'office.db');
const db = new DatabaseSync(DB_FILE);
db.exec('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)');
db.exec('CREATE TABLE IF NOT EXISTS journal(ts INTEGER, session TEXT, project TEXT, agent TEXT, agentType TEXT, kind TEXT, tool TEXT, detail TEXT, dff TEXT, ok INTEGER)');
db.exec('CREATE INDEX IF NOT EXISTS idx_j_ts ON journal(ts)');
db.exec('CREATE INDEX IF NOT EXISTS idx_j_session ON journal(session)');
db.exec('CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, project TEXT, cwd TEXT, model TEXT, status TEXT, startedAt INTEGER, lastActivity INTEGER, endedAt INTEGER, host TEXT, transcriptPath TEXT, lastPrompt TEXT, summary TEXT, agents TEXT, toolCounts TEXT, toolFails TEXT, files TEXT)');
db.exec('CREATE INDEX IF NOT EXISTS idx_s_project ON sessions(project)');
db.exec('CREATE INDEX IF NOT EXISTS idx_s_status ON sessions(status)');
const kvGetStmt = db.prepare('SELECT v FROM kv WHERE k=?');
const kvSetStmt = db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
const kvDelStmt = db.prepare('DELETE FROM kv WHERE k=?');
const jInsStmt = db.prepare('INSERT INTO journal(ts,session,project,agent,agentType,kind,tool,detail,dff,ok) VALUES(?,?,?,?,?,?,?,?,?,?)');
const sUpsertStmt = db.prepare('INSERT INTO sessions(id,project,cwd,model,status,startedAt,lastActivity,endedAt,host,transcriptPath,lastPrompt,summary,agents,toolCounts,toolFails,files) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project=excluded.project,cwd=excluded.cwd,model=excluded.model,status=excluded.status,startedAt=excluded.startedAt,lastActivity=excluded.lastActivity,endedAt=excluded.endedAt,host=excluded.host,transcriptPath=excluded.transcriptPath,lastPrompt=excluded.lastPrompt,summary=excluded.summary,agents=excluded.agents,toolCounts=excluded.toolCounts,toolFails=excluded.toolFails,files=excluded.files');
const sDelStmt = db.prepare('DELETE FROM sessions WHERE id=?');
const sAllStmt = db.prepare('SELECT * FROM sessions');
const sIdsStmt = db.prepare('SELECT id FROM sessions');
function kvGet(k) { try { const r = kvGetStmt.get(k); return r ? JSON.parse(r.v) : null; } catch { return null; } }
function kvSet(k, val) { try { kvSetStmt.run(k, JSON.stringify(val)); } catch { /* ignore */ } }
function pj(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }
function saveSessions() {
  const ids = new Set();
  for (const s of sessions.values()) {
    ids.add(s.id);
    sUpsertStmt.run(s.id, s.project || '', s.cwd || '', s.model || '', s.status || '', s.startedAt || 0, s.lastActivity || 0, s.endedAt || null,
      s.host || '', s.transcriptPath || '', s.lastPrompt || '', s.summary || '',
      JSON.stringify(s.agents || {}), JSON.stringify(s.toolCounts || {}), JSON.stringify(s.toolFails || {}), JSON.stringify(s.files || {}));
  }
  for (const r of sIdsStmt.all()) if (!ids.has(r.id)) sDelStmt.run(r.id);   // sessions disparues
}
function loadSessions() {
  for (const r of sAllStmt.all()) {
    sessions.set(r.id, { id: r.id, project: r.project, cwd: r.cwd, model: r.model, status: r.status,
      startedAt: r.startedAt, lastActivity: r.lastActivity, endedAt: r.endedAt, host: r.host, transcriptPath: r.transcriptPath,
      lastPrompt: r.lastPrompt, summary: r.summary,
      agents: pj(r.agents, {}), toolCounts: pj(r.toolCounts, {}), toolFails: pj(r.toolFails, {}), files: pj(r.files, {}) });
  }
}

let webhookUrl = process.env.WEBHOOK_URL || '';   // webhook par défaut (Slack/Discord/Teams)
// config des notifications (persistée)
const notifCfg = {
  events: { fail: true, taskDone: false, pipeline: true, session: true, approval: true, rules: true, subDone: false, stuck: true },
  quietFrom: 0, quietTo: 0,   // heures silencieuses (from==to = désactivé)
  role: '',                   // id de rôle Discord à pinguer sur erreur critique
  digest: false,              // récap quotidien
  projectHooks: {},           // projet -> url dédiée
};
function postTo(url, text) {
  if (!url) return;
  let u; try { u = new URL(url); } catch { return; }
  const body = JSON.stringify({ text, content: text });
  const lib = u.protocol === 'http:' ? http : https;
  try {
    const rq = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 4000 });
    rq.on('error', () => {}); rq.on('timeout', () => rq.destroy());
    rq.end(body);
  } catch { /* jamais bloquant */ }
}
function inQuiet() {
  if (notifCfg.quietFrom === notifCfg.quietTo) return false;
  const h = new Date().getHours(), f = notifCfg.quietFrom, t = notifCfg.quietTo;
  return f < t ? (h >= f && h < t) : (h >= f || h < t);   // gère le passage minuit
}
function notifyWebhook(text) { postTo(webhookUrl, text); }   // brut (test de connexion)
function notify(type, project, text, critical) {
  if (!notifCfg.events[type]) return;      // type désactivé
  if (inQuiet()) return;                    // heures silencieuses
  const url = notifCfg.projectHooks[project] || webhookUrl;
  if (!url) return;
  if (critical && notifCfg.role) text = '<@&' + notifCfg.role + '> ' + text;
  postTo(url, text);
}

const PORT = Number(process.env.PORT) || 4519;
const HOST = process.env.HOST || '0.0.0.0';
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'office-state.json');
const JOURNAL_FILE = process.env.JOURNAL_FILE || path.join(__dirname, 'office-journal.jsonl');

// Chemin de fichier depuis le tool_input (Read/Edit/Write/Notebook).
function fileOf(ev, tool) {
  const t = String(tool || '').toLowerCase();
  if (!(t.includes('read') || t.includes('edit') || t.includes('write') || t.includes('notebook'))) return null;
  const ti = ev.tool_input || ev.toolInput || ev.input || {};
  return ti.file_path || ti.filePath || ti.notebook_path || ti.path || null;
}
function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '\n…(tronqué)' : s; }
// Diff d'une édition (Edit: old/new · Write: contenu) — pour le suivi du code produit.
function diffOf(ev, tool) {
  const t = String(tool || '').toLowerCase();
  const ti = ev.tool_input || ev.toolInput || ev.input || {};
  if (t.includes('edit')) return { file: fileOf(ev, tool), old: trunc(ti.old_string, 1600), new: trunc(ti.new_string, 1600) };
  if (t.includes('write')) return { file: fileOf(ev, tool), new: trunc(ti.content, 2200) };
  return null;
}

// ─── State (in-memory) ───────────────────────────────────────────────────────

/** @type {Map<string, Session>} */
const sessions = new Map();
/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();

const MAX_TICKS = 60;      // pulse-lane length per agent
const MAX_FEED = 60;       // global event feed length
const IDLE_MS = 90 * 1000; // after this with no activity → "idle"

const feed = []; // global recent events {ts, session, agent, kind, tool, ok, project}
const archive = []; // bibliothèque des sessions (pour reprise) {id, project, cwd, startedAt, endedAt, summary, prompt}
function archiveSession(s) {
  if (!s || !s.id) return;
  const rec = { id: s.id, project: s.project, cwd: s.cwd || '', startedAt: s.startedAt, endedAt: s.endedAt || now(), summary: s.summary || '', prompt: s.lastPrompt || '' };
  const i = archive.findIndex(a => a.id === s.id);
  if (i >= 0) archive[i] = rec; else archive.unshift(rec);
  if (archive.length > 100) archive.length = 100;
}

// ─── Contrôle (kill-switch / blocage d'outils) ───────────────────────────────
const paused = new Set();   // sessionIds en pause (prochain outil bloqué)
const blocked = {};         // sessionId -> [noms d'outils bloqués]
const needApproval = new Set();   // sessionIds nécessitant approbation humaine
const pending = {};               // id -> {id,sid,project,tool,detail,decision,ts}
let pendId = 0;
const APPROVAL_TOOLS = /bash|powershell|shell|write|edit|notebook/i;
let rules = [];             // règles de notif : {type:'errors',project,n} | {type:'file',text}
function evalRules(session, ev, tool) {
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.type === 'errors') {
      if (r.project && r.project !== '*' && !String(session.project).toLowerCase().includes(String(r.project).toLowerCase())) continue;
      let tf = 0; for (const a of Object.values(session.agents)) tf += a.fails || 0;
      session._firedErr = session._firedErr || {};
      if (tf >= (r.n || 3) && !session._firedErr[i]) { session._firedErr[i] = 1; notify('rules', session.project, '🚨 Règle : ' + session.project + ' a atteint ' + tf + ' erreurs', true); }
    } else if (r.type === 'file') {
      const fp = fileOf(ev, tool);
      if (fp && r.text && String(fp).toLowerCase().includes(String(r.text).toLowerCase())) notify('rules', session.project, '📌 Règle : ' + session.project + ' a modifié ' + shortPath(fp));
    }
  }
}

// ─── Stats persistantes (uptime + histogramme horaire) ───────────────────────
const bootStart = Date.now();
const stats = { firstStart: Date.now(), totalActions: 0, hourly: {}, daily: {} };  // hourly: 'YYYY-MM-DD HH' · daily: 'YYYY-MM-DD' -> count
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function hourKey(ts) { return dayKey(ts) + ' ' + String(new Date(ts).getHours()).padStart(2, '0'); }
function bumpStat(isErr) {
  const k = hourKey(Date.now());
  const h = stats.hourly[k] || (stats.hourly[k] = { a: 0, e: 0 });
  h.a++; if (isErr) h.e++;
  stats.daily = stats.daily || {};
  const dk = dayKey(Date.now());
  stats.daily[dk] = (stats.daily[dk] || 0) + 1;
  stats.totalActions++;
  const keys = Object.keys(stats.hourly).sort();
  while (keys.length > 72) delete stats.hourly[keys.shift()];  // garde ~3 jours
  const dks = Object.keys(stats.daily).sort();
  while (dks.length > 120) delete stats.daily[dks.shift()];    // garde ~4 mois
}
function dailySeries(days) {
  const out = [], base = new Date(); base.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    const k = dayKey(d.getTime());
    out.push({ d: k, c: (stats.daily && stats.daily[k]) || 0 });
  }
  return out;
}
function hourlySeries(hours) {
  const out = [], base = new Date();
  base.setMinutes(0, 0, 0);
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 3600000);
    const k = hourKey(d.getTime());
    const h = stats.hourly[k] || { a: 0, e: 0 };
    out.push({ h: String(d.getHours()).padStart(2, '0') + 'h', a: h.a, e: h.e });
  }
  return out;
}

function now() { return Date.now(); }

// ─── Persistance disque (survit au redémarrage) ──────────────────────────────
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSessions();
    kvSet('feed', feed);
    kvSet('stats', stats);
    kvSet('rules', rules);
    kvSet('webhookUrl', webhookUrl);
    kvSet('notifCfg', notifCfg);
    kvSet('archive', archive);
  }, 1500);
}
function applyLoaded(data) {
  if (Array.isArray(data.sessions)) for (const s of data.sessions) { if (s && s.id) sessions.set(s.id, s); }
  if (Array.isArray(data.feed)) { feed.push(...data.feed); if (feed.length > MAX_FEED) feed.splice(0, feed.length - MAX_FEED); }
  if (data.stats) { stats.firstStart = Math.min(stats.firstStart, data.stats.firstStart || stats.firstStart); stats.totalActions = data.stats.totalActions || 0; stats.hourly = data.stats.hourly || {}; stats.daily = data.stats.daily || {}; }
  if (Array.isArray(data.rules)) rules = data.rules;
  if (Array.isArray(data.archive)) { archive.push(...data.archive); if (archive.length > 100) archive.length = 100; }
  if (data.webhookUrl && !webhookUrl) webhookUrl = data.webhookUrl;
  if (data.notifCfg) {
    if (data.notifCfg.events) Object.assign(notifCfg.events, data.notifCfg.events);
    if ('quietFrom' in data.notifCfg) notifCfg.quietFrom = data.notifCfg.quietFrom;
    if ('quietTo' in data.notifCfg) notifCfg.quietTo = data.notifCfg.quietTo;
    if ('role' in data.notifCfg) notifCfg.role = data.notifCfg.role;
    if ('digest' in data.notifCfg) notifCfg.digest = data.notifCfg.digest;
    if (data.notifCfg.projectHooks) notifCfg.projectHooks = data.notifCfg.projectHooks;
  }
}
// migration unique : ancien office-state.json + office-journal.jsonl → SQLite
function migrateFromJson() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8'); const data = JSON.parse(raw);
    for (const k of ['sessions', 'feed', 'stats', 'rules', 'webhookUrl', 'notifCfg', 'archive']) if (k in data) kvSet(k, data[k]);
    console.log('migration JSON → SQLite (état)');
  } catch { /* pas d'ancien fichier */ }
  try {
    const raw = fs.readFileSync(JOURNAL_FILE, 'utf8');
    let n = 0;
    for (const ln of raw.split('\n')) { if (!ln) continue; let e; try { e = JSON.parse(ln); } catch { continue; }
      jInsStmt.run(e.ts || 0, e.session || '', e.project || '', e.agent || '', e.agentType || '', e.kind || '', e.tool || '', e.detail || '', e.diff ? JSON.stringify(e.diff) : null, e.ok === false ? 0 : 1); n++; }
    if (n) console.log('migration JSONL → SQLite (' + n + ' events)');
  } catch { /* pas d'ancien journal */ }
}
function loadState() {
  const cnt = db.prepare('SELECT count(*) c FROM sessions').get().c;
  if (!kvGet('stats') && cnt === 0) migrateFromJson();   // 1re fois : ancien JSON → kv + journal
  // ancien blob kv['sessions'] → table normalisée (migration unique)
  const blob = kvGet('sessions');
  if (Array.isArray(blob)) { for (const s of blob) if (s && s.id) sessions.set(s.id, s); saveSessions(); try { kvDelStmt.run('sessions'); } catch { /* */ } }
  else loadSessions();
  const data = {};
  for (const k of ['feed', 'stats', 'rules', 'webhookUrl', 'notifCfg', 'archive']) data[k] = kvGet(k);
  applyLoaded(data);
  console.log('SQLite : ' + sessions.size + ' sessions restaurées (table dédiée)');
}

function projectOf(cwd) {
  if (!cwd) return 'unknown';
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function getSession(id, ev) {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      cwd: ev.cwd || '',
      project: projectOf(ev.cwd),
      model: ev.model || '',
      status: 'working',
      startedAt: now(),
      lastActivity: now(),
      endedAt: null,
      agents: {},
      toolCounts: {},
      toolFails: {},
      files: {},
    };
    sessions.set(id, s);
  }
  if (ev.cwd && !s.cwd) { s.cwd = ev.cwd; s.project = projectOf(ev.cwd); }
  if (ev.model && !s.model) s.model = ev.model;
  if ((ev.transcript_path || ev.transcriptPath) && !s.transcriptPath) s.transcriptPath = ev.transcript_path || ev.transcriptPath;
  return s;
}

function getAgent(session, ev) {
  // Best-effort attribution: subagent id/type if present, else "main".
  const id =
    ev.subagent_id || ev.agent_id || ev.subagentId ||
    (ev.hook_event_name && /Subagent/i.test(ev.hook_event_name) ? (ev.agent_type || ev.subagent_type || 'subagent') : null) ||
    'main';
  let a = session.agents[id];
  if (!a) {
    a = {
      id,
      type: id === 'main' ? 'main' : (ev.agent_type || ev.subagent_type || 'subagent'),
      currentTool: null,
      status: 'idle',
      ticks: [],
      startedAt: now(),
      lastActivity: now(),
    };
    session.agents[id] = a;
  }
  if (ev.agent_type && a.id !== 'main') a.type = ev.agent_type;
  return a;
}

function pushTick(agent, ok, tool, detail) {
  agent.ticks.push({ ts: now(), ok: !!ok, tool: tool || null, detail: detail || '' });
  if (agent.ticks.length > MAX_TICKS) agent.ticks.shift();
}

function pushFeed(entry) {
  feed.push(entry);
  if (feed.length > MAX_FEED) feed.shift();
}

// Coupe une chaîne pour l'affichage (sans casser au milieu d'un mot si possible).
function clip(str, max) {
  const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Résumé humain de ce que fait l'agent, extrait du payload du hook.
 * Renvoie une phrase courte : "lit server.js", "exécute npm test", etc.
 */
function summarize(ev, kind, tool) {
  if (kind === 'UserPromptSubmit') {
    const p = ev.prompt || ev.user_prompt || '';
    return p ? '“' + clip(p, 120) + '”' : '';
  }

  const ti = ev.tool_input || ev.toolInput || ev.input || {};
  const t = String(tool || '').toLowerCase();
  const base = (verb) => {
    if (t.includes('bash') || t.includes('powershell') || t.includes('shell')) {
      const cmd = ti.command || '';
      const desc = ti.description || '';
      return verb + (cmd ? clip(cmd, 90) : (desc ? clip(desc, 90) : ''));
    }
    if (t.includes('read') || t.includes('edit') || t.includes('write') || t.includes('notebook')) {
      return verb + shortPath(ti.file_path || ti.filePath || ti.notebook_path || ti.path || '');
    }
    if (t.includes('grep')) return verb + '“' + clip(ti.pattern, 60) + '”' + (ti.path ? ' dans ' + shortPath(ti.path) : '');
    if (t.includes('glob')) return verb + clip(ti.pattern, 70);
    if (t.includes('webfetch') || (t.includes('fetch') && ti.url)) return verb + clip(ti.url, 80);
    if (t.includes('websearch') || t.includes('search')) return verb + '“' + clip(ti.query || ti.pattern, 70) + '”';
    if (t.includes('task') || t.includes('agent')) {
      const d = ti.description || ti.subagent_type || '';
      return verb + clip(d, 80);
    }
    if (t.includes('todo')) {
      const todos = ti.todos || [];
      const cur = Array.isArray(todos) ? todos.find(x => x && x.status === 'in_progress') : null;
      return verb + (cur ? clip(cur.content || cur.activeForm || '', 80) : (todos.length + ' tâches'));
    }
    if (t.includes('workflow')) return verb + clip(ti.description || ti.name || '', 80);
    if (t.includes('__') || t.includes('mcp')) {
      const firstStr = Object.values(ti).find(v => typeof v === 'string');
      return verb + (firstStr ? clip(firstStr, 70) : tool);
    }
    // fallback générique : première valeur texte du tool_input
    const firstStr = Object.values(ti).find(v => typeof v === 'string' && v.length);
    return verb + (firstStr ? clip(firstStr, 80) : '');
  };
  return base('').trim();
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : '…/' + parts.slice(-2).join('/');
}

// ─── Event ingestion ─────────────────────────────────────────────────────────

function handleEvent(ev, remoteAddr) {
  const kind = ev.hook_event_name || ev.event || 'Unknown';
  const sid = ev.session_id || ev.sessionId || 'unknown';
  const session = getSession(sid, ev);
  session.lastActivity = now();
  session._stuck = 0;   // activité → plus bloqué
  if (remoteAddr && !session.host) {
    const ip = String(remoteAddr).replace('::ffff:', '');
    session.host = (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') ? 'local' : ip;
  }

  const agent = getAgent(session, ev);
  agent.lastActivity = now();

  const tool = ev.tool_name || ev.toolName || null;
  const detail = summarize(ev, kind, tool); // résumé lisible de l'action

  switch (kind) {
    case 'SessionStart':
      session.status = 'working';
      session.endedAt = null;
      break;

    case 'UserPromptSubmit':
      session.status = 'working';
      agent.status = 'working';
      agent.waiting = false;
      if (detail) { session.lastPrompt = detail; agent.lastAction = detail; }
      break;

    case 'PreToolUse':
      session.status = 'working';
      agent.status = 'working';
      agent.waiting = false;
      agent.currentTool = tool;
      if (detail) agent.lastAction = detail;
      break;

    case 'PostToolUse':
      agent.currentTool = null;
      agent.status = 'working';
      if (detail) agent.lastAction = detail;
      agent.actions = (agent.actions || 0) + 1;
      pushTick(agent, true, tool, detail);
      if (tool) session.toolCounts[tool] = (session.toolCounts[tool] || 0) + 1;
      { const fp = fileOf(ev, tool); if (fp) { session.files = session.files || {}; const rec = session.files[fp] || (session.files[fp] = { n: 0, edited: false }); rec.n++; if (/edit|write|notebook/i.test(tool)) rec.edited = true; } }
      bumpStat(false);
      break;

    case 'PostToolUseFailure':
      agent.currentTool = null;
      agent.status = 'working';
      if (detail) agent.lastAction = detail;
      agent.actions = (agent.actions || 0) + 1;
      agent.fails = (agent.fails || 0) + 1;
      agent.lastErrorAt = now();
      agent.lastErrorTool = tool || '';
      pushTick(agent, false, tool, detail);
      if (tool) { session.toolCounts[tool] = (session.toolCounts[tool] || 0) + 1; session.toolFails = session.toolFails || {}; session.toolFails[tool] = (session.toolFails[tool] || 0) + 1; }
      bumpStat(true);
      notify('fail', session.project, '❌ ' + session.project + ' : échec ' + (tool || '') + (detail ? ' — ' + detail : ''), true);
      break;

    case 'SubagentStart':
      agent.status = 'working';
      break;

    case 'SubagentStop': {
      agent.status = 'done';
      agent.currentTool = null;
      notify('subDone', session.project, '🔻 ' + session.project + ' · sous-agent ' + (agent.type || '') + ' terminé');
      // pipeline terminé : plus aucun sous-agent actif
      const subsAll = Object.values(session.agents).filter(a => a.id !== 'main');
      if (subsAll.length && !subsAll.some(a => a.status === 'working')) {
        notify('pipeline', session.project, '🏁 ' + session.project + ' — pipeline terminé (' + subsAll.length + ' sous-agents)');
      }
      break;
    }

    case 'Stop': {
      session.status = 'idle';
      for (const a of Object.values(session.agents)) {
        if (a.id === 'main') { a.status = 'idle'; a.currentTool = null; }
      }
      let acts = 0; for (const a of Object.values(session.agents)) acts += a.actions || 0;
      notify('taskDone', session.project, '✅ ' + session.project + ' — tâche terminée (' + acts + ' actions)');
      break;
    }

    case 'SessionEnd': {
      session.status = 'done';
      session.endedAt = now();
      for (const a of Object.values(session.agents)) { a.status = 'done'; a.currentTool = null; }
      let acts = 0, fails = 0;
      for (const a of Object.values(session.agents)) { acts += a.actions || 0; fails += a.fails || 0; }
      const dur = Math.round((session.endedAt - session.startedAt) / 60000);
      session.summary = acts + ' actions · ' + fails + ' échecs · ' + dur + ' min';
      archiveSession(session);
      notify('session', session.project, (fails ? '⚠️' : '✅') + ' ' + session.project + ' terminé — ' + session.summary, !!fails);
      break;
    }

    case 'Notification':
      // Claude attend une action de l'utilisateur (permission, idle…)
      agent.waiting = true;
      agent.notice = detail || ev.message || 'attend une action';
      notify('approval', session.project, '⏳ ' + session.project + ' attend une action : ' + agent.notice, true);
      break;

    default:
      break;
  }

  if (kind === 'PostToolUse' || kind === 'PostToolUseFailure') evalRules(session, ev, tool);

  const entry = {
    ts: now(),
    session: sid,
    project: session.project,
    agent: agent.id,
    agentType: agent.type,
    kind,
    tool,
    detail: (kind === 'SessionEnd' && session.summary) ? session.summary : detail,
    ok: kind !== 'PostToolUseFailure',
  };
  pushFeed(entry);
  // journal en base (le diff des éditions est stocké dans la colonne dff)
  const df = (kind === 'PostToolUse') ? diffOf(ev, tool) : null;
  try { jInsStmt.run(entry.ts, entry.session, entry.project, entry.agent, entry.agentType, entry.kind, entry.tool || '', entry.detail || '', df ? JSON.stringify(df) : null, entry.ok ? 1 : 0); } catch { /* jamais bloquant */ }

  broadcast();
  scheduleSave();
}

// ─── Snapshot + SSE ──────────────────────────────────────────────────────────

function refreshStatuses() {
  const t = now();
  for (const [id, s] of sessions) {
    // détection "bloqué" : inactif > 2 min alors qu'une tâche est en cours
    if (s.status !== 'done' && !s._stuck && (t - s.lastActivity) > 120000) {
      s._stuck = 1;
      notify('stuck', s.project, '⚠️ ' + s.project + ' semble bloqué (aucune activité depuis 2 min)', true);
    }
    if (s.status === 'working' && t - s.lastActivity > IDLE_MS) s.status = 'idle';
    // purge auto : session terminée depuis > 5 min, ou totalement inactive depuis > 30 min
    if ((s.status === 'done' && s.endedAt && t - s.endedAt > 5 * 60 * 1000) ||
        (t - s.lastActivity > 30 * 60 * 1000)) {
      archiveSession(s);
      sessions.delete(id);
    }
  }
}

function snapshot() {
  refreshStatuses();
  return {
    now: now(),
    sessions: [...sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity),
    feed: [...feed].reverse(),
    paused: [...paused],
    blocked,
    needApproval: [...needApproval],
    approvals: Object.values(pending).filter(p => !p.decision).map(p => ({ id: p.id, sid: p.sid, project: p.project, tool: p.tool, detail: p.detail })),
    webhook: !!webhookUrl,
    notifCfg,
    rules,
    archive,
    stats: { boot: bootStart, firstStart: stats.firstStart, now: now(), totalActions: stats.totalActions, hourly: hourlySeries(24), daily: dailySeries(105) },
  };
}

function broadcast() {
  const data = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const res of sseClients) {
    try { res.write(data); } catch { /* client gone */ }
  }
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(raw));
    req.on('error', () => resolve(raw));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // POST /event — hook ingestion. Répond {} immédiatement, jamais bloquant.
  if (req.method === 'POST' && url.pathname === '/event') {
    const raw = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    if (raw) {
      try { handleEvent(JSON.parse(raw), req.socket.remoteAddress); }
      catch { /* payload non-JSON : on ignore sans casser la session */ }
    }
    return;
  }

  // GET /events — SSE stream
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    sseClients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return;
  }

  // POST /gate-check — hook PreToolUse : autoriser / refuser / mettre EN ATTENTE d'approbation
  if (req.method === 'POST' && url.pathname === '/gate-check') {
    const raw = await readBody(req);
    let resp = { decision: 'allow' };
    try {
      const ev = JSON.parse(raw || '{}');
      const sid = ev.session_id || ev.sessionId || '';
      const tool = ev.tool_name || ev.toolName || '';
      if (paused.has(sid)) resp = { decision: 'deny', reason: 'Session en pause depuis agent-office.' };
      else if (blocked[sid] && blocked[sid].includes(tool)) resp = { decision: 'deny', reason: 'Outil ' + tool + ' bloqué depuis agent-office.' };
      else if (needApproval.has(sid) && APPROVAL_TOOLS.test(String(tool))) {
        const s = sessions.get(sid);
        const id = ++pendId;
        pending[id] = { id, sid, project: s ? s.project : sid, tool, detail: summarize(ev, 'PreToolUse', tool), decision: null, ts: now() };
        notify('approval', s ? s.project : sid, '🖐️ Approbation requise : ' + (s ? s.project : sid) + ' → ' + tool, true);
        resp = { decision: 'pending', id };
        broadcast();
      }
    } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resp));
    return;
  }

  // GET /gate-decision?id= — le hook interroge la décision (allow/deny/pending)
  if (req.method === 'GET' && url.pathname === '/gate-decision') {
    const id = url.searchParams.get('id');
    const p = pending[id];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ decision: p ? (p.decision || 'pending') : 'allow' }));
    return;
  }

  // POST /approve — décision humaine depuis le bureau ({id, decision:'allow'|'deny'})
  if (req.method === 'POST' && url.pathname === '/approve') {
    const raw = await readBody(req);
    try { const b = JSON.parse(raw || '{}'); if (pending[b.id]) pending[b.id].decision = b.decision === 'allow' ? 'allow' : 'deny'; } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    broadcast();
    return;
  }

  // POST /webhook — définit/teste l'URL de webhook (Slack/Discord…)
  if (req.method === 'POST' && url.pathname === '/webhook') {
    const raw = await readBody(req);
    try { const b = JSON.parse(raw || '{}'); webhookUrl = (b.url || '').trim(); if (webhookUrl) notifyWebhook('🔔 agent-office connecté à ce webhook.'); } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, set: !!webhookUrl }));
    broadcast();
    scheduleSave();
    return;
  }

  // POST /rules — définit les règles de notification
  if (req.method === 'POST' && url.pathname === '/rules') {
    const raw = await readBody(req);
    try { const b = JSON.parse(raw || '{}'); if (Array.isArray(b.rules)) rules = b.rules.slice(0, 50); } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    broadcast(); scheduleSave();
    return;
  }

  // POST /notifcfg — réglages de notification
  if (req.method === 'POST' && url.pathname === '/notifcfg') {
    const raw = await readBody(req);
    try {
      const b = JSON.parse(raw || '{}');
      if (b.events) Object.assign(notifCfg.events, b.events);
      if ('quietFrom' in b) notifCfg.quietFrom = (b.quietFrom | 0);
      if ('quietTo' in b) notifCfg.quietTo = (b.quietTo | 0);
      if ('role' in b) notifCfg.role = String(b.role || '').replace(/[^0-9]/g, '');
      if ('digest' in b) notifCfg.digest = !!b.digest;
      if (b.projectHooks && typeof b.projectHooks === 'object') notifCfg.projectHooks = b.projectHooks;
    } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    broadcast(); scheduleSave();
    return;
  }

  // POST /control — actions depuis l'UI (pause/reprise/blocage d'outil)
  if (req.method === 'POST' && url.pathname === '/control') {
    const raw = await readBody(req);
    try {
      const b = JSON.parse(raw || '{}');
      const sid = b.session;
      if (b.action === 'pause') paused.add(sid);
      else if (b.action === 'resume') paused.delete(sid);
      else if (b.action === 'block' && b.tool) { (blocked[sid] = blocked[sid] || []); if (!blocked[sid].includes(b.tool)) blocked[sid].push(b.tool); }
      else if (b.action === 'unblock') { delete blocked[sid]; }
      else if (b.action === 'approvalOn') { needApproval.add(sid); }
      else if (b.action === 'approvalOff') { needApproval.delete(sid); }
    } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    broadcast();
    return;
  }

  // POST /prune — supprime les sessions non actives (terminées / inactives)
  if (req.method === 'POST' && url.pathname === '/prune') {
    for (const [id, s] of sessions) { if (s.status !== 'working') { archiveSession(s); sessions.delete(id); } }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    broadcast();
    scheduleSave();
    return;
  }

  // GET /api/journal — historique persistant (recherche par session / texte)
  if (req.method === 'GET' && url.pathname === '/api/journal') {
    const qp = url.searchParams;
    const sid = qp.get('session') || '';
    const q = (qp.get('q') || '').toLowerCase();
    const limit = Math.min(2000, Number(qp.get('limit')) || 300);
    const cond = [], params = [];
    if (sid) { cond.push('session = ?'); params.push(sid); }
    if (q) { const l = '%' + q + '%'; cond.push('(lower(project) LIKE ? OR lower(tool) LIKE ? OR lower(detail) LIKE ? OR lower(kind) LIKE ?)'); params.push(l, l, l, l); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    let rows = [];
    try { rows = db.prepare('SELECT * FROM journal ' + where + ' ORDER BY ts DESC LIMIT ?').all(...params, limit); } catch { /* ignore */ }
    const out = rows.map(r => ({ ts: r.ts, session: r.session, project: r.project, agent: r.agent, agentType: r.agentType, kind: r.kind, tool: r.tool, detail: r.detail, diff: r.dff ? JSON.parse(r.dff) : undefined, ok: r.ok === 1 }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: out }));
    return;
  }

  // GET /api/transcript — conversation live (prose de l'agent) depuis le .jsonl
  if (req.method === 'GET' && url.pathname === '/api/transcript') {
    const sid = url.searchParams.get('session') || '';
    const limit = Math.min(80, Number(url.searchParams.get('limit')) || 30);
    const s = sessions.get(sid);
    const out = [];
    if (s && s.transcriptPath) {
      try {
        let raw = fs.readFileSync(s.transcriptPath, 'utf8');
        if (raw.length > 6 * 1024 * 1024) raw = raw.slice(raw.length - 6 * 1024 * 1024);
        const lines = raw.split('\n');
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
          if (!lines[i]) continue;
          let o; try { o = JSON.parse(lines[i]); } catch { continue; }
          const msg = o.message || o;
          const role = msg.role || o.type;
          if (role !== 'user' && role !== 'assistant') continue;
          let text = '';
          if (typeof msg.content === 'string') text = msg.content;
          else if (Array.isArray(msg.content)) text = msg.content.filter(c => c && c.type === 'text').map(c => c.text).join(' ');
          text = text.trim();
          if (text) out.push({ role, text: text.length > 800 ? text.slice(0, 800) + '…' : text, ts: o.timestamp || 0 });
        }
      } catch { /* illisible */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: out.reverse() }));
    return;
  }

  // GET /api/subagents — activité RÉELLE des sous-agents, extraite des sidechains du transcript
  if (req.method === 'GET' && url.pathname === '/api/subagents') {
    const sid = url.searchParams.get('session') || '';
    const s = sessions.get(sid);
    const out = [];
    if (s && s.transcriptPath) {
      try {
        let raw = fs.readFileSync(s.transcriptPath, 'utf8');
        if (raw.length > 8 * 1024 * 1024) raw = raw.slice(raw.length - 8 * 1024 * 1024);
        for (const ln of raw.split('\n')) {
          if (!ln || ln.indexOf('isSidechain') < 0) continue;
          let o; try { o = JSON.parse(ln); } catch { continue; }
          if (!o.isSidechain) continue;
          const msg = o.message || o;
          if (!Array.isArray(msg.content)) continue;
          for (const c of msg.content) {
            if (c && c.type === 'tool_use') {
              out.push({ tool: c.name, detail: summarize({ tool_input: c.input }, 'PreToolUse', c.name), ts: o.timestamp || 0 });
            } else if (c && c.type === 'text' && c.text && c.text.trim()) {
              out.push({ tool: '', detail: clip(c.text, 140), ts: o.timestamp || 0, text: true });
            }
          }
        }
      } catch { /* illisible */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ acts: out.slice(-80) }));
    return;
  }

  // GET /api/state — JSON snapshot (debug / intégrations)
  if (req.method === 'GET' && url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  // GET / — dashboard
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // PWA : manifest, service worker, icône
  if (req.method === 'GET' && url.pathname === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(JSON.stringify({ name: 'agent-office', short_name: 'agent-office', start_url: '/', display: 'standalone',
      background_color: '#0d1420', theme_color: '#0d1420', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>self.clients.claim());self.addEventListener('fetch',function(){});");
    return;
  }
  if (req.method === 'GET' && url.pathname === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192"><rect width="192" height="192" rx="28" fill="#0d1420"/><text x="96" y="128" font-size="110" text-anchor="middle">🏢</text></svg>');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

loadState();   // restaure l'état précédent si présent

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`cc-agent-monitor → http://${shown}:${PORT}`);
  console.log(`POST hooks vers   → http://${shown}:${PORT}/event`);
});

// Refresh périodique pour faire basculer working→idle même sans nouvel event.
setInterval(() => { broadcast(); }, 5000);

// Récap quotidien (digest) envoyé une fois vers 20h si activé.
let lastDigestDay = '';
setInterval(() => {
  if (!notifCfg.digest || !webhookUrl) return;
  const d = new Date();
  if (d.getHours() !== 20) return;
  const day = dayKey(Date.now());
  if (day === lastDigestDay) return;
  lastDigestDay = day;
  const acts = (stats.daily && stats.daily[day]) || 0;
  let fails = 0; for (const s of sessions.values()) for (const a of Object.values(s.agents)) fails += a.fails || 0;
  if (!inQuiet()) postTo(webhookUrl, '📊 Récap du jour — ' + acts + ' actions · ' + fails + ' erreurs · ' + sessions.size + ' sessions');
}, 5 * 60 * 1000);

// ─── UI : bureau virtuel (Canvas 2D, single-file) ────────────────────────────

const HTML = /* html */ `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0d1420">
<link rel="manifest" href="/manifest.json">
<title>agent-office</title>
<style>
  :root{--bg:#0d1420;--line:#1e2735;--txt:#e6edf3;--dim:#8b98a9;--green:#3fb950;--amber:#ffb020;}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--txt);
    font:13px/1.4 "Segoe UI",system-ui,-apple-system,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  header{display:flex;align-items:center;gap:14px;padding:0 20px;height:52px;
    border-bottom:1px solid var(--line);background:rgba(10,14,20,.9);position:relative;z-index:5}
  header h1{font-size:14px;margin:0;font-weight:600;letter-spacing:.3px}
  header .dot{width:9px;height:9px;border-radius:50%;background:#5c6b7e;transition:.3s}
  header .dot.live{background:var(--green);box-shadow:0 0 10px var(--green)}
  header .stats{margin-left:auto;display:flex;gap:16px;color:var(--dim);font-size:12px}
  header .stats b{color:var(--txt)}
  header .tools2{display:flex;align-items:center;gap:8px;margin-left:16px}
  header input#q{background:#0e131c;border:1px solid #26344c;border-radius:8px;color:var(--txt);
    font:12px "Segoe UI",system-ui,sans-serif;padding:6px 10px;width:150px;outline:none}
  header input#q:focus{border-color:#3a4c6b}
  header input#q::placeholder{color:#5c6b7e}
  header .sbtn{cursor:pointer;border:1px solid #26344c;border-radius:8px;background:#0e131c;
    width:32px;height:30px;display:grid;place-items:center;font-size:14px;color:var(--dim)}
  header .sbtn:hover{border-color:#3a4c6b;color:#fff}
  header .sbtn.on{color:var(--green);border-color:#153d21}
  header .sbtn.warn{color:#f85149;border-color:#4a1d1d;background:#231010}

  /* mini-log d'activité (bas-gauche) */
  #log{position:absolute;left:14px;bottom:12px;width:340px;max-width:calc(100% - 28px);z-index:6;
    pointer-events:none;display:flex;flex-direction:column-reverse;gap:3px}
  #log .lg{background:rgba(10,16,26,.72);border:1px solid rgba(38,52,76,.7);border-left:3px solid #2f4a6b;
    border-radius:7px;padding:4px 9px;font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis;animation:lgin .18s ease}
  #log .lg .lt{color:#5c6b7e}
  #log .lg .lp{color:#bcd4ff}
  #log .lg .la{color:#e6edf3}
  #log .lg.fail{border-left-color:#f85149}
  #log .lg.done{border-left-color:#3fb950}
  @keyframes lgin{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

  /* ── thème clair ── */
  body.light{ --bg:#e9edf3; --line:#c6d0dd; --txt:#1b2431; --dim:#5a6b7e; }
  body.light header{ background:rgba(233,237,243,.92); }
  body.light header input#q{ background:#fff; color:#1b2431; border-color:#c6d0dd; }
  body.light header input#q::placeholder{ color:#8a97a6; }
  body.light header .sbtn{ background:#fff; border-color:#c6d0dd; color:#5a6b7e; }
  body.light header .sbtn.on{ color:#1f9d4d; border-color:#a9dcbb; }
  body.light #card{ background:linear-gradient(180deg,#ffffff,#eef2f7); border-color:#c6d0dd; }
  body.light #card .cav{ background:#eef2f7; border-color:#c6d0dd; }
  body.light #card .ct, body.light #card .row .val{ color:#1b2431; }
  body.light #card .cx{ border-color:#c6d0dd; }
  body.light #card .tm{ background:#f1f4f9; border-color:#d6dee9; }
  body.light #card .tm .tn{ color:#6b3fd0; }
  body.light #log .lg{ background:rgba(255,255,255,.85); border-color:rgba(180,195,215,.8); border-left-color:#8aa0bd; color:#5a6b7e; }
  body.light #log .lg .la{ color:#1b2431; } body.light #log .lg .lp{ color:#2f5bd0; }
  body.light #empty{ color:#5a6b7e; }
  body.light #card .cbtn{ background:#eef2f7; border-color:#c6d0dd; color:#1b2431; }
  body.light #card .cbtn:hover{ border-color:#8aa0bd; }
  body.light #card .cbtn.on{ background:#fff2d4; border-color:#e6c26a; color:#8a6a00; }
  body.light #card .cbtn.danger:hover{ border-color:#e0483f; color:#c0392b; }
  body.light #card .ctk{ background:#3f78d6; }
  body.light #card .val.alert{ color:#b5760a; }
  #stage{position:absolute;inset:52px 0 0 0}
  canvas{display:block;width:100%;height:100%}
  #empty{position:absolute;inset:52px 0 0 0;display:none;align-items:center;justify-content:center;
    color:var(--dim);text-align:center;padding:40px}
  #empty code{color:#4c9aff;background:#121a26;padding:2px 6px;border-radius:4px}
  canvas{cursor:default}
  canvas.hot{cursor:pointer}

  /* mode TV / plein écran : on masque le chrome */
  body.tv header, body.tv #team, body.tv #log, body.tv #card{display:none!important}
  body.tv #stage{inset:0}

  /* vue liste compacte */
  #list{position:absolute;inset:52px 0 0 0;z-index:9;background:var(--bg);overflow:auto;display:none;padding:16px 22px}
  #list.open{display:block}
  #list table{width:100%;max-width:1100px;margin:0 auto;border-collapse:collapse;font-size:13px}
  #list th{text-align:left;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:8px 10px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg)}
  #list td{padding:8px 10px;border-bottom:1px solid #141b27;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px}
  #list tr.row2{cursor:pointer}
  #list tr.row2:hover td{background:rgba(76,154,255,.06)}
  #list .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}
  #list .st{font-size:10px;text-transform:uppercase;letter-spacing:.5px}
  #list .st.working{color:var(--amber)} #list .st.idle{color:var(--dim)} #list .st.done{color:var(--green)}
  #list .mono{font-family:"Consolas",monospace;color:var(--dim)}
  #list .al{color:var(--amber)}
  body.light #list tr.row2:hover td{background:rgba(47,91,208,.08)}

  /* panneau statistiques + histogramme */
  #stats{position:absolute;top:66px;left:50%;transform:translateX(-50%);width:min(760px,calc(100% - 32px));z-index:9;
    background:linear-gradient(180deg,#141b28,#0e131c);border:1px solid #26344c;border-radius:14px;
    box-shadow:0 18px 50px rgba(0,0,0,.55);display:none;padding:16px 18px}
  #stats.open{display:block}
  #stats h3{font-size:12px;margin:0 0 12px;color:var(--dim);text-transform:uppercase;letter-spacing:1px}
  #stats .up{display:flex;gap:22px;flex-wrap:wrap;margin-bottom:14px;font-size:13px;color:var(--dim)}
  #stats .up b{color:var(--txt)}
  #stats .hist{display:flex;align-items:flex-end;gap:3px;height:130px;border-bottom:1px solid var(--line)}
  #stats .bar{flex:1;background:#4c9aff;border-radius:2px 2px 0 0;position:relative;min-height:2px;transition:height .2s}
  #stats .bar .e{position:absolute;bottom:0;left:0;right:0;background:#f85149;border-radius:2px 2px 0 0}
  #stats .lbls{display:flex;gap:3px;margin-top:4px}
  #stats .lbls span{flex:1;text-align:center;font-size:8px;color:var(--dim2,#5c6b7e)}
  #stats .lg2{font-size:11px;color:var(--dim);margin-top:8px}
  #stats .gantt{display:flex;flex-direction:column;gap:3px;margin-top:4px}
  #stats .grow{display:flex;align-items:center;gap:8px;font-size:11px}
  #stats .grow .gl{width:110px;flex:none;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #stats .grow .gt{flex:1;height:12px;background:#0e131c;border-radius:3px;position:relative}
  #stats .grow .gb{position:absolute;top:0;height:12px;border-radius:3px;min-width:3px}
  #stats table.rank{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px}
  #stats table.rank th{text-align:left;color:var(--dim);font-size:10px;text-transform:uppercase;padding:4px 8px;border-bottom:1px solid var(--line)}
  #stats table.rank td{padding:4px 8px;border-bottom:1px solid #141b27}
  body.light #stats{background:linear-gradient(180deg,#fff,#eef2f7);border-color:#c6d0dd}
  body.light #stats .grow .gt{background:#dde5ef}
  #stats .badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
  #stats .badge2{font-size:11px;padding:4px 9px;border-radius:20px;border:1px solid var(--line);color:var(--dim2,#5c6b7e);background:#0e131c;opacity:.55}
  #stats .badge2.on{opacity:1;color:#ffe08a;border-color:#4a3a10;background:#231c08}
  body.light #stats .badge2{background:#eef2f7} body.light #stats .badge2.on{background:#fff2d4;color:#8a6a00;border-color:#e6c26a}

  /* panneau historique / recherche */
  #hist{position:absolute;top:66px;left:50%;transform:translateX(-50%);width:min(780px,calc(100% - 32px));max-height:calc(100% - 90px);z-index:10;
    background:linear-gradient(180deg,#141b28,#0e131c);border:1px solid #26344c;border-radius:14px;
    box-shadow:0 18px 50px rgba(0,0,0,.6);display:none;flex-direction:column;overflow:hidden}
  #hist.open{display:flex}
  #histHead{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line)}
  #histHead input{flex:1;background:#0e131c;border:1px solid #26344c;border-radius:8px;color:var(--txt);font:13px "Segoe UI",sans-serif;padding:7px 10px;outline:none}
  #histHead #histTitle{color:var(--dim);font-size:12px;white-space:nowrap}
  #histHead #histX{cursor:pointer;color:var(--dim);border:1px solid #26344c;border-radius:7px;width:26px;height:26px;display:grid;place-items:center}
  #histHead #histX:hover{color:#fff;border-color:#3a4c6b}
  #histBody{overflow:auto;padding:6px 8px}
  #hist .he{display:flex;gap:9px;align-items:baseline;padding:5px 8px;border-top:1px solid #131a26;font-size:12px}
  #hist .he:first-child{border-top:none}
  #hist .he.fail{background:rgba(248,81,73,.07)} #hist .he.done{background:rgba(63,185,80,.05)}
  #hist .ht{color:var(--dim2,#5c6b7e);font-size:10px;width:60px;flex:none}
  #hist .hp{color:#bcd4ff;width:90px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #hist .hk{color:var(--amber);font-size:11px;width:90px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #hist .ha{color:var(--txt);font-family:"Consolas",monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  body.light #hist{background:linear-gradient(180deg,#fff,#eef2f7);border-color:#c6d0dd}
  body.light #histHead input{background:#fff;color:#1b2431;border-color:#c6d0dd}
  #hist .he.hasdiff{cursor:pointer}
  #hist .he.hasdiff .ha::before{content:'▸ ';color:var(--amber)}
  #hist .hd{display:none;margin:0 8px 6px;padding:8px 10px;background:#0a0f18;border:1px solid #1a2434;border-radius:8px;
    font-family:"Consolas",monospace;font-size:11px;white-space:pre-wrap;overflow:auto;max-height:240px}
  #hist .hd.open{display:block}
  #hist .hd .dm{color:#f0a0a0} #hist .hd .dp{color:#8be0a0}

  /* fichiers cliquables (ouvrir dans l'éditeur) */
  #card .fitem a.fp{color:#4c9aff;text-decoration:none}
  #card .fitem a.fp:hover{text-decoration:underline}

  /* heatmap calendrier */
  #stats .heat{display:grid;grid-template-rows:repeat(7,11px);grid-auto-flow:column;gap:2px;margin-top:4px;overflow-x:auto}
  #stats .hm{width:11px;height:11px;border-radius:2px;background:#1b2a3c}
  #stats .hm1{background:#1c4a2e} #stats .hm2{background:#2f8f4e} #stats .hm3{background:#3fb950}
  body.light #stats .hm{background:#dde5ef} body.light #stats .hm1{background:#a9dcbb}
  body.light #stats .hm2{background:#4bbf6f} body.light #stats .hm3{background:#2f9d4e}

  /* rappel navigation */
  #nav{position:absolute;right:12px;bottom:10px;z-index:6;pointer-events:none;font-size:10px;color:var(--dim);
    background:rgba(10,16,26,.6);border:1px solid var(--line);border-radius:8px;padding:5px 9px}
  #nav b{color:var(--txt)}
  body.tv #nav{display:none}
  body.light #nav{background:rgba(255,255,255,.7)}

  /* tooltip au survol */
  #tip{position:absolute;z-index:14;pointer-events:none;display:none;max-width:260px;
    background:rgba(10,16,26,.96);border:1px solid #26344c;border-radius:9px;padding:8px 10px;box-shadow:0 8px 24px rgba(0,0,0,.5)}
  #tip.show{display:block}
  #tip .tn{font-weight:600;font-size:12px;color:var(--txt)}
  #tip .tt{color:#ffe08a;font-size:11px;margin-top:3px}
  #tip .ta{color:var(--dim);font-size:11px;margin-top:3px;font-family:"Consolas",monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  body.light #tip{background:rgba(255,255,255,.97);border-color:#c6d0dd}

  /* badge compteur sur un bouton header */
  header .sbtn{position:relative}
  header .sbtn .cnt{position:absolute;top:-5px;right:-5px;min-width:15px;height:15px;border-radius:8px;background:#f85149;
    color:#fff;font-size:9px;line-height:15px;text-align:center;padding:0 3px;font-weight:700}

  /* centre de notifications */
  #notif{position:absolute;top:66px;right:16px;width:320px;max-width:calc(100% - 32px);max-height:calc(100% - 90px);z-index:11;
    background:linear-gradient(180deg,#141b28,#0e131c);border:1px solid #26344c;border-radius:14px;
    box-shadow:0 18px 50px rgba(0,0,0,.6);display:none;flex-direction:column;overflow:hidden}
  #notif.open{display:flex}
  #notif h3{font-size:12px;margin:0;padding:12px 14px;border-bottom:1px solid var(--line);color:var(--dim);text-transform:uppercase;letter-spacing:1px;display:flex}
  #notif h3 .nx{margin-left:auto;cursor:pointer}
  #notif .nb{overflow:auto;padding:6px}
  #notif .ni{display:flex;gap:8px;align-items:baseline;padding:7px 9px;border-radius:8px;font-size:12px;margin:2px 0;border:1px solid #1a2434;background:#0d131d}
  #notif .ni.fail{border-left:3px solid #f85149} #notif .ni.done{border-left:3px solid #3fb950}
  #notif .ni.warn{border-left:3px solid #ffb020} #notif .ni.appr{border-left:3px solid #a371f7}
  #notif .ni .nt{color:var(--dim2,#5c6b7e);font-size:10px;flex:none;width:52px}
  #notif .ni .np{color:#bcd4ff;flex:none}
  #notif .ni .nm{color:var(--txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  body.light #notif{background:linear-gradient(180deg,#fff,#eef2f7);border-color:#c6d0dd}
  body.light #notif .ni{background:#f1f4f9;border-color:#d6dee9}

  /* team : groupes par projet */
  #team .tgrp{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);padding:6px 8px 2px;cursor:pointer;display:flex;gap:6px;align-items:center}
  #team .tgrp .tgc{color:var(--dim2,#5c6b7e)}
  #team .tgrp.col .tgi{transform:rotate(-90deg)}
  #team .tgi{transition:transform .15s;display:inline-block}

  /* approbations : cartes ancrées près du perso */
  #approve{position:absolute;inset:52px 0 0 0;z-index:13;pointer-events:none;overflow:hidden}
  #approve .apc{position:absolute;transform:translate(-50%,-100%);width:250px;pointer-events:auto;
    background:linear-gradient(180deg,#141b28,#0e131c);border:2px solid #ffb020;border-radius:12px;
    padding:10px 12px;box-shadow:0 12px 30px rgba(0,0,0,.55);animation:cardin .15s ease}
  #approve .apc::after{content:'';position:absolute;left:50%;bottom:-9px;transform:translateX(-50%);
    border:8px solid transparent;border-top-color:#ffb020}
  #approve .apc .apt{font-size:12px;color:var(--txt);margin-bottom:6px}
  #approve .apc .apt b{color:#ffe08a}
  #approve .apc .apr{font-family:"Consolas",monospace;font-size:12px;color:#e6edf3;background:#0a0f18;
    border:1px solid #26344c;border-radius:6px;padding:6px 8px;margin-bottom:9px;max-height:64px;overflow:auto;word-break:break-word}
  #approve .apc .apb{display:flex;gap:8px}
  #approve .apc .apb button{cursor:pointer;flex:1;padding:8px;border-radius:8px;font-size:13px;font-weight:600;border:1px solid}
  #approve .apc .ok{background:#0d2314;border-color:#1f7a3a;color:#3fb950}
  #approve .apc .ok:hover{background:#12401f}
  #approve .apc .no{background:#2a0f0f;border-color:#7a1f1f;color:#f85149}
  #approve .apc .no:hover{background:#401414}
  body.light #approve .apc{background:linear-gradient(180deg,#fff,#eef2f7)}
  body.light #approve .apc .apt{color:#1b2431} body.light #approve .apc .apt b{color:#8a6a00}
  body.light #approve .apc .apr{background:#f1f4f9;color:#1b2431;border-color:#c6d0dd}

  /* conversation live */
  #convo{position:absolute;top:66px;right:16px;width:380px;max-width:calc(100% - 32px);max-height:calc(100% - 90px);z-index:10;
    background:linear-gradient(180deg,#141b28,#0e131c);border:1px solid #26344c;border-radius:14px;
    box-shadow:0 18px 50px rgba(0,0,0,.6);display:none;flex-direction:column;overflow:hidden}
  #convo.open{display:flex}
  #convoHead{display:flex;align-items:center;padding:11px 14px;border-bottom:1px solid var(--line);color:var(--dim);font-size:12px}
  #convoHead #convoX{margin-left:auto;cursor:pointer;border:1px solid #26344c;border-radius:7px;width:26px;height:26px;display:grid;place-items:center}
  #convoBody{overflow:auto;padding:10px}
  #convo .msg{margin:6px 0;padding:8px 11px;border-radius:10px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
  #convo .msg.user{background:#10202e;border:1px solid #1c3242;color:#bcd4ff}
  #convo .msg.assistant{background:#0e1a12;border:1px solid #1c3a26;color:#d6f0dd}
  #convo .msg .r{font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);display:block;margin-bottom:3px}
  body.light #convo{background:linear-gradient(180deg,#fff,#eef2f7);border-color:#c6d0dd}
  body.light #convo .msg.user{background:#eaf1fb;color:#1b3a5c} body.light #convo .msg.assistant{background:#eafaef;color:#1b4a2c}

  /* command palette (Ctrl+K) */
  #palette{position:absolute;top:90px;left:50%;transform:translateX(-50%);width:min(600px,calc(100% - 32px));z-index:12;
    background:linear-gradient(180deg,#141b28,#0e131c);border:1px solid #3a4c6b;border-radius:14px;
    box-shadow:0 24px 60px rgba(0,0,0,.6);display:none;padding:14px}
  #palette.open{display:block}
  #palette input{width:100%;background:#0b1220;border:1px solid #26344c;border-radius:9px;color:var(--txt);
    font:15px "Segoe UI",sans-serif;padding:11px 13px;outline:none}
  #palette input:focus{border-color:#4c9aff}
  #palette #palHint{color:var(--dim2,#5c6b7e);font-size:11px;margin-top:8px}
  body.light #palette{background:linear-gradient(180deg,#fff,#eef2f7);border-color:#8aa0bd}
  body.light #palette input{background:#fff;color:#1b2431;border-color:#c6d0dd}

  /* bibliothèque de sessions (reprise) */
  #lib{position:absolute;top:66px;left:50%;transform:translateX(-50%);width:min(680px,calc(100% - 32px));max-height:calc(100% - 90px);z-index:11;
    background:linear-gradient(180deg,#141b28,#0e131c);border:1px solid #26344c;border-radius:14px;
    box-shadow:0 18px 50px rgba(0,0,0,.6);display:none;flex-direction:column;overflow:hidden}
  #lib.open{display:flex}
  #lib h3{font-size:12px;margin:0;padding:12px 14px;border-bottom:1px solid var(--line);color:var(--dim);text-transform:uppercase;letter-spacing:1px;display:flex}
  #lib h3 .lx{margin-left:auto;cursor:pointer}
  #lib .lb{overflow:auto;padding:8px}
  #lib .li{border:1px solid #1a2434;border-radius:10px;padding:9px 11px;margin:6px 0;background:#0d131d}
  #lib .li .lh{display:flex;align-items:center;gap:8px;font-size:13px}
  #lib .li .lp{font-weight:600;color:var(--txt)}
  #lib .li .lst{margin-left:auto;font-size:10px;color:var(--dim)}
  #lib .li .lcwd{font-family:"Consolas",monospace;font-size:11px;color:var(--dim);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #lib .li .lsum{font-size:11px;color:#9fb0c4;margin-top:3px}
  #lib .li .lact{display:flex;gap:6px;margin-top:8px}
  #lib .li .lbtn{cursor:pointer;font-size:11px;padding:5px 9px;border-radius:7px;border:1px solid #26344c;background:#0e131c;color:var(--txt)}
  #lib .li .lbtn:hover{border-color:#3a4c6b}
  #lib .li .lbtn.go{border-color:#1f7a3a;color:#3fb950}
  body.light #lib{background:linear-gradient(180deg,#fff,#eef2f7);border-color:#c6d0dd}
  body.light #lib .li{background:#f1f4f9;border-color:#d6dee9}
  body.light #lib .li .lbtn{background:#fff;border-color:#c6d0dd;color:#1b2431}
  body.light #lib .li .lbtn:hover{border-color:#8aa0bd}
  body.light #lib .li .lbtn.go{color:#1f9d4d;border-color:#a9dcbb;background:#eaf7ee}
  body.light #lib .li .lcwd{color:#5a6b7e} body.light #lib .li .lsum{color:#3a5266}

  /* radar d'anomalies */
  #radar{position:absolute;top:66px;left:50%;transform:translateX(-50%);width:min(560px,calc(100% - 32px));z-index:9;
    background:linear-gradient(180deg,#141b28,#0e131c);border:1px solid #26344c;border-radius:14px;
    box-shadow:0 18px 50px rgba(0,0,0,.55);display:none;padding:14px 16px}
  #radar.open{display:block}
  #radar h3{font-size:12px;margin:0 0 10px;color:var(--dim);text-transform:uppercase;letter-spacing:1px}
  #radar .an{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #1a2434;border-radius:9px;margin:5px 0;background:#0d131d;cursor:pointer}
  #radar .an:hover{border-color:#3a4c6b}
  #radar .an .sev{width:9px;height:9px;border-radius:50%;flex:none}
  #radar .an .sev.hi{background:#f85149} #radar .an .sev.mid{background:#ffb020}
  #radar .an .anp{font-weight:600;color:var(--txt);flex:none}
  #radar .an .anm{color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #radar .none{color:#3fb950;font-size:13px;padding:10px;text-align:center}
  body.light #radar{background:linear-gradient(180deg,#fff,#eef2f7);border-color:#c6d0dd}
  body.light #radar .an{background:#f1f4f9;border-color:#d6dee9}

  /* barre de replay */
  #replay{position:absolute;left:50%;transform:translateX(-50%);bottom:14px;z-index:11;display:none;
    align-items:center;gap:12px;background:rgba(14,19,28,.95);border:1px solid #26344c;border-radius:12px;
    padding:9px 14px;box-shadow:0 12px 34px rgba(0,0,0,.5);width:min(680px,calc(100% - 24px))}
  #replay.open{display:flex}
  #replay #rpPlay,#replay #rpExit{cursor:pointer;color:var(--txt);border:1px solid #26344c;border-radius:8px;padding:5px 10px;font-size:12px;flex:none}
  #replay #rpPlay:hover,#replay #rpExit:hover{border-color:#3a4c6b}
  #replay #rpSlider{flex:1;accent-color:#4c9aff}
  #replay #rpTime{font-family:"Consolas",monospace;font-size:12px;color:#ffe08a;flex:none;min-width:120px;text-align:center}
  body.light #replay{background:rgba(255,255,255,.95);border-color:#c6d0dd}

  /* panneau config */
  #cfg{position:absolute;top:66px;right:16px;width:320px;max-width:calc(100% - 32px);z-index:10;
    background:linear-gradient(180deg,#141b28,#0e131c);border:1px solid #26344c;border-radius:14px;
    box-shadow:0 18px 50px rgba(0,0,0,.55);display:none;padding:14px 16px}
  #cfg.open{display:block}
  #cfg h3{font-size:12px;margin:0 0 12px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;display:flex}
  #cfg h3 .cx2{margin-left:auto;cursor:pointer}
  #cfg label{display:block;font-size:11px;color:var(--dim);margin:10px 0 4px}
  #cfg input{width:100%;background:#0e131c;border:1px solid #26344c;border-radius:8px;color:var(--txt);font:13px "Segoe UI",sans-serif;padding:7px 9px;outline:none}
  #cfg .cbtn2{margin-top:10px;cursor:pointer;font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid #26344c;background:#0e131c;color:var(--txt);display:inline-block}
  #cfg .cbtn2:hover{border-color:#3a4c6b}
  body.light #cfg{background:linear-gradient(180deg,#fff,#eef2f7);border-color:#c6d0dd}
  body.light #cfg input, body.light #cfg .cbtn2{background:#fff;color:#1b2431;border-color:#c6d0dd}

  /* responsive / mobile */
  @media(max-width:640px){
    header{flex-wrap:wrap;height:auto;padding:8px 12px}
    header .stats{display:none}
    header .tools2{margin-left:0;flex-wrap:wrap}
    header input#q{width:120px}
    #stage{inset:auto 0 0 0;top:96px}
    #team,#card,#cfg{width:calc(100% - 20px);left:10px;right:10px;top:auto;bottom:10px;max-height:45%}
    #stats,#hist{width:calc(100% - 16px)}
    #log{display:none}
  }

  /* historique d'outils (pulse-lane) dans le panneau détail */
  #card .cticks{display:flex;gap:2px;flex-wrap:wrap;align-items:center}
  #card .ctk{width:5px;height:13px;border-radius:1px;background:#4c9aff;opacity:.9}
  #card .ctk.bad{background:#f85149}
  #card .val.alert{color:var(--amber)}
  #card .files{display:flex;flex-direction:column;gap:3px}
  #card .fitem{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--txt)}
  #card .fitem .fp{font-family:"Consolas",monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  #card .fitem .fn{color:var(--dim);font-size:11px}
  #card .tchips{display:flex;flex-wrap:wrap;gap:5px}
  #card .tchip{font-size:11px;color:var(--dim);background:#141b27;border:1px solid var(--line);border-radius:6px;padding:2px 7px}
  #card .tchip b{color:#4c9aff}
  body.light #card .tchip{background:#eef2f7;border-color:#d6dee9}
  #card .ctrl{display:flex;gap:6px;flex-wrap:wrap}
  #card .cbtn{cursor:pointer;font-size:11px;padding:5px 9px;border-radius:7px;border:1px solid #26344c;background:#0e131c;color:var(--txt)}
  #card .cbtn:hover{border-color:#3a4c6b}
  #card .cbtn.on{background:#231c08;border-color:#4a3a10;color:var(--amber)}
  #card .cbtn.danger:hover{border-color:#f85149;color:#f85149}

  /* panneau Équipe (vue d'ensemble agents + sous-agents) */
  #team{position:absolute;top:66px;left:14px;width:300px;max-width:calc(100% - 28px);
    z-index:7;background:linear-gradient(180deg,#141b28,#0e131c);border:1px solid #26344c;
    border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.5);display:none;overflow:hidden}
  #teamBody{max-height:calc(100vh - 230px);overflow:auto}
  #team.open{display:block}
  #teamHead{font-size:11px;padding:10px 12px;border-bottom:1px solid #1e2735;color:var(--dim);
    text-transform:uppercase;letter-spacing:1px;display:flex;align-items:center;gap:8px;cursor:move;user-select:none}
  #teamHead .tot{margin-left:auto;color:var(--txt);font-size:11px;letter-spacing:0;text-transform:none}
  #teamHead #teamCol{cursor:pointer;color:var(--dim);font-size:13px;padding:0 2px;transition:transform .15s}
  #teamHead #teamCol:hover{color:var(--txt)}
  #team.collapsed #teamBody{display:none}
  #team.collapsed #teamCol{transform:rotate(-90deg)}
  #team .tbody{padding:6px}
  #team .ts{border:1px solid #1a2434;border-radius:9px;margin:5px;padding:8px 10px;background:#0d131d}
  #team .ts .th{display:flex;align-items:center;gap:7px;font-size:12px}
  #team .ts .dot{width:8px;height:8px;border-radius:50%;flex:none}
  #team .ts .pn{font-weight:600;color:var(--txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #team .ts .stt{margin-left:auto;font-size:9px;text-transform:uppercase;letter-spacing:.5px;flex:none}
  #team .ts .stt.working{color:var(--amber)} #team .ts .stt.idle{color:var(--dim)} #team .ts .stt.done{color:var(--green)}
  #team .ts .ac{font-size:11px;color:var(--dim);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:"Consolas",monospace}
  #team .sub{display:flex;align-items:center;gap:6px;font-size:11px;color:#c9b6f0;padding:3px 0 0 10px}
  #team .sub .sa{color:var(--dim);margin-left:auto;font-size:10px;font-family:"Consolas",monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px}
  #team .row2{cursor:pointer}
  #team .row2:hover .pn{color:#9cc3ff}
  body.light #team{background:linear-gradient(180deg,#fff,#eef2f7);border-color:#c6d0dd}
  body.light #team .ts{background:#f1f4f9;border-color:#d6dee9}
  body.light #team .ts .pn{color:#1b2431}

  /* panneau de détail (clic sur un agent) */
  #card{position:absolute;top:66px;right:16px;width:320px;max-width:calc(100% - 32px);
    background:linear-gradient(180deg,#141b28,#0e131c);border:1px solid #26344c;border-radius:14px;
    box-shadow:0 18px 50px rgba(0,0,0,.6);z-index:8;display:none;overflow:hidden}
  #card.open{display:block;animation:cardin .16s ease}
  @keyframes cardin{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
  #card .ch{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid #1e2735}
  #card .cav{width:30px;height:30px;border-radius:8px;flex:none;display:grid;place-items:center;font-size:16px;
    background:#0a0f18;border:1px solid #26344c}
  #card .ct{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #card .csub{color:var(--dim);font-size:11px}
  #card .cbadge{margin-left:auto;font-size:10px;padding:3px 9px;border-radius:20px;text-transform:uppercase;letter-spacing:.5px;flex:none}
  #card .cbadge.working{color:var(--amber);background:#231c08;border:1px solid #4a3a10}
  #card .cbadge.idle{color:var(--dim);background:#141a24;border:1px solid var(--line)}
  #card .cbadge.done{color:var(--green);background:#0d2314;border:1px solid #153d21}
  #card .cx{margin-left:6px;cursor:pointer;color:var(--dim);border:1px solid #26344c;border-radius:7px;
    width:26px;height:26px;display:grid;place-items:center;flex:none}
  #card .cx:hover{color:#fff;border-color:#3a4c6b}
  #card .cbody{padding:12px 15px;display:flex;flex-direction:column;gap:12px}
  #card .row .lbl{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
  #card .row .val{font-size:13px;color:var(--txt);word-break:break-word}
  #card .row .val.mono{font-family:"Consolas",ui-monospace,monospace;font-size:12px}
  #card .row .val.task{color:#ffe08a}
  #card .team{display:flex;flex-direction:column;gap:6px}
  #card .tm{display:flex;align-items:center;gap:8px;font-size:12px;background:#0d131d;border:1px solid #1a2434;
    border-radius:8px;padding:6px 9px}
  #card .tm.row3{cursor:pointer;transition:border-color .12s}
  #card .tm.row3:hover{border-color:#3a4c6b}
  #card .tm.row3:hover .tn{color:#c9b6f0}
  #card .tm .tdot{width:7px;height:7px;border-radius:50%;background:var(--amber);flex:none}
  #card .tm .tn{color:#c9b6f0;flex:none}
  #card .tm .ta{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #card .empty2{color:var(--dim2,#5c6b7e);font-size:12px}
</style>
</head>
<body>
<header>
  <span class="dot" id="live"></span>
  <h1>🏢 agent-office</h1>
  <div class="stats">
    <span><b id="s-sessions">0</b> sessions</span>
    <span><b id="s-working">0</b> au travail</span>
    <span><b id="s-agents">0</b> agents</span>
    <span><b id="s-tools">0</b> actions</span>
  </div>
  <div class="tools2">
    <input id="q" type="text" placeholder="🔍 filtrer (projet, outil, action…)" autocomplete="off">
    <span class="sbtn on" id="teamBtn" title="Panneau Équipe">👥</span>
    <span class="sbtn" id="spotBtn" title="Projecteur : suivre l'agent actif">🎯</span>
    <span class="sbtn" id="notifBtn" title="Centre de notifications">🛎️</span>
    <span class="sbtn" id="listBtn" title="Vue liste compacte (m)">☰</span>
    <span class="sbtn" id="statsBtn" title="Statistiques (s)">📊</span>
    <span class="sbtn" id="radarBtn" title="Radar d'anomalies">📡</span>
    <span class="sbtn" id="isoBtn" title="Vue isométrique">🧊</span>
    <span class="sbtn" id="rotBtn" title="Pivoter la vue iso (r)">🔄</span>
    <span class="sbtn" id="libBtn" title="Bibliothèque de sessions / reprise">📚</span>
    <span class="sbtn" id="histBtn" title="Historique / recherche (h)">🕘</span>
    <span class="sbtn" id="replayBtn" title="Replay / remonter le temps">⏪</span>
    <span class="sbtn" id="ambBtn" title="Sons d'ambiance">🎧</span>
    <span class="sbtn" id="tvBtn" title="Plein écran / mode TV (f)">📺</span>
    <span class="sbtn" id="hookBtn" title="Alertes Slack/Discord (webhook)">🔔</span>
    <span class="sbtn" id="cfgBtn" title="Configuration">⚙️</span>
    <span class="sbtn" id="prune" title="Nettoyer les sessions inactives">🧹</span>
    <span class="sbtn" id="rep" title="Exporter un rapport Markdown">📄</span>
    <span class="sbtn" id="theme" title="Thème clair / sombre">🌓</span>
    <span class="sbtn" id="day" title="Jour / nuit">☀️</span>
    <span class="sbtn on" id="snd" title="Sons (fin d'agent + erreurs)">🔊</span>
  </div>
</header>
<div id="stage"><canvas id="cv"></canvas></div>
<div id="empty">Bureau vide.<br><br>Branche tes hooks Claude Code vers <code>POST http://localhost:4519/event</code> puis lance une session.</div>
<div id="team" class="open">
  <div id="teamHead"><span>👥 Équipe</span><span id="teamTot" class="tot"></span><span id="teamCol" title="Replier">▾</span></div>
  <div id="teamBody"></div>
</div>
<div id="list"></div>
<div id="stats"></div>
<div id="radar"></div>
<div id="lib"></div>
<div id="hist">
  <div id="histHead"><input id="histQ" type="text" placeholder="🔎 rechercher (fichier, outil, texte…)" autocomplete="off"><span id="histTitle"></span><span id="histX" title="Fermer">✕</span></div>
  <div id="histBody"></div>
</div>
<div id="cfg">
  <h3>⚙️ Configuration <span class="cx2" id="cfgX">✕</span></h3>
  <label>Webhook (Slack / Discord / Teams)</label>
  <input id="cfgHook" type="text" placeholder="https://hooks.slack.com/… (vide = off)" autocomplete="off">
  <span class="cbtn2" id="cfgHookSave">Enregistrer le webhook</span>
  <label>Alerte durée de session (minutes, 0 = off)</label>
  <input id="cfgDur" type="number" min="0" step="1">
  <span class="cbtn2" id="cfgDurSave">Enregistrer le seuil</span>
  <label>Règles d'alerte (webhook)</label>
  <div id="cfgRules"></div>
  <div style="display:flex;gap:6px;margin-top:6px">
    <input id="ruleProj" type="text" placeholder="projet (vide=tous)" style="flex:1">
    <input id="ruleN" type="number" min="1" value="3" style="width:60px">
    <span class="cbtn2" id="ruleAddErr">+ erreurs</span>
  </div>
  <div style="display:flex;gap:6px;margin-top:6px">
    <input id="ruleFile" type="text" placeholder="fichier contient…" style="flex:1">
    <span class="cbtn2" id="ruleAddFile">+ fichier</span>
  </div>
  <label>Notifications Discord — quoi envoyer</label>
  <div id="ncEvents" style="display:flex;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--dim)"></div>
  <label>Heures silencieuses (de / à, 0–23 · égal = off)</label>
  <div style="display:flex;gap:6px;align-items:center">
    <input id="ncFrom" type="number" min="0" max="23" style="width:60px"> <span style="color:var(--dim)">→</span>
    <input id="ncTo" type="number" min="0" max="23" style="width:60px">
    <label style="margin:0 0 0 auto;display:flex;align-items:center;gap:5px;color:var(--dim)"><input id="ncDigest" type="checkbox"> digest 20h</label>
  </div>
  <label>Ping rôle Discord sur erreur (ID de rôle)</label>
  <input id="ncRole" type="text" placeholder="ex: 123456789012345678">
  <label>Webhook par projet (projet → url)</label>
  <div id="ncHooks"></div>
  <div style="display:flex;gap:6px;margin-top:6px">
    <input id="ncProj" type="text" placeholder="projet" style="width:90px">
    <input id="ncUrl" type="text" placeholder="url webhook" style="flex:1">
    <span class="cbtn2" id="ncAddHook">+</span>
  </div>
  <span class="cbtn2" id="ncSave" style="margin-top:10px">💾 Enregistrer les notifs</span>
</div>
<div id="log"></div>
<div id="replay">
  <span id="rpPlay" title="Lecture/pause">▶</span>
  <input id="rpSlider" type="range" min="0" max="1000" value="1000">
  <span id="rpTime">—</span>
  <span id="rpExit" title="Quitter le replay">✕ live</span>
</div>
<div id="nav">🖱️ molette : zoom · glisser : déplacer · double-clic : focus · <b>z</b> : recentrer</div>
<div id="tip"></div>
<div id="notif"></div>
<div id="approve"></div>
<div id="convo">
  <div id="convoHead"><span id="convoTitle">💬 Conversation</span><span id="convoX" title="Fermer">✕</span></div>
  <div id="convoBody"></div>
</div>
<div id="palette">
  <input id="palInput" type="text" autocomplete="off" placeholder="⌘ pause <projet> · focus <projet> · search <texte> · night/day · light/dark · tv/stats/team/list/radar/replay/iso · clear">
  <div id="palHint">Entrée pour exécuter · Échap pour fermer</div>
</div>
<div id="card"></div>

<script>
(function(){
'use strict';

var cv = document.getElementById('cv');
var ctx = cv.getContext('2d');
var live = document.getElementById('live');
var emptyEl = document.getElementById('empty');

// ── grille du bureau ────────────────────────────────────────────────────────
var GW = 24, GH = 14;
var TILE = 32, OX = 0, OY = 0, DPR = 1, STW = 0, STH = 0;

var WALL = {}, BLOCK = {}, CHAIRS = {};
var desks = [], decos = [], walkCells = [];
var AMENITIES = [], BED = null;   // coins détente (café/sport/canapé/eau) + lit
var MEETING = null;               // salle de réunion (workflows multi-agents)
function key(c, r){ return c + ',' + r; }

function buildLayout(){
  WALL = {}; BLOCK = {}; CHAIRS = {}; desks = []; decos = []; walkCells = [];
  var c, r;
  for(c = 0; c < GW; c++){ WALL[key(c,0)] = 1; WALL[key(c,GH-1)] = 1; }
  for(r = 0; r < GH; r++){ WALL[key(0,r)] = 1; WALL[key(GW-1,r)] = 1; }
  var doorC = Math.floor(GW/2);
  delete WALL[key(doorC, GH-1)];            // porte en bas au centre

  var rows = [2,5,8], cols = [3,6,9,12,15,18];
  for(var i=0;i<rows.length;i++) for(var j=0;j<cols.length;j++){
    var dc = cols[j], dr = rows[i];
    desks.push({ c:dc, r:dr, chair:{ c:dc, r:dr+1 } });
    BLOCK[key(dc,dr)] = 1;
    CHAIRS[key(dc,dr+1)] = 1;
  }
  decos.push({ t:'plant',  c:1,    r:1 });
  decos.push({ t:'plant',  c:1,    r:GH-2 });
  decos.push({ t:'shelf',  c:20,   r:2 });
  decos.push({ t:'shelf',  c:21,   r:2 });
  // coin détente (colonne de droite + bas-gauche)
  decos.push({ t:'coffee', c:22, r:7 });
  decos.push({ t:'gym',    c:22, r:9 });
  decos.push({ t:'bed',    c:22, r:11 });
  decos.push({ t:'couch',  c:20, r:11 });
  decos.push({ t:'water',  c:1,  r:6 });
  for(var d=0; d<decos.length; d++) BLOCK[key(decos[d].c, decos[d].r)] = 1;

  // équipements utilisables : emplacement où l'agent se tient pour "l'utiliser"
  AMENITIES = [
    { type:'coffee', emoji:'☕', spot:{c:21, r:7} },
    { type:'gym',    emoji:'🏃', spot:{c:21, r:9} },
    { type:'couch',  emoji:'😌', spot:{c:20, r:10} },
    { type:'water',  emoji:'💧', spot:{c:2,  r:6} }
  ];
  BED = { type:'bed', emoji:'💤', spot:{c:21, r:11} };

  // salle de réunion (bas-gauche) : table + 6 sièges autour
  decos.push({ t:'table', c:8,  r:11 });
  decos.push({ t:'table', c:9,  r:11 });
  BLOCK[key(8,11)] = 1; BLOCK[key(9,11)] = 1;
  MEETING = { cx:8.5, cy:11.3 };

  // positions de bureaux personnalisées (éditeur, persistées)
  var saved = loadDesks();
  if(saved && saved.length === desks.length){
    for(var si=0; si<desks.length; si++){
      delete BLOCK[key(desks[si].c, desks[si].r)];
      delete CHAIRS[key(desks[si].chair.c, desks[si].chair.r)];
      desks[si].c = saved[si].c; desks[si].r = saved[si].r;
      desks[si].chair = { c:saved[si].c, r:saved[si].r+1 };
      BLOCK[key(desks[si].c, desks[si].r)] = 1;
      CHAIRS[key(desks[si].chair.c, desks[si].chair.r)] = 1;
    }
  }

  for(c=1;c<GW-1;c++) for(r=1;r<GH-1;r++){
    if(!WALL[key(c,r)] && !BLOCK[key(c,r)] && !CHAIRS[key(c,r)]) walkCells.push({c:c,r:r});
  }
}
function loadDesks(){ try{ return JSON.parse(localStorage.getItem('agentOfficeDesks')||'null'); }catch(e){ return null; } }
function saveDesks(){ try{ localStorage.setItem('agentOfficeDesks', JSON.stringify(desks.map(function(d){ return {c:d.c,r:d.r}; }))); }catch(e){} }
function cellAt(mx,my){ return toTile(mx,my); }
function deskAt(mx,my){ var p = cellAt(mx,my); for(var i=0;i<desks.length;i++) if(desks[i].c===p.c && desks[i].r===p.r) return i; return -1; }
function deskFree(c,r,except){
  if(c<1 || r<1 || c>=GW-1 || r>=GH-2) return false;               // garder la place de la chaise (r+1)
  if(WALL[key(c,r)] || WALL[key(c,r+1)]) return false;
  for(var i=0;i<desks.length;i++){ if(i===except) continue;
    if(desks[i].c===c && desks[i].r===r) return false;
    if(desks[i].chair.c===c && desks[i].chair.r===r) return false; }
  for(var d=0;d<decos.length;d++){ if(decos[d].c===c && decos[d].r===r) return false; }
  return true;
}
function moveDesk(idx,c,r){
  var d = desks[idx];
  delete BLOCK[key(d.c,d.r)]; delete CHAIRS[key(d.chair.c,d.chair.r)];
  d.c = c; d.r = r; d.chair = { c:c, r:r+1 };
  BLOCK[key(c,r)] = 1; CHAIRS[key(c,r+1)] = 1;
  saveDesks();
  if(lastData) applyState(lastData);   // rafraîchit aussitôt le poste des agents concernés
}
function pickAmenity(k){
  var h = 0; for(var i=0;i<k.length;i++) h = (h*31 + k.charCodeAt(i)) >>> 0;
  return AMENITIES[h % AMENITIES.length];
}
// place N sous-agents en cercle (ellipse) autour de la table ; idx<0 = le chef (centre-haut)
function meetingSeat(idx, total){
  if(idx < 0) return { c: MEETING.cx, r: MEETING.cy };   // le chef AU CENTRE
  var n = Math.max(total, 1);
  var ang = -Math.PI/2 + (idx / n) * Math.PI*2;
  var rx = Math.min(6.5, 2.4 + n*0.22), ry = Math.min(1.9, 1.2 + n*0.07);   // rayon min → jamais au centre
  return { c: MEETING.cx + Math.cos(ang)*rx, r: MEETING.cy + Math.sin(ang)*ry };
}
function blocked(c,r){ if(c<1||r<1||c>=GW-1||r>=GH) return true; return !!WALL[key(c,r)] || !!BLOCK[key(c,r)]; }
function door(){ return { c: Math.floor(GW/2), r: GH-1 }; }

// ── pathfinding BFS ──────────────────────────────────────────────────────────
function bfs(from, to){
  if(from.c===to.c && from.r===to.r) return [];
  var start = key(from.c,from.r), goal = key(to.c,to.r);
  var q = [from], seen = {}, prev = {};
  seen[start] = 1;
  var dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  while(q.length){
    var cur = q.shift();
    if(cur.c===to.c && cur.r===to.r){
      var path = [], k = key(cur.c,cur.r);
      while(k !== start){ var p = k.split(','); path.unshift({c:+p[0], r:+p[1]}); k = prev[k]; }
      return path;
    }
    for(var i=0;i<4;i++){
      var nc = cur.c+dirs[i][0], nr = cur.r+dirs[i][1], nk = key(nc,nr);
      if(seen[nk]) continue;
      var isGoal = (nc===to.c && nr===to.r);
      // on peut traverser les cases marchables + la case cible (chaise/porte)
      if(blocked(nc,nr) && !isGoal) continue;
      seen[nk] = 1; prev[nk] = key(cur.c,cur.r); q.push({c:nc,r:nr});
    }
  }
  return [];
}

// ── palettes de personnages ──────────────────────────────────────────────────
var PALS = [
  { sk:'#e8b58f', ha:'#3a2a1a', sh:'#4c9aff' },
  { sk:'#f0c8a0', ha:'#141414', sh:'#3fb950' },
  { sk:'#d89a6a', ha:'#5a3a20', sh:'#a371f7' },
  { sk:'#f2d0b0', ha:'#c04a2a', sh:'#ffb020' },
  { sk:'#c88a5a', ha:'#20242c', sh:'#f85149' },
  { sk:'#e8c0a0', ha:'#6a4a2a', sh:'#22b8c0' }
];
function palOf(str){
  var h = 0, s = String(str||'');
  for(var i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0;
  return PALS[h % PALS.length];
}

// ── outils → icône / pose ─────────────────────────────────────────────────────
function toolIcon(t){
  if(!t) return '⚙️';
  var k = String(t).toLowerCase();
  if(k.indexOf('read')>=0) return '📖';
  if(k.indexOf('edit')>=0) return '✏️';
  if(k.indexOf('write')>=0||k.indexOf('notebook')>=0) return '📝';
  if(k.indexOf('bash')>=0||k.indexOf('powershell')>=0||k.indexOf('shell')>=0) return '💻';
  if(k.indexOf('grep')>=0) return '🔍';
  if(k.indexOf('glob')>=0||k.indexOf('ls')>=0) return '📁';
  if(k.indexOf('task')>=0||k.indexOf('agent')>=0) return '🤖';
  if(k.indexOf('webfetch')>=0||k.indexOf('fetch')>=0) return '🌐';
  if(k.indexOf('websearch')>=0||k.indexOf('search')>=0) return '🔎';
  if(k.indexOf('todo')>=0) return '✅';
  if(k.indexOf('workflow')>=0) return '🧩';
  if(k.indexOf('mcp')>=0||k.indexOf('__')>=0) return '🔌';
  return '⚙️';
}
function poseFor(tool){
  if(!tool) return 'think';
  var k = String(tool).toLowerCase();
  if(k.indexOf('read')>=0||k.indexOf('grep')>=0||k.indexOf('glob')>=0||k.indexOf('search')>=0||k.indexOf('fetch')>=0) return 'reading';
  return 'typing';
}

// rôle d'un sous-agent → icône + couleur (reconnaissance immédiate)
function roleInfo(type){
  var t = String(type||'').toLowerCase();
  if(t.indexOf('explore')>=0)  return { icon:'🔭', pal:{sk:'#e8b58f',ha:'#233a5c',sh:'#4c9aff'} };
  if(t.indexOf('plan')>=0)     return { icon:'🗺️', pal:{sk:'#f0c8a0',ha:'#3a2452',sh:'#a371f7'} };
  if(t.indexOf('review')>=0)   return { icon:'🔍', pal:{sk:'#d89a6a',ha:'#4a3316',sh:'#ffb020'} };
  if(t.indexOf('security')>=0) return { icon:'🛡️', pal:{sk:'#c88a5a',ha:'#20242c',sh:'#f85149'} };
  if(t.indexOf('test')>=0)     return { icon:'🧪', pal:{sk:'#f2d0b0',ha:'#1e4a30',sh:'#3fb950'} };
  if(t.indexOf('doc')>=0)      return { icon:'📚', pal:{sk:'#e8c0a0',ha:'#5a3a20',sh:'#e0803a'} };
  if(t.indexOf('debug')>=0||t.indexOf('fix')>=0) return { icon:'🐛', pal:{sk:'#d8a878',ha:'#333',sh:'#e05a7a'} };
  if(t.indexOf('general')>=0)  return { icon:'🤖', pal:{sk:'#e8c0a0',ha:'#2a2a2a',sh:'#22b8c0'} };
  return { icon:'🤝', pal:palOf(type||'agent') };
}

// ── entités (un worker par agent) ─────────────────────────────────────────────
var workers = {};   // key -> worker
var deskFor = {};   // sessionId -> deskIndex
var nextDesk = 0;
var retired = {};              // sessions terminées déjà parties (ne pas recréer)
var meetingName = '';          // nom du projet actuellement en salle de réunion
var REST_SECONDS = 18;         // temps de sommeil avant de quitter le bureau
function clockNow(){ return performance.now()*0.001; }
function durShort(ms){
  var s = Math.floor(ms/1000); if(s<60) return s+'s';
  var m = Math.floor(s/60); if(m<60) return m+'m';
  return Math.floor(m/60)+'h'+(m%60)+'m';
}

// ── filtre projet ─────────────────────────────────────────────────────────────
var filter = '';
var pinnedKey = null;   // focus : n'affiche que cette session
var durAlertMin = 0;    // alerte si session > X min (0 = off)
try{ durAlertMin = parseInt(localStorage.getItem('agentOfficeDurAlert')) || 0; }catch(e){}
var iso3d = false;      // vue isométrique — TOUJOURS 2D au chargement (pas de restauration auto)
var spotlight = false;  // projecteur : la caméra suit l'agent actif — off au chargement
function matchFilter(w){
  if(pinnedKey && workers[pinnedKey] && w.sid !== workers[pinnedKey].sid) return false;
  if(!filter) return true;
  var hay = ((w.name||'') + ' ' + (w.type||'') + ' ' + (w.tool||'') + ' ' + (w.action||'')).toLowerCase();
  return hay.indexOf(filter) >= 0;
}

// détecte les situations à surveiller (boucle, échecs en série, attente longue, inactivité)
function computeAlert(w){
  w.alert = false; w.alertMsg = '';
  var tk = w.ticks || [], i;
  if(tk.length >= 4){                       // même outil répété → boucle probable
    var last = tk[tk.length-1].tool, same = 0;
    for(i=tk.length-1; i>=0 && last && tk[i].tool===last; i--) same++;
    if(same >= 4){ w.alert = true; w.alertMsg = 'boucle ? ' + same + '× ' + last; }
  }
  if(!w.alert && tk.length >= 2){           // échecs consécutifs
    var f = 0; for(i=tk.length-1; i>=0 && !tk[i].ok; i--) f++;
    if(f >= 2){ w.alert = true; w.alertMsg = f + ' échecs de suite'; }
  }
  if(!w.alert && w.waiting && w.waitSince && (clockNow()-w.waitSince) > 120){
    w.alert = true; w.alertMsg = 'en attente depuis ' + durShort((clockNow()-w.waitSince)*1000);
  }
  if(!w.alert && w.stale){ w.alert = true; w.alertMsg = 'aucune activité depuis un moment'; }
  if(!w.alert && durAlertMin > 0 && w.isMain && w.sessStatus==='working' && w.startedAt && (Date.now()-w.startedAt) > durAlertMin*60000){
    w.alert = true; w.alertMsg = 'tourne depuis ' + durShort(Date.now()-w.startedAt) + ' (> ' + durAlertMin + ' min)';
  }
}

// ── thème clair / sombre (palette du canvas) ──────────────────────────────────
var themeLight = false;
function TH(){
  return themeLight
    ? { floorA:'#dde6f1', floorB:'#e8eef6', wall:'#b7c4d5', wallHi:'#cdd8e6', wallLo:'#9fafc2', mat:'#d3c6ea' }
    : { floorA:'#1b2a3c', floorB:'#1f3044', wall:'#2b3a4d', wallHi:'#374a61', wallLo:'#1f2a38', mat:'#3a2f4a' };
}

// ── jour / nuit ───────────────────────────────────────────────────────────────
var nightState = 'day';  // 'day' par défaut (plus d'auto-nuit) · 'auto' | 'night' via le bouton 🌗
function isNight(){
  if(nightState==='night') return true;
  if(nightState==='day') return false;
  var h = new Date().getHours();
  return h < 7 || h >= 19;
}
function drawNight(t){
  if(!isNight()) return;
  ctx.save();
  ctx.fillStyle = 'rgba(10,14,45,.5)';           // voile bleu nuit
  ctx.fillRect(0, 0, STW, STH);
  ctx.globalCompositeOperation = 'lighter';       // halos de lampes de bureau
  for(var wk in workers){
    var w = workers[wk];
    if(!(w.isMain && w.mode==='work' && w.deskChair)) continue;
    var lx = OX + (w.deskChair.c+0.5)*TILE, ly = OY + (w.deskChair.r-0.5)*TILE;
    var g = ctx.createRadialGradient(lx, ly, 2, lx, ly, TILE*1.6);
    g.addColorStop(0, 'rgba(255,200,120,.5)');
    g.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(lx, ly, TILE*1.6, 0, 7); ctx.fill();
  }
  ctx.restore();
}

// ── sons (mutables, off par défaut) ───────────────────────────────────────────
var soundOn = true, ambientOn = false, actx = null, lastSoundTs = 0;  // son ON, ambiance OFF par défaut
function ensureAudio(){
  if(!actx){ try{ actx = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){} }
  if(actx && actx.state === 'suspended') actx.resume();
}
function beep(type, freq, dur, vol, delay){
  if(!actx) return;
  var t0 = actx.currentTime + (delay || 0);
  var o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.value = freq;
  o.connect(g); g.connect(actx.destination);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.start(t0); o.stop(t0 + dur);
}
function chimeDone(){   // carillon doux ascendant : "l'agent a terminé"
  beep('sine', 523, 0.12, 0.06, 0);       // C5
  beep('sine', 784, 0.20, 0.06, 0.11);    // G5
}
function buzzError(){   // buzz grave distinct : erreur
  beep('square', 160, 0.28, 0.06, 0);
  beep('square', 120, 0.30, 0.05, 0.06);
}
function softClick(){   // cliquetis de clavier discret (ambiance)
  beep('triangle', 1400, 0.02, 0.012, 0);
}
function dingDong(){ beep('sine', 880, 0.12, 0.06, 0); beep('sine', 660, 0.16, 0.06, 0.12); }  // approbation
var lastApprovalCount = 0;
function playSounds(state){
  var f = state.feed || [];
  if((soundOn || ambientOn) && actx){
    for(var i=f.length-1; i>=0; i--){          // feed = plus récent en tête → du plus ancien au plus récent
      var e = f[i];
      if(e.ts <= lastSoundTs) continue;
      if(soundOn && e.kind==='PostToolUseFailure') buzzError();
      else if(soundOn && (e.kind==='Stop' || e.kind==='SessionEnd')) chimeDone();
      if(ambientOn && e.kind==='PostToolUse') softClick();   // cliquetis quand ça tape
    }
  }
  if(f.length) lastSoundTs = Math.max(lastSoundTs, f[0].ts);
  var apn = (state.approvals||[]).length;   // son distinct quand une approbation apparaît
  if(soundOn && actx && apn > lastApprovalCount) dingDong();
  lastApprovalCount = apn;
}
function deskIndexFor(sid){
  if(deskFor[sid] == null){ deskFor[sid] = nextDesk % desks.length; nextDesk++; }
  return deskFor[sid];
}
var SUB_OFFSETS = [
  {dc:-1,dr:0}, {dc:1,dr:0}, {dc:0,dr:1}, {dc:-1,dr:1}, {dc:1,dr:1},
  {dc:-2,dr:0}, {dc:2,dr:0}, {dc:0,dr:2}, {dc:-2,dr:1}, {dc:2,dr:1},
  {dc:-1,dr:2}, {dc:1,dr:2}, {dc:-2,dr:2}, {dc:2,dr:2}, {dc:-1,dr:-1}, {dc:1,dr:-1}
];
function subSpot(deskIdx, subIdx){
  var chair = desks[deskIdx].chair;
  var o = SUB_OFFSETS[subIdx % SUB_OFFSETS.length];   // offset DISTINCT par index → pas de chevauchement
  return { c: chair.c + o.dc, r: chair.r + o.dr };
}

function makeWorker(k, pal, name, isMain){
  var dr = door();
  var ci = k.lastIndexOf(':');
  return {
    key:k, sid:k.slice(0,ci), aid:k.slice(ci+1),
    pal:pal, name:name, isMain:isMain, type:'',
    fc:dr.c, fr:dr.r, cell:{c:dr.c, r:dr.r},
    path:[], mode:'work', home:{c:dr.c,r:dr.r},
    tool:null, action:'', task:'', sessStatus:'working', agentStatus:'working',
    facing:'up', moving:false, pose:'walk', amenity:null, deskChair:null,
    errSeen:0, errUntil:0, errTool:'', actions:0, startedAt:0, restSince:null,
    energy:100, teleUntil:0, waiting:false, roleIcon:'🤝', stale:false, ticks:[],
    fails:0, paused:false, blockedTools:[], waitSince:0, alert:false, alertMsg:'',
    rainUntil:performance.now()*0.001 + 1.4,   // pluie "Matrix" à l'arrivée
    spawn:performance.now()*0.001, dead:false
  };
}

// déclenche une bulle d'erreur (~3.5s) quand un nouvel échec d'outil arrive
function noteErr(w, ag){
  if(ag && ag.lastErrorAt && ag.lastErrorAt !== w.errSeen){
    w.errSeen = ag.lastErrorAt;
    w.errUntil = performance.now()*0.001 + 3.5;
    w.errTool = ag.lastErrorTool || '';
  }
}

// ── mini-log d'activité (bas-gauche) ──────────────────────────────────────────
var logEl = document.getElementById('log');
var _logHtml = '';
function fmtT(ts){ var d = new Date(ts); function p(n){ return (n<10?'0':'')+n; } return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
function updateLog(state){
  var f = state.feed || [], items = [];
  // si un agent est sélectionné → on filtre le log sur SA session
  var selSid = (typeof selectedKey!=='undefined' && selectedKey && workers[selectedKey]) ? workers[selectedKey].sid : null;
  for(var i=0; i<f.length && items.length<8; i++){
    var e = f[i];
    if(e.kind==='PreToolUse') continue;   // on garde le Post (évite les doublons)
    if(selSid && e.session !== selSid) continue;
    var cls = e.kind==='PostToolUseFailure' ? 'fail'
            : ((e.kind==='Stop'||e.kind==='SessionEnd'||e.kind==='SubagentStop') ? 'done' : '');
    var what = e.detail || e.kind;
    items.push('<div class="lg '+cls+'"><span class="lt">'+fmtT(e.ts)+'</span> '
      + '<span class="lp">'+esc(e.project||'')+'</span> <span class="la">'+esc(what)+'</span></div>');
  }
  var html = items.join('');
  if(html !== _logHtml){ _logHtml = html; logEl.innerHTML = html; }
}

// ── panneau Équipe : vue d'ensemble sessions → agents → sous-agents ───────────
var teamEl = document.getElementById('team');
var teamBodyEl = document.getElementById('teamBody');
var teamTotEl = document.getElementById('teamTot');
var _teamHtml = '';
var collapsedProj = {};
function sessionRow(s){
  var col = palOf(s.project||s.id).sh, main = s.agents && s.agents.main;
  var act = (main && main.currentTool) ? (toolIcon(main.currentTool)+' '+main.currentTool+(main.lastAction?' — '+main.lastAction:''))
          : (main && main.lastAction ? main.lastAction : (s.lastPrompt||'…'));
  var subs = '', subCount = 0, ags = s.agents || {};
  for(var aid in ags){ if(aid==='main') continue; var a = ags[aid]; if(a.status==='done') continue; subCount++;
    var ri = roleInfo(a.type), life = a.startedAt ? durShort(Date.now()-a.startedAt) : '';
    var sact = a.currentTool ? (toolIcon(a.currentTool)+' '+a.currentTool) : (a.lastAction||'en renfort');
    subs += '<div class="sub">'+ri.icon+' '+esc(a.type||'agent')+'<span class="sa">'+esc(sact)+' · '+life+'</span></div>';
  }
  return { subCount:subCount, html:'<div class="ts"><div class="th row2" data-sid="'+esc(s.id)+'">'
    + '<span class="dot" style="background:'+col+'"></span>'
    + '<span class="pn">'+esc(s.project||'session')+'</span>'
    + (subCount?'<span style="color:#8b98a9;font-size:10px">+'+subCount+'</span>':'')
    + (s.host&&s.host!=='local'?'<span style="color:#8b98a9;font-size:9px">🖥️'+esc(s.host)+'</span>':'')
    + '<span class="stt '+s.status+'">'+esc(s.status)+'</span></div>'
    + '<div class="ac">'+esc(act)+'</div>' + subs + '</div>' };
}
function updateTeam(state){
  var S = (state.sessions || []).slice().sort(function(a,b){ return a.startedAt - b.startedAt; });
  // regroupe par projet
  var groups = {}, order = [];
  for(var i=0;i<S.length;i++){ var p = S[i].project||'?'; if(!groups[p]){ groups[p]=[]; order.push(p); } groups[p].push(S[i]); }
  var rows = '', totAgents = 0;
  for(var g=0; g<order.length; g++){
    var p = order[g], list = groups[p], col = palOf(p).sh, gAgents = 0, body = '';
    for(var j=0;j<list.length;j++){ var r = sessionRow(list[j]); gAgents += 1 + r.subCount; body += r.html; }
    totAgents += gAgents;
    var isCol = !!collapsedProj[p];
    rows += '<div class="tgrp'+(isCol?' col':'')+'" data-proj="'+esc(p)+'"><span class="tgi">▾</span>'
      + '<span class="dot" style="background:'+col+';width:8px;height:8px;border-radius:50%"></span> '+esc(p)
      + '<span class="tgc">'+list.length+'</span></div>';
    if(!isCol) rows += body;
  }
  if(!rows) rows = '<div style="padding:14px;color:#5c6b7e;font-size:12px">Aucune session.</div>';
  var html = '<div class="tbody">'+rows+'</div>';
  if(html !== _teamHtml){ _teamHtml = html; teamBodyEl.innerHTML = html; }
  teamTotEl.textContent = S.length + ' sess · ' + totAgents + ' agents';
}

// ── notifications navigateur (agent en attente) ───────────────────────────────
var notifiedWait = {};
function notify(msg){ try{ if(window.Notification && Notification.permission==='granted') new Notification('agent-office', { body: msg }); }catch(e){} }
function checkNotifs(){
  for(var wk in workers){
    var w = workers[wk];
    if(w.waiting){ if(!notifiedWait[wk]){ notifiedWait[wk] = 1; notify(w.name + ' attend une action'); } }
    else notifiedWait[wk] = 0;
  }
}

// ── bibliothèque de sessions (reprise / mémoire locale) ──────────────────────
var libEl = document.getElementById('lib'), _libHtml = '';
function updateLib(state){
  if(!libEl.classList.contains('open')) return;
  var seen = {}, list = [];
  (state.sessions||[]).forEach(function(s){ seen[s.id]=1; list.push({ id:s.id, project:s.project, cwd:s.cwd||'', when:s.startedAt, status:s.status, summary:s.summary||'', prompt:s.lastPrompt||'' }); });
  (state.archive||[]).forEach(function(a){ if(!seen[a.id]) list.push({ id:a.id, project:a.project, cwd:a.cwd||'', when:a.endedAt||a.startedAt, status:'archivée', summary:a.summary||'', prompt:a.prompt||'' }); });
  list.sort(function(a,b){ return (b.when||0)-(a.when||0); });
  var rows = list.map(function(s){
    return '<div class="li"><div class="lh"><span class="dot" style="width:8px;height:8px;border-radius:50%;background:'+palOf(s.project||s.id).sh+'"></span>'
      + '<span class="lp">'+esc(s.project||'session')+'</span><span class="lst">'+esc(s.status)+' · '+(s.when?fmtT(s.when):'')+'</span></div>'
      + (s.cwd?'<div class="lcwd">'+esc(s.cwd)+'</div>':'')
      + (s.prompt||s.summary?'<div class="lsum">'+esc(s.prompt||s.summary)+'</div>':'')
      + '<div class="lact"><span class="lbtn go" data-resume="'+esc(s.id)+'" data-cwd="'+esc(s.cwd)+'">⤴ Reprendre</span>'
      + '<span class="lbtn" data-lhist="'+esc(s.id)+'" data-lname="'+esc(s.project)+'">🕘 Historique</span></div></div>';
  }).join('') || '<div style="padding:16px;color:#5c6b7e">Aucune session mémorisée.</div>';
  var html = '<h3>📚 Sessions <span class="lx">✕</span></h3><div class="lb">'+rows+'</div>';
  if(html!==_libHtml){ _libHtml=html; libEl.innerHTML=html; }
}
document.getElementById('libBtn').addEventListener('click', function(){ var on=libEl.classList.toggle('open'); this.classList.toggle('on',on); if(on&&lastData){ _libHtml=''; updateLib(lastData); } });
libEl.addEventListener('click', function(e){
  if(e.target.closest('.lx')){ libEl.classList.remove('open'); document.getElementById('libBtn').classList.remove('on'); return; }
  var g = e.target.closest('[data-resume]');
  if(g){ var id=g.getAttribute('data-resume'), cwd=g.getAttribute('data-cwd');
    var cmd = (cwd? 'cd "'+cwd+'" ; ' : '') + 'claude --resume ' + id;
    try{ navigator.clipboard.writeText(cmd); }catch(x){}
    var old=g.textContent; g.textContent='✓ commande copiée'; setTimeout(function(){ g.textContent=old; }, 1600);
    return;
  }
  var h = e.target.closest('[data-lhist]');
  if(h){ openHist(h.getAttribute('data-lhist'), h.getAttribute('data-lname')); }
});

// ── vue liste compacte ────────────────────────────────────────────────────────
var listEl = document.getElementById('list');
var _listHtml = '';
function updateList(state){
  if(!listEl.classList.contains('open')) return;
  var S = (state.sessions||[]).slice().sort(function(a,b){ return a.startedAt - b.startedAt; });
  var rows = S.map(function(s){
    var col = palOf(s.project||s.id).sh, main = s.agents && s.agents.main;
    var act = (main&&main.currentTool) ? (toolIcon(main.currentTool)+' '+main.currentTool+(main.lastAction?' — '+main.lastAction:''))
            : (main&&main.lastAction ? main.lastAction : (s.lastPrompt||'—'));
    var subN = 0, ags = s.agents||{}; for(var a in ags){ if(a!=='main' && ags[a].status!=='done') subN++; }
    var w = workers[s.id+':main'], al = (w&&w.alert) ? ('⚠ '+esc(w.alertMsg)) : '';
    return '<tr class="row2" data-sid="'+esc(s.id)+'"><td><span class="dot" style="background:'+col+'"></span>'+esc(s.project||'session')+(subN?' +'+subN:'')+'</td>'
      + '<td><span class="st '+s.status+'">'+esc(s.status)+'</span></td>'
      + '<td class="mono">'+esc(act)+'</td><td class="al">'+al+'</td>'
      + '<td>'+durShort(Date.now()-(s.startedAt||Date.now()))+'</td></tr>';
  }).join('');
  var html = '<table><thead><tr><th>Projet</th><th>Statut</th><th>Action</th><th>Alerte</th><th>Durée</th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="5" style="color:#5c6b7e">Aucune session.</td></tr>') + '</tbody></table>';
  if(html !== _listHtml){ _listHtml = html; listEl.innerHTML = html; }
}

// ── statistiques persistantes (uptime + histogramme horaire) ──────────────────
var statsEl = document.getElementById('stats');
function fmtDur(ms){
  var m = Math.floor(ms/60000); if(m < 60) return m + ' min';
  var h = Math.floor(m/60); if(h < 24) return h + 'h' + String(m%60).padStart(2,'0');
  return Math.floor(h/24) + 'j ' + (h%24) + 'h';
}
function updateStats(state){
  if(!statsEl.classList.contains('open')) return;
  var st = state.stats; if(!st) return;
  var series = st.hourly || [], max = 1;
  series.forEach(function(x){ if(x.a > max) max = x.a; });
  var bars = series.map(function(x){
    var ha = Math.round(x.a/max*100), he = x.a ? Math.round(x.e/x.a*ha) : 0;
    return '<div class="bar" style="height:'+Math.max(2,ha)+'%" title="'+x.h+' — '+x.a+' actions, '+x.e+' erreurs"><div class="e" style="height:'+he+'%"></div></div>';
  }).join('');
  var lbls = series.map(function(x,i){ return '<span>'+((i%3===0)?x.h:'')+'</span>'; }).join('');

  // classement projets (aujourd'hui) : actions / erreurs / durée
  var S = state.sessions || [], byProj = {};
  S.forEach(function(s){
    var p = byProj[s.project] || (byProj[s.project] = { a:0, e:0, dur:0 });
    var tc = s.toolCounts||{}; for(var k in tc) p.a += tc[k];
    var tf = s.toolFails||{}; for(var k2 in tf) p.e += tf[k2];
    p.dur += Math.max(0, (s.endedAt||st.now) - s.startedAt);
  });
  var rank = Object.keys(byProj).map(function(p){ return { p:p, a:byProj[p].a, e:byProj[p].e, dur:byProj[p].dur }; })
    .sort(function(a,b){ return b.a - a.a; }).slice(0,8);
  var rankRows = rank.map(function(r){ return '<tr><td>'+esc(r.p)+'</td><td>'+r.a+'</td><td style="color:#f85149">'+r.e+'</td><td>'+fmtDur(r.dur)+'</td></tr>'; }).join('')
    || '<tr><td colspan="4" style="color:#5c6b7e">—</td></tr>';

  // gantt global : barres par session (fenêtre = du plus ancien départ à maintenant)
  var sorted = S.slice().sort(function(a,b){ return a.startedAt - b.startedAt; }).slice(0,14);
  var minT = sorted.length ? sorted[0].startedAt : st.now, span = Math.max(60000, st.now - minT);
  var gantt = sorted.map(function(s){
    var x0 = (s.startedAt - minT)/span*100, x1 = ((s.endedAt||st.now) - minT)/span*100;
    var col = s.status==='done' ? '#3fb950' : (s.status==='idle' ? '#5c6b7e' : '#ffb020');
    return '<div class="grow"><span class="gl">'+esc(s.project)+'</span><span class="gt"><span class="gb" style="left:'+x0.toFixed(1)+'%;width:'+Math.max(1,(x1-x0)).toFixed(1)+'%;background:'+col+'"></span></span></div>';
  }).join('') || '<div style="color:#5c6b7e;font-size:12px">—</div>';

  statsEl.innerHTML = '<h3>📊 Statistiques</h3>'
    + '<div class="up"><span>⏱ Tourne depuis <b>'+fmtDur(st.now-st.boot)+'</b></span>'
    + '<span>📅 1er lancement il y a <b>'+fmtDur(st.now-st.firstStart)+'</b></span>'
    + '<span>⚙ Total actions <b>'+st.totalActions+'</b></span>'
    + '<span class="durcfg" style="cursor:pointer;color:#4c9aff">⏰ Alerte durée : <b>'+(durAlertMin?durAlertMin+' min':'off')+'</b> (modifier)</span></div>'
    + '<div class="lg2">Actions par heure (24 h) — <span style="color:#4c9aff">■</span> actions · <span style="color:#f85149">■</span> erreurs</div>'
    + '<div class="hist">'+bars+'</div><div class="lbls">'+lbls+'</div>'
    + '<div class="lg2" style="margin-top:14px">Timeline des sessions (Gantt)</div><div class="gantt">'+gantt+'</div>'
    + '<div class="lg2" style="margin-top:14px">Classement projets</div>'
    + '<table class="rank"><thead><tr><th>Projet</th><th>Actions</th><th>Erreurs</th><th>Durée</th></tr></thead><tbody>'+rankRows+'</tbody></table>'
    + scoreHtml(st)
    + heatHtml(st);
}
function scoreHtml(st){
  var dd = st.daily||[], streak = 0;
  for(var i=dd.length-1;i>=0;i--){ if(dd[i].c>0) streak++; else break; }
  var activeDays = dd.filter(function(x){ return x.c>0; }).length, ta = st.totalActions||0;
  var defs = [
    {n:'🎯 100 actions', ok: ta>=100},
    {n:'🔥 1 000 actions', ok: ta>=1000},
    {n:'🚀 10 000 actions', ok: ta>=10000},
    {n:'📅 Série 3 j', ok: streak>=3},
    {n:'🗓️ Série 7 j', ok: streak>=7},
    {n:'🏅 30 j actifs', ok: activeDays>=30}
  ];
  var badges = defs.map(function(d){ return '<span class="badge2'+(d.ok?' on':'')+'">'+d.n+'</span>'; }).join('');
  return '<div class="lg2" style="margin-top:14px">Score — série actuelle : <b style="color:#ffe08a">'+streak+' j</b> · '+activeDays+' jours actifs · '+ta+' actions</div><div class="badges">'+badges+'</div>';
}
function heatHtml(st){
  var dd = st.daily || []; if(!dd.length) return '';
  var max = 1; dd.forEach(function(x){ if(x.c > max) max = x.c; });
  var cells = dd.map(function(x){
    var lvl = x.c===0 ? 0 : (x.c/max > 0.66 ? 3 : (x.c/max > 0.33 ? 2 : 1));
    return '<span class="hm hm'+lvl+'" title="'+x.d+' — '+x.c+' actions"></span>';
  }).join('');
  return '<div class="lg2" style="margin-top:14px">Activité (15 semaines) — <span style="color:#3fb950">■</span> plus foncé = plus actif</div><div class="heat">'+cells+'</div>';
}

// ── historique persistant / recherche (journal serveur) ──────────────────────
var histEl = document.getElementById('hist');
var histBody = document.getElementById('histBody');
var histQ = document.getElementById('histQ');
var histTitle = document.getElementById('histTitle');
var histSid = '';
function openHist(sid, title){ histSid = sid || ''; histTitle.textContent = title || (sid ? '' : 'tout'); histEl.classList.add('open'); fetchHist(); }
function fetchHist(){
  var url = '/api/journal?limit=400';
  if(histSid) url += '&session=' + encodeURIComponent(histSid);
  var q = histQ.value.trim(); if(q) url += '&q=' + encodeURIComponent(q);
  fetch(url).then(function(r){ return r.json(); }).then(function(d){ renderHist(d.events||[]); }).catch(function(){});
}
function diffHtml(d){
  var NL2 = String.fromCharCode(10), out = [];
  if(d.old) d.old.split(NL2).forEach(function(l){ out.push('<span class="dm">- '+esc(l)+'</span>'); });
  if(d.new) d.new.split(NL2).forEach(function(l){ out.push('<span class="dp">+ '+esc(l)+'</span>'); });
  return out.join(NL2);
}
function renderHist(evs){
  if(!evs.length){ histBody.innerHTML = '<div style="padding:22px;color:#5c6b7e;text-align:center">Aucun événement.</div>'; return; }
  histBody.innerHTML = evs.map(function(e,i){
    var cls = e.kind==='PostToolUseFailure' ? 'fail' : ((e.kind==='Stop'||e.kind==='SessionEnd'||e.kind==='SubagentStop') ? 'done' : '');
    var has = e.diff ? ' hasdiff' : '';
    var row = '<div class="he '+cls+has+'" data-hd="'+i+'"><span class="ht">'+fmtT(e.ts)+'</span><span class="hp">'+esc(e.project||'')+'</span>'
      + '<span class="hk">'+esc(e.tool||e.kind)+'</span><span class="ha">'+esc(e.detail||'')+'</span></div>';
    if(e.diff) row += '<pre class="hd" id="hd'+i+'">'+diffHtml(e.diff)+'</pre>';
    return row;
  }).join('');
}
histQ.addEventListener('input', function(){ clearTimeout(histQ._t); histQ._t = setTimeout(fetchHist, 250); });
histEl.addEventListener('click', function(e){
  if(e.target.closest('#histX')){ histEl.classList.remove('open'); return; }
  var row = e.target.closest('.he.hasdiff'); if(row){ var pre = document.getElementById('hd'+row.getAttribute('data-hd')); if(pre) pre.classList.toggle('open'); }
});
document.getElementById('histBtn').addEventListener('click', function(){ if(histEl.classList.contains('open')) histEl.classList.remove('open'); else openHist('', 'tout'); });

// ── replay / remonter le temps (reconstruit l'état depuis le journal) ─────────
var replaying = false, replayEvents = [], replayT0 = 0, replayT1 = 0, replayPlaying = false, replayCur = 0;
var rpEl = document.getElementById('replay'), rpSlider = document.getElementById('rpSlider'), rpTime = document.getElementById('rpTime'), rpPlay = document.getElementById('rpPlay');
function enterReplay(){
  fetch('/api/journal?limit=3000').then(function(r){ return r.json(); }).then(function(d){
    var evs = (d.events||[]).slice().reverse();   // chronologique
    if(!evs.length){ alert('Journal vide — rien à rejouer pour le moment.'); return; }
    replayEvents = evs; replayT0 = evs[0].ts; replayT1 = evs[evs.length-1].ts;
    replaying = true; replayPlaying = false; rpPlay.textContent = '▶';
    rpEl.classList.add('open'); document.getElementById('replayBtn').classList.add('on');
    replaySeek(replayT1);
  }).catch(function(){});
}
function exitReplay(){ replaying = false; replayPlaying = false; rpEl.classList.remove('open'); document.getElementById('replayBtn').classList.remove('on'); if(lastData) applyState(lastData); }
function replayStateAt(t){
  var ss = {};
  for(var i=0;i<replayEvents.length;i++){ var e = replayEvents[i]; if(e.ts > t) break;
    var s = ss[e.session] || (ss[e.session] = { id:e.session, project:e.project, status:'working', startedAt:e.ts, lastActivity:e.ts, lastPrompt:'', agents:{}, toolCounts:{}, toolFails:{}, files:{} });
    s.lastActivity = e.ts; if(e.project) s.project = e.project;
    var aid = e.agent || 'main';
    var a = s.agents[aid] || (s.agents[aid] = { id:aid, type: aid==='main'?'main':(e.agentType||'subagent'), currentTool:null, status:'working', ticks:[], actions:0, startedAt:e.ts, lastActivity:e.ts });
    a.lastActivity = e.ts;
    if(e.kind==='UserPromptSubmit'){ s.status='working'; a.status='working'; if(e.detail) s.lastPrompt=e.detail; }
    else if(e.kind==='PreToolUse'){ s.status='working'; a.status='working'; a.currentTool=e.tool; if(e.detail) a.lastAction=e.detail; }
    else if(e.kind==='PostToolUse'){ a.currentTool=null; a.status='working'; a.actions++; if(e.detail) a.lastAction=e.detail; a.ticks.push({ts:e.ts,ok:true,tool:e.tool,detail:e.detail}); if(e.tool) s.toolCounts[e.tool]=(s.toolCounts[e.tool]||0)+1; }
    else if(e.kind==='PostToolUseFailure'){ a.currentTool=null; a.actions++; a.ticks.push({ts:e.ts,ok:false,tool:e.tool,detail:e.detail}); }
    else if(e.kind==='SubagentStart'){ a.status='working'; }
    else if(e.kind==='SubagentStop'){ a.status='done'; a.currentTool=null; }
    else if(e.kind==='Stop'){ s.status='idle'; if(s.agents.main){ s.agents.main.status='idle'; s.agents.main.currentTool=null; } }
    else if(e.kind==='SessionEnd'){ s.status='done'; }
  }
  return { now:t, sessions:Object.keys(ss).map(function(k){ return ss[k]; }), feed:[], paused:[], blocked:{} };
}
function replaySeek(t){
  replayCur = t; var span = Math.max(1, replayT1 - replayT0);
  rpSlider.value = Math.round((t - replayT0) / span * 1000);
  rpTime.textContent = new Date(t).toLocaleTimeString();
  applyState(replayStateAt(t));
}
rpSlider.addEventListener('input', function(){ var span = replayT1 - replayT0; replaySeek(replayT0 + span * (rpSlider.value/1000)); });
rpPlay.addEventListener('click', function(){ replayPlaying = !replayPlaying; rpPlay.textContent = replayPlaying ? '⏸' : '▶'; });
document.getElementById('rpExit').addEventListener('click', exitReplay);
document.getElementById('replayBtn').addEventListener('click', function(){ if(replaying) exitReplay(); else enterReplay(); });

// ── caméra (zoom sur un agent au double-clic) ─────────────────────────────────
var cam = { s:1, fx:0, fy:0, ts:1, tfx:0, tfy:0, init:false };
function officeCenter(){ return iso3d ? { x: px(GW/2-0.5, GH/2-0.5), y: py(GW/2-0.5, GH/2-0.5) } : { x: OX + GW*TILE/2, y: OY + GH*TILE/2 }; }
function s2w(mx,my){ var sx = STW/2 - cam.fx*cam.s, sy = STH/2 - cam.fy*cam.s; return { x:(mx-sx)/cam.s, y:(my-sy)/cam.s }; }

// ── confettis (célébration fin de session sans erreur) ────────────────────────
var confetti = [], CONF_COL = ['#f85149','#4c9aff','#ffb020','#3fb950','#a371f7','#22b8c0'];
function burstConfetti(){
  for(var i=0;i<60;i++) confetti.push({ x:Math.random()*STW, y:-10-Math.random()*60, vx:(Math.random()-0.5)*80,
    vy:70+Math.random()*90, c:CONF_COL[i%CONF_COL.length], rot:Math.random()*6, vr:(Math.random()-0.5)*8, life:2.4 });
}
var seenDone = {};

// ── humeur du bureau (calme / actif / effervescent / en feu) ──────────────────
var officeMood = 'calm';
function computeMood(state){
  var active = 0; for(var wk in workers){ var w = workers[wk]; if(w.tool && w.mode==='work') active++; }
  var errs = 0, f = state.feed||[], nowT = state.now || Date.now();
  for(var i=0;i<f.length;i++){ if(f[i].kind==='PostToolUseFailure' && (nowT - f[i].ts) < 60000) errs++; }
  officeMood = errs>=3 ? 'fire' : (active>=4 ? 'busy' : (active>=1 ? 'active' : 'calm'));
}
function drawMood(t){
  if(officeMood==='fire'){ ctx.fillStyle = 'rgba(248,81,73,'+(0.06+0.05*Math.abs(Math.sin(t*3)))+')'; ctx.fillRect(0,0,STW,STH); }
  else if(officeMood==='busy'){ ctx.fillStyle = 'rgba(255,176,32,0.05)'; ctx.fillRect(0,0,STW,STH); }
}

// ── radar d'anomalies (comportement anormal vs baseline) ──────────────────────
var anomalies = [], radarEl = document.getElementById('radar');
function computeAnomalies(state){
  anomalies = [];
  var S = state.sessions||[], totA = 0, totF = 0;
  S.forEach(function(s){ var tc = s.toolCounts||{}, tf = s.toolFails||{}; for(var k in tc) totA += tc[k]; for(var k2 in tf) totF += tf[k2]; });
  var avg = totA > 0 ? totF/totA : 0;   // taux d'erreur global (baseline)
  for(var wk in workers){ var w = workers[wk]; if(!w.isMain) continue; w.anom = false; w.anomMsg = '';
    var a = 0, f = 0, tc = w.toolCounts||{}, tf = w.toolFails||{};
    for(var k in tc) a += tc[k]; for(var k2 in tf) f += tf[k2];
    var rate = a > 0 ? f/a : 0, sev = '';
    if(a >= 5 && rate > Math.max(0.25, 2*avg)){ sev = 'hi'; w.anomMsg = 'taux d\\'erreur anormal (' + Math.round(rate*100) + '% vs ~' + Math.round(avg*100) + '% habituel)'; }
    else if(w.stale){ sev = 'mid'; w.anomMsg = 'session figée anormalement longtemps'; }
    else if(w.alert && /boucle/.test(w.alertMsg||'')){ sev = 'mid'; w.anomMsg = w.alertMsg; }
    if(sev){ w.anom = true; anomalies.push({ key:w.key, project:w.name, msg:w.anomMsg, sev:sev }); }
  }
  anomalies.sort(function(a,b){ return (a.sev==='hi'?0:1) - (b.sev==='hi'?0:1); });
}
function updateRadar(){
  document.getElementById('radarBtn').classList.toggle('warn', anomalies.length > 0);
  if(!radarEl.classList.contains('open')) return;
  var rows = anomalies.length
    ? anomalies.map(function(a){ return '<div class="an" data-key="'+esc(a.key)+'"><span class="sev '+a.sev+'"></span><span class="anp">'+esc(a.project)+'</span><span class="anm">'+esc(a.msg)+'</span></div>'; }).join('')
    : '<div class="none">✅ Rien d\\'anormal détecté.</div>';
  radarEl.innerHTML = '<h3>📡 Radar d\\'anomalies</h3>' + rows;
}
function drawAnomMark(w, t){
  if(!w.anom || w.mode==='leave') return;
  var x = px(w.fc, w.fr) - TILE*0.26, y = py(w.fc, w.fr) - TILE*0.58, s = 1 + 0.25*Math.abs(Math.sin(t*6));
  ctx.font = Math.round(TILE*0.22*s) + 'px "Segoe UI",sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('📡', x, y);
}

// ── sparkline d'activité (10 dernières minutes) ───────────────────────────────
function sparkRow(w){
  var tk = w.ticks||[]; if(tk.length < 2) return '';
  var nowT = Date.now(), b = [0,0,0,0,0,0,0,0,0,0];
  tk.forEach(function(t){ var age = (nowT - t.ts)/60000; if(age >= 0 && age < 10) b[9 - Math.floor(age)]++; });
  var max = Math.max.apply(null, b) || 1;
  var bars = b.map(function(v){ return '<span style="display:inline-block;width:8px;height:'+Math.max(2,Math.round(v/max*22))+'px;background:#4c9aff;margin-right:2px;vertical-align:bottom;border-radius:1px"></span>'; }).join('');
  return '<div class="row"><div class="lbl">Activité (10 min)</div><div style="height:24px;display:flex;align-items:flex-end">'+bars+'</div></div>';
}

// ── application de l'état serveur ─────────────────────────────────────────────
var lastData = null;
function applyState(state){
  if(!replaying) lastData = state;   // en replay, on préserve le dernier état live
  var S = state.sessions || [];
  emptyEl.style.display = S.length ? 'none' : 'flex';

  var agentsTot = 0, tools = 0, working = 0;
  for(var i=0;i<S.length;i++){
    agentsTot += Object.keys(S[i].agents||{}).length;
    var tc = S[i].toolCounts||{}; for(var kk in tc) tools += tc[kk];
    if(S[i].status==='working') working++;
  }
  document.getElementById('s-sessions').textContent = S.length;
  document.getElementById('s-working').textContent = working;
  document.getElementById('s-agents').textContent = agentsTot;
  document.getElementById('s-tools').textContent = tools;

  // ordre stable pour l'attribution des bureaux
  var ordered = S.slice().sort(function(a,b){ return a.startedAt - b.startedAt; });
  var desired = {};

  // demandes d'approbation par session
  var apBySid = {}; (state.approvals||[]).forEach(function(a){ apBySid[a.sid] = a; });

  // salle de réunion : la session avec le plus de sous-agents actifs (≥2) s'y installe
  var meetingSid = null, maxSubs = 1, meetingCount = 0;
  meetingName = '';
  for(var mI=0; mI<ordered.length; mI++){
    var ms = ordered[mI], cnt = 0, mags = ms.agents || {};
    for(var ma in mags){ if(ma!=='main' && mags[ma].status!=='done') cnt++; }
    if(cnt > maxSubs){ maxSubs = cnt; meetingSid = ms.id; meetingName = ms.project || 'session'; meetingCount = cnt; }
  }

  for(var s=0;s<ordered.length;s++){
    var sess = ordered[s];
    var di = deskIndexFor(sess.id);
    var main = (sess.agents && sess.agents.main) ? sess.agents.main : null;
    var inMeeting = (sess.id === meetingSid);

    // total d'actions de la session (tous agents confondus)
    var sessActions = 0, ags0 = sess.agents || {};
    for(var a0 in ags0) sessActions += (ags0[a0].actions || 0);

    // agent principal
    var mk = sess.id + ':main';
    var retiredGone = (sess.status==='done' && retired[sess.id] && !workers[mk]);
    if(!retiredGone){
      desired[mk] = 1;
      var w = workers[mk];
      if(!w){ w = workers[mk] = makeWorker(mk, palOf(sess.project||sess.id), sess.project||'session', true); }
      w.name = sess.project || 'session';
      w.tool = main ? main.currentTool : null;
      w.action = main ? (main.lastAction||'') : (sess.lastPrompt||'');
      w.task = sess.lastPrompt || '';
      w.sessStatus = sess.status;
      w.agentStatus = main ? main.status : sess.status;
      w.actions = sessActions;
      w.startedAt = sess.startedAt || 0;
      w.waiting = main ? !!main.waiting : false;
      w.ticks = main ? (main.ticks || []) : [];
      w.fails = main ? (main.fails || 0) : 0;
      w.files = sess.files || {};
      w.toolCounts = sess.toolCounts || {};
      w.toolFails = sess.toolFails || {};
      w.paused = (state.paused||[]).indexOf(sess.id) >= 0;
      w.blockedTools = (state.blocked||{})[sess.id] || [];
      w.approval = (state.needApproval||[]).indexOf(sess.id) >= 0;
      w.approvalReq = apBySid[sess.id] || null;
      w.host = sess.host || '';
      w.stale = (sess.status==='working' && (state.now - (sess.lastActivity||0)) > 45000);
      if(main) noteErr(w, main);
      w.deskChair = desks[di].chair;
      w.home = (inMeeting && sess.status==='working') ? meetingSeat(-1, meetingCount) : desks[di].chair;
      if(sess.status==='working'){ w.mode = 'work'; w.restSince = null; delete retired[sess.id]; }
      else if(sess.status==='idle'){ w.mode = 'relax'; w.restSince = null; delete retired[sess.id]; }
      else { // terminé : dort au lit un moment puis quitte le bureau
        if(w.restSince == null) w.restSince = clockNow();
        if(clockNow() - w.restSince > REST_SECONDS){ w.mode = 'leave'; retired[sess.id] = 1; }
        else w.mode = 'rest';
      }
    }

    // sous-agents actifs
    var subIdx = 0;
    var ags = sess.agents || {};
    for(var aid in ags){
      if(aid === 'main') continue;
      var a = ags[aid];
      if(a.status === 'done') continue;         // terminé → quitte le bureau
      var sk = sess.id + ':' + aid;
      desired[sk] = 1;
      var ri = roleInfo(a.type);
      var sw = workers[sk];
      if(!sw){ sw = workers[sk] = makeWorker(sk, ri.pal, a.type||'agent', false); }
      sw.pal = ri.pal; sw.roleIcon = ri.icon;
      sw.name = a.type || 'agent';
      sw.type = a.type || '';
      sw.tool = a.currentTool;
      sw.action = a.lastAction || '';
      sw.task = sess.lastPrompt || '';
      sw.sessStatus = sess.status;
      sw.agentStatus = a.status;
      sw.actions = a.actions || 0;
      sw.startedAt = a.startedAt || sess.startedAt || 0;
      sw.waiting = !!a.waiting;
      sw.ticks = a.ticks || [];
      sw.fails = a.fails || 0;
      sw.paused = (state.paused||[]).indexOf(sess.id) >= 0;
      noteErr(sw, a);
      sw.home = inMeeting ? meetingSeat(subIdx, meetingCount) : subSpot(di, subIdx);
      sw.mode = 'work';
      subIdx++;
    }
  }

  // workers dont la session/agent a disparu → ils partent
  for(var wk in workers){ if(!desired[wk]) workers[wk].mode = 'leave'; }

  // ── anti-chevauchement GLOBAL : séparation par forces (aucune paire trop proche) ──
  var arr = [];
  for(var ck in workers){ var cw = workers[ck]; if(cw.mode!=='leave' && cw.home){ cw.home = { c: cw.home.c, r: cw.home.r }; arr.push(cw); } }  // clone (ne mute pas chaise/table)
  var MIN = 1.0;  // distance mini entre 2 agents (en tuiles)
  for(var it=0; it<12; it++){
    for(var a=0; a<arr.length; a++) for(var b=a+1; b<arr.length; b++){
      var A = arr[a].home, B = arr[b].home;
      var dx = B.c-A.c, dy = B.r-A.r, d = Math.sqrt(dx*dx+dy*dy);
      if(d >= MIN) continue;
      if(d < 0.0001){ dx = ((a*7+b*13)%10)/10 - 0.5 + 0.01; dy = ((a*11+b*5)%10)/10 - 0.5 + 0.01; d = Math.sqrt(dx*dx+dy*dy) || 1; }  // exactement superposés → écart déterministe
      var push = (MIN-d)/2, ux = dx/d, uy = dy/d;
      A.c -= ux*push; A.r -= uy*push; B.c += ux*push; B.r += uy*push;
    }
  }

  // alertes + titre d'onglet (nb de sessions en alerte)
  var alerts = 0;
  for(var ak in workers){
    var aw = workers[ak];
    if(aw.waiting){ if(!aw.waitSince) aw.waitSince = clockNow(); } else aw.waitSince = 0;
    computeAlert(aw);
    if(aw.isMain && aw.alert) alerts++;
  }
  document.title = (alerts ? '('+alerts+'⚠) ' : '') + 'agent-office';
  computeAnomalies(state); updateRadar();

  // confettis quand une session se termine sans erreur (une seule fois) — pas en replay
  if(!replaying) for(var di2=0; di2<S.length; di2++){
    var ds = S[di2];
    if(ds.status==='done' && !seenDone[ds.id]){
      seenDone[ds.id] = 1;
      var fl = 0, dag = ds.agents||{}; for(var da in dag) fl += dag[da].fails||0;
      if(fl === 0) burstConfetti();
    }
    if(ds.status!=='done') seenDone[ds.id] = 0;
  }

  computeMood(state);  // humeur du bureau
  updateLog(state);    // mini-log d'activité
  updateTeam(state);   // panneau Équipe
  updateList(state);   // vue liste compacte
  updateLib(state);    // bibliothèque de sessions
  updateStats(state);  // panneau statistiques
  if(!replaying){
    document.getElementById('hookBtn').classList.toggle('on', !!state.webhook);
    if(state.rules){ rulesLocal = state.rules; if(document.getElementById('cfg').classList.contains('open')) renderRules(); }
    if(state.notifCfg){ ncLocal = state.notifCfg; if(document.getElementById('cfg').classList.contains('open')) renderNotifCfg(); }
    updateNotif(state);  // centre de notifications (badge + panneau)
    checkNotifs();       // notifications navigateur
    playSounds(state);   // sons sur nouveaux events (si activés)
  }
}

// ── boucle d'animation ────────────────────────────────────────────────────────
var SPEED = 3.4; // tuiles / seconde
function eq(a,b){ return a.c===b.c && a.r===b.r; }

function update(dt, t){
  for(var wk in workers){
    var w = workers[wk];

    // objectif courant
    var goal;
    if(w.mode === 'leave'){ w.amenity = null; goal = door(); }
    else if(w.mode === 'relax'){
      if(!w.amenity) w.amenity = pickAmenity(w.key);   // coin détente fixe, stable
      goal = w.amenity.spot;
    }
    else if(w.mode === 'rest'){
      w.amenity = BED;                                 // va dormir au lit
      goal = BED.spot;
    }
    else { w.amenity = null; goal = w.home; }

    // téléportation : au lieu de marcher, l'agent se rematérialise directement
    w.moving = false;
    if(w.mode==='leave'){ w.dead = true; continue; }   // il se dématérialise et part
    if(!eq(w.cell, goal)){
      w.fc = goal.c; w.fr = goal.r; w.cell = {c:goal.c, r:goal.r};
      w.spawn = t;              // rejoue l'anim d'apparition (scale-in)
      w.teleUntil = t + 0.5;    // effet de téléportation
    }

    // pose (plus de marche)
    if(w.mode==='work') w.pose = w.tool ? poseFor(w.tool) : 'think';
    else if(w.mode==='rest') w.pose = 'bed';
    else if(w.mode==='relax') w.pose = w.amenity ? w.amenity.type : 'idle';
    else w.pose = 'idle';

    w.sitting = (w.mode==='work') && eq(w.cell, w.home) && w.isMain;

    // énergie : baisse quand il bosse dur, remonte au repos / café
    var drain = (w.mode==='work' && w.tool) ? 5.5 : 0;
    var gain = 0;
    if(w.mode==='rest') gain = 16;
    else if(w.mode==='relax') gain = (w.amenity && w.amenity.type==='coffee') ? 22 : 11;
    else if(w.mode==='work' && !w.tool) gain = 2.5;    // réflexion = petite récup
    w.energy = Math.max(0, Math.min(100, w.energy - drain*dt + gain*dt));
  }
  for(var dk in workers){ if(workers[dk].dead) delete workers[dk]; }

  // projecteur : la caméra vise l'agent épinglé ou le premier agent actif
  if(spotlight && !replaying){
    var tgt = (pinnedKey && workers[pinnedKey]) ? workers[pinnedKey] : null;
    if(!tgt){ for(var swk in workers){ if(workers[swk].tool){ tgt = workers[swk]; break; } } }
    if(tgt){ cam.ts = 1.8; cam.tfx = px(tgt.fc, tgt.fr); cam.tfy = py(tgt.fc, tgt.fr); }
    else { cam.ts = 1; var oc = officeCenter(); cam.tfx = oc.x; cam.tfy = oc.y; }
  }
  // caméra : lerp doux vers la cible (zoom)
  var kf = Math.min(1, dt*8);
  cam.s += (cam.ts - cam.s)*kf; cam.fx += (cam.tfx - cam.fx)*kf; cam.fy += (cam.tfy - cam.fy)*kf;

  // confettis
  for(var ci=confetti.length-1; ci>=0; ci--){
    var p = confetti[ci];
    p.x += p.vx*dt; p.y += p.vy*dt; p.vy += 120*dt; p.rot += p.vr*dt; p.life -= dt;
    if(p.life <= 0 || p.y > STH + 30) confetti.splice(ci,1);
  }
}

// ── rendu ──────────────────────────────────────────────────────────────────────
// ── projection : plat (par défaut) ou isométrique vrai (🧊) avec rotation (🔄) ──
var IW = 0, IH = 0, ISOX = 0, ISOY = 0, isoRot = 0;   // isoRot ∈ {0,1,2,3} = 4 orientations
function rotXYa(c, r, rot){
  var cx = (GW-1)/2, cy = (GH-1)/2, x = c-cx, y = r-cy, a = rot*Math.PI/2, ca = Math.cos(a), sa = Math.sin(a);
  return [ cx + x*ca - y*sa, cy + x*sa + y*ca ];
}
function RP(cc, rr){
  if(!iso3d) return { x: OX + cc*TILE, y: OY + rr*TILE };
  var p = rotXYa(cc, rr, isoRot); return { x: ISOX + (p[0]-p[1])*IW, y: ISOY + (p[0]+p[1])*IH };
}
function px(fc, fr){ if(!iso3d) return OX + (fc+0.5)*TILE; var p = rotXYa(fc+0.5, fr+0.5, isoRot); return ISOX + (p[0]-p[1])*IW; }
function py(fc, fr){ if(!iso3d) return OY + (fr+0.5)*TILE; var p = rotXYa(fc+0.5, fr+0.5, isoRot); return ISOY + (p[0]+p[1])*IH; }
function isoDepth(c, r){ var p = rotXYa(c, r, isoRot); return p[0] + p[1]; }   // tri profondeur (iso)
function toTile(wx, wy){   // pixel (pré-caméra) → coord tuile
  if(!iso3d) return { c: Math.floor((wx-OX)/TILE), r: Math.floor((wy-OY)/TILE) };
  var X = (wx-ISOX)/IW, Y = (wy-ISOY)/IH, u = (X+Y)/2, v = (Y-X)/2;
  var p = rotXYa(u, v, -isoRot);   // dé-rotation
  return { c: Math.floor(p[0]), r: Math.floor(p[1]) };
}
function rr(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
// losange d'une tuile (iso) — 4 coins
function tileDiamond(c, r){ var a=RP(c,r), b=RP(c+1,r), d=RP(c+1,r+1), e=RP(c,r+1);
  ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.lineTo(d.x,d.y); ctx.lineTo(e.x,e.y); ctx.closePath(); }

function drawFloor(){
  var th = TH();
  if(iso3d){
    for(var c=0;c<GW;c++) for(var r=0;r<GH;r++){
      tileDiamond(c,r);
      if(WALL[key(c,r)]){ ctx.fillStyle = th.wall; ctx.fill(); ctx.strokeStyle = th.wallLo; ctx.lineWidth = 1; ctx.stroke(); }
      else { ctx.fillStyle = ((c+r)%2===0) ? th.floorA : th.floorB; ctx.fill(); }
    }
    var d0 = door(); tileDiamond(d0.c, d0.r); ctx.fillStyle = th.mat; ctx.fill();
    return;
  }
  for(var c2=0;c2<GW;c2++) for(var r2=0;r2<GH;r2++){
    var x = OX + c2*TILE, y = OY + r2*TILE;
    if(WALL[key(c2,r2)]){
      ctx.fillStyle = th.wall; ctx.fillRect(x,y,TILE,TILE);
      ctx.fillStyle = th.wallHi; ctx.fillRect(x,y,TILE,3);
      ctx.fillStyle = th.wallLo; ctx.fillRect(x,y+TILE-3,TILE,3);
    } else {
      ctx.fillStyle = ((c2+r2)%2===0) ? th.floorA : th.floorB;
      ctx.fillRect(x,y,TILE,TILE);
    }
  }
  var d = door();
  ctx.fillStyle = th.mat;
  ctx.fillRect(OX+(d.c-0.5)*TILE, OY+(d.r-1)*TILE, TILE*2, TILE);
}

function drawDesk(dk){
  if(iso3d){
    var H = IH*1.4;   // hauteur du bloc bureau
    // face avant (volume) : coins bas du losange descendus de H
    var b = RP(dk.c+1, dk.r), d = RP(dk.c+1, dk.r+1), e = RP(dk.c, dk.r+1);
    ctx.fillStyle = '#4a3220';
    ctx.beginPath(); ctx.moveTo(b.x,b.y); ctx.lineTo(d.x,d.y); ctx.lineTo(d.x,d.y+H); ctx.lineTo(b.x,b.y+H); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(d.x,d.y); ctx.lineTo(e.x,e.y); ctx.lineTo(e.x,e.y+H); ctx.lineTo(d.x,d.y+H); ctx.closePath(); ctx.fill();
    // plateau (losange)
    tileDiamond(dk.c, dk.r); ctx.fillStyle = '#7a5230'; ctx.fill();
    tileDiamond(dk.c, dk.r); ctx.strokeStyle = '#8f6238'; ctx.lineWidth = 1; ctx.stroke();
    // écran allumé/éteint au centre
    var ce = px(dk.c, dk.r), cy2 = py(dk.c, dk.r);
    ctx.fillStyle = deskActive(dk) ? '#2f81f7' : '#26313f';
    ctx.fillRect(ce - IW*0.22, cy2 - IH*1.6, IW*0.44, IH*1.1);
    return;
  }
  var x = OX + dk.c*TILE, y = OY + dk.r*TILE, m = TILE*0.1;
  // plateau
  ctx.fillStyle = '#7a5230'; rr(x+m, y+m, TILE-2*m, TILE-2*m, 4); ctx.fill();
  ctx.fillStyle = '#8f6238'; ctx.fillRect(x+m, y+m, TILE-2*m, 4);
  // écran (côté opposé à la chaise = haut)
  var scOn = deskActive(dk);
  ctx.fillStyle = '#11161f'; ctx.fillRect(x+TILE*0.28, y+TILE*0.16, TILE*0.44, TILE*0.28);
  ctx.fillStyle = scOn ? '#2f81f7' : '#26313f';
  ctx.fillRect(x+TILE*0.31, y+TILE*0.19, TILE*0.38, TILE*0.20);
  // clavier (côté chaise = bas)
  ctx.fillStyle = '#cdd7e3'; ctx.fillRect(x+TILE*0.3, y+TILE*0.66, TILE*0.4, TILE*0.14);
}
function deskActive(dk){
  // écran allumé si un worker de ce bureau bosse
  for(var wk in workers){
    var w = workers[wk];
    if(w.isMain && w.deskChair && w.deskChair.c===dk.chair.c && w.deskChair.r===dk.chair.r && w.mode==='work') return true;
  }
  return false;
}

function drawDeco(dc){
  if(iso3d){
    var colr = {plant:'#2f8f4e',cooler:'#4cb3e0',water:'#4cb3e0',coffee:'#c0392b',gym:'#556072',bed:'#6f8fc0',shelf:'#5a3f28',couch:'#3a4b63',table:'#5a4630'}[dc.t] || '#556';
    var H = IH*1.2, b = RP(dc.c+1,dc.r), d = RP(dc.c+1,dc.r+1);
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath(); ctx.moveTo(b.x,b.y); ctx.lineTo(d.x,d.y); ctx.lineTo(d.x,d.y+H); ctx.lineTo(b.x,b.y+H); ctx.closePath(); ctx.fill();
    tileDiamond(dc.c, dc.r); ctx.fillStyle = colr; ctx.fill();
    return;
  }
  var x = OX + dc.c*TILE, y = OY + dc.r*TILE;
  if(dc.t==='plant'){
    ctx.fillStyle='#5a3a24'; ctx.fillRect(x+TILE*0.34,y+TILE*0.55,TILE*0.32,TILE*0.3);
    ctx.fillStyle='#2f8f4e'; ctx.beginPath(); ctx.arc(x+TILE*0.5,y+TILE*0.45,TILE*0.28,0,7); ctx.fill();
    ctx.fillStyle='#3fb063'; ctx.beginPath(); ctx.arc(x+TILE*0.4,y+TILE*0.38,TILE*0.16,0,7); ctx.fill();
  } else if(dc.t==='cooler' || dc.t==='water'){
    ctx.fillStyle='#d6e6f2'; rr(x+TILE*0.3,y+TILE*0.3,TILE*0.4,TILE*0.55,3); ctx.fill();
    ctx.fillStyle='#4cb3e0'; ctx.fillRect(x+TILE*0.36,y+TILE*0.2,TILE*0.28,TILE*0.22);
  } else if(dc.t==='coffee'){
    ctx.fillStyle='#2b3340'; rr(x+TILE*0.24,y+TILE*0.2,TILE*0.52,TILE*0.6,4); ctx.fill();
    ctx.fillStyle='#c0392b'; ctx.fillRect(x+TILE*0.3,y+TILE*0.3,TILE*0.4,TILE*0.1);
    ctx.fillStyle='#e8e2d8'; ctx.fillRect(x+TILE*0.4,y+TILE*0.52,TILE*0.2,TILE*0.16);
  } else if(dc.t==='gym'){
    ctx.fillStyle='#20242c'; rr(x+TILE*0.18,y+TILE*0.5,TILE*0.64,TILE*0.32,4); ctx.fill();
    ctx.fillStyle='#3a4453'; ctx.fillRect(x+TILE*0.7,y+TILE*0.2,TILE*0.1,TILE*0.4);
    ctx.fillStyle='#556072'; ctx.fillRect(x+TILE*0.62,y+TILE*0.18,TILE*0.26,TILE*0.08);
  } else if(dc.t==='bed'){
    ctx.fillStyle='#5a4230'; ctx.fillRect(x+TILE*0.1,y+TILE*0.2,TILE*0.8,TILE*0.65);
    ctx.fillStyle='#6f8fc0'; rr(x+TILE*0.14,y+TILE*0.3,TILE*0.72,TILE*0.5,3); ctx.fill();
    ctx.fillStyle='#eef3f8'; ctx.fillRect(x+TILE*0.16,y+TILE*0.34,TILE*0.24,TILE*0.2);
  } else if(dc.t==='shelf'){
    ctx.fillStyle='#5a3f28'; ctx.fillRect(x+TILE*0.15,y+TILE*0.15,TILE*0.7,TILE*0.7);
    var books=['#f85149','#4c9aff','#ffb020','#3fb950','#a371f7'];
    for(var b=0;b<5;b++){ ctx.fillStyle=books[b]; ctx.fillRect(x+TILE*0.2+b*TILE*0.12, y+TILE*0.2, TILE*0.09, TILE*0.6); }
  } else if(dc.t==='couch'){
    ctx.fillStyle='#3a4b63'; rr(x+TILE*0.12,y+TILE*0.35,TILE*0.76,TILE*0.5,5); ctx.fill();
    ctx.fillStyle='#46597a'; ctx.fillRect(x+TILE*0.12,y+TILE*0.3,TILE*0.76,TILE*0.15);
  } else if(dc.t==='table'){
    ctx.fillStyle='#5a4630'; ctx.fillRect(x, y+TILE*0.28, TILE, TILE*0.5);
    ctx.fillStyle='#6e5738'; ctx.fillRect(x, y+TILE*0.28, TILE, 4);
  }
}

var RAIN_CH = '01ｱｳｴｶｷｸｹﾊﾋﾌ$#%&@';
function drawWorker(w, t){
  var x = px(w.fc, w.fr), y = py(w.fc, w.fr);
  var scale = Math.min(1, (t - w.spawn) / 0.4); // petite anim d'apparition
  var s = TILE * 0.5 * scale;

  // ── pluie "Matrix" à l'arrivée d'un nouvel agent ──
  if(t < w.rainUntil){
    var a2 = Math.min(1, (w.rainUntil - t) / 0.5);
    ctx.save();
    ctx.font = Math.round(TILE*0.24) + 'px "Consolas",monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for(var col=-1; col<=1; col++){
      for(var d=0; d<5; d++){
        var yy = y - TILE*0.9 + (((t*90 + d*22 + (col+2)*13) % (TILE*1.7)));
        var ci = (Math.floor(t*12) + d*3 + col*5) % RAIN_CH.length;
        ctx.fillStyle = (d===0) ? 'rgba(180,255,200,' + a2 + ')' : 'rgba(60,220,120,' + (a2*0.8) + ')';
        ctx.fillText(RAIN_CH.charAt(ci), x + col*TILE*0.24, yy);
      }
    }
    ctx.restore();
  }

  // ── effet de téléportation (rayon + anneau qui s'élargit) ──
  if(t < w.teleUntil){
    var p = 1 - (w.teleUntil - t) / 0.5;          // 0 → 1
    var a = 1 - p;                                 // fondu
    ctx.save();
    ctx.globalAlpha = a * 0.8;
    var grd = ctx.createLinearGradient(x, y - TILE*0.9, x, y + TILE*0.5);
    grd.addColorStop(0, 'rgba(90,220,255,0)');
    grd.addColorStop(0.5, 'rgba(90,220,255,.9)');
    grd.addColorStop(1, 'rgba(90,220,255,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(x - TILE*0.16, y - TILE*0.9, TILE*0.32, TILE*1.4);
    ctx.globalAlpha = a;
    ctx.strokeStyle = '#8fe8ff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(x, y + TILE*0.12, TILE*0.2 + p*TILE*0.5, TILE*0.08 + p*TILE*0.2, 0, 0, 7); ctx.stroke();
    ctx.restore();
  }

  // ── pose couchée (dort au lit) ─────────────────────────────
  if(w.pose==='bed'){
    var breathe = Math.sin(t*1.6)*(s*0.03);
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.beginPath(); ctx.ellipse(x, y + s*0.5, s*0.6, s*0.2, 0, 0, 7); ctx.fill();
    ctx.fillStyle = w.pal.sh;                        // corps allongé (couverture)
    rr(x - s*0.55, y - s*0.16 + breathe, s*1.0, s*0.4, s*0.18); ctx.fill();
    ctx.fillStyle = w.pal.sk;                        // tête sur l'oreiller
    ctx.beginPath(); ctx.arc(x + s*0.6, y + s*0.04, s*0.22, 0, 7); ctx.fill();
    ctx.fillStyle = w.pal.ha;
    ctx.beginPath(); ctx.arc(x + s*0.6, y, s*0.22, Math.PI*0.6, Math.PI*1.5); ctx.fill();
    return;
  }

  var bob = 0, legSwing = 0, handBob = 0;
  if(w.pose==='walk'){ bob = Math.sin(t*10)* (TILE*0.04); legSwing = Math.sin(t*10)*(TILE*0.12); }
  else if(w.pose==='typing'){ handBob = Math.abs(Math.sin(t*12))*(TILE*0.06); }
  else if(w.pose==='gym'){ bob = Math.abs(Math.sin(t*14))*(TILE*0.05); legSwing = Math.sin(t*16)*(TILE*0.16); }
  else if(w.pose==='think'){ bob = Math.sin(t*2)*(TILE*0.02); }
  else { bob = Math.sin(t*3)*(TILE*0.02); }  // idle / coffee / couch / water

  var cy = y + bob;

  // chaise si assis au bureau
  if(w.sitting){
    ctx.fillStyle = '#33445c';
    rr(x - s*0.5, cy - s*0.1, s, s*0.9, 4); ctx.fill();
  }
  // ombre (plus marquée et décalée en relief 2.5D)
  ctx.fillStyle = iso3d ? 'rgba(0,0,0,.45)' : 'rgba(0,0,0,.35)';
  ctx.beginPath(); ctx.ellipse(x + (iso3d?s*0.12:0), y + s*0.55, s*(iso3d?0.6:0.5), s*(iso3d?0.22:0.18), 0, 0, 7); ctx.fill();

  // jambes (debout)
  if(!w.sitting){
    ctx.fillStyle = '#2b3444';
    ctx.fillRect(x - s*0.28 + legSwing, cy + s*0.1, s*0.2, s*0.4);
    ctx.fillRect(x + s*0.08 - legSwing, cy + s*0.1, s*0.2, s*0.4);
  }
  // corps (chemise)
  ctx.fillStyle = w.pal.sh;
  rr(x - s*0.34, cy - s*0.15, s*0.68, s*0.5, s*0.16); ctx.fill();
  // mains qui tapent
  if(w.pose==='typing'){
    ctx.fillStyle = w.pal.sk;
    ctx.fillRect(x - s*0.3, cy - s*0.25 - handBob, s*0.16, s*0.16);
    ctx.fillRect(x + s*0.14, cy - s*0.25 - handBob*0.6, s*0.16, s*0.16);
  }
  // livre (lecture)
  if(w.pose==='reading'){
    ctx.fillStyle = '#eef3f8';
    ctx.fillRect(x - s*0.24, cy - s*0.42, s*0.48, s*0.26);
    ctx.strokeStyle = '#9fb0c4'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(x, cy - s*0.42); ctx.lineTo(x, cy - s*0.16); ctx.stroke();
  }
  // tasse de café à la main
  if(w.pose==='coffee'){
    ctx.fillStyle = '#e8e2d8'; ctx.fillRect(x + s*0.2, cy - s*0.05, s*0.18, s*0.16);
    ctx.strokeStyle = '#e8e2d8'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x + s*0.4, cy + s*0.03, s*0.06, -1.4, 1.4); ctx.stroke();
  }
  // haltère (sport) dans les mains levées
  if(w.pose==='gym'){
    ctx.fillStyle = '#20242c';
    ctx.fillRect(x - s*0.42, cy - s*0.34 - bob, s*0.16, s*0.1);
    ctx.fillRect(x + s*0.26, cy - s*0.34 - bob, s*0.16, s*0.1);
  }
  // tête
  ctx.fillStyle = w.pal.sk;
  ctx.beginPath(); ctx.arc(x, cy - s*0.32, s*0.26, 0, 7); ctx.fill();
  // cheveux
  ctx.fillStyle = w.pal.ha;
  ctx.beginPath(); ctx.arc(x, cy - s*0.36, s*0.26, Math.PI*1.05, Math.PI*1.95); ctx.fill();

  // barre d'énergie au-dessus de la tête
  var e = w.energy == null ? 100 : w.energy;
  var bw = s*0.8, bx = x - bw/2, byy = cy - s*0.78;
  ctx.fillStyle = 'rgba(8,12,20,.6)'; rr(bx, byy, bw, 3.5, 2); ctx.fill();
  ctx.fillStyle = e>50 ? '#3fb950' : (e>25 ? '#ffb020' : '#f85149');
  rr(bx, byy, bw * (e/100), 3.5, 2); ctx.fill();
}

function drawTag(w){
  var x = px(w.fc, w.fr), y = py(w.fc, w.fr) - TILE*0.62;
  ctx.font = '600 11px "Segoe UI",system-ui,sans-serif';
  var label = w.name;
  var tw = ctx.measureText(label).width + 12;
  ctx.fillStyle = 'rgba(10,16,26,.82)';
  rr(x - tw/2, y - 8, tw, 15, 4); ctx.fill();
  ctx.fillStyle = w.isMain ? '#e6edf3' : '#c9b6f0';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y);
}

function fit(str, maxw){
  if(ctx.measureText(str).width <= maxw) return str;
  var s = str;
  while(s.length > 1 && ctx.measureText(s + '…').width > maxw) s = s.slice(0, -1);
  return s + '…';
}
function drawBubble(w, t){
  // seulement quand le worker fait quelque chose de parlant
  var line1 = '', line2 = '';
  if(w.mode==='work' && w.tool){ line1 = toolIcon(w.tool) + ' ' + w.tool; line2 = w.action || ''; }
  else if(!w.isMain && w.mode==='work'){ line1 = '🤝 ' + (w.type||'agent'); line2 = w.action || 'en renfort…'; }
  else if(w.isMain && w.mode==='work' && !w.moving){ line1 = '💭 réfléchit…'; }
  else if(w.mode==='leave'){ return; }
  else return;
  if(!line1) return;

  var x = px(w.fc, w.fr), top = py(w.fc, w.fr) - TILE*0.95;
  ctx.font = '600 11px "Segoe UI",system-ui,sans-serif';
  var maxw = 190;
  line1 = fit(line1, maxw);
  ctx.font = '11px "Consolas",ui-monospace,monospace';
  if(line2) line2 = fit(line2, maxw);
  ctx.font = '600 11px "Segoe UI",system-ui,sans-serif';
  var w1 = ctx.measureText(line1).width;
  ctx.font = '11px "Consolas",ui-monospace,monospace';
  var w2 = line2 ? ctx.measureText(line2).width : 0;
  var bw = Math.max(w1, w2) + 16;
  var bh = line2 ? 34 : 20;
  var bx = x - bw/2, by = top - bh;

  ctx.fillStyle = '#ffffff';
  rr(bx, by, bw, bh, 7); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x-5, by+bh); ctx.lineTo(x+5, by+bh); ctx.lineTo(x, by+bh+7); ctx.closePath(); ctx.fill();

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#14212e';
  ctx.font = '600 11px "Segoe UI",system-ui,sans-serif';
  ctx.fillText(line1, x, by + (line2?11:10));
  if(line2){ ctx.fillStyle = '#3a5266'; ctx.font = '11px "Consolas",ui-monospace,monospace'; ctx.fillText(line2, x, by + 24); }
}

// étiquette PERSISTANTE de la tâche (sur quoi il travaille) sous le perso
function drawTask(w){
  if(!w.isMain || !w.task || w.mode==='leave') return;
  var x = px(w.fc, w.fr), y = py(w.fc, w.fr) + TILE*0.6;
  ctx.font = '11px "Segoe UI",system-ui,sans-serif';
  var label = fit(w.task, 200);
  var tw = ctx.measureText(label).width + 16;
  ctx.fillStyle = 'rgba(255,224,138,.14)';
  rr(x - tw/2, y, tw, 17, 5); ctx.fill();
  ctx.strokeStyle = 'rgba(255,224,138,.35)'; ctx.lineWidth = 1; rr(x - tw/2, y, tw, 17, 5); ctx.stroke();
  ctx.fillStyle = '#ffe08a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y + 9);
}

// discussion : traits animés + bulles 💬 entre le chef et ses sous-agents actifs
function drawCollab(t){
  // regroupe les workers par session
  var groups = {};
  for(var wk in workers){
    var w = workers[wk];
    (groups[w.sid] = groups[w.sid] || {main:null, subs:[]});
    if(w.isMain) groups[w.sid].main = w; else groups[w.sid].subs.push(w);
  }
  for(var sid in groups){
    var g = groups[sid];
    if(!g.main || !g.subs.length) continue;
    var mx = px(g.main.fc, g.main.fr), my = py(g.main.fc, g.main.fr) - TILE*0.2;
    for(var i=0;i<g.subs.length;i++){
      var sub = g.subs[i];
      if(sub.mode==='leave') continue;
      var sx = px(sub.fc, sub.fr), sy = py(sub.fc, sub.fr) - TILE*0.2;
      // trait pointillé de communication
      ctx.strokeStyle = 'rgba(163,113,247,.55)'; ctx.lineWidth = 2;
      ctx.setLineDash([3,4]); ctx.lineDashOffset = -(t*14) % 7;
      ctx.beginPath(); ctx.moveTo(mx,my); ctx.lineTo(sx,sy); ctx.stroke();
      ctx.setLineDash([]);
      // "message" qui circule le long du trait (va-et-vient)
      var f = (Math.sin(t*2.2 + i) + 1) / 2;
      var bxp = mx + (sx-mx)*f, byp = my + (sy-my)*f;
      ctx.font = '13px "Segoe UI",sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('💬', bxp, byp);
    }
  }
}

// plaque de poste : nom du projet fixé au bureau (permanent, une seule fois)
function drawDeskPlate(w){
  if(!w.isMain || !w.deskChair) return;
  var cx = iso3d ? px(w.deskChair.c, w.deskChair.r-1) : OX + (w.deskChair.c + 0.5)*TILE;
  var y = iso3d ? (py(w.deskChair.c, w.deskChair.r-1) - IH*3) : (OY + (w.deskChair.r - 1)*TILE - 17);
  ctx.font = '600 10px "Segoe UI",system-ui,sans-serif';
  var label = fit(w.name, TILE*1.7);
  var tw = Math.max(TILE*0.6, ctx.measureText(label).width + 10);
  ctx.fillStyle = '#0c1526';
  rr(cx - tw/2, y, tw, 14, 3); ctx.fill();
  ctx.strokeStyle = '#3f6bd6'; ctx.lineWidth = 1; rr(cx - tw/2, y, tw, 14, 3); ctx.stroke();
  ctx.fillStyle = '#bcd4ff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, y + 7);
  // petite ligne de stats : durée + nombre d'actions
  if(w.startedAt){
    var stat = '⏱ ' + durShort(Date.now() - w.startedAt) + '   ⚙ ' + (w.actions||0);
    ctx.font = '9px "Segoe UI",system-ui,sans-serif';
    ctx.fillStyle = '#7488a0';
    ctx.fillText(stat, cx, y - 7);
  }
}

// plaque sur la table de réunion : nom du projet en réunion
function drawMeetingLabel(){
  if(!meetingName || !MEETING) return;
  var cx = iso3d ? px(MEETING.cx, MEETING.cy-2) : OX + 9*TILE;
  var y  = iso3d ? (py(MEETING.cx, MEETING.cy-2) - IH*2) : OY + 11*TILE - 6;
  ctx.font = '600 11px "Segoe UI",system-ui,sans-serif';
  var label = '🪑 ' + meetingName + ' — réunion';
  var tw = ctx.measureText(label).width + 14;
  ctx.fillStyle = '#160f26';
  rr(cx - tw/2, y - 15, tw, 17, 5); ctx.fill();
  ctx.strokeStyle = '#a371f7'; ctx.lineWidth = 1; rr(cx - tw/2, y - 15, tw, 17, 5); ctx.stroke();
  ctx.fillStyle = '#c9b6f0'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, y - 6);
}

// label de type permanent sous un sous-agent (Explore, Plan…)
function drawSubLabel(w){
  if(w.isMain || !w.type || w.mode==='leave') return;
  var x = px(w.fc, w.fr), y = py(w.fc, w.fr) + TILE*0.5;
  ctx.font = '600 9px "Segoe UI",system-ui,sans-serif';
  var label = (w.roleIcon||'') + ' ' + w.type;
  var tw = ctx.measureText(label).width + 8;
  ctx.fillStyle = 'rgba(22,15,38,.85)';
  rr(x - tw/2, y, tw, 13, 3); ctx.fill();
  ctx.fillStyle = '#c9b6f0'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y + 6.5);
}

// petit badge d'icône (pas de texte) au-dessus d'un agent qui bosse
function drawBadge(w, t){
  if(w.mode==='leave' || w.moving) return;
  var ic = '';
  if(w.mode==='work' && w.tool) ic = toolIcon(w.tool);
  else if(w.mode==='work' && w.isMain) ic = '💭';
  else if(w.mode==='work' && !w.isMain) ic = w.roleIcon || '🤝';
  else if(w.mode==='rest') ic = '💤';
  else if(w.mode==='relax' && w.amenity) ic = w.amenity.emoji;
  else return;
  var x = px(w.fc, w.fr), y = py(w.fc, w.fr) - TILE*0.6;
  var pulse = 1 + Math.sin(t*4)*0.06;
  ctx.fillStyle = 'rgba(8,12,20,.62)';
  ctx.beginPath(); ctx.arc(x, y, TILE*0.2*pulse, 0, 7); ctx.fill();
  ctx.font = Math.round(TILE*0.26) + 'px "Segoe UI",system-ui,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(ic, x, y + 1);
}

// bulle d'erreur rouge quand un outil vient d'échouer
function drawError(w, t){
  if(!w.errUntil || t > w.errUntil || w.mode==='leave') return;
  var x = px(w.fc, w.fr) + Math.sin(t*38)*2, y = py(w.fc, w.fr) - TILE*0.95;
  var txt = '💥 échec' + (w.errTool ? ' ' + w.errTool : '');
  ctx.font = '600 11px "Segoe UI",system-ui,sans-serif';
  var tw = ctx.measureText(txt).width + 14;
  ctx.fillStyle = '#f85149';
  rr(x - tw/2, y - 16, tw, 20, 6); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x-5, y+4); ctx.lineTo(x+5, y+4); ctx.lineTo(x, y+11); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(txt, x, y - 6);
}

// bulle "attente d'action" (permission / idle) — pulse pour attirer l'œil
function drawWaiting(w, t){
  if(!w.waiting || w.mode==='leave') return;
  var pulse = 0.6 + 0.4*Math.abs(Math.sin(t*3));
  var x = px(w.fc, w.fr), y = py(w.fc, w.fr) - TILE*0.95;
  ctx.save(); ctx.globalAlpha = pulse;
  var txt = '❓ attend';
  ctx.font = '600 11px "Segoe UI",system-ui,sans-serif';
  var tw = ctx.measureText(txt).width + 14;
  ctx.fillStyle = '#ffb020';
  rr(x - tw/2, y - 16, tw, 20, 6); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x-5, y+4); ctx.lineTo(x+5, y+4); ctx.lineTo(x, y+11); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#241a00'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(txt, x, y - 6);
  ctx.restore();
}

// alerte "bloqué" : anneau rouge pulsant (aucune activité depuis longtemps)
function drawStale(w, t){
  if(!w.stale || w.mode==='leave') return;
  var x = px(w.fc, w.fr), y = py(w.fc, w.fr);
  var pulse = 0.4 + 0.5*Math.abs(Math.sin(t*3));
  ctx.save(); ctx.globalAlpha = pulse;
  ctx.strokeStyle = '#f85149'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.ellipse(x, y + TILE*0.1, TILE*0.46, TILE*0.54, 0, 0, 7); ctx.stroke();
  ctx.restore();
}

// marqueur ⚠️ (boucle / échecs / attente) à côté de la tête
function drawAlertMark(w, t){
  if(!w.alert || w.mode==='leave') return;
  var x = px(w.fc, w.fr) + TILE*0.26, y = py(w.fc, w.fr) - TILE*0.58;
  var s = 0.9 + 0.15*Math.abs(Math.sin(t*5));
  ctx.font = Math.round(TILE*0.24*s) + 'px "Segoe UI",system-ui,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('⚠️', x, y);
}

// session en pause (kill-switch) : anneau cyan + ⏸
function drawPaused(w, t){
  if(!w.paused || w.mode==='leave') return;
  var x = px(w.fc, w.fr), y = py(w.fc, w.fr);
  ctx.save();
  ctx.strokeStyle = '#22b8c0'; ctx.lineWidth = 3; ctx.globalAlpha = 0.5 + 0.4*Math.abs(Math.sin(t*2.5));
  ctx.beginPath(); ctx.ellipse(x, y + TILE*0.1, TILE*0.46, TILE*0.54, 0, 0, 7); ctx.stroke();
  ctx.globalAlpha = 1; ctx.font = Math.round(TILE*0.26)+'px "Segoe UI",sans-serif';
  ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('⏸', x - TILE*0.26, y - TILE*0.58);
  ctx.restore();
}

// anneau de surbrillance (survol / sélection)
function drawRing(w, sel){
  var x = px(w.fc, w.fr), y = py(w.fc, w.fr);
  ctx.strokeStyle = sel ? '#ffe08a' : 'rgba(255,255,255,.5)';
  ctx.lineWidth = sel ? 3 : 2;
  ctx.beginPath(); ctx.ellipse(x, y + TILE*0.1, TILE*0.42, TILE*0.5, 0, 0, 7); ctx.stroke();
}

// ── sélection / clic ──────────────────────────────────────────────────────────
var selectedKey = null, hoverKey = null;
function hitTest(mx, my){
  var best = null, bd = TILE*0.7;
  for(var wk in workers){
    var w = workers[wk];
    var dx = mx - px(w.fc, w.fr), dy = my - py(w.fc, w.fr);
    var d = Math.sqrt(dx*dx + dy*dy);
    if(d < bd){ bd = d; best = wk; }
  }
  return best;
}
function esc(s){ return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

var card = document.getElementById('card');
var _cardHtml = '';
function histRow(w){
  var tk = w.ticks || [];
  if(!tk.length) return '';
  var squares = tk.slice(-34).map(function(t){ return '<span class="ctk'+(t.ok?'':' bad')+'" title="'+esc((t.tool||'')+(t.detail?' — '+t.detail:''))+'"></span>'; }).join('');
  return '<div class="row"><div class="lbl">Derniers outils</div><div class="cticks">'+squares+'</div></div>';
}
function clientShort(p){ var a = String(p||'').split(/[\\/]/).filter(Boolean); return a.length<=2 ? a.join('/') : '…/'+a.slice(-2).join('/'); }
function filesRow(w){
  var keys = Object.keys(w.files||{}); if(!keys.length) return '';
  keys.sort(function(a,b){ return w.files[b].n - w.files[a].n; });
  var items = keys.slice(0,8).map(function(k){ var f = w.files[k];
    var href = 'vscode://file/' + encodeURI(String(k).replace(/\\\\/g,'/'));
    return '<div class="fitem"><span>'+(f.edited?'✏️':'📖')+'</span><a class="fp" href="'+href+'" title="Ouvrir : '+esc(k)+'">'+esc(clientShort(k))+'</a><span class="fn">'+f.n+'</span></div>'; }).join('');
  return '<div class="row"><div class="lbl">Fichiers travaillés ('+keys.length+')</div><div class="files">'+items+'</div></div>';
}
function toolsRow(w){
  var tc = w.toolCounts||{}, tf = w.toolFails||{}, keys = Object.keys(tc); if(!keys.length) return '';
  keys.sort(function(a,b){ return tc[b]-tc[a]; });
  var chips = keys.map(function(k){ var f = tf[k]||0;
    var rate = f ? ' <span style="color:#f85149">'+Math.round(f/tc[k]*100)+'%✗</span>' : '';
    return '<span class="tchip">'+toolIcon(k)+' '+esc(k)+' <b>'+tc[k]+'</b>'+rate+'</span>'; }).join('');
  return '<div class="row"><div class="lbl">Par outil</div><div class="tchips">'+chips+'</div></div>';
}
function updateCard(){
  var w = selectedKey ? workers[selectedKey] : null;
  if(!w){ if(card.classList.contains('open')){ card.classList.remove('open'); _cardHtml=''; } return; }

  var st = w.agentStatus || w.sessStatus || 'working';
  var stcls = st==='done' ? 'done' : (st==='idle' ? 'idle' : 'working');
  var avatar = w.isMain ? '🧑\\u200d💻' : '🤝';
  var action = w.tool ? (toolIcon(w.tool)+' '+w.tool + (w.action ? ' — '+w.action : ''))
                      : (w.action || (st==='working' ? '💭 réflexion en cours…' : '—'));

  // coéquipiers de la même session
  var team = '';
  if(w.isMain){
    var subs = [];
    for(var k in workers){ var o = workers[k]; if(o.sid===w.sid && !o.isMain && o.mode!=='leave') subs.push(o); }
    if(subs.length){
      var rows = subs.map(function(o){
        var act = o.tool ? (toolIcon(o.tool)+' '+o.tool) : (o.action || 'en renfort…');
        return '<div class="tm row3" data-key="'+esc(o.key)+'"><span class="tdot"></span>'+(o.roleIcon||'')
             + ' <span class="tn">'+esc(o.type||'agent')+'</span>'
             + '<span class="ta">'+esc(act)+'</span></div>';
      }).join('');
      team = '<div class="row"><div class="lbl">Discute avec ('+subs.length+')</div><div class="team">'+rows+'</div></div>';
    }
  }

  var html =
      '<div class="ch">'
      + '<span class="cav">'+avatar+'</span>'
      + '<div style="min-width:0"><div class="ct">'+esc(w.name)+'</div>'
        + '<div class="csub">'+(w.isMain?'agent principal':'sous-agent · '+esc(w.type||''))+(w.host&&w.host!=='local'?' · 🖥️ '+esc(w.host):'')+'</div></div>'
      + '<span class="cbadge '+stcls+'">'+esc(st)+'</span>'
      + '<span class="cx">✕</span>'
    + '</div>'
    + '<div class="cbody">'
      + (w.task ? '<div class="row"><div class="lbl">Tâche</div><div class="val task">'+esc(w.task)+'</div></div>' : '')
      + '<div class="row"><div class="lbl">En cours</div><div class="val mono">'+esc(action)+'</div></div>'
      + '<div class="row"><div class="lbl">Durée · Actions · Échecs</div><div class="val">⏱ '+(w.startedAt?durShort(Date.now()-w.startedAt):'—')+'   ·   ⚙ '+(w.actions||0)+'   ·   ❌ '+(w.fails||0)+(w.actions?' ('+Math.round(100*(w.fails||0)/w.actions)+'%)':'')+'</div></div>'
      + (w.alert ? '<div class="row"><div class="lbl">⚠ Alerte</div><div class="val alert">'+esc(w.alertMsg)+'</div></div>' : '')
      + histRow(w)
      + sparkRow(w)
      + filesRow(w)
      + toolsRow(w)
      + '<div class="row"><div class="lbl">Contrôle</div><div class="ctrl">'
        + '<span class="cbtn" data-act="convo">💬 Conversation</span>'
        + (w.isMain ? '<span class="cbtn" data-act="subs">🔎 Sous-agents</span>' : '')
        + '<span class="cbtn" data-act="hist">🕘 Historique</span>'
        + '<span class="cbtn '+(w.paused?'on':'')+'" data-act="'+(w.paused?'resume':'pause')+'">'+(w.paused?'▶ Reprendre':'⏸ Pause')+'</span>'
        + (w.tool ? '<span class="cbtn danger" data-act="block" data-tool="'+esc(w.tool)+'">🚫 Bloquer '+esc(w.tool)+'</span>' : '')
        + '<span class="cbtn '+(w.approval?'on':'')+'" data-act="'+(w.approval?'approvalOff':'approvalOn')+'">'+(w.approval?'🔓 Auto ON':'🖐️ Exiger OK')+'</span>'
        + ((w.blockedTools&&w.blockedTools.length) ? '<span class="cbtn" data-act="unblock">Débloquer ('+w.blockedTools.length+')</span>' : '')
        + '<span class="cbtn '+(pinnedKey===w.key?'on':'')+'" data-act="pin">📌 '+(pinnedKey===w.key?'Épinglé':'Focus')+'</span>'
      + '</div></div>'
      + team
    + '</div>';

  if(html !== _cardHtml){ _cardHtml = html; card.innerHTML = html; }
  if(!card.classList.contains('open')) card.classList.add('open');
}
card.addEventListener('click', function(e){
  if(e.target.closest('.cx')){ selectedKey = null; card.classList.remove('open'); _cardHtml=''; return; }
  var tm = e.target.closest('.tm'); // clic sur un sous-agent → l'inspecter
  if(tm && tm.getAttribute('data-key') && workers[tm.getAttribute('data-key')]){
    selectedKey = tm.getAttribute('data-key'); _cardHtml=''; updateCard(); if(lastData) updateLog(lastData); return;
  }
  var btn = e.target.closest('.cbtn'); if(!btn) return;
  var w = selectedKey ? workers[selectedKey] : null; if(!w) return;
  var act = btn.getAttribute('data-act');
  if(act === 'hist'){ openHist(w.sid, w.name); return; }
  if(act === 'convo'){ openConvo(w.sid, w.name); return; }
  if(act === 'subs'){ openSubs(w.sid, w.name); return; }
  if(act === 'pin'){ pinnedKey = (pinnedKey===w.key) ? null : w.key; _cardHtml=''; updateCard(); return; }
  var body = { action: act, session: w.sid };
  if(act === 'block') body.tool = btn.getAttribute('data-tool');
  fetch('/control', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }).catch(function(){});
});

// clic = inspecter un agent ; glisser un bureau = le déplacer (éditeur)
var drag = null, pan = null;
function stopSpot(){ if(spotlight){ spotlight=false; document.getElementById('spotBtn').classList.remove('on'); } }
// molette = zoom (vers le curseur)
cv.addEventListener('wheel', function(e){
  e.preventDefault(); stopSpot();
  var before = s2w(e.offsetX, e.offsetY);
  var f = e.deltaY < 0 ? 1.15 : 0.87;
  cam.s = cam.ts = Math.max(0.4, Math.min(5, cam.ts * f));
  var after = s2w(e.offsetX, e.offsetY);   // garde le point sous le curseur fixe
  cam.fx += before.x - after.x; cam.fy += before.y - after.y; cam.tfx = cam.fx; cam.tfy = cam.fy;
}, { passive:false });
cv.addEventListener('pointerdown', function(e){
  var wp = s2w(e.offsetX, e.offsetY);
  if(hitTest(wp.x, wp.y)) return;                    // sur un agent → sélection au relâchement
  var di = deskAt(wp.x, wp.y);
  if(di >= 0){ drag = { idx:di, moved:false, ok:true, cell:{c:desks[di].c, r:desks[di].r} }; try{ cv.setPointerCapture(e.pointerId); }catch(x){} return; }
  pan = { sx:e.offsetX, sy:e.offsetY, fx:cam.fx, fy:cam.fy, moved:false };   // glisser le fond = panoramique
  stopSpot(); try{ cv.setPointerCapture(e.pointerId); }catch(x){}
});
cv.addEventListener('pointermove', function(e){
  if(pan){
    cam.fx = pan.fx - (e.offsetX - pan.sx)/cam.s; cam.fy = pan.fy - (e.offsetY - pan.sy)/cam.s;
    cam.tfx = cam.fx; cam.tfy = cam.fy;
    if(Math.abs(e.offsetX-pan.sx)+Math.abs(e.offsetY-pan.sy) > 3){ pan.moved = true; cv.classList.add('hot'); }
    return;
  }
  var wp = s2w(e.offsetX, e.offsetY);
  if(drag){
    var cell = cellAt(wp.x, wp.y);
    drag.cell = cell; drag.ok = deskFree(cell.c, cell.r, drag.idx); drag.moved = true;
    cv.classList.add('hot');
    return;
  }
  hoverKey = hitTest(wp.x, wp.y);
  cv.classList.toggle('hot', !!hoverKey);
  var tip = document.getElementById('tip');
  if(hoverKey && workers[hoverKey]){
    var hw = workers[hoverKey];
    tip.innerHTML = '<div class="tn">'+esc(hw.name)+(hw.isMain?'':' · '+esc(hw.type||''))+(hw.host&&hw.host!=='local'?' · 🖥️'+esc(hw.host):'')+'</div>'
      + (hw.isMain && hw.task ? '<div class="tt">'+esc(hw.task)+'</div>' : '')
      + (hw.action ? '<div class="ta">'+esc(hw.action)+'</div>' : '');
    tip.style.left = Math.min(STW-270, e.clientX+14) + 'px'; tip.style.top = (e.clientY+14) + 'px'; tip.classList.add('show');
  } else tip.classList.remove('show');
});
cv.addEventListener('pointerleave', function(){ document.getElementById('tip').classList.remove('show'); });
cv.addEventListener('pointerup', function(e){
  if(pan){ var pmoved = pan.moved; pan = null; cv.classList.remove('hot'); if(pmoved) return; }  // panoramique, pas de sélection
  if(drag){
    if(drag.moved && drag.ok) moveDesk(drag.idx, drag.cell.c, drag.cell.r);
    var moved = drag.moved; drag = null; cv.classList.remove('hot');
    if(moved) return;                                // c'était un déplacement, pas une sélection
  }
  var wp = s2w(e.offsetX, e.offsetY);
  var k = hitTest(wp.x, wp.y);
  selectedKey = (k && k===selectedKey) ? null : k;
  updateCard();
  if(lastData) updateLog(lastData);   // le log se filtre sur l'agent sélectionné
});
// double-clic : zoom caméra sur l'agent (ou dézoom sur le vide)
cv.addEventListener('dblclick', function(e){
  var wp = s2w(e.offsetX, e.offsetY), k = hitTest(wp.x, wp.y);
  if(k){ var w = workers[k]; cam.ts = 2.2; cam.tfx = px(w.fc, w.fr); cam.tfy = py(w.fc, w.fr); }
  else { cam.ts = 1; var c = officeCenter(); cam.tfx = c.x; cam.tfy = c.y; }
});
document.addEventListener('keydown', function(e){
  if((e.ctrlKey||e.metaKey) && (e.key||'').toLowerCase()==='k'){ e.preventDefault(); openPalette(); return; }
  if(e.target && e.target.tagName === 'INPUT') return;
  var k = (e.key||'').toLowerCase();
  if(e.key === 'Escape'){ selectedKey=null; card.classList.remove('open'); _cardHtml=''; listEl.classList.remove('open'); statsEl.classList.remove('open'); histEl.classList.remove('open'); radarEl.classList.remove('open'); document.getElementById('cfg').classList.remove('open'); convoEl.classList.remove('open'); notifEl.classList.remove('open'); libEl.classList.remove('open'); if(lastData) updateLog(lastData); return; }
  if(k === 'f'){ toggleTV(); }
  else if(k === 's'){ document.getElementById('statsBtn').click(); }
  else if(k === 'h'){ document.getElementById('histBtn').click(); }
  else if(k === 't'){ teamBtn.click(); }
  else if(k === 'l'){ document.getElementById('theme').click(); }
  else if(k === 'm'){ document.getElementById('listBtn').click(); }
  else if(k === '/'){ e.preventDefault(); qInput.focus(); }
  else if(k === 'z'){ cam.ts = 1; var c = officeCenter(); cam.tfx = c.x; cam.tfy = c.y; }  // reset zoom
  else if(k === 'r'){ rotateIso(e.shiftKey ? -1 : 1); }   // pivoter la vue iso
});

// panneau Équipe : toggle + clic sur une session → sélectionne son chef
var teamBtn = document.getElementById('teamBtn');
teamBtn.addEventListener('click', function(){ var on = teamEl.classList.toggle('open'); teamBtn.classList.toggle('on', on); });
teamEl.addEventListener('click', function(e){
  var grp = e.target.closest('.tgrp');
  if(grp){ var p = grp.getAttribute('data-proj'); collapsedProj[p] = !collapsedProj[p]; if(lastData) updateTeam(lastData); return; }
  var row = e.target.closest('.row2'); if(!row) return;
  var sid = row.getAttribute('data-sid');
  selectedKey = sid + ':main'; updateCard(); if(lastData) updateLog(lastData);
});

// replier / déplacer le panneau Équipe
var teamHead = document.getElementById('teamHead');
var teamCol = document.getElementById('teamCol');
teamCol.addEventListener('click', function(e){
  e.stopPropagation();
  var c = teamEl.classList.toggle('collapsed');
  try{ localStorage.setItem('agentOfficeTeamCol', c ? '1' : '0'); }catch(x){}
});
var tdrag = null;
teamHead.addEventListener('pointerdown', function(e){
  if(e.target === teamCol) return;
  var r = teamEl.getBoundingClientRect();
  tdrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  try{ teamHead.setPointerCapture(e.pointerId); }catch(x){}
});
teamHead.addEventListener('pointermove', function(e){
  if(!tdrag) return;
  var x = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - tdrag.dx));
  var y = Math.max(56, Math.min(window.innerHeight - 40, e.clientY - tdrag.dy));
  teamEl.style.left = x + 'px'; teamEl.style.top = y + 'px'; teamEl.style.right = 'auto';
});
teamHead.addEventListener('pointerup', function(){
  if(!tdrag) return; tdrag = null;
  try{ localStorage.setItem('agentOfficeTeamPos', JSON.stringify({ x:parseInt(teamEl.style.left), y:parseInt(teamEl.style.top) })); }catch(x){}
});
try{
  if(localStorage.getItem('agentOfficeTeamCol') === '1') teamEl.classList.add('collapsed');
  var tp = JSON.parse(localStorage.getItem('agentOfficeTeamPos') || 'null');
  if(tp){ teamEl.style.left = tp.x + 'px'; teamEl.style.top = tp.y + 'px'; teamEl.style.right = 'auto'; }
}catch(x){}

// nettoyage manuel des sessions inactives
document.getElementById('prune').addEventListener('click', function(){
  fetch('/prune', { method:'POST' }).catch(function(){});
});

// mode plein écran / TV
function toggleTV(){
  var on = document.body.classList.toggle('tv');
  try{
    if(on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    else if(!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
  }catch(e){}
  setTimeout(resize, 80);
}
document.getElementById('tvBtn').addEventListener('click', toggleTV);

// vue liste compacte
document.getElementById('listBtn').addEventListener('click', function(){
  var on = listEl.classList.toggle('open'); this.classList.toggle('on', on);
  if(on && lastData) updateList(lastData);
});
listEl.addEventListener('click', function(e){
  var r = e.target.closest('.row2'); if(!r) return;
  selectedKey = r.getAttribute('data-sid') + ':main';
  listEl.classList.remove('open'); document.getElementById('listBtn').classList.remove('on');
  updateCard(); if(lastData) updateLog(lastData);
});

// panneau statistiques
document.getElementById('statsBtn').addEventListener('click', function(){
  var on = statsEl.classList.toggle('open'); this.classList.toggle('on', on);
  if(on && lastData) updateStats(lastData);
});
statsEl.addEventListener('click', function(e){
  if(e.target.closest('.durcfg')){
    var v = prompt('Alerte si une session dépasse (minutes) — 0 pour désactiver :', durAlertMin);
    if(v !== null){ durAlertMin = parseInt(v) || 0; try{ localStorage.setItem('agentOfficeDurAlert', durAlertMin); }catch(x){} if(lastData) updateStats(lastData); }
  }
});

// webhook Slack/Discord (raccourci direct)
document.getElementById('hookBtn').addEventListener('click', function(){
  var v = prompt('URL du webhook (Slack / Discord / Teams) — laisser vide pour désactiver :', '');
  if(v !== null){ fetch('/webhook', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: v.trim() }) }).catch(function(){}); }
});

// ── approbation (human-in-the-loop) : marqueur + carte HTML ancrée près du perso ──
var approveEl = document.getElementById('approve');
function approve(id, d){ fetch('/approve', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id:id, decision:d }) }).catch(function(){}); var c=approveEl.querySelector('[data-card="'+id+'"]'); if(c) c.remove(); }
// monde → écran (inverse de la caméra)
function w2s(wx, wy){ return { x: (STW/2 - cam.fx*cam.s) + wx*cam.s, y: (STH/2 - cam.fy*cam.s) + wy*cam.s }; }
function drawApproval(w, t){   // petit marqueur clignotant au-dessus du perso
  if(!w.approvalReq) return;
  var x = px(w.fc, w.fr), y = py(w.fc, w.fr) - TILE*0.6, s = 1 + 0.25*Math.abs(Math.sin(t*5));
  ctx.font = Math.round(TILE*0.3*s) + 'px "Segoe UI",sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('🖐️', x, y);
}
function updateApprovalCards(){
  var seen = {};
  for(var wk in workers){ var w = workers[wk]; if(!w.approvalReq) continue;
    var id = w.approvalReq.id; seen[id] = 1;
    var card = approveEl.querySelector('[data-card="'+id+'"]');
    if(!card){
      card = document.createElement('div'); card.className = 'apc'; card.setAttribute('data-card', id);
      card.innerHTML = '<div class="apt">🖐️ <b>'+esc(w.name)+'</b> veut exécuter <b>'+esc(w.approvalReq.tool)+'</b></div>'
        + (w.approvalReq.detail ? '<div class="apr">'+esc(w.approvalReq.detail)+'</div>' : '')
        + '<div class="apb"><button class="ok">✅ Autoriser</button><button class="no">⛔ Refuser</button></div>';
      card.querySelector('.ok').addEventListener('click', function(){ approve(id, 'allow'); });
      card.querySelector('.no').addEventListener('click', function(){ approve(id, 'deny'); });
      approveEl.appendChild(card);
    }
    var sc = w2s(px(w.fc, w.fr), py(w.fc, w.fr) - TILE*0.9);
    card.style.left = sc.x + 'px'; card.style.top = sc.y + 'px';
  }
  // retire les cartes dont l'approbation n'existe plus
  var cards = approveEl.children;
  for(var i=cards.length-1;i>=0;i--){ if(!seen[cards[i].getAttribute('data-card')]) cards[i].remove(); }
}

// ── conversation live (prose de l'agent depuis le transcript) ─────────────────
var convoEl = document.getElementById('convo'), convoBody = document.getElementById('convoBody'), convoTitle = document.getElementById('convoTitle'), convoSid = '', convoMode = 'chat';
function openConvo(sid, name){ convoSid = sid; convoMode = 'chat'; convoTitle.textContent = '💬 ' + (name||''); convoEl.classList.add('open'); fetchConvo(); }
function openSubs(sid, name){ convoSid = sid; convoMode = 'subs'; convoTitle.textContent = '🔎 Sous-agents · ' + (name||''); convoEl.classList.add('open'); fetchConvo(); }
function fetchConvo(){
  if(!convoSid) return;
  if(convoMode === 'subs'){
    fetch('/api/subagents?session=' + encodeURIComponent(convoSid)).then(function(r){ return r.json(); }).then(function(d){
      var a = d.acts || [];
      convoBody.innerHTML = a.length ? a.map(function(x){
        return x.text ? '<div class="msg assistant"><span class="r">sous-agent · note</span>'+esc(x.detail)+'</div>'
                      : '<div class="msg user"><span class="r">'+esc(x.tool||'outil')+'</span>'+esc(x.detail||'')+'</div>';
      }).join('') : '<div style="padding:16px;color:#5c6b7e">Aucune activité de sous-agent détectée dans le transcript.</div>';
      convoBody.scrollTop = convoBody.scrollHeight;
    }).catch(function(){});
    return;
  }
  fetch('/api/transcript?session=' + encodeURIComponent(convoSid) + '&limit=40').then(function(r){ return r.json(); }).then(function(d){
    var m = d.messages || [];
    convoBody.innerHTML = m.length ? m.map(function(x){ return '<div class="msg '+x.role+'"><span class="r">'+x.role+'</span>'+esc(x.text)+'</div>'; }).join('') : '<div style="padding:16px;color:#5c6b7e">Pas de conversation lisible.</div>';
    convoBody.scrollTop = convoBody.scrollHeight;
  }).catch(function(){});
}
document.getElementById('convoX').addEventListener('click', function(){ convoEl.classList.remove('open'); convoSid = ''; });
setInterval(function(){ if(convoEl.classList.contains('open')) fetchConvo(); }, 3000);

// ── command palette (Ctrl+K) ──────────────────────────────────────────────────
var palEl = document.getElementById('palette'), palInput = document.getElementById('palInput');
function openPalette(){ palEl.classList.add('open'); palInput.value=''; palInput.focus(); }
function closePalette(){ palEl.classList.remove('open'); }
function findSession(name){ name=(name||'').toLowerCase(); for(var wk in workers){ var w=workers[wk]; if(w.isMain && (w.name||'').toLowerCase().indexOf(name)>=0) return w; } return null; }
function ctrl(action, sid){ fetch('/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action,session:sid})}).catch(function(){}); }
function runCommand(txt){
  txt=(txt||'').trim(); if(!txt){ closePalette(); return; }
  var parts=txt.split(/\s+/), cmd=parts[0].toLowerCase(), rest=parts.slice(1).join(' '), w;
  if(cmd==='pause'||cmd==='resume'){ w=findSession(rest); if(w) ctrl(cmd, w.sid); }
  else if(cmd==='focus'){ w=findSession(rest); pinnedKey=w?w.key:null; }
  else if(cmd==='unfocus'||cmd==='clear'){ pinnedKey=null; filter=''; qInput.value=''; }
  else if(cmd==='search'){ openHist('', 'tout'); histQ.value=rest; fetchHist(); }
  else if(cmd==='night'){ nightState='night'; } else if(cmd==='day'){ nightState='day'; }
  else if(cmd==='light'){ if(!themeLight) document.getElementById('theme').click(); }
  else if(cmd==='dark'){ if(themeLight) document.getElementById('theme').click(); }
  else if(cmd==='tv'){ toggleTV(); }
  else if(cmd==='stats'){ document.getElementById('statsBtn').click(); }
  else if(cmd==='team'){ teamBtn.click(); }
  else if(cmd==='list'){ document.getElementById('listBtn').click(); }
  else if(cmd==='radar'){ document.getElementById('radarBtn').click(); }
  else if(cmd==='replay'){ document.getElementById('replayBtn').click(); }
  else if(cmd==='iso'){ document.getElementById('isoBtn').click(); }
  else if(cmd==='prune'){ fetch('/prune',{method:'POST'}).catch(function(){}); }
  closePalette();
}
palInput.addEventListener('keydown', function(e){ if(e.key==='Enter') runCommand(palInput.value); else if(e.key==='Escape') closePalette(); });

// vue isométrique
(function(){ var b=document.getElementById('isoBtn'); b.classList.toggle('on', iso3d);
  b.addEventListener('click', function(){
    iso3d = !iso3d; b.classList.toggle('on', iso3d);
    try{ localStorage.setItem('agentOfficeIso', iso3d?'1':'0'); }catch(e){}
    cam.ts = 1; resize(); cam.fx = cam.tfx; cam.fy = cam.tfy;   // recalcule la projection et recadre
  });
})();
function rotateIso(dir){
  if(!iso3d){ iso3d = true; document.getElementById('isoBtn').classList.add('on'); try{ localStorage.setItem('agentOfficeIso','1'); }catch(e){} }
  isoRot = (isoRot + dir + 4) % 4;
  cam.ts = 1; resize(); cam.fx = cam.tfx; cam.fy = cam.tfy;
}
document.getElementById('rotBtn').addEventListener('click', function(){ rotateIso(1); });

// radar d'anomalies
document.getElementById('radarBtn').addEventListener('click', function(){
  var on = radarEl.classList.toggle('open'); this.classList.toggle('on', on); if(on) updateRadar();
});
radarEl.addEventListener('click', function(e){
  var row = e.target.closest('.an'); if(!row) return;
  var k = row.getAttribute('data-key'); if(workers[k]){ selectedKey = k; updateCard(); if(lastData) updateLog(lastData); }
});

// sons d'ambiance (cliquetis clavier) — off par défaut
document.getElementById('ambBtn').addEventListener('click', function(){
  ambientOn = !ambientOn; this.classList.toggle('on', ambientOn); if(ambientOn) ensureAudio();
});

// projecteur : suivre l'agent actif
document.getElementById('spotBtn').addEventListener('click', function(){
  spotlight = !spotlight; this.classList.toggle('on', spotlight);
  if(!spotlight){ cam.ts=1; var c=officeCenter(); cam.tfx=c.x; cam.tfy=c.y; }
});

// centre de notifications
var notifEl = document.getElementById('notif'), lastNotifTs = 0;
notifEl.innerHTML = '<h3>🛎️ Notifications <span class="nx">✕</span></h3><div class="nb"></div>';
function updateNotif(state){
  var f = state.feed || [];
  var items = f.filter(function(e){ return e.kind==='PostToolUseFailure'||e.kind==='Stop'||e.kind==='SessionEnd'; }).slice(0,40);
  var unseen = items.filter(function(e){ return e.ts > lastNotifTs; }).length + ((state.approvals||[]).length);
  var btn = document.getElementById('notifBtn'), ex = btn.querySelector('.cnt');
  if(unseen>0){ if(!ex){ ex=document.createElement('span'); ex.className='cnt'; btn.appendChild(ex); } ex.textContent = unseen>99?'99+':unseen; }
  else if(ex){ ex.remove(); }
  if(notifEl.classList.contains('open')){
    var rows = (state.approvals||[]).map(function(a){ return '<div class="ni appr"><span class="nt">⏳</span><span class="np">'+esc(a.project)+'</span><span class="nm">🖐️ attend : '+esc(a.tool)+'</span></div>'; }).join('')
      + items.map(function(e){ var cls = e.kind==='PostToolUseFailure'?'fail':'done'; return '<div class="ni '+cls+'"><span class="nt">'+fmtT(e.ts)+'</span><span class="np">'+esc(e.project||'')+'</span><span class="nm">'+esc(e.detail||e.kind)+'</span></div>'; }).join('');
    notifEl.querySelector('.nb').innerHTML = rows || '<div style="padding:16px;color:#5c6b7e">Rien pour l\\'instant.</div>';
  }
}
document.getElementById('notifBtn').addEventListener('click', function(){
  var on = notifEl.classList.toggle('open'); this.classList.toggle('on', on);
  if(on){ lastNotifTs = (lastData && lastData.now) || Date.now(); var ex=this.querySelector('.cnt'); if(ex) ex.remove(); if(lastData) updateNotif(lastData); }
});
notifEl.querySelector('.nx').addEventListener('click', function(){ notifEl.classList.remove('open'); document.getElementById('notifBtn').classList.remove('on'); });

// panneau de configuration unifié
var cfgEl = document.getElementById('cfg');
document.getElementById('cfgBtn').addEventListener('click', function(){
  var on = cfgEl.classList.toggle('open'); this.classList.toggle('on', on);
  if(on){ document.getElementById('cfgDur').value = durAlertMin || 0; renderRules(); renderNotifCfg(); }
});
document.getElementById('cfgX').addEventListener('click', function(){ cfgEl.classList.remove('open'); document.getElementById('cfgBtn').classList.remove('on'); });
document.getElementById('cfgHookSave').addEventListener('click', function(){
  var u = document.getElementById('cfgHook').value.trim();
  fetch('/webhook', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: u }) }).catch(function(){});
});
document.getElementById('cfgDurSave').addEventListener('click', function(){
  durAlertMin = parseInt(document.getElementById('cfgDur').value) || 0;
  try{ localStorage.setItem('agentOfficeDurAlert', durAlertMin); }catch(x){}
});
// règles de notification
var rulesLocal = [];
function renderRules(){
  var el = document.getElementById('cfgRules');
  el.innerHTML = rulesLocal.length ? rulesLocal.map(function(r,i){
    var t = r.type==='errors' ? ('erreurs ≥ '+r.n+(r.project&&r.project!=='*'?' · '+r.project:'')) : ('fichier ~ '+r.text);
    return '<div style="display:flex;gap:6px;align-items:center;font-size:11px;color:var(--dim);margin:3px 0"><span style="flex:1">'+esc(t)+'</span><span class="cbtn2" data-ri="'+i+'" style="padding:2px 7px">✕</span></div>';
  }).join('') : '<div style="font-size:11px;color:#5c6b7e">Aucune règle.</div>';
}
function saveRules(){ fetch('/rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rules:rulesLocal})}).catch(function(){}); renderRules(); }
document.getElementById('ruleAddErr').addEventListener('click', function(){
  var p=document.getElementById('ruleProj').value.trim(); var n=parseInt(document.getElementById('ruleN').value)||3;
  rulesLocal.push({type:'errors',project:p||'*',n:n}); saveRules();
});
document.getElementById('ruleAddFile').addEventListener('click', function(){
  var t=document.getElementById('ruleFile').value.trim(); if(t){ rulesLocal.push({type:'file',text:t}); saveRules(); document.getElementById('ruleFile').value=''; }
});
document.getElementById('cfgRules').addEventListener('click', function(e){
  var b=e.target.closest('[data-ri]'); if(b){ rulesLocal.splice(parseInt(b.getAttribute('data-ri')),1); saveRules(); }
});

// ── config des notifications ──
var NC_EVENTS = [['fail','échec'],['taskDone','tâche finie'],['pipeline','pipeline'],['session','session finie'],['approval','approbation'],['rules','règles'],['subDone','sous-agent'],['stuck','bloqué']];
var ncLocal = { events:{}, quietFrom:0, quietTo:0, role:'', digest:false, projectHooks:{} };
function renderNotifCfg(){
  var ev = ncLocal.events || {};
  document.getElementById('ncEvents').innerHTML = NC_EVENTS.map(function(e){
    return '<label style="display:flex;align-items:center;gap:4px"><input type="checkbox" data-ev="'+e[0]+'" '+(ev[e[0]]?'checked':'')+'> '+e[1]+'</label>';
  }).join('');
  document.getElementById('ncFrom').value = ncLocal.quietFrom||0;
  document.getElementById('ncTo').value = ncLocal.quietTo||0;
  document.getElementById('ncRole').value = ncLocal.role||'';
  document.getElementById('ncDigest').checked = !!ncLocal.digest;
  var ph = ncLocal.projectHooks||{};
  document.getElementById('ncHooks').innerHTML = Object.keys(ph).map(function(p){
    return '<div style="display:flex;gap:6px;align-items:center;font-size:11px;color:var(--dim);margin:3px 0"><span style="flex:1">'+esc(p)+' → …'+esc(String(ph[p]).slice(-12))+'</span><span class="cbtn2" data-ph="'+esc(p)+'" style="padding:2px 7px">✕</span></div>';
  }).join('') || '<div style="font-size:11px;color:#5c6b7e">Aucun.</div>';
}
function saveNotifCfg(){
  var events = {}; document.querySelectorAll('#ncEvents [data-ev]').forEach(function(c){ events[c.getAttribute('data-ev')] = c.checked; });
  var body = { events:events, quietFrom:parseInt(document.getElementById('ncFrom').value)||0, quietTo:parseInt(document.getElementById('ncTo').value)||0,
    role:document.getElementById('ncRole').value.trim(), digest:document.getElementById('ncDigest').checked, projectHooks:ncLocal.projectHooks||{} };
  ncLocal = body;
  fetch('/notifcfg', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }).catch(function(){});
}
document.getElementById('ncSave').addEventListener('click', saveNotifCfg);
document.getElementById('ncAddHook').addEventListener('click', function(){
  var p=document.getElementById('ncProj').value.trim(), u=document.getElementById('ncUrl').value.trim();
  if(p&&u){ ncLocal.projectHooks = ncLocal.projectHooks||{}; ncLocal.projectHooks[p]=u; document.getElementById('ncProj').value=''; document.getElementById('ncUrl').value=''; renderNotifCfg(); saveNotifCfg(); }
});
document.getElementById('ncHooks').addEventListener('click', function(e){
  var b=e.target.closest('[data-ph]'); if(b){ delete ncLocal.projectHooks[b.getAttribute('data-ph')]; renderNotifCfg(); saveNotifCfg(); }
});

// export d'un rapport Markdown de l'état courant
var NL = String.fromCharCode(10);
document.getElementById('rep').addEventListener('click', function(){
  var S = (lastData && lastData.sessions) || [];
  var out = ['# Rapport agent-office', '', '_' + new Date().toLocaleString() + '_', ''];
  for(var i=0;i<S.length;i++){
    var s = S[i], ags = s.agents || {}, tot = 0;
    for(var a in ags) tot += (ags[a].actions || 0);
    out.push('## ' + (s.project||'session') + ' — ' + s.status);
    if(s.lastPrompt) out.push('- Tâche : ' + s.lastPrompt);
    out.push('- Actions : ' + tot);
    for(var aid in ags){ if(aid==='main') continue; var ag = ags[aid]; out.push('  - ' + (ag.type||'agent') + ' (' + ag.status + ')'); }
    out.push('');
  }
  var blob = new Blob([out.join(NL)], { type:'text/markdown' });
  var url = URL.createObjectURL(blob), el = document.createElement('a');
  el.href = url; el.download = 'agent-office-rapport.md'; el.click(); URL.revokeObjectURL(url);
});

// recherche / filtre projet
var qInput = document.getElementById('q');
qInput.addEventListener('input', function(){ filter = qInput.value.trim().toLowerCase(); });

// jour / nuit (cycle : auto → jour → nuit)
var dayBtn = document.getElementById('day');
dayBtn.addEventListener('click', function(){
  nightState = nightState==='auto' ? 'day' : (nightState==='day' ? 'night' : 'auto');
  dayBtn.textContent = nightState==='day' ? '☀️' : (nightState==='night' ? '🌙' : '🌗');
  dayBtn.title = 'Jour/nuit : ' + nightState;
});

// thème clair / sombre (persisté)
var themeBtn = document.getElementById('theme');
function applyTheme(){ document.body.classList.toggle('light', themeLight); themeBtn.classList.toggle('on', themeLight); }
themeBtn.addEventListener('click', function(){
  themeLight = !themeLight;
  try{ localStorage.setItem('agentOfficeTheme', themeLight ? 'light' : 'dark'); }catch(e){}
  applyTheme();
});
try{ themeLight = localStorage.getItem('agentOfficeTheme') === 'light'; }catch(e){}
applyTheme();

// son ON par défaut + permission notifications ; besoin d'un premier geste utilisateur
window.addEventListener('pointerdown', function(){
  ensureAudio();
  try{ if(window.Notification && Notification.permission==='default') Notification.requestPermission(); }catch(e){}
}, { once:true });
var sndBtn = document.getElementById('snd');
sndBtn.addEventListener('click', function(){
  soundOn = !soundOn;
  sndBtn.textContent = soundOn ? '🔊' : '🔇';
  sndBtn.classList.toggle('on', soundOn);
  if(soundOn) ensureAudio();
});

function draw(t){
  ctx.clearRect(0,0,STW,STH);
  ctx.save();
  // caméra : translate + scale (zoom)
  ctx.translate(STW/2 - cam.fx*cam.s, STH/2 - cam.fy*cam.s);
  ctx.scale(cam.s, cam.s);
  drawFloor();

  // liste triée par profondeur (y) : bureaux, déco, workers
  var items = [];
  for(var i=0;i<desks.length;i++) items.push({ y: iso3d?isoDepth(desks[i].c,desks[i].r):(desks[i].r+1)*TILE, kind:'desk', o:desks[i] });
  for(var j=0;j<decos.length;j++) items.push({ y: iso3d?isoDepth(decos[j].c,decos[j].r):(decos[j].r+1)*TILE, kind:'deco', o:decos[j] });
  for(var wk in workers){ var w = workers[wk]; items.push({ y: iso3d?isoDepth(w.fc,w.fr):(w.fr+1)*TILE, kind:'worker', o:w }); }
  items.sort(function(a,b){ return a.y - b.y; });
  for(var k=0;k<items.length;k++){
    var it = items[k];
    if(it.kind==='desk') drawDesk(it.o);
    else if(it.kind==='deco') drawDeco(it.o);
    else { ctx.globalAlpha = matchFilter(it.o) ? 1 : 0.14; drawWorker(it.o, t); ctx.globalAlpha = 1; }
  }
  // plaques de poste : nom du projet fixé à chaque bureau (permanent)
  for(var wp in workers){ var pw = workers[wp]; ctx.globalAlpha = matchFilter(pw) ? 1 : 0.14; drawDeskPlate(pw); ctx.globalAlpha = 1; }
  // discussion entre agents
  drawCollab(t);
  // voile nuit + lampes (avant les libellés UI pour qu'ils restent lisibles)
  drawNight(t);
  // plaque de la salle de réunion (nom du projet)
  drawMeetingLabel();
  // labels de type des sous-agents + alertes "bloqué" + pause + alerte
  for(var wl in workers){ if(matchFilter(workers[wl])){ var lw = workers[wl];
    drawSubLabel(lw); drawStale(lw, t); drawPaused(lw, t); drawAlertMark(lw, t); drawAnomMark(lw, t); } }
  // badges + erreurs (masqués pour les persos filtrés)
  for(var wk2 in workers){ if(matchFilter(workers[wk2])) drawBadge(workers[wk2], t); }
  for(var we in workers){ if(matchFilter(workers[we])) drawError(workers[we], t); }
  for(var ww in workers){ if(matchFilter(workers[ww])) drawWaiting(workers[ww], t); }
  for(var wa in workers){ if(matchFilter(workers[wa])) drawApproval(workers[wa], t); }
  // surbrillance survol + sélection, avec nom uniquement sur l'agent visé
  if(hoverKey && workers[hoverKey] && hoverKey!==selectedKey){ drawRing(workers[hoverKey], false); drawTag(workers[hoverKey]); }
  if(selectedKey && workers[selectedKey]){ drawRing(workers[selectedKey], true); drawTag(workers[selectedKey]); }
  // aperçu de déplacement de bureau (éditeur)
  if(typeof drag !== 'undefined' && drag && drag.moved){
    ctx.save(); ctx.globalAlpha = 0.55;
    ctx.fillStyle = drag.ok ? 'rgba(63,185,80,.45)' : 'rgba(248,81,73,.45)';
    ctx.strokeStyle = drag.ok ? '#3fb950' : '#f85149'; ctx.lineWidth = 2;
    if(iso3d){ tileDiamond(drag.cell.c, drag.cell.r); ctx.fill(); ctx.stroke(); }
    else { var gx = OX + drag.cell.c*TILE, gy = OY + drag.cell.r*TILE; ctx.fillRect(gx, gy, TILE, TILE); ctx.strokeRect(gx, gy, TILE, TILE); }
    ctx.restore();
  }
  ctx.restore();  // fin caméra

  // confettis (espace écran, au-dessus de tout)
  for(var cf=0; cf<confetti.length; cf++){
    var p = confetti[cf];
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.globalAlpha = Math.min(1, p.life);
    ctx.fillStyle = p.c; ctx.fillRect(-4, -3, 8, 6);
    ctx.restore();
  }
  drawMood(t);   // teinte d'ambiance selon l'humeur du bureau
  updateApprovalCards();   // cartes d'approbation HTML ancrées près des persos
  updateCard();
}

// ── resize ────────────────────────────────────────────────────────────────────
function resize(){
  var stage = document.getElementById('stage');
  STW = stage.clientWidth; STH = stage.clientHeight;
  DPR = window.devicePixelRatio || 1;
  cv.width = STW*DPR; cv.height = STH*DPR;
  ctx.setTransform(DPR,0,0,DPR,0,0);
  TILE = Math.floor(Math.min(STW/GW, STH/GH));
  OX = Math.floor((STW - TILE*GW)/2);
  OY = Math.floor((STH - TILE*GH)/2);
  // params isométriques (losange 2:1)
  IW = Math.min(STW / (GW+GH) * 0.98, STH / (GW+GH));
  IH = IW * 0.5;
  ISOX = 0; ISOY = 0;
  var c = officeCenter();
  cam.tfx = c.x; cam.tfy = c.y;
  if(!cam.init){ cam.fx = c.x; cam.fy = c.y; cam.init = true; }
}
window.addEventListener('resize', resize);

// ── boucle ──────────────────────────────────────────────────────────────────
var prev = performance.now()*0.001;
function loop(){
  var t = performance.now()*0.001;
  var dt = Math.min(0.05, t - prev); prev = t;
  if(replaying && replayPlaying){
    replayCur += dt*60000;   // 60× la vitesse réelle
    if(replayCur >= replayT1){ replayCur = replayT1; replayPlaying = false; rpPlay.textContent = '▶'; }
    replaySeek(replayCur);
  }
  update(dt, t);
  draw(t);
  requestAnimationFrame(loop);
}

// ── SSE ────────────────────────────────────────────────────────────────────────
var es;
function connect(){
  es = new EventSource('/events');
  es.onopen = function(){ live.classList.add('live'); };
  es.onmessage = function(m){ try{ var d = JSON.parse(m.data); lastData = d; if(!replaying) applyState(d); }catch(e){} };
  es.onerror = function(){ live.classList.remove('live'); es.close(); setTimeout(connect, 1500); };
}

buildLayout();
resize();
connect();
requestAnimationFrame(loop);
if('serviceWorker' in navigator){ try{ navigator.serviceWorker.register('/sw.js'); }catch(e){} }
})();
</script>
</body>
</html>`;
