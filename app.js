/* ═══════════════════════════════════════════════════════════════════
   OpenHub R1 — Mobile Control Center for Rabbit R1
   8 Tabs: Dashboard, Agents, Tasks, Money, Chat, Arcade, Actions, Status
   Dynamic theme per tab • R1 hardware events • WebSocket real-time
   ═══════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

// ─── Config ────────────────────────────────────────────────────────
const API = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? `http://${location.hostname}:${location.port || 3001}`
  : `http://192.168.0.62:3001`;
const WS_URL = API.replace('http','ws');
const isR1 = typeof PluginMessageHandler !== 'undefined';

// ─── Tab Definitions ───────────────────────────────────────────────
const TABS = [
  { id:'dashboard', icon:'◈', label:'Home',  theme:{ h:180,s:100,l:50 } },
  { id:'agents',    icon:'◎', label:'Agents', theme:{ h:270,s:80,l:55 } },
  { id:'tasks',     icon:'▣', label:'Tasks',  theme:{ h:35,s:100,l:50 } },
  { id:'money',     icon:'◆', label:'Money',  theme:{ h:120,s:80,l:45 } },
  { id:'chat',      icon:'◉', label:'Chat',   theme:{ h:200,s:90,l:55 } },
  { id:'arcade',    icon:'♠', label:'Arcade', theme:{ h:300,s:80,l:55 } },
  { id:'actions',   icon:'⚡', label:'Actions', theme:{ h:55,s:100,l:50 } },
  { id:'status',    icon:'●', label:'Status',  theme:{ h:0,s:0,l:50 } },
];

// ─── State ─────────────────────────────────────────────────────────
let currentTab = 0;
let ws = null;
let wsConnected = false;
let cache = { agents:[], tasks:[], logs:[], stats:{}, streams:[], chat:[] };
let particleCtx = null;
let particles = [];
let currentChatMsg = '';

// ─── DOM ───────────────────────────────────────────────────────────
const $view = document.getElementById('view');
const $tabbar = document.getElementById('tabbar');
const $connPill = document.getElementById('connPill');
const $connText = document.getElementById('connText');

// ─── Initialize ────────────────────────────────────────────────────
function init(){
  buildTabBar();
  initParticles();
  connectWS();
  applyTheme(0);
  renderTab();
  fetchAll();
  setInterval(fetchAll, 15000);
  setupR1Events();
}

// ─── Tab Bar ───────────────────────────────────────────────────────
function buildTabBar(){
  $tabbar.innerHTML = '';
  TABS.forEach((t,i) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (i===currentTab?' active':'');
    btn.innerHTML = `<span class="tab-icon">${t.icon}</span><span>${t.label}</span>`;
    btn.onclick = () => switchTab(i);
    $tabbar.appendChild(btn);
  });
}

function switchTab(idx){
  if(idx<0||idx>=TABS.length||idx===currentTab) return;
  currentTab = idx;
  applyTheme(idx);
  buildTabBar();
  renderTab();
}

function applyTheme(idx){
  const t = TABS[idx].theme;
  const hsl = `hsl(${t.h},${t.s}%,${t.l}%)`;
  const hslDim = `hsl(${t.h},${t.s}%,${Math.max(t.l-30,10)}%)`;
  const hslGlow = `hsl(${t.h},${t.s}%,${Math.min(t.l+10,70)}%)`;
  document.documentElement.style.setProperty('--accent', hsl);
  document.documentElement.style.setProperty('--accent2', hslDim);
  document.documentElement.style.setProperty('--theme-h', t.h);
  document.documentElement.style.setProperty('--theme-s', t.s+'%');
  document.documentElement.style.setProperty('--theme-l', t.l+'%');
}

// ─── R1 Hardware Events ────────────────────────────────────────────
function setupR1Events(){
  // Scroll wheel: switch tabs
  window.addEventListener('scrollUp', () => {
    if(isScrollable()) return;
    switchTab(currentTab - 1);
  });
  window.addEventListener('scrollDown', () => {
    if(isScrollable()) return;
    switchTab(currentTab + 1);
  });
  // Side click: primary action on current tab
  window.addEventListener('sideClick', () => handleSideClick());
  // Long press: toggle connection
  window.addEventListener('longPressStart', () => {
    if(ws && ws.readyState === WebSocket.OPEN) ws.close();
    else connectWS();
  });

  // PC fallbacks
  window.addEventListener('keydown', e => {
    if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if(e.key === 'ArrowUp'){ e.preventDefault(); switchTab(currentTab-1); }
    if(e.key === 'ArrowDown'){ e.preventDefault(); switchTab(currentTab+1); }
    if(e.key === ' '||e.key === 'Enter'){ e.preventDefault(); handleSideClick(); }
    if(e.key === 'Escape') switchTab(0);
    // Number keys 1-8 for direct tab access
    const num = parseInt(e.key);
    if(num >= 1 && num <= 8) switchTab(num - 1);
  });
  window.addEventListener('wheel', e => {
    if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if(isScrollable()) return;
    e.preventDefault();
    if(e.deltaY < 0) switchTab(currentTab - 1);
    else switchTab(currentTab + 1);
  }, {passive:false});
}

function isScrollable(){
  const v = $view;
  return v.scrollTop > 0 && v.scrollTop < (v.scrollHeight - v.clientHeight - 2);
}

function handleSideClick(){
  const tab = TABS[currentTab].id;
  if(tab === 'chat') sendChat();
  if(tab === 'actions') runCurrentAction();
  if(tab === 'arcade') launchRandomGame();
}

// ─── Particle Background ───────────────────────────────────────────
function initParticles(){
  const canvas = document.getElementById('particleBg');
  canvas.width = 240; canvas.height = 282;
  particleCtx = canvas.getContext('2d');
  for(let i=0;i<25;i++){
    particles.push({
      x:Math.random()*240, y:Math.random()*282,
      vx:(Math.random()-0.5)*0.3, vy:(Math.random()-0.5)*0.3,
      r:Math.random()*1.5+0.5, a:Math.random()*0.3+0.1
    });
  }
  animateParticles();
}

function animateParticles(){
  if(!particleCtx) return;
  particleCtx.clearRect(0,0,240,282);
  const h = TABS[currentTab].theme.h;
  particles.forEach(p => {
    p.x += p.vx; p.y += p.vy;
    if(p.x < 0) p.x = 240;
    if(p.x > 240) p.x = 0;
    if(p.y < 0) p.y = 282;
    if(p.y > 282) p.y = 0;
    particleCtx.beginPath();
    particleCtx.arc(p.x, p.y, p.r, 0, Math.PI*2);
    particleCtx.fillStyle = `hsla(${h},100%,70%,${p.a})`;
    particleCtx.fill();
  });
  requestAnimationFrame(animateParticles);
}

// ─── WebSocket ─────────────────────────────────────────────────────
function connectWS(){
  try{
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      wsConnected = true;
      $connPill.classList.remove('offline');
      $connText.textContent = 'LIVE';
    };
    ws.onclose = () => {
      wsConnected = false;
      $connPill.classList.add('offline');
      $connText.textContent = 'OFF';
      setTimeout(connectWS, 5000);
    };
    ws.onerror = () => {};
    ws.onmessage = e => {
      try {
        const d = JSON.parse(e.data);
        handleWSMessage(d);
      } catch(err){}
    };
  } catch(e){
    wsConnected = false;
    $connPill.classList.add('offline');
    $connText.textContent = 'OFF';
  }
}

function handleWSMessage(d){
  if(d.type === 'agent_updated' || d.type === 'agent_added') fetchAgents();
  if(d.type === 'task_created' || d.type === 'task_updated' || d.type === 'task_completed') fetchTasks();
  if(d.type === 'activity_new' || d.type === 'traffic_log' || d.type === 'income_log' || d.type === 'hustler_log' || d.type === 'r1builder_log') fetchLogs();
  if(d.type === 'chat_message') fetchChat();
}

// ─── Data Fetching ─────────────────────────────────────────────────
async function fetchAll(){
  await Promise.all([fetchAgents(), fetchTasks(), fetchLogs(), fetchStats(), fetchStreams(), fetchChat()]);
  if(TABS[currentTab].id === 'dashboard') renderTab();
}

async function fetchAgents(){
  try{
    const r = await fetch(API+'/api/agents');
    const j = await r.json();
    if(j.success) cache.agents = j.agents || [];
  } catch(e){}
}
async function fetchTasks(){
  try{
    const r = await fetch(API+'/api/tasks');
    const j = await r.json();
    if(j.success) cache.tasks = j.tasks || [];
  } catch(e){}
}
async function fetchLogs(){
  try{
    const r = await fetch(API+'/api/activity?limit=30');
    const j = await r.json();
    if(j.success) cache.logs = j.logs || j.activities || [];
  } catch(e){}
}
async function fetchStats(){
  try{
    const r = await fetch(API+'/api/stats');
    const j = await r.json();
    if(j.success) cache.stats = j;
  } catch(e){}
}
async function fetchStreams(){
  try{
    const r = await fetch(API+'/api/income/streams');
    const j = await r.json();
    if(j.success) cache.streams = j.streams || [];
  } catch(e){}
}
async function fetchChat(){
  try{
    const r = await fetch(API+'/api/chat?limit=30');
    const j = await r.json();
    if(j.success) cache.chat = j.messages || [];
  } catch(e){}
}

// ─── Tab Renderers ─────────────────────────────────────────────────
function renderTab(){
  const id = TABS[currentTab].id;
  $view.scrollTop = 0;
  switch(id){
    case 'dashboard': renderDashboard(); break;
    case 'agents': renderAgents(); break;
    case 'tasks': renderTasks(); break;
    case 'money': renderMoney(); break;
    case 'chat': renderChat(); break;
    case 'arcade': renderArcade(); break;
    case 'actions': renderActions(); break;
    case 'status': renderStatus(); break;
  }
}

// ─── Dashboard ─────────────────────────────────────────────────────
function renderDashboard(){
  const s = cache.stats;
  const active = (cache.agents||[]).filter(a=>a.status==='working').length;
  const total = (cache.agents||[]).length;
  const taskTotal = (cache.tasks||[]).length;
  const taskDone = (cache.tasks||[]).filter(t=>t.status==='completed').length;
  const recent = (cache.logs||[]).slice(0,5);

  $view.innerHTML = `
    <div class="stat-grid">
      <div class="stat-box"><div class="stat-num">${total}</div><div class="stat-label">AGENTS</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--success)">${active}</div><div class="stat-label">ACTIVE</div></div>
      <div class="stat-box"><div class="stat-num">${taskTotal}</div><div class="stat-label">TASKS</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--success)">${taskDone}</div><div class="stat-label">DONE</div></div>
    </div>
    <div class="section-title">⚡ Recent Activity</div>
    ${recent.map(l => `
      <div class="activity-item">
        <div class="activity-dot"></div>
        <div class="activity-text"><strong>${esc(l.agent_name||'System')}</strong> ${esc(l.action||'')}</div>
        <div class="activity-time">${timeAgo(l.timestamp)}</div>
      </div>
    `).join('') || '<div class="card" style="text-align:center;color:var(--text-dim)">No activity yet</div>'}
  `;
}

// ─── Agents ────────────────────────────────────────────────────────
function renderAgents(){
  const agents = cache.agents||[];
  $view.innerHTML = `
    <div class="section-title">🤖 Agent Fleet (${agents.length})</div>
    ${agents.map(a => `
      <div class="agent-card">
        <div class="agent-avatar">${a.avatar||'🤖'}</div>
        <div class="agent-info">
          <div class="agent-name">${esc(a.name)}</div>
          <div class="agent-role">${esc(a.role||'')}</div>
          ${a.current_task?`<div class="agent-role" style="color:var(--accent)">▸ ${esc(a.current_task)}</div>`:''}
          ${a.level?`<div class="xp-bar"><div class="xp-fill" style="width:${Math.min(((a.xp||0)%1000)/10,100)}%"></div></div>
          <div class="agent-role">Lvl ${a.level} • ${a.xp||0} XP • ${esc(a.skill||'Generalist')}</div>`:''}
        </div>
        <div class="agent-status ${a.status}">${a.status||'idle'}</div>
      </div>
    `).join('') || '<div class="card" style="text-align:center;color:var(--text-dim)">No agents registered</div>'}
  `;
}

// ─── Tasks ─────────────────────────────────────────────────────────
function renderTasks(){
  const tasks = (cache.tasks||[]).slice(0,20);
  const pending = tasks.filter(t=>t.status==='pending'||t.status==='in-progress');
  const done = tasks.filter(t=>t.status==='completed');
  $view.innerHTML = `
    <div class="section-title">▣ Active Tasks (${pending.length})</div>
    ${pending.map(t => `
      <div class="task-item ${t.priority||''}">
        <div class="task-title">#${t.id} ${esc(t.title)}</div>
        <div class="task-meta">${esc(t.assignee||'unassigned')} • ${t.priority||'medium'} • ${t.status}</div>
        <div class="task-progress"><div class="task-progress-fill" style="width:${t.progress||0}%"></div></div>
      </div>
    `).join('') || '<div class="card" style="text-align:center;color:var(--text-dim)">No active tasks</div>'}
    <div class="section-title">✓ Completed (${done.length})</div>
    ${done.slice(0,5).map(t => `
      <div class="task-item" style="opacity:0.6;border-left-color:var(--success)">
        <div class="task-title" style="text-decoration:line-through">#${t.id} ${esc(t.title)}</div>
        <div class="task-meta">${esc(t.assignee||'')} • done</div>
      </div>
    `).join('') || ''}
  `;
}

// ─── Money ─────────────────────────────────────────────────────────
function renderMoney(){
  const streams = cache.streams||[];
  const active = streams.filter(s=>s.status==='active');
  $view.innerHTML = `
    <div class="money-big">$${(cache.stats.totalDeposited||0).toFixed(2)}</div>
    <div class="money-label">TOTAL EARNED</div>
    <div class="stat-grid" style="margin-top:6px">
      <div class="stat-box"><div class="stat-num">${streams.length}</div><div class="stat-label">STREAMS</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--success)">${active.length}</div><div class="stat-label">ACTIVE</div></div>
    </div>
    <div class="section-title">💰 Income Streams</div>
    ${streams.slice(0,8).map(s => `
      <div class="card">
        <div class="card-row">
          <span class="card-label">${esc(s.name)}</span>
          <span class="agent-status ${s.status==='active'?'working':'idle'}">${s.status}</span>
        </div>
        ${s.method?`<div class="card-row"><span class="card-label" style="font-size:7px;color:var(--text-dim)">${esc(s.method).substring(0,60)}</span></div>`:''}
      </div>
    `).join('') || '<div class="card" style="text-align:center;color:var(--text-dim)">No income streams yet</div>'}
  `;
}

// ─── Chat ──────────────────────────────────────────────────────────
function renderChat(){
  const msgs = (cache.chat||[]).slice(-20);
  $view.innerHTML = `
    <div class="chat-messages" id="chatMsgs">
      ${msgs.map(m => `
        <div class="chat-msg ${m.sender==='Ghost'||m.sender==='You'?'self':'other'}">
          <div class="chat-sender">${esc(m.sender||'')}</div>
          <div class="chat-bubble">${esc(m.message||'')}</div>
        </div>
      `).join('') || '<div style="text-align:center;color:var(--text-dim);padding:20px;font-size:8px">No messages yet. Press side button to send.</div>'}
    </div>
    <div class="chat-input-row">
      <input class="chat-input" id="chatIn" placeholder="Type a message..." maxlength="200">
      <button class="chat-send" onclick="window._oh.sendChat()">▶</button>
    </div>
  `;
  const cm = document.getElementById('chatMsgs');
  if(cm) cm.scrollTop = cm.scrollHeight;
  // Focus handling for R1: use scroll to select, sideClick to type
  const inp = document.getElementById('chatIn');
  if(inp) inp.addEventListener('keydown', e => { if(e.key==='Enter') sendChat(); });
}

function sendChat(){
  const inp = document.getElementById('chatIn');
  const msg = (inp?inp.value:'').trim();
  if(!msg) return;
  if(inp) inp.value = '';
  // Optimistic add
  cache.chat.push({sender:'Ghost',message:msg,timestamp:new Date().toISOString()});
  renderChat();
  fetch(API+'/api/chat/ai', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({message:msg, sender:'Ghost'})
  }).then(r=>r.json()).then(()=>{
    fetchChat().then(()=>{ if(TABS[currentTab].id==='chat') renderChat(); });
  }).catch(()=>{});
}

// ─── Arcade ────────────────────────────────────────────────────────
const GAMES = [
  {name:'Tic Tac Toe',icon:'✕',color:'var(--accent)'},
  {name:'Snake',icon:'🐍',color:'var(--success)'},
  {name:'2048',icon:'🔢',color:'var(--warn)'},
  {name:'Memory',icon:'🃏',color:'var(--accent2)'},
  {name:'Pong',icon:'🏓',color:'var(--accent)'},
  {name:'Flappy',icon:'🐦',color:'var(--success)'},
  {name:'Simon',icon:'🔴',color:'var(--danger)'},
  {name:'Whack Mole',icon:'🔨',color:'var(--warn)'},
];

function renderArcade(){
  const xp = cache.agents?.find(a=>a.name==='R1 Builder')?.xp||0;
  const level = Math.floor(xp/1000)+1;
  $view.innerHTML = `
    <div class="card" style="text-align:center">
      <div style="font-family:'Orbitron',sans-serif;font-size:10px;color:var(--accent)">ARCADE</div>
      <div class="xp-bar" style="margin:4px 0"><div class="xp-fill" style="width:${(xp%1000)/10}%"></div></div>
      <div style="font-size:7px;color:var(--text-dim)">Level ${level} • ${xp} XP</div>
    </div>
    <div class="game-grid">
      ${GAMES.map(g => `
        <div class="game-card" onclick="window._oh.toast('${g.name} coming soon!')">
          <div class="game-icon">${g.icon}</div>
          <div class="game-name">${g.name}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function launchRandomGame(){
  const g = GAMES[Math.floor(Math.random()*GAMES.length)];
  toast(g.name+' coming soon!');
}

// ─── Actions ───────────────────────────────────────────────────────
const ACTIONS = [
  {name:'Run POD Cycle', endpoint:'/api/pod/run', method:'POST', desc:'Generate new print-on-demand designs'},
  {name:'Run Income Brainstorm', endpoint:'/api/income/run', method:'POST', desc:'Brainstorm new passive income streams'},
  {name:'Run Money Hustler', endpoint:'/api/hustler/run', method:'POST', desc:'Hunt for legal income opportunities'},
  {name:'Run Traffic Agent', endpoint:'/api/traffic/run', method:'POST', desc:'Plan customer acquisition strategies'},
  {name:'Run R1 Builder', endpoint:'/api/r1builder/run', method:'POST', desc:'Generate new R1 Creation ideas'},
  {name:'Run Full Monetize', endpoint:'/api/monetize/run', method:'POST', desc:'Full automation: POD + Income + Evolve'},
  {name:'Force Learn', endpoint:'/api/monetize/learn', method:'POST', desc:'Attribute payouts and evolve agents'},
  {name:'Sync PayPal', endpoint:'/api/payouts/sync', method:'POST', desc:'Sync real PayPal payout data'},
];

let currentActionIdx = 0;
function renderActions(){
  $view.innerHTML = `
    <div class="section-title">⚡ Quick Actions</div>
    ${ACTIONS.map((a,i) => `
      <div class="card" style="cursor:pointer;${i===currentActionIdx?'border-color:var(--accent);':''}" onclick="window._oh.runAction(${i})">
        <div style="font-size:9px;font-weight:700;color:var(--text-bright)">${a.name}</div>
        <div style="font-size:7px;color:var(--text-dim)">${a.desc}</div>
      </div>
    `).join('')}
  `;
}

function runAction(idx){
  const a = ACTIONS[idx];
  if(!a) return;
  toast('Running '+a.name+'...');
  fetch(API+a.endpoint, {method:a.method, headers:{'Content-Type':'application/json'}, body:'{}'})
    .then(r=>r.json())
    .then(d => toast(d.message||'Done!'))
    .catch(e => toast('Error: '+e.message));
}

function runCurrentAction(){ runAction(currentActionIdx); }

// ─── Status ────────────────────────────────────────────────────────
function renderStatus(){
  const s = cache.stats;
  const sys = s.system||{};
  $view.innerHTML = `
    <div class="section-title">● System Status</div>
    <div class="status-grid">
      <div class="status-item"><div class="status-val">${wsConnected?'✓':'✗'}</div><div class="status-key">WebSocket</div></div>
      <div class="status-item"><div class="status-val">${sys.cpu||'—'}%</div><div class="status-key">CPU</div></div>
      <div class="status-item"><div class="status-val">${sys.memory||'—'}%</div><div class="status-key">Memory</div></div>
      <div class="status-item"><div class="status-val">${sys.memoryUsedGB||'—'}</div><div class="status-key">RAM Used</div></div>
      <div class="status-item"><div class="status-val">${s.totalAgents||0}</div><div class="status-key">Agents</div></div>
      <div class="status-item"><div class="status-val">${s.totalTasks||0}</div><div class="status-key">Tasks</div></div>
      <div class="status-item"><div class="status-val">${s.completedTasks||0}</div><div class="status-key">Completed</div></div>
      <div class="status-item"><div class="status-val">${s.totalLearnings||0}</div><div class="status-key">Learnings</div></div>
    </div>
    <div class="section-title">📋 Server Info</div>
    <div class="card">
      <div class="card-row"><span class="card-label">Platform</span><span class="card-value">${sys.platform||'—'}</span></div>
      <div class="card-row"><span class="card-label">Hostname</span><span class="card-value" style="font-size:7px">${sys.hostname||'—'}</span></div>
      <div class="card-row"><span class="card-label">Node</span><span class="card-value">${sys.nodeVersion||'—'}</span></div>
      <div class="card-row"><span class="card-label">Uptime</span><span class="card-value">${sys.uptime?Math.floor(sys.uptime/3600)+'h':'—'}</span></div>
      <div class="card-row"><span class="card-label">R1 Device</span><span class="card-value">${isR1?'Yes':'No (Browser)'}</span></div>
    </div>
  `;
}

// ─── Helpers ───────────────────────────────────────────────────────
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function timeAgo(ts){
  if(!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  if(diff < 60000) return 'now';
  if(diff < 3600000) return Math.floor(diff/60000)+'m';
  if(diff < 86400000) return Math.floor(diff/3600000)+'h';
  return Math.floor(diff/86400000)+'d';
}

function toast(msg){
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(()=>{ if(el.parentNode) el.parentNode.removeChild(el); }, 3000);
}

// ─── Global API for inline handlers ────────────────────────────────
window._oh = { sendChat, runAction, toast, runCurrentAction };

// ─── Boot ──────────────────────────────────────────────────────────
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
