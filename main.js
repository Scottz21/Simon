/*  OVERVIEW
  - This file implements a classic Simon game with a polished UI and telemetry.
  - Layout assumptions: three columns
      Left: controls (name, toggles, volume/tone) + stats card
      Center: 4 color pads ("board") + a center status pill + small HUD hint
      Right: local leaderboard
  - Accessibility: 
      • statusText doubles as a visible game state pill; srLive is an aria-live region
      • pads are buttons; pointer and keyboard (Enter/Space) are supported
      • aria attributes (aria-pressed on pads, aria-valuenow on progressbar)
  - Persistence:
      • localStorage is used when available; otherwise a memory fallback is used for LB
      • settings persisted: labels toggle, stats toggle, player name, volume, tone preset
  - Audio:
      • Web Audio API (OscillatorNode + GainNode) for tones
      • Master gain controlled by volume slider (0–100 → 0.0–1.0)
  - Gameplay pacing:
      • Step duration adapts by round and by recent accuracy (better accuracy → faster)
      • Tone presets tweak press duration and per-step multiplier
  - Stats:
      • Accuracy over a sliding window of inputs (recentWindow)
      • Reaction sparkline summarizes first-input reaction time per round (rtWindow)
  - Leaderboard:
      • Sorted primarily by round, then accuracy, then recency
      • Only updated when a run ends (not per-round) to avoid noisy movement
  - State machine:
      mode: 'idle' → 'playing' → ['gameending' → 'gameover'] or directly 'gameover' (strict error)
  ──────────────────────────────────────────────────────────────────────────────
*/

(() => {
  // ===== DOM =====
  const padEls = Array.from(document.querySelectorAll('.pad')); // the 4 colored pads, each has data-index
  const startBtn = document.getElementById('startBtn');         // main CTA: Start / End Game / New Game
  const strictToggle = document.getElementById('strictToggle'); // strict mode: mistake ends the run
  const soundToggle  = document.getElementById('soundToggle');  // global SFX on/off (does not disable visuals)
  const labelsToggle = document.getElementById('labelsToggle'); // shows letter/labels on pads via body class
  const statsToggle  = document.getElementById('statsToggle');  // show/hide stats card (persisted)
  const roundText = document.getElementById('roundText');       // "Round N" indicator (left panel)
  const statusText = document.getElementById('statusText');     // center pill (hidden when idle)
  const hudHint = document.getElementById('hudHint');           // small hint in left HUD (idle only)
  const srLive = document.getElementById('srLive');             // aria-live region for screen readers
  const hubLed = document.getElementById('hubLed');             // decorative LED (breathing/blink classes)

  // Left panel
  const nameInput  = document.getElementById('nameInput')  || { value:'', focus:()=>{} }; // name-gating + persistence

  // Stats (accuracy + reaction time sparkline)
  const statsCard = document.getElementById('statsCard');
  const accValue = document.getElementById('accValue');   // "85%" text
  const accFill  = document.getElementById('accFill');    // width-animated inner bar
  const accBar   = document.getElementById('accBar');     // progressbar element (ARIA)
  const accFoot  = document.getElementById('accFoot');    // "Based on last X inputs"

  const rtSpark  = document.getElementById('rtSpark');    // <canvas> for sparkline
  const rtAvgEl  = document.getElementById('rtAvg');      // "XXX ms"
  const rtFoot   = document.getElementById('rtFoot');     // "Last N rounds · min X · max Y"

  // Audio controls
  const volSlider = document.getElementById('volSlider'); // 0–100, persisted, maps to masterGain.gain
  const toneRadios = Array.from(document.querySelectorAll('input[name="tonePreset"]')); // short/medium/long

  // Leaderboard (right)
  const lbList     = document.getElementById('lbList');       // <ul> container for leaderboard rows
  const clearLbBtn = document.getElementById('clearLbBtn');   // clears persisted scores after confirm()

  // ===== Timing (pacing) =====
  const DELAY_AFTER_ROUND_COMPLETE = 650; // hold "Nice!" then proceed
  const DELAY_BEFORE_SHOW_SEQUENCE = 450; // small anticipatory delay before AI playback

  // Tone presets
  const PRESETS = {
    // press: how long the user's pad stays lit and tone plays when pressed
    // stepMul: scales AI playback speed per step (lower → faster)
    short:  { press: 120, stepMul: 0.85 },
    medium: { press: 150, stepMul: 1.00 },
    long:   { press: 220, stepMul: 1.15 },
  };
  function currentPreset(){
    // Returns the currently selected tone preset; defaults defensively to 'medium'.
    const sel = toneRadios.find(r => r.checked)?.value || 'medium';
    return PRESETS[sel] || PRESETS.medium;
  }

  // ===== Audio (sine beeps) =====
  const FREQS = [329.63, 261.63, 220.0, 164.81]; // green, red, yellow, blue (E4, C4, A3, E3-ish)
  let ctx = null, masterGain = null;

  function ensureAudio(){
    // Lazily initializes audio context and master gain node.
    // Also resumes a suspended context due to autoplay policies.
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.connect(ctx.destination);
      masterGain.gain.value = 0.25; // default before slider applies persisted value
    }
    if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
  }

  function playTone(index, duration = 450) {
    // Plays a short sine beep for the given pad index.
    // Returns a Promise that resolves when the oscillator ends to allow sequencing via await.
    if (!soundToggle?.checked) return Promise.resolve();
    ensureAudio();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = FREQS[index % FREQS.length];
    gain.gain.value = 0.0001; // start near silent, then ramp
    osc.connect(gain); gain.connect(masterGain);

    // Quick attack + brief release to avoid clicks
    const now = ctx.currentTime, attack = 0.01, release = 0.08;
    const durSec = Math.max(0.05, duration/1000);
    gain.gain.linearRampToValueAtTime(1.0, now + attack);
    gain.gain.linearRampToValueAtTime(0.0001, now + durSec - release);

    osc.start(now); osc.stop(now + durSec + 0.02);
    return new Promise(res => osc.onended = res);
  }

  function beepError(){
    // Distinctive error sound (square wave) that ignores the returned promise since it’s fire-and-forget.
    if (!soundToggle?.checked) return;
    ensureAudio();
    const now=ctx.currentTime, o=ctx.createOscillator(), g=ctx.createGain();
    o.type='square'; o.frequency.value=110; // low pitch for "wrong"
    g.gain.value=.001; o.connect(g); g.connect(masterGain);
    // Quick swell then fade
    g.gain.linearRampToValueAtTime(.6, now+.01);
    g.gain.linearRampToValueAtTime(.0001, now+.35);
    o.start(now); o.stop(now+.37);
  }

  // ===== UI helpers =====
  function showStatus(t, sr=false){
    // Shows center status pill with text t.
    // If sr=true, also update srLive to announce to screen readers.
    if (!statusText) return;
    statusText.hidden = false;
    statusText.textContent = t;
    if (sr && srLive) srLive.textContent = t;
  }
  function hideStatus(){
    // Hides center status pill and clears text.
    if (!statusText) return;
    statusText.hidden = true;
    statusText.textContent = '';
  }
  function setRound(n){ if (roundText) roundText.textContent = `Round ${n}`; }

  // ===== State =====
  const state = {
    mode:'idle',            // 'idle' | 'playing' | 'gameending' | 'gameover'
    sequence:[],            // AI-generated sequence of pad indices
    accepting:false,        // when true, user inputs are accepted
    inputIndex:0,           // next expected index into sequence
    round:0,                // 1-based; incremented at start of each round
    showing:false,          // true while the AI is playing back the sequence

    // Accuracy tracking
    recent:[],              // last N correctness bits (1/0) for inputs (not rounds)
    recentWindow:20,        // size of sliding window for accuracy
    runInputs:0,            // inputs seen during the entire run
    runCorrect:0,           // correct inputs during the entire run
    completedRounds:0,      // highest round fully completed in the run

    // Reaction time tracking
    rts:[],                 // reaction times (ms) for the first input of each round
    padEnableTs:0,          // timestamp when pads were enabled (for reaction baseline)
    rtWindow:24,            // number of recent rounds rendered in sparkline
  };

  // Accuracy
  function recordResult(ok){
    // Adds a correctness bit into the sliding window and tallies run counters.
    state.recent.push(ok ? 1 : 0);
    if (state.recent.length > state.recentWindow) state.recent.shift();
    state.runInputs += 1; if (ok) state.runCorrect += 1;
    updateAccuracyUI();
  }
  function getRecentAccuracy(){
    // Returns mean of recent window; if no data, assume a neutral-ish baseline (85%)
    if (state.recent.length===0) return 0.85;
    return state.recent.reduce((a,b)=>a+b,0)/state.recent.length;
  }
  function displayAccuracyValue(){
    // Writes accuracy % + progressbar width + footnote
    if (!accValue || !accFill || !accBar || !accFoot) return;
    if (state.recent.length===0){
      accValue.textContent='—'; accFill.style.width='0%'; accBar.setAttribute('aria-valuenow','0'); accFoot.textContent='Based on last 0 inputs'; return;
    }
    const pct = Math.round(getRecentAccuracy()*100);
    accValue.textContent=`${pct}%`; accFill.style.width=`${pct}%`; accBar.setAttribute('aria-valuenow', String(pct));
    accFoot.textContent = `Based on last ${state.recent.length} inputs`;
  }
  function updateAccuracyUI(){ displayAccuracyValue(); }

  // Reaction
  function pushReaction(ms){
    // Stores clamped reaction time for sparkline; only first input each round is captured.
    const clamped = Math.max(50, Math.min(2000, ms|0));
    state.rts.push(clamped);
    if (state.rts.length > state.rtWindow) state.rts.shift();
    drawRtSpark();
  }
  function drawRtSpark(){
    // Renders a lightweight sparkline of reaction times + average guide line.
    if (!rtSpark || !rtAvgEl || !rtFoot) return;
    const c = rtSpark.getContext('2d'), w=rtSpark.width, h=rtSpark.height;
    c.clearRect(0,0,w,h);
    if (state.rts.length===0){ rtAvgEl.textContent='—'; rtFoot.textContent='Last 0 rounds'; return; }
    const v=state.rts, n=v.length, min=Math.min(...v), max=Math.max(...v);
    const padX=2, padY=3, innerW=w-padX*2, innerH=h-padY*2, stepX=innerW/Math.max(1,n-1);
    const mapY = val => padY + innerH - ((val-min)/Math.max(1,max-min))*innerH;
    const avg = v.reduce((a,b)=>a+b,0)/n, avgY=mapY(avg);

    // average guide
    c.globalAlpha=.25; c.strokeStyle='#9ca3af';
    c.beginPath(); c.moveTo(padX,avgY); c.lineTo(w-padX,avgY); c.stroke(); c.globalAlpha=1;

    // line plot
    c.strokeStyle='#22d3ee'; c.lineWidth=1.5; c.beginPath();
    v.forEach((val,i)=>{ const x=padX+i*stepX, y=mapY(val); i?c.lineTo(x,y):c.moveTo(x,y); });
    c.stroke();

    // highlight last point
    const lastX=padX+(n-1)*stepX, lastY=mapY(v[n-1]);
    c.fillStyle='#22d3ee'; c.beginPath(); c.arc(lastX,lastY,2.2,0,Math.PI*2); c.fill();

    rtAvgEl.textContent=`${Math.round(avg)} ms`;
    rtFoot.textContent=`Last ${n} rounds · min ${min} · max ${max}`;
  }

  // Speed
  function stepDuration(round){
    // Computes AI playback step duration (ms) as a function of round and recent accuracy.
    // Faster at higher rounds; additionally grants a speed bonus for accuracy above 60%.
    const base=720, min=200, roundFactor=round*45;
    const acc=getRecentAccuracy(), accBonus=Math.max(0,(acc-0.60))*380; // up to +38% speed boost
    const presetMul = currentPreset().stepMul; // user tone preset also affects speed perception
    return Math.max(min, (base - roundFactor - accBonus) * presetMul);
  }

  // RNG / Pad helpers
  function randomStep(){ return Math.floor(Math.random()*4); } // 0..3 inclusive

  function enablePads(on){
    // Enables/disables all player pads; records enabling timestamp for reaction timing.
    state.accepting = on;
    padEls.forEach(el=>{ el.disabled=!on; el.setAttribute('aria-pressed','false'); });
    if (on) state.padEnableTs = performance.now();
  }

  function flashPad(el,on=true){ el.classList.toggle('is-active',!!on); } // purely visual helper

  async function lightAndSound(i,dur){
    // Lights pad i and plays tone in parallel; also blinks the hub LED for extra feedback.
    const el=padEls[i];
    flashPad(el,true);
    hubLed?.classList.add('is-blink');
    await Promise.all([playTone(i,dur), new Promise(r=>setTimeout(r,dur))]);
    flashPad(el,false);
    hubLed?.classList.remove('is-blink');
    await new Promise(r=>setTimeout(r,80)); // small inter-step gap to keep beats distinct
  }

  async function showSequence(){
    // Plays back the current sequence to the user (no input accepted during playback).
    state.showing=true; enablePads(false);
    hubLed?.classList.add('is-breathing'); // "listen" animation
    const dur=stepDuration(state.round);
    showStatus(`Listen… (speed ${Math.round(dur)}ms)`);
    for (const idx of state.sequence){
      // If state changes mid-playback (e.g., player ends), abort cleanly.
      if (state.mode!=='playing'){ state.showing=false; hubLed?.classList.remove('is-breathing'); return; }
      await lightAndSound(idx,dur);
    }
    hubLed?.classList.remove('is-breathing');
    state.showing=false; enablePads(true); showStatus('Your turn!', true); // sr announce for turn change
  }

  function updateIdleHint(){
    // Left HUD helper message nudges user to enter a name before starting.
    if (!hudHint) return;
    const hasName = (nameInput?.value || '').trim().length > 0;
    hudHint.textContent = hasName ? 'Press Start to begin' : 'Enter your name to start';
  }

  function resetToIdleUI(){
    // Resets UI + transient state back to a clean idle screen (no center pill).
    state.mode='idle';
    state.sequence=[]; state.accepting=false; state.inputIndex=0; state.round=0; state.showing=false;
    state.recent=[]; state.runInputs=0; state.runCorrect=0; state.completedRounds=0;
    state.rts=[]; drawRtSpark();
    setRound(0);
    hideStatus();               // <-- no center text when idle
    updateIdleHint();           // <-- hint lives in left HUD
    updateAccuracyUI();
    updateStartEnabled();
  }

  // ===== Leaderboard (polished) =====
  const LB_KEY='simon_leaderboard_v5'; // versioned key (bump when schema changes)
  const storageOK = (()=>{ 
    // Detect if localStorage is usable; some contexts (e.g., privacy mode) may throw.
    try{ const k='__simon_t'; localStorage.setItem(k,'1'); localStorage.removeItem(k); return true; } catch { return false; } 
  })();
  let memLB = [];       // in-memory fallback when localStorage is unavailable
  let lastAddedTs = null; // used to apply "is-new" CSS pulse to the most recent score

  function formatRelativeTime(ts){
    // Displays friendly relative time; falls back to localized date after ~1 week.
    const s = Math.floor((Date.now() - ts)/1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s/60); if (m < 60) return `${m}m ago`;
    const h = Math.floor(m/60); if (h < 24) return `${h}h ago`;
    const d = Math.floor(h/24); if (d < 7) return `${d}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month:'short', day:'numeric' });
  }

  function loadLeaderboard(){ 
    // Returns persisted list or in-memory copy; always harmless if UI is missing.
    if (!lbList) return []; 
    if (!storageOK) return memLB.slice(); 
    try{ return JSON.parse(localStorage.getItem(LB_KEY)||'[]'); }catch{ return []; } 
  }

  function saveLeaderboard(list){ 
    // Persists at most 200 entries; when storage not OK, mirrors into memLB.
    if (!lbList) return; 
    const trimmed=list.slice(0,200); 
    if (!storageOK){ memLB=trimmed.slice(); return; } 
    try{ localStorage.setItem(LB_KEY, JSON.stringify(trimmed)); }catch{} 
  }

  function addScore(name, round, acc, strict, timeOverride){
    // Appends a score and sorts by: round desc, accuracy desc, time desc.
    if (!lbList || !name) return;
    const list=loadLeaderboard();
    list.push({ name, round, acc, strict:!!strict, time: timeOverride ?? Date.now() });
    list.sort((a,b)=> b.round - a.round || b.acc - a.acc || b.time - a.time);
    saveLeaderboard(list);
  }

  function renderLeaderboard(){
    // Renders top 10 entries; adds rank chips and a relative time label.
    if (!lbList) return;
    const list=loadLeaderboard();
    lbList.innerHTML='';
    if (!list.length){
      const li=document.createElement('li'); li.className='small';
      li.textContent = storageOK ? 'No scores yet — finish a game to record one!' : 'Storage disabled: scores are temporary.';
      lbList.appendChild(li); return;
    }
    list.slice(0,10).forEach((e,i)=>{
      const li=document.createElement('li');
      li.className='lb-row';
      if (lastAddedTs && e.time === lastAddedTs) li.classList.add('is-new'); // visual highlight for the freshly saved score
      li.title = new Date(e.time).toLocaleString(); // precise tooltip timestamp

      const rank=document.createElement('span'); rank.className='rank'; rank.textContent=String(i+1);
      if (i < 3) rank.classList.add(`rank-${i+1}`); // decorate podium

      const who=document.createElement('span');  who.className='who';  who.textContent=e.name;

      const score=document.createElement('span'); score.className='score';

      const chipRound=document.createElement('span'); chipRound.className='lb-chip lb-round'; chipRound.textContent=`R${e.round}`;
      const chipAcc=document.createElement('span');   chipAcc.className='lb-chip lb-acc';   chipAcc.textContent=`${Math.round((e.acc||0)*100)}%`;
      const chipMode=document.createElement('span');  chipMode.className=`lb-chip lb-mode ${e.strict?'lb-mode--strict':'lb-mode--normal'}`; chipMode.textContent = e.strict ? 'Strict' : 'Normal';

      const time=document.createElement('span'); time.className='lb-time small'; time.textContent=formatRelativeTime(e.time);

      score.append(chipRound, chipAcc, chipMode, time);
      li.append(rank, who, score);
      lbList.appendChild(li);
    });
  }

  function getPlayerName(){ return (nameInput?.value||'').trim(); }
  function updateStartEnabled(){
    // Gate Start button behind a non-empty name while idle; during play, button becomes "End Game" (always enabled).
    if (!startBtn) return;
    const hasName = getPlayerName().length>0;
    startBtn.disabled = state.mode==='idle' ? !hasName : false;
  }

  function finalizeRun(){
    // Called once at end of a run (either via "End Game" or a terminal mistake in strict mode).
    // Computes final stats, persists to leaderboard, and transitions to 'gameover'.
    const finalRound = state.completedRounds || 0;
    const finalAcc = state.runInputs ? (state.runCorrect / state.runInputs) : 0;
    if (finalRound > 0){
      const t = Date.now();
      addScore(getPlayerName(), finalRound, finalAcc, !!strictToggle?.checked, t);
      lastAddedTs = t; // track for "is-new" pulse
      renderLeaderboard();
      showStatus(`Game over — Score R${finalRound}`);
    } else {
      showStatus('Game over — No completed rounds');
    }
    state.mode='gameover';
    enablePads(false);
    state.sequence=[]; state.accepting=false; state.inputIndex=0; state.round=0; state.showing=false;
    if (startBtn) startBtn.textContent='New Game';
  }

  // Flow
  async function onMainButton(){
    // Main button cycles behavior by mode:
    // idle → start playing; playing → request graceful end; gameover → reset to idle
    if (state.mode==='idle'){
      if (!getPlayerName()){ updateIdleHint(); nameInput?.focus(); return; }
      state.mode='playing';
      state.sequence=[]; state.inputIndex=0; state.round=0; state.completedRounds=0;
      state.recent=[]; state.runInputs=0; state.runCorrect=0; state.rts=[]; drawRtSpark();
      if (startBtn) startBtn.textContent='End Game';
      showStatus('Get ready…');          // center pill shows only during play
      await new Promise(r=>setTimeout(r,350));
      await nextRound(); return;
    }
    if (state.mode==='playing'){
      // Graceful end: stop accepting input, show short message, then finalize (end-only LB update).
      state.mode='gameending'; enablePads(false); showStatus('Ending run…');
      await new Promise(r=>setTimeout(r,120)); finalizeRun(); return;
    }
    if (state.mode==='gameover'){ resetToIdleUI(); if (startBtn) startBtn.textContent='Start'; return; }
  }

  async function nextRound(){
    // Advances to the next round: appends a random step and plays back the full sequence.
    if (state.mode!=='playing') return;
    state.inputIndex=0; state.round += 1; setRound(state.round);
    showStatus(`Round ${state.round} — get ready…`);
    await new Promise(r=>setTimeout(r, DELAY_BEFORE_SHOW_SEQUENCE));
    state.sequence.push(Math.floor(Math.random()*4));
    await showSequence();
  }

  async function handlePadPress(index){
    // Handles user pressing a pad (pointer or keyboard).
    // Validates against expected sequence element; handles strict vs retry flow; updates metrics.
    if (state.mode!=='playing' || !state.accepting) return;

    const pressDur = currentPreset().press;
    const el = padEls[index];
    el.classList.add('is-active');
    await Promise.all([ playTone(index, pressDur), new Promise(r => setTimeout(r, pressDur)) ]);
    el.classList.remove('is-active');
    await new Promise(r => setTimeout(r, 80));

    // Reaction time (first input each turn): measured from when pads were enabled after AI playback.
    if (state.inputIndex === 0 && state.padEnableTs){
      pushReaction(performance.now() - state.padEnableTs);
    }

    const expected = state.sequence[state.inputIndex];
    if (index !== expected){
      // Mistake branch
      recordResult(false); enablePads(false); beepError();
      if (strictToggle?.checked){
        // Strict mode: immediately finalize (no retries)
        await new Promise(r=>setTimeout(r,320)); finalizeRun(); return;
      } else {
        // Non-strict: replay same round from beginning
        showStatus('Wrong! Try again.'); await new Promise(r=>setTimeout(r,300));
        state.inputIndex=0; await showSequence(); return;
      }
    }

    // Correct input branch
    recordResult(true);
    state.inputIndex += 1;

    if (state.inputIndex === state.sequence.length){
      // Completed the round; capture "completedRounds" and proceed to next after a brief pause.
      state.completedRounds = Math.max(state.completedRounds, state.round);
      enablePads(false); showStatus('Nice!');
      await new Promise(r=>setTimeout(r, DELAY_AFTER_ROUND_COMPLETE));
      await nextRound();
    }
  }

  // Events
  padEls.forEach(el=>{
    // Pointer: click/tap on pads (guarded by mode/accepting in the handler)
    el.addEventListener('pointerdown', ()=>{ if (state.mode!=='playing' || !state.accepting) return; handlePadPress(Number(el.dataset.index)); });
    // Keyboard: Enter/Space trigger the focused pad
    el.addEventListener('keydown', (e)=>{ if (e.key==='Enter'||e.key===' '){ e.preventDefault(); handlePadPress(Number(el.dataset.index)); } });
  });
  startBtn?.addEventListener('click', onMainButton);
  document.addEventListener('keydown', (e)=>{ 
    // Global Enter key toggles start/stop unless typing in the name field
    if (document.activeElement===nameInput) return; 
    if (e.key==='Enter'){ onMainButton(); } 
  });

  // Labels toggle
  function applyLabels(on){ document.body.classList.toggle('labels-on', !!on); }
  (()=>{
    // Persisted preference for showing pad labels (e.g., letters)
    try{ const saved=localStorage.getItem('simon_labels'); if (saved!==null && labelsToggle) labelsToggle.checked = saved==='1'; }catch{}
    applyLabels(labelsToggle?.checked);
    labelsToggle?.addEventListener('change', ()=>{ applyLabels(labelsToggle.checked); try{ localStorage.setItem('simon_labels', labelsToggle.checked?'1':'0'); }catch{} });
  })();

  // Stats toggle (persisted)
  (()=>{
    // Allows hiding the stats card; default is visible if toggle exists, else force visible.
    try{ const saved=localStorage.getItem('simon_stats_show'); if (saved!==null && statsToggle) statsToggle.checked = saved==='1'; }catch{}
    function apply(show){ if (statsCard) statsCard.style.display = show ? '' : 'none'; try{ localStorage.setItem('simon_stats_show', show?'1':'0'); }catch{} }
    statsToggle?.addEventListener('change', ()=>apply(statsToggle.checked));
    apply(statsToggle ? statsToggle.checked : true);
  })();

  // Name persistence + gating
  (()=>{
    // Prefill name from storage; update hints and Start enabled state on input.
    try{ const savedName=localStorage.getItem('simon_name'); if (savedName && nameInput) nameInput.value=savedName; }catch{}
    updateIdleHint();
    nameInput?.addEventListener('input', ()=>{ const v=(nameInput.value||'').trim(); try{ localStorage.setItem('simon_name', v); }catch{} updateStartEnabled(); updateIdleHint(); });
  })();

  // Volume & tone preset persistence
  (()=>{
    // Volume: 0–100 slider persisted; mapped to masterGain 0.0–1.0. ensureAudio() to apply live.
    const savedVol = (()=>{ try{ return Number(localStorage.getItem('simon_vol')); }catch{ return NaN; } })();
    if (!Number.isNaN(savedVol) && volSlider) volSlider.value = String(Math.max(0, Math.min(100, savedVol)));
    function applyVolume(){ const v=Math.max(0, Math.min(100, Number(volSlider?.value||30))); try{ localStorage.setItem('simon_vol', String(v)); }catch{} ensureAudio(); masterGain.gain.value = v/100; }
    volSlider?.addEventListener('input', applyVolume); applyVolume();

    // Tone preset: persists selected radio; affects press duration and AI speed multiplier.
    const savedPreset = (()=>{ try{ return localStorage.getItem('simon_tone') || 'medium'; }catch{ return 'medium'; }})()
    ;
    toneRadios.forEach(r=>{ if (r.value===savedPreset) r.checked=true; r.addEventListener('change', ()=>{ try{ localStorage.setItem('simon_tone', r.value); }catch{} }); });
  })();

  // Clear leaderboard
  clearLbBtn?.addEventListener('click', ()=>{
    // Defensive confirm; clears storage key and re-renders empty state.
    if (confirm('Clear local leaderboard?')){
      try{ localStorage.removeItem(LB_KEY); }catch{}
      renderLeaderboard();
    }
  });

  // Init
  enablePads(false);      // prevent accidental input until a round is live
  resetToIdleUI();        // clears state, hides status, sets hint and round=0
  renderLeaderboard();    // draws persisted/memory leaderboard
})();
