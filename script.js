// ==========================================
// CONFIGURAÇÕES E VARIÁVEIS DE ESTADO
// ==========================================
const MAX_RECORD_TIME = 120;
const TONE_START_FREQ = 18500;
const TONE_END_FREQ = 17500;
const TONE_DURATION = 100;

let audioCtx, analyser, micStream, mediaRecorder;
let audioChunks = [];
let isRecording = false;
let isPlaying = false;
let isPlayingPTT = false; // NOVO CONTROLE SEPARADO
let isSystemReady = false; 
let forceWaitRelease = false; 
let activeKey = null;

let recordTimerInterval, playbackTimerInterval;
let timeRemaining = MAX_RECORD_TIME;
let playbackCurrentTime = 0;

let dataArray, peakValue = 0, peakHoldCounter = 0;
let pendingAnnouncement = false, idleTimer = null;

// Variáveis do Áudio Personalizado
let customAudioData = null;
let customAudioName = null;

// Elementos da DOM
const statusIndicator = document.getElementById('status-indicator');
const timeLabel = document.getElementById('time-label');
const timeDisplay = document.getElementById('time-remaining');
const progressFill = document.getElementById('progress-fill');
const vuBar = document.getElementById('vu-bar'), vuPeak = document.getElementById('vu-peak');
const selectAutoTime = document.getElementById('auto-announce');
const clockDisplay = document.getElementById('clock-display');

// Elementos do Áudio Personalizado
const customAudioInput = document.getElementById('custom-audio-input');
const customAudioLabel = document.getElementById('custom-audio-label');
const btnChooseFile = document.getElementById('btn-choose-file');
const btnResetAudio = document.getElementById('btn-reset-audio');

// ==========================================
// 🕒 RELÓGIO E FORMATAÇÃO
// ==========================================
function formatTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

setInterval(() => {
    const agora = new Date();
    clockDisplay.innerText = agora.getHours().toString().padStart(2, '0') + ':' + 
                             agora.getMinutes().toString().padStart(2, '0') + ':' + 
                             agora.getSeconds().toString().padStart(2, '0');
}, 1000);

// ==========================================
// 🚀 INICIALIZAÇÃO AUTOMÁTICA
// ==========================================
window.onload = () => {
    loadPreferences(); 
    resetTimerUI();
    forceInitialize();
};

async function forceInitialize() {
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const resume = async () => { if (audioCtx.state === 'suspended') { await audioCtx.resume(); setTimeout(resume, 500); }};
        resume();

        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        dataArray = new Float32Array(analyser.frequencyBinCount);
        
        startVUMeter();
        startClockSync();
        await runBootSequence();
    } catch (err) {
        setTimeout(forceInitialize, 2000);
    }
}

async function runBootSequence() {
    isPlaying = true;
    setStatus('INICIALIZANDO...', 'status-playing');
    await playBeep(TONE_START_FREQ, TONE_DURATION);
    await playAudioFile('boot.mp3'); 
    await playBeep(TONE_END_FREQ, TONE_DURATION);
    isPlaying = false; isSystemReady = true;
    setStatus('PRONTO', 'status-idle');
    checkIdleState(false); // Não é PTT, executa pendência imediatamente se houver
}

// ==========================================
// 🧠 LÓGICA INTELIGENTE (ATUALIZADA)
// ==========================================
function resetIdleTimer() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }

function checkIdleState(fromPTT = false) {
    // Agora avalia corretamente usando !isPlayingPTT
    if (pendingAnnouncement && !isRecording && !isPlayingPTT && !forceWaitRelease) {
        resetIdleTimer();
        
        if (fromPTT) {
            // Se viemos do PTT, garantimos o delay de 10s
            idleTimer = setTimeout(() => {
                if (pendingAnnouncement && !isRecording && !isPlayingPTT && !forceWaitRelease) {
                    // Evitar sobreposição com áudio regular (ex: boot)
                    if (!isPlaying) {
                        pendingAnnouncement = false;
                        executarAnuncioDeHora();
                    }
                }
            }, 10000); 
        } else {
            // Se viemos de qualquer outro áudio que terminou, a pendência toca na hora (delay 0s)
            if (!isPlaying) {
                pendingAnnouncement = false;
                executarAnuncioDeHora();
            }
        }
    }
}

// ==========================================
// ⌨️ CONTROLE PTT
// ==========================================
window.addEventListener('keydown', async (e) => {
    if (!isSystemReady || isPlaying || e.repeat || isRecording || forceWaitRelease) return;
    if (e.key === 'F7' || e.key === 'F2') { e.preventDefault(); activeKey = e.key; await startRecording(); }
});

window.addEventListener('keyup', (e) => {
    if (e.key === activeKey || (!activeKey && (e.key === 'F7' || e.key === 'F2'))) {
        e.preventDefault();
        if (forceWaitRelease) { forceWaitRelease = false; activeKey = null; processAndPlayRecording(); }
        else if (isRecording) { activeKey = null; stopRecording(); }
    }
});

// ==========================================
// 🎤 CORE: GRAVAÇÃO E REPRODUÇÃO (ATUALIZADO)
// ==========================================
async function startRecording() {
    try {
        resetIdleTimer(); isRecording = true; audioChunks = [];
        setStatus('GRAVANDO...', 'status-recording');
        analyser.disconnect();
        let micSource = audioCtx.createMediaStreamSource(micStream);
        micSource.connect(analyser);
        mediaRecorder = new MediaRecorder(micStream);
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = () => { micSource.disconnect(); if (!forceWaitRelease) processAndPlayRecording(); };
        mediaRecorder.start(); startTimer();
    } catch (err) { setStatus('ERRO MIC', 'status-idle'); isRecording = false; }
}

function stopRecording() { if (mediaRecorder?.state === 'recording') mediaRecorder.stop(); stopTimer(); isRecording = false; }

async function processAndPlayRecording() {
    resetIdleTimer(); 
    isPlaying = true; 
    isPlayingPTT = true; // SINALIZAÇÃO CORRETA PTT ATIVO
    
    setStatus('REPRODUZINDO...', 'status-playing');
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    const audioBuffer = await audioCtx.decodeAudioData(await audioBlob.arrayBuffer());
    const totalDur = (TONE_DURATION / 1000) * 2 + audioBuffer.duration;
    
    startPlaybackTimer(totalDur);
    await playBeep(TONE_START_FREQ, TONE_DURATION);
    await playBuffer(audioBuffer);
    await playBeep(TONE_END_FREQ, TONE_DURATION);
    stopPlaybackTimer(); 
    
    isPlaying = false; 
    isPlayingPTT = false; // SINALIZAÇÃO CORRETA PTT FINALIZADO
    
    setStatus('PRONTO', 'status-idle'); 
    checkIdleState(true); // FLAG TRUE: Força os 10s de delay
}

// ==========================================
// 🔊 AUDIO ENGINE
// ==========================================
function playBeep(freq, dur) {
    return new Promise(resolve => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine'; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + 0.01);
        gain.gain.setValueAtTime(0.5, audioCtx.currentTime + (dur/1000) - 0.01);
        gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + (dur/1000));
        osc.connect(gain); gain.connect(analyser); analyser.connect(audioCtx.destination);
        osc.start(); osc.stop(audioCtx.currentTime + (dur/1000));
        setTimeout(resolve, dur + 50);
    });
}

async function playAudioFile(file) {
    try {
        const resp = await fetch(file);
        const buffer = await audioCtx.decodeAudioData(await resp.arrayBuffer());
        await playBuffer(buffer);
    } catch (e) { await new Promise(r => setTimeout(r, 500)); }
}

function playBuffer(buf) {
    return new Promise(res => {
        const src = audioCtx.createBufferSource();
        src.buffer = buf; src.connect(analyser); analyser.connect(audioCtx.destination);
        src.onended = res; src.start(0);
    });
}

// ==========================================
// ⏰ HORA AUTOMÁTICA & CUSTOM AUDIO
// ==========================================
document.getElementById('btn-ouvir-hora').onclick = () => {
    if (!isSystemReady || isPlaying || isRecording) return;
    pendingAnnouncement = false; resetIdleTimer(); executarAnuncioDeHora();
};

async function executarAnuncioDeHora() {
    pendingAnnouncement = false; // Segurança para o agendamento
    isPlaying = true; setStatus('ANUNCIANDO...', 'status-playing');
    const agora = new Date();
    const h = agora.getHours().toString().padStart(2, '0'), m = agora.getMinutes().toString().padStart(2, '0');
    await playBeep(TONE_START_FREQ, TONE_DURATION);
    
    let playedCustom = false;
    if (customAudioData) {
        try {
            const resp = await fetch(customAudioData);
            const arrayBuffer = await resp.arrayBuffer();
            const buffer = await audioCtx.decodeAudioData(arrayBuffer);
            await playBuffer(buffer);
            playedCustom = true;
        } catch (e) {
            console.warn("Falha ao tocar áudio personalizado, ativando fallback.", e);
        }
    }
    
    if (!playedCustom) {
        await playAudioFile('chamada.mp3'); 
    }
    
    await playAudioFile(`${h}h.mp3`); 
    await playAudioFile(`${m}m.mp3`);
    await playBeep(TONE_END_FREQ, TONE_DURATION);
    
    isPlaying = false; setStatus('PRONTO', 'status-idle'); 
    checkIdleState(false); // Passa false pois não é PTT (sem delay de 10s para pendências)
}

function startClockSync() {
    setInterval(() => {
        if (!isSystemReady) return;
        const agora = new Date();
        if (agora.getSeconds() === 0) {
            const config = selectAutoTime.value, min = agora.getMinutes();
            let trigger = (config==='1M') || (config==='5M' && min%5===0) || (config==='15M' && min%15===0) || (config==='30M' && min%30===0) || (config==='1H' && min===0);
            if (trigger) { 
                // Se ALGO estiver tocando (PTT ou Normal), agenda. Se tiver livre, toca imediatamente.
                if (isRecording || isPlayingPTT || forceWaitRelease || isPlaying) {
                    pendingAnnouncement = true; 
                } else { 
                    executarAnuncioDeHora(); 
                }
            }
        }
    }, 1000);
}

// ==========================================
// 📁 SELETOR DE ÁUDIO & PREFERÊNCIAS
// ==========================================
btnChooseFile.onclick = () => customAudioInput.click();
btnResetAudio.onclick = resetCustomAudio;

customAudioInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    try {
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

        if (audioBuffer.duration > 60) {
            alert("Somente arquivos de até 60 segundos são permitidos.");
            resetCustomAudio();
            return;
        }

        const reader = new FileReader();
        reader.onload = (e2) => {
            const b64 = e2.target.result;
            try {
                localStorage.setItem('ptt_customAudioData', b64);
                localStorage.setItem('ptt_customAudioName', file.name);
                customAudioData = b64;
                customAudioName = file.name;
                updateAudioLabel();
            } catch (err) {
                alert("O arquivo é muito grande para ser salvo no navegador. Usando chamada padrão.");
                resetCustomAudio();
            }
        };
        reader.readAsDataURL(file);
    } catch (err) {
        console.error("Erro ao processar áudio", err);
        alert("Erro ao ler o arquivo de áudio.");
        resetCustomAudio();
    }
});

function resetCustomAudio() {
    customAudioData = null;
    customAudioName = null;
    localStorage.removeItem('ptt_customAudioData');
    localStorage.removeItem('ptt_customAudioName');
    customAudioInput.value = '';
    updateAudioLabel();
}

function updateAudioLabel() {
    if (customAudioData && customAudioName) {
        customAudioLabel.innerText = customAudioName;
        customAudioLabel.style.color = 'var(--accent-color)';
        btnResetAudio.style.display = 'inline-block';
    } else {
        customAudioLabel.innerText = "Usando chamada padrão";
        customAudioLabel.style.color = '#aaa';
        btnResetAudio.style.display = 'none';
    }
}

function loadPreferences() { 
    const s = localStorage.getItem('ptt_autoHora'); 
    if (s) selectAutoTime.value = s; 
    
    const savedAudio = localStorage.getItem('ptt_customAudioData');
    const savedName = localStorage.getItem('ptt_customAudioName');
    if (savedAudio) { 
        customAudioData = savedAudio; 
        customAudioName = savedName || 'Chamada personalizada'; 
    }
    updateAudioLabel();
}
selectAutoTime.onchange = (e) => localStorage.setItem('ptt_autoHora', e.target.value);

// ==========================================
// 📊 UI TIMERS & METERING
// ==========================================
function startTimer() {
    timeRemaining = MAX_RECORD_TIME; timeLabel.innerText = "Tempo Restante";
    progressFill.className = 'progress-fill fill-recording';
    recordTimerInterval = setInterval(() => {
        timeRemaining -= 0.1;
        if (timeRemaining <= 0) { stopRecording(); forceWaitRelease = true; setStatus('SOLTE A TECLA', 'status-recording'); }
        timeDisplay.innerText = formatTime(Math.max(0, timeRemaining));
        progressFill.style.width = `${(timeRemaining / MAX_RECORD_TIME) * 100}%`;
    }, 100);
}
function stopTimer() { clearInterval(recordTimerInterval); }

function startPlaybackTimer(dur) {
    playbackCurrentTime = 0; timeLabel.innerText = "Reproduzindo";
    progressFill.className = 'progress-fill fill-playing';
    playbackTimerInterval = setInterval(() => {
        playbackCurrentTime += 0.1; if (playbackCurrentTime > dur) playbackCurrentTime = dur;
        timeDisplay.innerText = `${formatTime(playbackCurrentTime)} / ${formatTime(dur)}`;
        progressFill.style.width = `${(playbackCurrentTime / dur) * 100}%`;
    }, 100);
}
function stopPlaybackTimer() { clearInterval(playbackTimerInterval); resetTimerUI(); }

function resetTimerUI() {
    timeLabel.innerText = "Tempo Disponível"; timeDisplay.innerText = formatTime(MAX_RECORD_TIME);
    progressFill.className = 'progress-fill fill-ready'; progressFill.style.width = '100%';
}

function setStatus(txt, cls) { statusIndicator.innerText = txt; statusIndicator.className = cls; }

function startVUMeter() {
    function draw() {
        requestAnimationFrame(draw); if (!analyser) return;
        analyser.getFloatTimeDomainData(dataArray);
        let rms = Math.sqrt(dataArray.reduce((acc, val) => acc + val * val, 0) / dataArray.length);
        let percent = Math.max(0, (20 * Math.log10(rms) + 60) / 60) * 100;
        vuBar.style.width = `${Math.min(100, percent)}%`;
        if (percent > peakValue) { peakValue = percent; peakHoldCounter = 30; } 
        else { if (peakHoldCounter > 0) peakHoldCounter--; else peakValue = Math.max(0, peakValue - 1.5); }
        vuPeak.style.left = `${Math.min(100, peakValue)}%`;
    } draw();
}