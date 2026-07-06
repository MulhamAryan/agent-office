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
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 4519;
const HOST = process.env.HOST || '0.0.0.0';
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'office-state.json');

// ─── State (in-memory) ───────────────────────────────────────────────────────

/** @type {Map<string, Session>} */
const sessions = new Map();
/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();

const MAX_TICKS = 60;      // pulse-lane length per agent
const MAX_FEED = 60;       // global event feed length
const IDLE_MS = 90 * 1000; // after this with no activity → "idle"

const feed = []; // global recent events {ts, session, agent, kind, tool, ok, project}

// ─── Contrôle (kill-switch / blocage d'outils) ───────────────────────────────
const paused = new Set();   // sessionIds en pause (prochain outil bloqué)
const blocked = {};         // sessionId -> [noms d'outils bloqués]

function now() { return Date.now(); }

// ─── Persistance disque (survit au redémarrage) ──────────────────────────────
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const data = JSON.stringify({ sessions: [...sessions.values()], feed });
      fs.writeFile(STATE_FILE, data, () => {});
    } catch { /* jamais bloquant */ }
  }, 1500);
}
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.sessions)) {
      for (const s of data.sessions) { if (s && s.id) sessions.set(s.id, s); }
    }
    if (data && Array.isArray(data.feed)) { feed.push(...data.feed); if (feed.length > MAX_FEED) feed.splice(0, feed.length - MAX_FEED); }
    console.log(`état restauré : ${sessions.size} sessions`);
  } catch { /* pas de fichier / illisible : on démarre à vide */ }
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
    };
    sessions.set(id, s);
  }
  if (ev.cwd && !s.cwd) { s.cwd = ev.cwd; s.project = projectOf(ev.cwd); }
  if (ev.model && !s.model) s.model = ev.model;
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

function handleEvent(ev) {
  const kind = ev.hook_event_name || ev.event || 'Unknown';
  const sid = ev.session_id || ev.sessionId || 'unknown';
  const session = getSession(sid, ev);
  session.lastActivity = now();

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
      if (tool) session.toolCounts[tool] = (session.toolCounts[tool] || 0) + 1;
      break;

    case 'SubagentStart':
      agent.status = 'working';
      break;

    case 'SubagentStop':
      agent.status = 'done';
      agent.currentTool = null;
      break;

    case 'Stop':
      session.status = 'idle';
      for (const a of Object.values(session.agents)) {
        if (a.id === 'main') { a.status = 'idle'; a.currentTool = null; }
      }
      break;

    case 'SessionEnd':
      session.status = 'done';
      session.endedAt = now();
      for (const a of Object.values(session.agents)) { a.status = 'done'; a.currentTool = null; }
      break;

    case 'Notification':
      // Claude attend une action de l'utilisateur (permission, idle…)
      agent.waiting = true;
      agent.notice = detail || ev.message || 'attend une action';
      break;

    default:
      break;
  }

  pushFeed({
    ts: now(),
    session: sid,
    project: session.project,
    agent: agent.id,
    agentType: agent.type,
    kind,
    tool,
    detail,
    ok: kind !== 'PostToolUseFailure',
  });

  broadcast();
  scheduleSave();
}

// ─── Snapshot + SSE ──────────────────────────────────────────────────────────

function refreshStatuses() {
  const t = now();
  for (const [id, s] of sessions) {
    if (s.status === 'working' && t - s.lastActivity > IDLE_MS) s.status = 'idle';
    // purge auto : session terminée depuis > 5 min, ou totalement inactive depuis > 30 min
    if ((s.status === 'done' && s.endedAt && t - s.endedAt > 5 * 60 * 1000) ||
        (t - s.lastActivity > 30 * 60 * 1000)) {
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
      try { handleEvent(JSON.parse(raw)); }
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

  // POST /gate-check — appelé par le hook PreToolUse : doit-on bloquer cet outil ?
  if (req.method === 'POST' && url.pathname === '/gate-check') {
    const raw = await readBody(req);
    let block = false, reason = '';
    try {
      const ev = JSON.parse(raw || '{}');
      const sid = ev.session_id || ev.sessionId || '';
      const tool = ev.tool_name || ev.toolName || '';
      if (paused.has(sid)) { block = true; reason = 'Session en pause depuis le bureau agent-office.'; }
      else if (blocked[sid] && blocked[sid].includes(tool)) { block = true; reason = 'Outil ' + tool + ' bloqué depuis agent-office.'; }
    } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ block, reason }));
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
    } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    broadcast();
    return;
  }

  // POST /prune — supprime les sessions non actives (terminées / inactives)
  if (req.method === 'POST' && url.pathname === '/prune') {
    for (const [id, s] of sessions) { if (s.status !== 'working') sessions.delete(id); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    broadcast();
    scheduleSave();
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
setInterval(() => { if (sseClients.size) broadcast(); }, 5000);

// ─── UI : bureau virtuel (Canvas 2D, single-file) ────────────────────────────

const HTML = /* html */ `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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

  /* historique d'outils (pulse-lane) dans le panneau détail */
  #card .cticks{display:flex;gap:2px;flex-wrap:wrap;align-items:center}
  #card .ctk{width:5px;height:13px;border-radius:1px;background:#4c9aff;opacity:.9}
  #card .ctk.bad{background:#f85149}
  #card .val.alert{color:var(--amber)}
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
    <span class="sbtn" id="prune" title="Nettoyer les sessions inactives">🧹</span>
    <span class="sbtn" id="rep" title="Exporter un rapport Markdown">📄</span>
    <span class="sbtn" id="theme" title="Thème clair / sombre">🌓</span>
    <span class="sbtn" id="day" title="Jour / nuit">🌗</span>
    <span class="sbtn on" id="snd" title="Sons (fin d'agent + erreurs)">🔊</span>
  </div>
</header>
<div id="stage"><canvas id="cv"></canvas></div>
<div id="empty">Bureau vide.<br><br>Branche tes hooks Claude Code vers <code>POST http://localhost:4519/event</code> puis lance une session.</div>
<div id="team" class="open">
  <div id="teamHead"><span>👥 Équipe</span><span id="teamTot" class="tot"></span><span id="teamCol" title="Replier">▾</span></div>
  <div id="teamBody"></div>
</div>
<div id="log"></div>
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
  MEETING = { seats:[ {c:7,r:11},{c:10,r:11},{c:8,r:10},{c:9,r:10},{c:8,r:12},{c:9,r:12} ] };

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
function cellAt(mx,my){ return { c:Math.floor((mx-OX)/TILE), r:Math.floor((my-OY)/TILE) }; }
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
}

// ── thème clair / sombre (palette du canvas) ──────────────────────────────────
var themeLight = false;
function TH(){
  return themeLight
    ? { floorA:'#dde6f1', floorB:'#e8eef6', wall:'#b7c4d5', wallHi:'#cdd8e6', wallLo:'#9fafc2', mat:'#d3c6ea' }
    : { floorA:'#1b2a3c', floorB:'#1f3044', wall:'#2b3a4d', wallHi:'#374a61', wallLo:'#1f2a38', mat:'#3a2f4a' };
}

// ── jour / nuit ───────────────────────────────────────────────────────────────
var nightState = 'auto';  // 'auto' | 'day' | 'night'
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
var soundOn = true, actx = null, lastSoundTs = 0;  // ON par défaut
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
function playSounds(state){
  var f = state.feed || [];
  if(soundOn && actx){
    for(var i=f.length-1; i>=0; i--){          // feed = plus récent en tête → on parcourt du plus ancien au plus récent
      var e = f[i];
      if(e.ts <= lastSoundTs) continue;
      // UNIQUEMENT : fin d'agent (carillon) et erreur (buzz). Rien sur les actions/communication.
      if(e.kind==='PostToolUseFailure') buzzError();
      else if(e.kind==='Stop' || e.kind==='SessionEnd') chimeDone();
    }
  }
  if(f.length) lastSoundTs = Math.max(lastSoundTs, f[0].ts);
}
function deskIndexFor(sid){
  if(deskFor[sid] == null){ deskFor[sid] = nextDesk % desks.length; nextDesk++; }
  return deskFor[sid];
}
var SUB_OFFSETS = [ {dc:-1,dr:0}, {dc:1,dr:0}, {dc:-1,dr:1}, {dc:1,dr:1}, {dc:0,dr:1} ];
function subSpot(deskIdx, subIdx){
  var chair = desks[deskIdx].chair, tries = 0;
  for(var i=0;i<SUB_OFFSETS.length;i++){
    var o = SUB_OFFSETS[(subIdx+i) % SUB_OFFSETS.length];
    var c = chair.c + o.dc, r = chair.r + o.dr;
    if(!blocked(c,r)) return {c:c, r:r};
  }
  return {c:chair.c, r:chair.r+1};
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
function updateTeam(state){
  var S = (state.sessions || []).slice().sort(function(a,b){ return a.startedAt - b.startedAt; });
  var rows = '', totAgents = 0;
  for(var i=0;i<S.length;i++){
    var s = S[i], col = palOf(s.project||s.id).sh, main = s.agents && s.agents.main;
    var act = (main && main.currentTool) ? (toolIcon(main.currentTool)+' '+main.currentTool+(main.lastAction?' — '+main.lastAction:''))
            : (main && main.lastAction ? main.lastAction : (s.lastPrompt||'…'));
    var subs = '', subCount = 0, ags = s.agents || {};
    for(var aid in ags){ if(aid==='main') continue; var a = ags[aid]; if(a.status==='done') continue; subCount++;
      var ri = roleInfo(a.type), life = a.startedAt ? durShort(Date.now()-a.startedAt) : '';
      var sact = a.currentTool ? (toolIcon(a.currentTool)+' '+a.currentTool) : (a.lastAction||'en renfort');
      subs += '<div class="sub">'+ri.icon+' '+esc(a.type||'agent')+'<span class="sa">'+esc(sact)+' · '+life+'</span></div>';
    }
    totAgents += 1 + subCount;
    rows += '<div class="ts"><div class="th row2" data-sid="'+esc(s.id)+'">'
      + '<span class="dot" style="background:'+col+'"></span>'
      + '<span class="pn">'+esc(s.project||'session')+'</span>'
      + (subCount?'<span style="color:#8b98a9;font-size:10px">+'+subCount+'</span>':'')
      + '<span class="stt '+s.status+'">'+esc(s.status)+'</span></div>'
      + '<div class="ac">'+esc(act)+'</div>' + subs + '</div>';
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

// ── application de l'état serveur ─────────────────────────────────────────────
var lastData = null;
function applyState(state){
  lastData = state;
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

  // salle de réunion : la session avec le plus de sous-agents actifs (≥2) s'y installe
  var meetingSid = null, maxSubs = 1;
  meetingName = '';
  for(var mI=0; mI<ordered.length; mI++){
    var ms = ordered[mI], cnt = 0, mags = ms.agents || {};
    for(var ma in mags){ if(ma!=='main' && mags[ma].status!=='done') cnt++; }
    if(cnt > maxSubs){ maxSubs = cnt; meetingSid = ms.id; meetingName = ms.project || 'session'; }
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
      w.paused = (state.paused||[]).indexOf(sess.id) >= 0;
      w.blockedTools = (state.blocked||{})[sess.id] || [];
      w.stale = (sess.status==='working' && (state.now - (sess.lastActivity||0)) > 45000);
      if(main) noteErr(w, main);
      w.deskChair = desks[di].chair;
      w.home = (inMeeting && sess.status==='working') ? MEETING.seats[0] : desks[di].chair;
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
      sw.home = inMeeting ? (MEETING.seats[(subIdx+1) % MEETING.seats.length]) : subSpot(di, subIdx);
      sw.mode = 'work';
      subIdx++;
    }
  }

  // workers dont la session/agent a disparu → ils partent
  for(var wk in workers){ if(!desired[wk]) workers[wk].mode = 'leave'; }

  // alertes + titre d'onglet (nb de sessions en alerte)
  var alerts = 0;
  for(var ak in workers){
    var aw = workers[ak];
    if(aw.waiting){ if(!aw.waitSince) aw.waitSince = clockNow(); } else aw.waitSince = 0;
    computeAlert(aw);
    if(aw.isMain && aw.alert) alerts++;
  }
  document.title = (alerts ? '('+alerts+'⚠) ' : '') + 'agent-office';

  updateLog(state);    // mini-log d'activité
  updateTeam(state);   // panneau Équipe
  checkNotifs();       // notifications navigateur
  playSounds(state);   // sons sur nouveaux events (si activés)
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
}

// ── rendu ──────────────────────────────────────────────────────────────────────
function px(fc){ return OX + (fc+0.5)*TILE; }
function py(fr){ return OY + (fr+0.5)*TILE; }
function rr(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }

function drawFloor(){
  var th = TH();
  for(var c=0;c<GW;c++) for(var r=0;r<GH;r++){
    var x = OX + c*TILE, y = OY + r*TILE;
    if(WALL[key(c,r)]){
      ctx.fillStyle = th.wall; ctx.fillRect(x,y,TILE,TILE);
      ctx.fillStyle = th.wallHi; ctx.fillRect(x,y,TILE,3);
      ctx.fillStyle = th.wallLo; ctx.fillRect(x,y+TILE-3,TILE,3);
    } else {
      ctx.fillStyle = ((c+r)%2===0) ? th.floorA : th.floorB;
      ctx.fillRect(x,y,TILE,TILE);
    }
  }
  // tapis d'entrée
  var d = door();
  ctx.fillStyle = th.mat;
  ctx.fillRect(OX+(d.c-0.5)*TILE, OY+(d.r-1)*TILE, TILE*2, TILE);
}

function drawDesk(dk){
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
  var x = px(w.fc), y = py(w.fr);
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
  // ombre
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.beginPath(); ctx.ellipse(x, y + s*0.55, s*0.5, s*0.18, 0, 0, 7); ctx.fill();

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
  var x = px(w.fc), y = py(w.fr) - TILE*0.62;
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

  var x = px(w.fc), top = py(w.fr) - TILE*0.95;
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
  var x = px(w.fc), y = py(w.fr) + TILE*0.6;
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
    var mx = px(g.main.fc), my = py(g.main.fr) - TILE*0.2;
    for(var i=0;i<g.subs.length;i++){
      var sub = g.subs[i];
      if(sub.mode==='leave') continue;
      var sx = px(sub.fc), sy = py(sub.fr) - TILE*0.2;
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
  var cx = OX + (w.deskChair.c + 0.5)*TILE;
  var deskTop = OY + (w.deskChair.r - 1)*TILE;
  var y = deskTop - 17;
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
  var cx = OX + 9*TILE;                 // centre de la table (cases 8 et 9, r=11)
  var y  = OY + 11*TILE - 6;
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
  var x = px(w.fc), y = py(w.fr) + TILE*0.5;
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
  var x = px(w.fc), y = py(w.fr) - TILE*0.6;
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
  var x = px(w.fc) + Math.sin(t*38)*2, y = py(w.fr) - TILE*0.95;
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
  var x = px(w.fc), y = py(w.fr) - TILE*0.95;
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
  var x = px(w.fc), y = py(w.fr);
  var pulse = 0.4 + 0.5*Math.abs(Math.sin(t*3));
  ctx.save(); ctx.globalAlpha = pulse;
  ctx.strokeStyle = '#f85149'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.ellipse(x, y + TILE*0.1, TILE*0.46, TILE*0.54, 0, 0, 7); ctx.stroke();
  ctx.restore();
}

// marqueur ⚠️ (boucle / échecs / attente) à côté de la tête
function drawAlertMark(w, t){
  if(!w.alert || w.mode==='leave') return;
  var x = px(w.fc) + TILE*0.26, y = py(w.fr) - TILE*0.58;
  var s = 0.9 + 0.15*Math.abs(Math.sin(t*5));
  ctx.font = Math.round(TILE*0.24*s) + 'px "Segoe UI",system-ui,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('⚠️', x, y);
}

// session en pause (kill-switch) : anneau cyan + ⏸
function drawPaused(w, t){
  if(!w.paused || w.mode==='leave') return;
  var x = px(w.fc), y = py(w.fr);
  ctx.save();
  ctx.strokeStyle = '#22b8c0'; ctx.lineWidth = 3; ctx.globalAlpha = 0.5 + 0.4*Math.abs(Math.sin(t*2.5));
  ctx.beginPath(); ctx.ellipse(x, y + TILE*0.1, TILE*0.46, TILE*0.54, 0, 0, 7); ctx.stroke();
  ctx.globalAlpha = 1; ctx.font = Math.round(TILE*0.26)+'px "Segoe UI",sans-serif';
  ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('⏸', x - TILE*0.26, y - TILE*0.58);
  ctx.restore();
}

// anneau de surbrillance (survol / sélection)
function drawRing(w, sel){
  var x = px(w.fc), y = py(w.fr);
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
    var dx = mx - px(w.fc), dy = my - py(w.fr);
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
        + '<div class="csub">'+(w.isMain?'agent principal':'sous-agent · '+esc(w.type||''))+'</div></div>'
      + '<span class="cbadge '+stcls+'">'+esc(st)+'</span>'
      + '<span class="cx">✕</span>'
    + '</div>'
    + '<div class="cbody">'
      + (w.task ? '<div class="row"><div class="lbl">Tâche</div><div class="val task">'+esc(w.task)+'</div></div>' : '')
      + '<div class="row"><div class="lbl">En cours</div><div class="val mono">'+esc(action)+'</div></div>'
      + '<div class="row"><div class="lbl">Durée · Actions · Échecs</div><div class="val">⏱ '+(w.startedAt?durShort(Date.now()-w.startedAt):'—')+'   ·   ⚙ '+(w.actions||0)+'   ·   ❌ '+(w.fails||0)+(w.actions?' ('+Math.round(100*(w.fails||0)/w.actions)+'%)':'')+'</div></div>'
      + (w.alert ? '<div class="row"><div class="lbl">⚠ Alerte</div><div class="val alert">'+esc(w.alertMsg)+'</div></div>' : '')
      + histRow(w)
      + '<div class="row"><div class="lbl">Contrôle</div><div class="ctrl">'
        + '<span class="cbtn '+(w.paused?'on':'')+'" data-act="'+(w.paused?'resume':'pause')+'">'+(w.paused?'▶ Reprendre':'⏸ Pause')+'</span>'
        + (w.tool ? '<span class="cbtn danger" data-act="block" data-tool="'+esc(w.tool)+'">🚫 Bloquer '+esc(w.tool)+'</span>' : '')
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
  if(act === 'pin'){ pinnedKey = (pinnedKey===w.key) ? null : w.key; _cardHtml=''; updateCard(); return; }
  var body = { action: act, session: w.sid };
  if(act === 'block') body.tool = btn.getAttribute('data-tool');
  fetch('/control', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }).catch(function(){});
});

// clic = inspecter un agent ; glisser un bureau = le déplacer (éditeur)
var drag = null;
cv.addEventListener('pointerdown', function(e){
  if(hitTest(e.offsetX, e.offsetY)) return;         // sur un agent → sélection au relâchement
  var di = deskAt(e.offsetX, e.offsetY);
  if(di >= 0){ drag = { idx:di, moved:false, ok:true, cell:{c:desks[di].c, r:desks[di].r} }; try{ cv.setPointerCapture(e.pointerId); }catch(x){} }
});
cv.addEventListener('pointermove', function(e){
  if(drag){
    var cell = cellAt(e.offsetX, e.offsetY);
    drag.cell = cell; drag.ok = deskFree(cell.c, cell.r, drag.idx); drag.moved = true;
    cv.classList.add('hot');
    return;
  }
  hoverKey = hitTest(e.offsetX, e.offsetY);
  cv.classList.toggle('hot', !!hoverKey);
});
cv.addEventListener('pointerup', function(e){
  if(drag){
    if(drag.moved && drag.ok) moveDesk(drag.idx, drag.cell.c, drag.cell.r);
    var moved = drag.moved; drag = null; cv.classList.remove('hot');
    if(moved) return;                                // c'était un déplacement, pas une sélection
  }
  var k = hitTest(e.offsetX, e.offsetY);
  selectedKey = (k && k===selectedKey) ? null : k;
  updateCard();
  if(lastData) updateLog(lastData);   // le log se filtre sur l'agent sélectionné
});
document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ selectedKey=null; card.classList.remove('open'); _cardHtml=''; if(lastData) updateLog(lastData); } });

// panneau Équipe : toggle + clic sur une session → sélectionne son chef
var teamBtn = document.getElementById('teamBtn');
teamBtn.addEventListener('click', function(){ var on = teamEl.classList.toggle('open'); teamBtn.classList.toggle('on', on); });
teamEl.addEventListener('click', function(e){
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
  drawFloor();

  // liste triée par profondeur (y) : bureaux, déco, workers
  var items = [];
  for(var i=0;i<desks.length;i++) items.push({ y:(desks[i].r+1)*TILE, kind:'desk', o:desks[i] });
  for(var j=0;j<decos.length;j++) items.push({ y:(decos[j].r+1)*TILE, kind:'deco', o:decos[j] });
  for(var wk in workers){ var w = workers[wk]; items.push({ y:(w.fr+1)*TILE, kind:'worker', o:w }); }
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
    drawSubLabel(lw); drawStale(lw, t); drawPaused(lw, t); drawAlertMark(lw, t); } }
  // badges + erreurs (masqués pour les persos filtrés)
  for(var wk2 in workers){ if(matchFilter(workers[wk2])) drawBadge(workers[wk2], t); }
  for(var we in workers){ if(matchFilter(workers[we])) drawError(workers[we], t); }
  for(var ww in workers){ if(matchFilter(workers[ww])) drawWaiting(workers[ww], t); }
  // surbrillance survol + sélection, avec nom uniquement sur l'agent visé
  if(hoverKey && workers[hoverKey] && hoverKey!==selectedKey){ drawRing(workers[hoverKey], false); drawTag(workers[hoverKey]); }
  if(selectedKey && workers[selectedKey]){ drawRing(workers[selectedKey], true); drawTag(workers[selectedKey]); }
  // aperçu de déplacement de bureau (éditeur)
  if(typeof drag !== 'undefined' && drag && drag.moved){
    var gx = OX + drag.cell.c*TILE, gy = OY + drag.cell.r*TILE;
    ctx.save(); ctx.globalAlpha = 0.55;
    ctx.fillStyle = drag.ok ? 'rgba(63,185,80,.45)' : 'rgba(248,81,73,.45)';
    ctx.fillRect(gx, gy, TILE, TILE);
    ctx.strokeStyle = drag.ok ? '#3fb950' : '#f85149'; ctx.lineWidth = 2; ctx.strokeRect(gx, gy, TILE, TILE);
    ctx.restore();
  }
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
}
window.addEventListener('resize', resize);

// ── boucle ──────────────────────────────────────────────────────────────────
var prev = performance.now()*0.001;
function loop(){
  var t = performance.now()*0.001;
  var dt = Math.min(0.05, t - prev); prev = t;
  update(dt, t);
  draw(t);
  requestAnimationFrame(loop);
}

// ── SSE ────────────────────────────────────────────────────────────────────────
var es;
function connect(){
  es = new EventSource('/events');
  es.onopen = function(){ live.classList.add('live'); };
  es.onmessage = function(m){ try{ applyState(JSON.parse(m.data)); }catch(e){} };
  es.onerror = function(){ live.classList.remove('live'); es.close(); setTimeout(connect, 1500); };
}

buildLayout();
resize();
connect();
requestAnimationFrame(loop);
})();
</script>
</body>
</html>`;
