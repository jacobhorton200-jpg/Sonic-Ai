(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const els = {
    rom: $('#romInput'), empty: $('#emptyState'), game: $('#game'), frame: $('#gameFrame'),
    statusDot: $('#statusDot'), status: $('#statusText'), ramBadge: $('#ramBadge'), ai: $('#aiBtn'), aiSub: $('#aiSub'),
    takeover: $('#takeoverBtn'), fullscreen: $('#fullscreenBtn'), thought: $('#thought'), rings: $('#ringsStat'),
    stage: $('#stageStat'), speed: $('#speedStat'), goal: $('#goalStat'), bridgeExplain: $('#bridgeExplain'),
    log: $('#logOutput'), refresh: $('#refreshLogBtn'), export: $('#exportLogBtn'), clear: $('#clearLogBtn'),
    about: $('#aboutDialog'), aboutBtn: $('#aboutBtn'), closeAbout: $('#closeAbout')
  };

  const MEMORY_KEY = 'sonic-cognition-v3-web-memory';
  const LOG_KEY = 'sonic-ai-failure-log-v1';
  const CORE_DATA = 'https://cdn.emulatorjs.org/stable/data/';
  const CORE_LOADER = CORE_DATA + 'loader.js';
  const SYSTEM_RAM_ID = 2; // libretro RETRO_MEMORY_SYSTEM_RAM

  let logger = new SonicAIFailureLog(readJSON(LOG_KEY));
  let agent = new SonicCognitionV3(readJSON(MEMORY_KEY), logger);
  let ram = null;
  let aiOn = false;
  let aiTimer = null;
  let saveTimer = null;
  let telemetryTimer = null;
  let lastObs = null;
  let lastIntent = null;
  let loaded = false;
  let pressed = new Set();
  let jumpUntil = 0;
  let waitUntil = 0;
  let attachAttempts = 0;
  let fakeSensorsState = { lastX: null, lastY: null, still: 0 };

  function readJSON(key){ try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
  function save(){
    try {
      localStorage.setItem(MEMORY_KEY, JSON.stringify(agent.export()));
      localStorage.setItem(LOG_KEY, JSON.stringify(logger.export()));
    } catch {}
  }

  function setStatus(text, kind='idle'){
    els.status.textContent = text;
    els.statusDot.className = 'status-dot ' + kind;
  }

  function renderLog(){
    const rows = logger.summary().slice(0, 30);
    els.log.textContent = (agent.message ? `NOW: ${agent.message}\n\n` : '') + (rows.length
      ? rows.map((r,i)=>`${i+1}. ${r.type.toUpperCase()} x${r.count} · stage ${fmtStage(r.stage)} · ${r.profile}\n   @ ${r.lastX},${r.lastY} · rings ${r.rings} · ${r.reason}`).join('\n')
      : 'No failures recorded yet.');
  }

  function fmtStage(stage){
    if(stage == null) return '–';
    const zone = (stage >> 8) & 255, act = (stage & 255) + 1;
    const names = ['GHZ','LZ','MZ','SLZ','SYZ','SBZ'];
    return `${names[zone] || 'Z'+zone}-${act}`;
  }

  function signed16(v){ return v & 0x8000 ? v - 0x10000 : v; }
  function rb(mem,a){ return mem[(a ^ 1) & 0xffff] || 0; }
  function rw(mem,a){ a &= 0xffff; return (((mem[a] || 0) << 8) | (mem[(a+1)&0xffff] || 0)) & 0xffff; }

  function objects(mem){
    const out=[];
    for(let a=0xd800;a<0xf000;a+=64){
      const id=rb(mem,a); if(!id) continue;
      out.push({
        id,
        x:rw(mem,a+8), y:rw(mem,a+12),
        render:rb(mem,a+1), collision:rb(mem,a+0x20),
        routine:rb(mem,a+0x24), subtype:rb(mem,a+0x28)
      });
    }
    return out;
  }

  function inferredSensors(obs){
    const dx = fakeSensorsState.lastX == null ? 0 : obs.x - fakeSensorsState.lastX;
    const dy = fakeSensorsState.lastY == null ? 0 : obs.y - fakeSensorsState.lastY;
    const moving = Math.abs(dx) > 1 || Math.abs(dy) > 1;
    fakeSensorsState.still = moving ? 0 : fakeSensorsState.still + 1;
    fakeSensorsState.lastX = obs.x; fakeSensorsState.lastY = obs.y;

    const dir = Math.sign(obs.inertia || obs.vx || 1);
    const stuck = obs.grounded && fakeSensorsState.still > 8 && Math.abs(obs.inertia) < 0x120;
    const nearby = obs.objects || [];
    const platformAbove = nearby.filter(o => o.y < obs.y - 24 && obs.y - o.y < 150 && Math.abs(o.x - obs.x) < 190 && (o.id === 0x18 || o.collision));
    const platformBelow = nearby.filter(o => o.y > obs.y + 20 && o.y - obs.y < 160 && Math.abs(o.x - obs.x) < 190 && (o.id === 0x18 || o.collision));

    // We deliberately keep unknown flat ground traversable in both directions.
    // Actual stalls become a wall hint instead of making "right" the default.
    return {
      wallAhead: stuck ? 0 : 255,
      wallBehind: 255,
      floorAhead: obs.grounded ? 0 : 48,
      floorFarAhead: obs.grounded ? 0 : 64,
      floorBehind: obs.grounded ? 0 : 48,
      ceiling: 255,
      gapAhead: false,
      gapBehind: false,
      platformAbove,
      platformBelow,
      inferredDirection: dir
    };
  }

  function observation(){
    if(!ram) return null;
    const obs = {
      active:true,
      mode:rb(ram,0xf600),
      locked:!!rb(ram,0xf7aa),
      stage:rw(ram,0xfe10),
      physics:'normal',
      x:rw(ram,0xd008), y:rw(ram,0xd00c),
      vx:signed16(rw(ram,0xd010)), vy:signed16(rw(ram,0xd012)),
      inertia:signed16(rw(ram,0xd014)),
      angle:rb(ram,0xd026), status:rb(ram,0xd022), routine:rb(ram,0xd024),
      rings:rw(ram,0xfe20), lives:rb(ram,0xfe12), checkpoint:rb(ram,0xfe30), emeralds:rb(ram,0xfe57),
      shield:rb(ram,0xfe2c), invincible:rb(ram,0xfe2d), shoes:rb(ram,0xfe2e),
      grounded:!(rb(ram,0xd022)&2),
      mechanic:rw(ram,0xff86),
      objects:objects(ram),
      sensors:{}, onPlatform:false, platformId:0
    };
    obs.sensors = inferredSensors(obs);
    return obs;
  }

  function moduleCandidates(){
    const e = window.EJS_emulator;
    return [
      e?.gameManager?.Module,
      e?.gameManager?.module,
      e?.gameManager?.emulator?.Module,
      e?.Module,
      window.Module
    ].filter(Boolean);
  }

  function exportedFn(mod, name){
    if(typeof mod[name] === 'function') return mod[name].bind(mod);
    if(typeof mod['_' + name] === 'function') return mod['_' + name].bind(mod);
    if(typeof mod.cwrap === 'function') {
      try { return mod.cwrap(name, 'number', ['number']); } catch {}
    }
    return null;
  }

  function attachRam(){
    attachAttempts++;
    for(const mod of moduleCandidates()){
      try {
        const heap = mod.HEAPU8;
        if(!heap?.buffer) continue;
        const getData = exportedFn(mod, 'retro_get_memory_data');
        const getSize = exportedFn(mod, 'retro_get_memory_size');
        if(!getData || !getSize) continue;
        const ptr = Number(getData(SYSTEM_RAM_ID));
        const size = Number(getSize(SYSTEM_RAM_ID));
        if(ptr > 0 && size >= 0x10000 && ptr + 0x10000 <= heap.byteLength){
          ram = new Uint8Array(heap.buffer, ptr, 0x10000);
          els.ramBadge.textContent = `RAM bridge: ${Math.round(size/1024)} KB`;
          els.ramBadge.style.color = 'var(--green)';
          els.ai.disabled = false;
          els.aiSub.textContent = 'Cognition v3 ready';
          els.bridgeExplain.textContent = 'Connected to the Genesis system RAM through libretro. AI decisions come from real Sonic game state; movement is sent as controller inputs.';
          setStatus('Game ready · AI bridge attached','ready');
          renderTelemetry();
          return true;
        }
      } catch(err){ console.debug('RAM candidate failed', err); }
    }
    if(attachAttempts > 25){
      els.ramBadge.textContent = 'RAM bridge: unavailable';
      els.aiSub.textContent = 'Core RAM hook unavailable';
      els.bridgeExplain.textContent = 'The game is playable, but this EmulatorJS/core build did not expose libretro system RAM to the page. AI Play stays disabled rather than pretending it can see the game.';
    }
    return false;
  }

  function manager(){ return window.EJS_emulator?.gameManager || null; }
  function simulate(id, value){
    try {
      const gm = manager();
      if(gm?.simulateInput) { gm.simulateInput(0,id,value); return true; }
      if(typeof window.simulate_input === 'function') { window.simulate_input(0,id,value); return true; }
    } catch(e){ console.debug(e); }
    return false;
  }

  function setInput(id, down){
    const has = pressed.has(id);
    if(down && !has){ simulate(id,1); pressed.add(id); }
    else if(!down && has){ simulate(id,0); pressed.delete(id); }
  }
  function releaseAll(){ [...pressed].forEach(id=>simulate(id,0)); pressed.clear(); jumpUntil=0; waitUntil=0; }

  // libretro joypad ids: 6 left, 7 right, 5 down; use three face buttons
  // for jump so Genesis mappings remain tolerant across control profiles.
  const JUMP_IDS=[0,8,9];
  function drive(intent, obs){
    const now=performance.now();
    if(!intent){
      setInput(6,false);setInput(7,false);setInput(5,false);JUMP_IDS.forEach(i=>setInput(i,false));
      return;
    }

    if(intent.waitFrames && waitUntil < now) waitUntil = now + intent.waitFrames * 16.67;
    if(now < waitUntil){
      setInput(6,false); setInput(7,false); setInput(5,false); JUMP_IDS.forEach(i=>setInput(i,false));
      return;
    }

    let dir = intent.direction || Math.sign((intent.targetX || obs.x) - obs.x);
    const desired = Math.abs(intent.desiredSpeed || 0x380);
    const current = Math.abs(obs.inertia || obs.vx || 0);

    // Human-like speed control: don't hammer a wall and don't brake for tiny errors.
    if(current > desired + 0x180 && obs.grounded) {
      if(Math.abs((intent.targetX || obs.x)-obs.x) < 110) dir = 0;
    }

    setInput(6,dir<0); setInput(7,dir>0);
    setInput(5,/roll|duck/i.test(intent.skill || '') && obs.grounded && current>0x180);

    if(intent.jump && jumpUntil < now) jumpUntil = now + Math.max(2,intent.jumpHold || 7)*16.67;
    const jumping = now < jumpUntil;
    JUMP_IDS.forEach(i=>setInput(i,jumping));
  }

  function aiStep(){
    if(!aiOn || !ram) return;
    try {
      const obs = observation(); if(!obs) return;
      lastObs = obs;
      lastIntent = agent.observe(obs);
      drive(lastIntent,obs);
      renderTelemetry();
    } catch(err){
      console.error(err);
      setStatus('AI error · manual play still available','error');
      els.thought.textContent = 'AI paused after an internal error.';
      disableAI(false);
    }
  }

  function enableAI(){
    if(!ram || aiOn) return;
    aiOn=true; els.ai.classList.add('on'); els.aiSub.textContent='Playing · tap Take Over';
    els.takeover.disabled=false; setStatus('AI is playing','ready');
    // This click itself gives the emulator a user gesture on browsers that gate input/audio.
    els.game.querySelector('canvas')?.focus?.();
    aiTimer=setInterval(aiStep,50);
    aiStep();
  }
  function disableAI(reset=true){
    if(aiTimer) clearInterval(aiTimer); aiTimer=null; aiOn=false; releaseAll();
    els.ai.classList.remove('on');
    els.aiSub.textContent=ram?'Cognition v3 ready':'RAM bridge unavailable';
    if(reset) agent.resetEpisode?.();
    if(loaded) setStatus(ram?'Game ready · manual control':'Game ready · manual only','ready');
    save(); renderTelemetry();
  }

  function renderTelemetry(){
    if(!ram){ return; }
    const s = lastObs || observation(); if(!s) return;
    els.rings.textContent=String(s.rings);
    els.stage.textContent=fmtStage(s.stage);
    els.speed.textContent=String(Math.round(Math.abs(s.inertia||s.vx||0)/16));
    els.goal.textContent=lastIntent?.goalType || (aiOn?'observe':'manual');
    els.thought.textContent=aiOn ? (lastIntent?.reason || agent.message || 'Observing the level') : 'Manual control. AI memory is preserved.';
  }

  async function loadRom(file){
    if(loaded) return;
    if(!file) return;
    loaded=true;
    els.empty.classList.add('hidden');
    els.takeover.disabled=false; els.fullscreen.disabled=false;
    setStatus('Loading Genesis emulator…','loading');
    els.ramBadge.textContent='RAM bridge: starting';

    const url=URL.createObjectURL(file);
    window.EJS_player='#game';
    window.EJS_core='segaMD';
    window.EJS_gameUrl=url;
    window.EJS_gameName=file.name.replace(/\.[^.]+$/,'') || 'Sonic 1';
    window.EJS_pathtodata=CORE_DATA;
    window.EJS_startOnLoaded=true;
    window.EJS_controlScheme='segaMD';
    window.EJS_DEBUG_XX=true;
    window.EJS_backgroundColor='#000';
    window.EJS_AdUrl='';
    window.EJS_AdTimer=-1;
    window.EJS_browserMode = matchMedia('(pointer:coarse)').matches ? 'mobile' : 'desktop';
    window.EJS_defaultControls={0:{
      0:{value:'z',value2:'BUTTON_2'}, 8:{value:'x',value2:'BUTTON_1'}, 9:{value:'c',value2:'BUTTON_3'},
      3:{value:'enter',value2:'START'},4:{value:'ArrowUp',value2:'DPAD_UP'},5:{value:'ArrowDown',value2:'DPAD_DOWN'},
      6:{value:'ArrowLeft',value2:'DPAD_LEFT'},7:{value:'ArrowRight',value2:'DPAD_RIGHT'}
    },1:{},2:{},3:{}};
    window.EJS_VirtualGamepadSettings=[
      {type:'dpad',location:'left',left:'50%',right:'50%',joystickInput:false,inputValues:[4,5,6,7]},
      {type:'button',text:'A',id:'a',location:'right',left:15,top:58,bold:true,input_value:8},
      {type:'button',text:'B',id:'b',location:'right',left:69,top:22,bold:true,input_value:0},
      {type:'button',text:'C',id:'c',location:'right',left:118,top:58,bold:true,input_value:9},
      {type:'button',text:'START',id:'start',location:'center',left:15,fontSize:12,block:true,input_value:3}
    ];

    const script=document.createElement('script');
    script.src=CORE_LOADER; script.async=true;
    script.onload=()=>{
      setStatus('Emulator loaded · starting game…','loading');
      const poll=setInterval(()=>{
        const gm=manager();
        if(gm){
          clearInterval(poll);
          setStatus('Game ready · attaching AI bridge…','loading');
          const ramPoll=setInterval(()=>{ if(attachRam() || attachAttempts>30) clearInterval(ramPoll); },400);
        }
      },250);
      setTimeout(()=>{ if(!manager()) setStatus('Emulator is taking longer than expected…','loading'); },8000);
    };
    script.onerror=()=>{ setStatus('Could not load the emulator core','error'); els.empty.classList.remove('hidden'); loaded=false; };
    document.head.appendChild(script);
  }

  els.rom.addEventListener('change',e=>loadRom(e.target.files?.[0]));

  async function loadBundledRom(){
    try {
      setStatus('Loading bundled Sonic 1 ROM…','loading');
      const response = await fetch('./sonic1.gen');
      if(!response.ok) throw new Error(`ROM HTTP ${response.status}`);
      const blob = await response.blob();
      const file = new File([blob], 'Sonic The Hedgehog (USA, Europe).gen', {type:'application/octet-stream'});
      await loadRom(file);
    } catch (err) {
      console.error(err);
      setStatus('Bundled ROM could not be opened · choose a ROM manually','error');
      els.empty.classList.remove('hidden');
    }
  }
  function bootBundledRom(){
    if(window.__sonicBundledBootStarted) return;
    window.__sonicBundledBootStarted=true;
    setTimeout(loadBundledRom,120);
  }
  if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootBundledRom, {once:true});
  } else {
    bootBundledRom();
  }
  els.ai.addEventListener('click',()=> aiOn ? disableAI() : enableAI());
  els.takeover.addEventListener('click',()=>disableAI());
  els.fullscreen.addEventListener('click',()=>{
    const el=els.frame;
    (el.requestFullscreen?.() || el.webkitRequestFullscreen?.());
  });
  els.refresh.addEventListener('click',renderLog);
  els.export.addEventListener('click',()=>logger.download('sonic-ai-failure-log.json'));
  els.clear.addEventListener('click',()=>{logger.clear();save();renderLog();});
  els.aboutBtn.addEventListener('click',()=>els.about.showModal());
  els.closeAbout.addEventListener('click',()=>els.about.close());

  // Manual keyboard input is an explicit takeover.
  addEventListener('keydown',e=>{
    if(aiOn && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','z','x','c','Enter'].includes(e.key)) disableAI();
  },true);

  // Tapping the emulator's own mobile gamepad means the player wants control.
  els.game.addEventListener('pointerdown',()=>{ if(aiOn) disableAI(); },true);

  saveTimer=setInterval(save,2500);
  telemetryTimer=setInterval(()=>{ if(ram) renderTelemetry(); if(aiOn) renderLog(); },1000);
  addEventListener('beforeunload',()=>{save();releaseAll();});
  renderLog();
})();
