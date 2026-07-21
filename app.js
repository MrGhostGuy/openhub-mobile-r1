/* ═══════════════════════════════════════════════════════════════════
   OpenHub R1 — Mobile Control Center for Rabbit R1
   8 Tabs: Dashboard, Agents, Tasks, Money, Chat, Arcade, Actions, Status
   Dynamic theme per tab • R1 hardware events • WebSocket real-time
   Speech-to-text • Camera capture • Agent task assignment
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
let cache = { agents:[], tasks:[], logs:[], stats:{}, streams:[], chat:[], r1builder:{} };
let particleCtx = null;
let particles = [];
let chatScrollLocked = true;

// ─── Speech-to-Text State ──────────────────────────────────────────
let sttActive = false;
let sttRecognition = null;
let sttLang = 'en-US';

// ─── Camera State ──────────────────────────────────────────────────
let cameraStream = null;

// ─── Notification Badges ───────────────────────────────────────────
let unreadChat = 0;
let lastChatCount = 0;

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
  setInterval(fetchAll, 12000);
  setupR1Events();
}

// ─── Tab Bar ───────────────────────────────────────────────────────
function buildTabBar(){
  $tabbar.innerHTML = '';
  TABS.forEach((t,i) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (i===currentTab?' active':'');
    let badge = '';
    if(t.id === 'chat' && unreadChat > 0) badge = `<span class="tab-badge">${unreadChat > 9?'9+':unreadChat}</span>`;
    btn.innerHTML = `<span class="tab-icon">${t.icon}</span><span>${t.label}</span>${badge}`;
    btn.onclick = () => switchTab(i);
    $tabbar.appendChild(btn);
  });
}

function switchTab(idx){
  if(idx<0||idx>=TABS.length||idx===currentTab) return;
  // Stop STT when leaving chat
  if(TABS[currentTab].id === 'chat' && sttActive) stopSTT();
  currentTab = idx;
  if(TABS[idx].id === 'chat') unreadChat = 0;
  applyTheme(idx);
  buildTabBar();
  renderTab();
}

function applyTheme(idx){
  const t = TABS[idx].theme;
  const hsl = `hsl(${t.h},${t.s}%,${t.l}%)`;
  const hslDim = `hsl(${t.h},${t.s}%,${Math.max(t.l-30,10)}%)`;
  document.documentElement.style.setProperty('--accent', hsl);
  document.documentElement.style.setProperty('--accent2', hslDim);
  document.documentElement.style.setProperty('--theme-h', t.h);
  document.documentElement.style.setProperty('--theme-s', t.s+'%');
  document.documentElement.style.setProperty('--theme-l', t.l+'%');
}

// ─── R1 Hardware Events ────────────────────────────────────────────
function setupR1Events(){
  window.addEventListener('scrollUp', () => {
    if(isScrollable()) return;
    switchTab(currentTab - 1);
  });
  window.addEventListener('scrollDown', () => {
    if(isScrollable()) return;
    switchTab(currentTab + 1);
  });
  window.addEventListener('sideClick', () => handleSideClick());
  window.addEventListener('longPressStart', () => {
    // Long press on chat tab = toggle STT
    if(TABS[currentTab].id === 'chat'){
      if(sttActive) stopSTT(); else startSTT();
    } else {
      if(ws && ws.readyState === WebSocket.OPEN) ws.close();
      else connectWS();
    }
  });

  // PC fallbacks
  window.addEventListener('keydown', e => {
    if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if(e.key === 'ArrowUp'){ e.preventDefault(); switchTab(currentTab-1); }
    if(e.key === 'ArrowDown'){ e.preventDefault(); switchTab(currentTab+1); }
    if(e.key === ' '||e.key === 'Enter'){ e.preventDefault(); handleSideClick(); }
    if(e.key === 'Escape') switchTab(0);
    const num = parseInt(e.key);
    if(num >= 1 && num <= 8) switchTab(num - 1);
    // 'v' key = toggle STT in chat
    if(e.key === 'v' && TABS[currentTab].id === 'chat'){
      if(sttActive) stopSTT(); else startSTT();
    }
    // 'c' key = camera in chat
    if(e.key === 'c' && TABS[currentTab].id === 'chat') capturePhoto();
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
  if(tab === 'chat'){
    if(sttActive) return; // don't send while recording
    sendChat();
  }
  if(tab === 'actions') runCurrentAction();
  if(tab === 'arcade' && !document.getElementById('arcadeOverlay')) launchRandomGame();
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
    if(p.x < 0) p.x = 240; if(p.x > 240) p.x = 0;
    if(p.y < 0) p.y = 282; if(p.y > 282) p.y = 0;
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
      try { handleWSMessage(JSON.parse(e.data)); } catch(err){}
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
  if(d.type === 'chat_message'){
    fetchChat().then(()=>{
      if(TABS[currentTab].id !== 'chat'){
        unreadChat++;
        buildTabBar();
      } else {
        renderChat();
      }
    });
  }
  if(d.type === 'notification_new') toast(d.notification?.message || 'New notification');
}

// ─── Data Fetching ─────────────────────────────────────────────────
async function fetchAll(){
  await Promise.all([fetchAgents(), fetchTasks(), fetchLogs(), fetchStats(), fetchStreams(), fetchChat(), fetchR1Builder()]);
  if(TABS[currentTab].id === 'dashboard') renderTab();
}

async function fetchAgents(){
  try{ const r = await fetch(API+'/api/agents'); const j = await r.json(); if(j.success) cache.agents = j.agents || []; } catch(e){}
}
async function fetchTasks(){
  try{ const r = await fetch(API+'/api/tasks'); const j = await r.json(); if(j.success) cache.tasks = j.tasks || []; } catch(e){}
}
async function fetchLogs(){
  try{ const r = await fetch(API+'/api/activity?limit=30'); const j = await r.json(); if(j.success) cache.logs = j.logs || j.activities || []; } catch(e){}
}
async function fetchStats(){
  try{ const r = await fetch(API+'/api/stats'); const j = await r.json(); if(j.success) cache.stats = j; } catch(e){}
}
async function fetchStreams(){
  try{ const r = await fetch(API+'/api/income/streams'); const j = await r.json(); if(j.success) cache.streams = j.streams || []; } catch(e){}
}
async function fetchChat(){
  try{
    const r = await fetch(API+'/api/chat?limit=50');
    const j = await r.json();
    if(j.success){
      const prev = cache.chat.length;
      cache.chat = j.messages || [];
      if(TABS[currentTab].id === 'chat' && cache.chat.length > prev) renderChat();
    }
  } catch(e){}
}
async function fetchR1Builder(){
  try{ const r = await fetch(API+'/api/r1builder/status'); const j = await r.json(); if(j.success) cache.r1builder = j.status || {}; } catch(e){}
}

// ─── Tab Renderers ─────────────────────────────────────────────────
function renderTab(){
  const id = TABS[currentTab].id;
  $view.scrollTop = 0;
  $view.className = id === 'chat' ? 'view chat-mode' : 'view';
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
  const recent = (cache.logs||[]).slice(0,6);
  const r1b = cache.r1builder || {};

  $view.innerHTML = `
    <div class="stat-grid">
      <div class="stat-box"><div class="stat-num">${total}</div><div class="stat-label">AGENTS</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--success)">${active}</div><div class="stat-label">ACTIVE</div></div>
      <div class="stat-box"><div class="stat-num">${taskTotal}</div><div class="stat-label">TASKS</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--success)">${taskDone}</div><div class="stat-label">DONE</div></div>
    </div>
    ${r1b.name?`<div class="card" style="border-left:2px solid var(--accent)">
      <div class="card-row"><span class="card-label">🐰 R1 Builder</span><span class="agent-status ${r1b.running?'working':'idle'}">${r1b.running?'building':'idle'}</span></div>
      <div class="card-row"><span class="card-label">Lvl ${r1b.level||1} • ${r1b.xp||0} XP</span><span class="card-label">${r1b.totalCreations||0} creations</span></div>
    </div>`:''}
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
  const working = agents.filter(a=>a.status==='working');
  const idle = agents.filter(a=>a.status==='idle'||a.status==='active');
  $view.innerHTML = `
    <div class="section-title">🤖 Working (${working.length})</div>
    ${working.map(a => agentCard(a)).join('') || '<div class="card" style="text-align:center;color:var(--text-dim);font-size:8px">No agents working</div>'}
    <div class="section-title">💤 Idle / Active (${idle.length})</div>
    ${idle.slice(0,12).map(a => agentCard(a)).join('')}
    ${idle.length > 12 ? `<div class="card" style="text-align:center;color:var(--text-dim);font-size:8px">+${idle.length-12} more</div>` : ''}
  `;
}

function agentCard(a){
  return `<div class="agent-card" onclick="window._oh.showAgent('${esc(a.name)}')">
    <div class="agent-avatar">${a.avatar||'🤖'}</div>
    <div class="agent-info">
      <div class="agent-name">${esc(a.name)}</div>
      <div class="agent-role">${esc(a.role||'')}</div>
      ${a.current_task?`<div class="agent-role" style="color:var(--accent);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">▸ ${esc(a.current_task)}</div>`:''}
      ${a.level?`<div class="xp-bar"><div class="xp-fill" style="width:${Math.min(((a.xp||0)%1000)/10,100)}%"></div></div>
      <div class="agent-role">Lvl ${a.level} • ${a.xp||0} XP</div>`:''}
    </div>
    <div class="agent-status ${a.status}">${a.status||'idle'}</div>
  </div>`;
}

// ─── Tasks ─────────────────────────────────────────────────────────
function renderTasks(){
  const tasks = (cache.tasks||[]).slice(0,30);
  const pending = tasks.filter(t=>t.status==='pending'||t.status==='in-progress');
  const done = tasks.filter(t=>t.status==='completed');
  $view.innerHTML = `
    <div class="section-title">▣ Active (${pending.length})</div>
    ${pending.map(t => `
      <div class="task-item ${t.priority||''}">
        <div class="task-title">#${t.id} ${esc(t.title)}</div>
        <div class="task-meta">${esc(t.assignee||'unassigned')} • ${t.priority||'medium'} • ${t.status}</div>
        <div class="task-progress"><div class="task-progress-fill" style="width:${t.progress||0}%"></div></div>
      </div>
    `).join('') || '<div class="card" style="text-align:center;color:var(--text-dim)">No active tasks</div>'}
    <div class="section-title">✓ Done (${done.length})</div>
    ${done.slice(0,8).map(t => `
      <div class="task-item" style="opacity:0.5;border-left-color:var(--success)">
        <div class="task-title" style="text-decoration:line-through;font-size:8px">#${t.id} ${esc(t.title)}</div>
        <div class="task-meta">${esc(t.assignee||'')}</div>
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
    <div class="section-title">💰 Streams</div>
    ${streams.slice(0,10).map(s => `
      <div class="card">
        <div class="card-row">
          <span class="card-label" style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</span>
          <span class="agent-status ${s.status==='active'?'working':'idle'}">${s.status}</span>
        </div>
      </div>
    `).join('') || '<div class="card" style="text-align:center;color:var(--text-dim)">No streams yet</div>'}
  `;
}

// ─── Chat (with STT + Camera) ──────────────────────────────────────
function renderChat(){
  const msgs = (cache.chat||[]).slice(-30);
  const sttBtnClass = sttActive ? 'chat-mic active' : 'chat-mic';
  const sttLabel = sttActive ? '■' : '●';
  const sttTitle = sttActive ? 'Stop recording' : 'Start speech-to-text';

  $view.innerHTML = `
    <div class="chat-messages" id="chatMsgs">
      ${msgs.map(m => {
        const isImage = m.message && m.message.startsWith('data:image');
        const isSelf = m.sender==='Ghost'||m.sender==='You';
        return `<div class="chat-msg ${isSelf?'self':'other'}">
          <div class="chat-sender">${esc(m.sender||'')}</div>
          ${isImage
            ? `<div class="chat-bubble"><img src="${m.message}" style="max-width:160px;border-radius:4px" onclick="window._oh.expandImage(this.src)"></div>`
            : `<div class="chat-bubble">${formatMsg(m.message||'')}</div>`
          }
        </div>`;
      }).join('') || '<div style="text-align:center;color:var(--text-dim);padding:30px 10px;font-size:8px">Chat with your agents. Use the mic button for voice input or the camera to send photos.</div>'}
    </div>
    <div id="sttIndicator" class="stt-indicator" style="display:${sttActive?'flex':'none'}">
      <span class="stt-dot"></span>
      <span class="stt-text">Listening...</span>
    </div>
    <div class="chat-controls">
      <button class="${sttBtnClass}" onclick="window._oh.toggleSTT()" title="${sttTitle}">${sttLabel}</button>
      <button class="chat-cam" onclick="window._oh.capturePhoto()" title="Take photo">📷</button>
      <input class="chat-input" id="chatIn" placeholder="Type or speak..." maxlength="500">
      <button class="chat-send" onclick="window._oh.sendChat()">▶</button>
    </div>
  `;
  const cm = document.getElementById('chatMsgs');
  if(cm && chatScrollLocked) cm.scrollTop = cm.scrollHeight;
  const inp = document.getElementById('chatIn');
  if(inp) inp.addEventListener('keydown', e => { if(e.key==='Enter') sendChat(); });
}

function formatMsg(msg){
  if(!msg) return '';
  // Escape HTML then convert newlines
  return esc(msg).replace(/\n/g,'<br>');
}

// ─── Speech-to-Text ────────────────────────────────────────────────
function startSTT(){
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SpeechRecognition){
    toast('Speech recognition not supported in this browser');
    return;
  }
  if(sttRecognition){ try{ sttRecognition.abort(); }catch(e){} }

  sttRecognition = new SpeechRecognition();
  sttRecognition.continuous = true;
  sttRecognition.interimResults = true;
  sttRecognition.lang = sttLang;
  sttRecognition.maxAlternatives = 1;

  const inp = document.getElementById('chatIn');
  let finalTranscript = inp ? inp.value : '';

  sttRecognition.onresult = e => {
    let interim = '';
    for(let i = e.resultIndex; i < e.results.length; i++){
      const t = e.results[i][0].transcript;
      if(e.results[i].isFinal) finalTranscript += t + ' ';
      else interim = t;
    }
    if(inp) inp.value = (finalTranscript + interim).trim();
  };

  sttRecognition.onerror = e => {
    if(e.error === 'no-speech'){
      // Silently restart
      if(sttActive) try{ sttRecognition.start(); }catch(ex){}
      return;
    }
    if(e.error === 'aborted') return;
    toast('Speech error: ' + e.error);
    stopSTT();
  };

  sttRecognition.onend = () => {
    // Auto-restart if still active
    if(sttActive) try{ sttRecognition.start(); }catch(e){}
  };

  try{
    sttRecognition.start();
    sttActive = true;
    toast('Listening... speak now');
    if(TABS[currentTab].id === 'chat') renderChat();
  } catch(e){
    toast('Could not start speech recognition');
  }
}

function stopSTT(){
  sttActive = false;
  if(sttRecognition){
    try{ sttRecognition.stop(); }catch(e){}
    sttRecognition = null;
  }
  toast('Speech recognition stopped');
  if(TABS[currentTab].id === 'chat') renderChat();
}

// ─── Camera Capture ────────────────────────────────────────────────
function capturePhoto(){
  // Check if R1 has camera plugin
  if(isR1 && typeof PluginMessageHandler !== 'undefined'){
    // R1 camera: request photo via plugin
    try {
      PluginMessageHandler.postMessage(JSON.stringify({
        type: 'camera',
        action: 'capture'
      }));
      toast('Camera opened — photo will appear in chat');
    } catch(e){
      toast('Camera not available on this device');
    }
    return;
  }

  // Browser/R1 WebView fallback: use getUserMedia
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    toast('Camera not available');
    return;
  }

  // Create hidden video + canvas for capture
  const video = document.createElement('video');
  video.setAttribute('autoplay','');
  video.setAttribute('playsinline','');
  video.style.cssText = 'position:fixed;top:0;left:0;width:240px;height:282px;z-index:10000;object-fit:cover;background:#000';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:240px;height:282px;z-index:10001;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:10px;background:linear-gradient(transparent 60%,rgba(0,0,0,0.7))';

  const captureBtn = document.createElement('button');
  captureBtn.textContent = '📸 CAPTURE';
  captureBtn.style.cssText = 'background:var(--accent);color:#000;border:none;border-radius:20px;padding:6px 16px;font-size:10px;font-weight:700;font-family:JetBrains Mono,monospace;cursor:pointer;margin-bottom:10px';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕ Cancel';
  cancelBtn.style.cssText = 'background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:12px;padding:4px 12px;font-size:8px;font-family:JetBrains Mono,monospace;cursor:pointer;margin-bottom:4px';

  overlay.appendChild(captureBtn);
  overlay.appendChild(cancelBtn);
  document.body.appendChild(video);
  document.body.appendChild(overlay);

  navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment', width:{ideal:240}, height:{ideal:282} } })
    .then(stream => {
      cameraStream = stream;
      video.srcObject = stream;
      video.play();

      function doCapture(){
        const canvas = document.createElement('canvas');
        canvas.width = 240; canvas.height = 282;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, 240, 282);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);

        // Stop camera
        stream.getTracks().forEach(t => t.stop());
        document.body.removeChild(video);
        document.body.removeChild(overlay);
        cameraStream = null;

        // Send photo in chat
        sendImageChat(dataUrl);
      }

      captureBtn.onclick = doCapture;
      cancelBtn.onclick = () => {
        stream.getTracks().forEach(t => t.stop());
        document.body.removeChild(video);
        document.body.removeChild(overlay);
        cameraStream = null;
      };
    })
    .catch(e => {
      toast('Camera access denied: ' + e.message);
      if(video.parentNode) document.body.removeChild(video);
      if(overlay.parentNode) document.body.removeChild(overlay);
    });
}

function sendImageChat(dataUrl){
  // Add to local cache immediately
  cache.chat.push({sender:'Ghost', message:dataUrl, timestamp:new Date().toISOString()});
  if(TABS[currentTab].id === 'chat') renderChat();

  // Send to server
  fetch(API+'/api/chat', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({sender:'Ghost', message:'[Camera photo] '+dataUrl, channel:'main'})
  }).then(()=>{
    // Also notify via AI chat so agents can analyze it
    return fetch(API+'/api/chat/ai', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({message:'[User sent a camera photo. Analyze the image content and describe what you see, identify objects, text, people, or anything notable. Then suggest what can be done with this image.]', sender:'Ghost'})
    });
  }).then(r=>r.json()).then(()=>{
    fetchChat().then(()=>{ if(TABS[currentTab].id==='chat') renderChat(); });
  }).catch(()=>{});
}

function expandImage(src){
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:240px;height:282px;z-index:10002;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;cursor:pointer';
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:230px;max-height:270px;border-radius:4px';
  overlay.appendChild(img);
  overlay.onclick = () => document.body.removeChild(overlay);
  document.body.appendChild(overlay);
}

// ─── Send Chat ─────────────────────────────────────────────────────
function sendChat(){
  const inp = document.getElementById('chatIn');
  const msg = (inp?inp.value:'').trim();
  if(!msg) return;
  if(inp) inp.value = '';
  chatScrollLocked = true;
  cache.chat.push({sender:'Ghost', message:msg, timestamp:new Date().toISOString()});
  renderChat();
  fetch(API+'/api/chat/ai', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({message:msg, sender:'Ghost'})
  }).then(r=>r.json()).then(()=>{
    fetchChat().then(()=>{ if(TABS[currentTab].id==='chat') renderChat(); });
  }).catch(()=>{});
}

// ─── Agent Detail (tap an agent card) ──────────────────────────────
function showAgentDetail(name){
  const a = (cache.agents||[]).find(x => x.name === name);
  if(!a) return;
  const evo = a.level ? `Lvl ${a.level} • ${a.xp||0} XP • ${esc(a.skill||'Generalist')}` : '';
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:240px;height:282px;z-index:10002;background:rgba(10,10,15,0.95);padding:10px;overflow-y:auto';
  overlay.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-family:Orbitron,sans-serif;font-size:10px;color:var(--accent)">${a.avatar||'🤖'} ${esc(a.name)}</div>
      <button onclick="this.parentElement.parentElement.remove()" style="background:transparent;color:var(--text-dim);border:none;font-size:14px;cursor:pointer">✕</button>
    </div>
    <div class="card">
      <div class="card-row"><span class="card-label">Role</span><span class="card-value" style="font-size:8px">${esc(a.role||'')}</span></div>
      <div class="card-row"><span class="card-label">Status</span><span class="agent-status ${a.status}">${a.status||'idle'}</span></div>
      ${a.current_task?`<div class="card-row"><span class="card-label">Task</span><span class="card-value" style="font-size:7px;max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(a.current_task)}</span></div>`:''}
      ${evo?`<div class="card-row"><span class="card-label">Evolution</span><span class="card-value" style="font-size:7px">${evo}</span></div>`:''}
      <div class="card-row"><span class="card-label">Completed</span><span class="card-value">${a.tasks_completed||0}</span></div>
    </div>
    <div style="margin-top:6px;display:flex;gap:4px">
      <button class="btn btn-accent btn-sm" onclick="window._oh.assignTaskTo('${esc(a.name)}');this.parentElement.parentElement.remove()">Assign Task</button>
      <button class="btn btn-outline btn-sm" onclick="this.parentElement.parentElement.remove()">Close</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

function assignTaskTo(agentName){
  const title = prompt('Task for ' + agentName + ':');
  if(!title) return;
  fetch(API+'/api/tasks', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({title, assignee:agentName, priority:'medium', stage:'queued', status:'pending'})
  }).then(r=>r.json()).then(d => {
    toast(d.message || 'Task created');
    fetchTasks();
  }).catch(e => toast('Error: '+e.message));
}

// ─── Arcade ────────────────────────────────────────────────────────
let arcadePlayerCount = 1;

function renderArcade(){
  const xp = cache.r1builder?.xp||0;
  const level = cache.r1builder?.level||1;
  const games = window.Arcade ? Arcade.GAMES : [];
  const agentScores = window.Arcade ? Arcade.getAgentScores() : [];
  $view.innerHTML = `
    <div class="card" style="text-align:center">
      <div style="font-family:Orbitron,sans-serif;font-size:10px;color:var(--accent)">ARCADE</div>
      <div class="xp-bar" style="margin:4px 0"><div class="xp-fill" style="width:${(xp%1000)/10}%"></div></div>
      <div style="font-size:7px;color:var(--text-dim)">Level ${level} • ${xp} XP</div>
    </div>
    <div class="section-title">🎮 Select Players</div>
    <div class="player-select">
      ${[1,2,3,4].map(n => `<button class="player-btn${n===arcadePlayerCount?' active':''}" onclick="window._oh.setArcadePlayers(${n})">${n}P</button>`).join('')}
    </div>
    <div class="game-grid">
      ${games.map((g,i) => `
        <div class="game-card" onclick="window._oh.launchGame(${i})">
          <div class="game-icon">${g.icon}</div>
          <div class="game-name">${g.name}</div>
          <div style="font-size:6px;color:var(--text-dim);margin-top:1px">${g.players}P</div>
        </div>
      `).join('')}
    </div>
    ${agentScores.length ? `
      <div class="section-title">🏆 Leaderboard</div>
      <div class="card">
        <div class="lb-table">
          <div class="lb-row header"><span class="rank">#</span><span class="name">Agent</span><span class="score">Score</span></div>
          ${agentScores.map((a,i) => `
            <div class="lb-row"><span class="rank">${i+1}</span><span class="name">${esc(a.name)}</span><span class="score">${a.total}</span></div>
          `).join('')}
        </div>
      </div>
    ` : ''}
  `;
}

function setArcadePlayers(n){
  arcadePlayerCount = n;
  renderArcade();
}

function launchGame(idx){
  if(!window.Arcade){ toast('Arcade not loaded'); return; }
  const games = Arcade.GAMES;
  const g = games[idx];
  if(!g) return;
  // For single-player-only games, force 1 player
  const pc = g.players === '1' ? 1 : arcadePlayerCount;

  // Create overlay with canvas
  const overlay = document.createElement('div');
  overlay.className = 'arcade-overlay';
  overlay.id = 'arcadeOverlay';
  const cvs = document.createElement('canvas');
  overlay.appendChild(cvs);
  const backBtn = document.createElement('button');
  backBtn.className = 'arcade-back';
  backBtn.textContent = '✕';
  overlay.appendChild(backBtn);
  document.body.appendChild(overlay);

  backBtn.onclick = () => {
    Arcade.exitGame();
    if(overlay.parentNode) overlay.parentNode.removeChild(overlay);
  };

  Arcade.startGame(cvs, idx, pc, () => {
    // On game exit: record score from leaderboard if available, close overlay
    if(overlay.parentNode) overlay.parentNode.removeChild(overlay);
    renderArcade();
  });
}

function launchRandomGame(){
  if(!window.Arcade){ toast('Arcade not loaded'); return; }
  const idx = Math.floor(Math.random()*Arcade.GAMES.length);
  launchGame(idx);
}

// ─── Actions ───────────────────────────────────────────────────────
const ACTIONS = [
  {name:'Run POD Cycle', endpoint:'/api/pod/run', desc:'Generate new print-on-demand designs'},
  {name:'Income Brainstorm', endpoint:'/api/income/run', desc:'Brainstorm new passive income streams'},
  {name:'Money Hustler', endpoint:'/api/hustler/run', desc:'Hunt for legal income opportunities'},
  {name:'Traffic Agent', endpoint:'/api/traffic/run', desc:'Plan customer acquisition strategies'},
  {name:'R1 Builder', endpoint:'/api/r1builder/run', desc:'Generate new R1 Creation ideas'},
  {name:'Full Monetize', endpoint:'/api/monetize/run', desc:'Full automation: POD + Income + Evolve'},
  {name:'Force Learn', endpoint:'/api/monetize/learn', desc:'Attribute payouts and evolve agents'},
  {name:'Sync PayPal', endpoint:'/api/payouts/sync', desc:'Sync real PayPal payout data'},
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
  currentActionIdx = idx;
  toast('Running '+a.name+'...');
  fetch(API+a.endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'})
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
    <div class="section-title">● System</div>
    <div class="status-grid">
      <div class="status-item"><div class="status-val">${wsConnected?'✓':'✗'}</div><div class="status-key">WebSocket</div></div>
      <div class="status-item"><div class="status-val">${sys.cpu||'—'}%</div><div class="status-key">CPU</div></div>
      <div class="status-item"><div class="status-val">${sys.memory||'—'}%</div><div class="status-key">Memory</div></div>
      <div class="status-item"><div class="status-val">${sys.memoryUsedGB||'—'}</div><div class="status-key">RAM</div></div>
      <div class="status-item"><div class="status-val">${s.totalAgents||0}</div><div class="status-key">Agents</div></div>
      <div class="status-item"><div class="status-val">${s.totalTasks||0}</div><div class="status-key">Tasks</div></div>
      <div class="status-item"><div class="status-val">${s.completedTasks||0}</div><div class="status-key">Done</div></div>
      <div class="status-item"><div class="status-val">${s.totalLearnings||0}</div><div class="status-key">Learn</div></div>
    </div>
    <div class="section-title">📋 Server</div>
    <div class="card">
      <div class="card-row"><span class="card-label">Platform</span><span class="card-value">${sys.platform||'—'}</span></div>
      <div class="card-row"><span class="card-label">Host</span><span class="card-value" style="font-size:7px">${sys.hostname||'—'}</span></div>
      <div class="card-row"><span class="card-label">Node</span><span class="card-value">${sys.nodeVersion||'—'}</span></div>
      <div class="card-row"><span class="card-label">Uptime</span><span class="card-value">${sys.uptime?formatUptime(sys.uptime):'—'}</span></div>
      <div class="card-row"><span class="card-label">R1</span><span class="card-value">${isR1?'Yes':'Browser'}</span></div>
      <div class="card-row"><span class="card-label">Skills</span><span class="card-value">${s.skillsEnabled||0}/${s.skillsTotal||0}</span></div>
    </div>
    <div class="section-title">🐰 R1 Builder</div>
    <div class="card">
      <div class="card-row"><span class="card-label">Status</span><span class="agent-status ${cache.r1builder?.running?'working':'idle'}">${cache.r1builder?.running?'building':'idle'}</span></div>
      <div class="card-row"><span class="card-label">Level</span><span class="card-value">${cache.r1builder?.level||1}</span></div>
      <div class="card-row"><span class="card-label">XP</span><span class="card-value">${cache.r1builder?.xp||0}</span></div>
      <div class="card-row"><span class="card-label">Creations</span><span class="card-value">${cache.r1builder?.totalCreations||0}</span></div>
      <div class="card-row"><span class="card-label">Knowledge</span><span class="card-value">${cache.r1builder?.knowledgeBase?.existingApps||0} apps</span></div>
    </div>
  `;
}

function formatUptime(s){
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  return h > 0 ? h+'h '+m+'m' : m+'m';
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

// ─── Global API ────────────────────────────────────────────────────
window._oh = {
  sendChat, runAction, toast, runCurrentAction,
  toggleSTT: ()=>{ if(sttActive) stopSTT(); else startSTT(); },
  capturePhoto,
  showAgent: showAgentDetail,
  assignTaskTo,
  expandImage,
  launchGame,
  setArcadePlayers
};

// ─── Boot ──────────────────────────────────────────────────────────
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
