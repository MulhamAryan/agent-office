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
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 4519;
const HOST = process.env.HOST || '0.0.0.0';

// ─── State (in-memory) ───────────────────────────────────────────────────────

/** @type {Map<string, Session>} */
const sessions = new Map();
/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();

const MAX_TICKS = 60;      // pulse-lane length per agent
const MAX_FEED = 60;       // global event feed length
const IDLE_MS = 90 * 1000; // after this with no activity → "idle"

const feed = []; // global recent events {ts, session, agent, kind, tool, ok, project}

function now() { return Date.now(); }

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
      if (detail) { session.lastPrompt = detail; agent.lastAction = detail; }
      break;

    case 'PreToolUse':
      session.status = 'working';
      agent.status = 'working';
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
}

// ─── Snapshot + SSE ──────────────────────────────────────────────────────────

function refreshStatuses() {
  const t = now();
  for (const s of sessions.values()) {
    if (s.status === 'working' && t - s.lastActivity > IDLE_MS) s.status = 'idle';
  }
}

function snapshot() {
  refreshStatuses();
  return {
    now: now(),
    sessions: [...sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity),
    feed: [...feed].reverse(),
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
  #stage{position:absolute;inset:52px 0 0 0}
  canvas{display:block;width:100%;height:100%}
  #empty{position:absolute;inset:52px 0 0 0;display:none;align-items:center;justify-content:center;
    color:var(--dim);text-align:center;padding:40px}
  #empty code{color:#4c9aff;background:#121a26;padding:2px 6px;border-radius:4px}
  canvas{cursor:default}
  canvas.hot{cursor:pointer}

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
    <input id="q" type="text" placeholder="🔍 filtrer un projet…" autocomplete="off">
    <span class="sbtn" id="snd" title="Sons (clic pour activer)">🔇</span>
  </div>
</header>
<div id="stage"><canvas id="cv"></canvas></div>
<div id="empty">Bureau vide.<br><br>Branche tes hooks Claude Code vers <code>POST http://localhost:4519/event</code> puis lance une session.</div>
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

  for(c=1;c<GW-1;c++) for(r=1;r<GH-1;r++){
    if(!WALL[key(c,r)] && !BLOCK[key(c,r)] && !CHAIRS[key(c,r)]) walkCells.push({c:c,r:r});
  }
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

// ── entités (un worker par agent) ─────────────────────────────────────────────
var workers = {};   // key -> worker
var deskFor = {};   // sessionId -> deskIndex
var nextDesk = 0;
var retired = {};              // sessions terminées déjà parties (ne pas recréer)
var REST_SECONDS = 18;         // temps de sommeil avant de quitter le bureau
function clockNow(){ return performance.now()*0.001; }
function durShort(ms){
  var s = Math.floor(ms/1000); if(s<60) return s+'s';
  var m = Math.floor(s/60); if(m<60) return m+'m';
  return Math.floor(m/60)+'h'+(m%60)+'m';
}

// ── filtre projet ─────────────────────────────────────────────────────────────
var filter = '';
function matchFilter(w){ return !filter || (w.name||'').toLowerCase().indexOf(filter) >= 0; }

// ── sons (mutables, off par défaut) ───────────────────────────────────────────
var soundOn = false, actx = null, lastSoundTs = 0;
function beep(freq, dur, vol){
  if(!actx) return;
  var o = actx.createOscillator(), g = actx.createGain();
  o.type = 'sine'; o.frequency.value = freq; g.gain.value = vol;
  o.connect(g); g.connect(actx.destination);
  o.start(); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
  o.stop(actx.currentTime + dur);
}
function playSounds(state){
  var f = state.feed || [];
  if(soundOn && actx){
    for(var i=f.length-1; i>=0; i--){          // feed = plus récent en tête → on parcourt du plus ancien au plus récent
      var e = f[i];
      if(e.ts <= lastSoundTs) continue;
      if(e.kind==='PostToolUseFailure') beep(200, 0.2, 0.09);
      else if(e.kind==='PostToolUse') beep(680, 0.05, 0.035);
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
    facing:'up', moving:false, pose:'walk', amenity:null,
    errSeen:0, errUntil:0, errTool:'', actions:0, startedAt:0, restSince:null,
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

  for(var s=0;s<ordered.length;s++){
    var sess = ordered[s];
    var di = deskIndexFor(sess.id);
    var main = (sess.agents && sess.agents.main) ? sess.agents.main : null;

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
      if(main) noteErr(w, main);
      w.home = desks[di].chair;
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
      var sw = workers[sk];
      if(!sw){ sw = workers[sk] = makeWorker(sk, palOf(aid), a.type||'agent', false); }
      sw.name = a.type || 'agent';
      sw.type = a.type || '';
      sw.tool = a.currentTool;
      sw.action = a.lastAction || '';
      sw.task = sess.lastPrompt || '';
      sw.sessStatus = sess.status;
      sw.agentStatus = a.status;
      sw.actions = a.actions || 0;
      sw.startedAt = a.startedAt || sess.startedAt || 0;
      noteErr(sw, a);
      sw.home = subSpot(di, subIdx);
      sw.mode = 'work';
      subIdx++;
    }
  }

  // workers dont la session/agent a disparu → ils partent
  for(var wk in workers){ if(!desired[wk]) workers[wk].mode = 'leave'; }

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

    // (re)calcul du chemin si besoin
    var pend = w.path.length ? w.path[w.path.length-1] : null;
    if(!eq(w.cell, goal) && (!pend || !eq(pend, goal))){
      w.path = bfs(w.cell, goal);
    }

    // suivi du chemin
    w.moving = false;
    if(w.path.length){
      var nx = w.path[0];
      var tx = nx.c, ty = nx.r;
      var dx = tx - w.fc, dy = ty - w.fr;
      var dist = Math.sqrt(dx*dx + dy*dy);
      var step = SPEED * dt;
      if(dist <= step || dist < 0.001){
        w.fc = tx; w.fr = ty; w.cell = {c:tx, r:ty}; w.path.shift();
      } else {
        w.fc += dx/dist * step; w.fr += dy/dist * step;
        w.facing = Math.abs(dx) > Math.abs(dy) ? (dx>0?'right':'left') : (dy>0?'down':'up');
      }
      w.moving = true;
    }

    // arrivée à la porte en mode "leave" → suppression
    if(w.mode==='leave' && eq(w.cell, door()) && !w.path.length){ w.dead = true; }

    // pose
    if(w.moving) w.pose = 'walk';
    else if(w.mode==='work') w.pose = w.tool ? poseFor(w.tool) : 'think';
    else if(w.mode==='rest') w.pose = 'bed';
    else if(w.mode==='relax') w.pose = w.amenity ? w.amenity.type : 'idle';
    else w.pose = 'idle';

    w.sitting = (w.mode==='work') && !w.moving && eq(w.cell, w.home) && w.isMain;
  }
  for(var dk in workers){ if(workers[dk].dead) delete workers[dk]; }
}

// ── rendu ──────────────────────────────────────────────────────────────────────
function px(fc){ return OX + (fc+0.5)*TILE; }
function py(fr){ return OY + (fr+0.5)*TILE; }
function rr(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }

function drawFloor(){
  for(var c=0;c<GW;c++) for(var r=0;r<GH;r++){
    var x = OX + c*TILE, y = OY + r*TILE;
    if(WALL[key(c,r)]){
      ctx.fillStyle = '#2b3a4d'; ctx.fillRect(x,y,TILE,TILE);
      ctx.fillStyle = '#374a61'; ctx.fillRect(x,y,TILE,3);
      ctx.fillStyle = '#1f2a38'; ctx.fillRect(x,y+TILE-3,TILE,3);
    } else {
      ctx.fillStyle = ((c+r)%2===0) ? '#1b2a3c' : '#1f3044';
      ctx.fillRect(x,y,TILE,TILE);
    }
  }
  // tapis d'entrée
  var d = door();
  ctx.fillStyle = '#3a2f4a';
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
    if(w.isMain && w.home && w.home.c===dk.chair.c && w.home.r===dk.chair.r && w.mode==='work') return true;
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
  }
}

function drawWorker(w, t){
  var x = px(w.fc), y = py(w.fr);
  var scale = Math.min(1, (t - w.spawn) / 0.4); // petite anim d'apparition
  var s = TILE * 0.5 * scale;

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
  if(!w.isMain || !w.home) return;
  var cx = OX + (w.home.c + 0.5)*TILE;
  var deskTop = OY + (w.home.r - 1)*TILE;
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

// petit badge d'icône (pas de texte) au-dessus d'un agent qui bosse
function drawBadge(w, t){
  if(w.mode==='leave' || w.moving) return;
  var ic = '';
  if(w.mode==='work' && w.tool) ic = toolIcon(w.tool);
  else if(w.mode==='work' && w.isMain) ic = '💭';
  else if(w.mode==='work' && !w.isMain) ic = '🤝';
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
        return '<div class="tm"><span class="tdot"></span><span class="tn">'+esc(o.type||'agent')+'</span>'
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
      + '<div class="row"><div class="lbl">Durée · Actions</div><div class="val">⏱ '+(w.startedAt?durShort(Date.now()-w.startedAt):'—')+'   ·   ⚙ '+(w.actions||0)+' outils</div></div>'
      + team
    + '</div>';

  if(html !== _cardHtml){ _cardHtml = html; card.innerHTML = html; }
  if(!card.classList.contains('open')) card.classList.add('open');
}
card.addEventListener('click', function(e){
  if(e.target.closest('.cx')){ selectedKey = null; card.classList.remove('open'); _cardHtml=''; }
});
cv.addEventListener('mousemove', function(e){
  hoverKey = hitTest(e.offsetX, e.offsetY);
  cv.classList.toggle('hot', !!hoverKey);
});
cv.addEventListener('click', function(e){
  var k = hitTest(e.offsetX, e.offsetY);
  selectedKey = (k && k===selectedKey) ? null : k;
  updateCard();
});
document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ selectedKey=null; card.classList.remove('open'); _cardHtml=''; } });

// recherche / filtre projet
var qInput = document.getElementById('q');
qInput.addEventListener('input', function(){ filter = qInput.value.trim().toLowerCase(); });

// bouton son (off par défaut : les navigateurs bloquent l'audio avant interaction)
var sndBtn = document.getElementById('snd');
sndBtn.addEventListener('click', function(){
  soundOn = !soundOn;
  sndBtn.textContent = soundOn ? '🔊' : '🔇';
  sndBtn.classList.toggle('on', soundOn);
  if(soundOn && !actx){ try{ actx = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){} }
  if(actx && actx.state === 'suspended') actx.resume();
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
  // badges + erreurs (masqués pour les persos filtrés)
  for(var wk2 in workers){ if(matchFilter(workers[wk2])) drawBadge(workers[wk2], t); }
  for(var we in workers){ if(matchFilter(workers[we])) drawError(workers[we], t); }
  // surbrillance survol + sélection, avec nom uniquement sur l'agent visé
  if(hoverKey && workers[hoverKey] && hoverKey!==selectedKey){ drawRing(workers[hoverKey], false); drawTag(workers[hoverKey]); }
  if(selectedKey && workers[selectedKey]){ drawRing(workers[selectedKey], true); drawTag(workers[selectedKey]); }
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
