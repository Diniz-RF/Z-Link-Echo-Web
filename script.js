// ==========================================
// CONFIGURAÇÕES E ESTADO
// ==========================================
const MAX_RECORD_TIME = 120;
const MAX_CUSTOM_AUDIO_DURATION = 30;
const TONE_START_FREQ = 18500;
const TONE_END_FREQ = 17500;
const TONE_DURATION = 100;

let audioCtx, analyser, micStream, mediaRecorder;
let audioChunks = [];
let isRecording = false;
let isPlaying = false; // Controle global de reprodução
let isPlayingPTT = false; // Lógica específica de 10s
let isSystemReady = false; 
let forceWaitRelease = false; 
let activeKey = null;

let recordTimerInterval, playbackTimerInterval;
let timeRemaining = MAX_RECORD_TIME;
let playbackCurrentTime = 0;

let dataArray, peakValue = 0, peakHoldCounter = 0;
let pendingAnnouncement = false, idleTimer = null;

let customAudioData = null;
let customAudioName = null;

// DOM
const statusIndicator = document.getElementById('status-indicator');
const timeLabel = document.getElementById('time-label');
const timeDisplay = document.getElementById('time-remaining');
const progressFill = document.getElementById('progress-fill');
const vuBar = document.getElementById('vu-bar'), vuPeak = document.getElementById('vu-peak');
const selectAutoTime = document.getElementById('auto-announce');
const clockDisplay = document.getElementById('clock-display');
const customAudioInput = document.getElementById('custom-audio-input');
const customAudioLabel = document.getElementById('custom-audio-label');
const btnChooseFile = document.getElementById('btn-choose-file');
const btnResetAudio = document.getElementById('btn-reset-audio');

// ==========================================
// 🕒 RELÓGIO E AUXILIARES
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

function setStatus(txt, cls) { statusIndicator.innerText = txt; statusIndicator.className = cls; }

// ==========================================
// 🧠 LÓGICA DE DELAY (10 SEGUNDOS)
// ==========================================
function resetIdleTimer() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }

function checkIdleState(isFromPTT = false) {
    if (!pendingAnnouncement) return;
    resetIdleTimer();
    
    if (isFromPTT) {
        // Aplica 10 segundos de delay
        idleTimer = setTimeout(() => {
            if (pendingAnnouncement && !isRecording && !isPlayingPTT && !isPlaying) {
                executarAnuncioDeHora();
            }
        }, 10000);
    } else {
        // Executa imediatamente para boot ou anúncios de hora
        if (!isRecording && !isPlayingPTT && !isPlaying) {
            executarAnuncioDeHora();
        }
    }
}

// ==========================================
// 🎤 CORE: GRAVAÇÃO E PTT
// ==========================================
async function startRecording() {
    try {
        resetIdleTimer(); isRecording = true; audioChunks = [];
        setStatus('RECEBENDO', 'status-recording');
        analyser.disconnect();
        let micSource = audioCtx.createMediaStreamSource(micStream);
        micSource.connect(analyser);
        mediaRecorder = new MediaRecorder(micStream);
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = () => { micSource.disconnect(); if (!forceWaitRelease) processAndPlayRecording(); };
        mediaRecorder.start(); startTimer();
    } catch (err) { setStatus('MIC ERRO', 'status-idle'); isRecording = false; }
}

function stopRecording() { if (mediaRecorder?.state === 'recording') mediaRecorder.stop(); stopTimer(); isRecording = false; }

async function processAndPlayRecording() {
    isPlaying = true; // Bloqueia outras reproduções
    isPlayingPTT = true; // Define estado PTT para delay
    setStatus('REPRODUÇÃO', 'status-playing');
    
    try {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const audioBuffer = await audioCtx.decodeAudioData(await audioBlob.arrayBuffer());
        const totalDur = (TONE_DURATION / 1000) * 2 + audioBuffer.duration;
        
        startPlaybackTimer(totalDur);
        await playBeep(TONE_START_FREQ, TONE_DURATION);
        await playBuffer(audioBuffer);
        await playBeep(TONE_END_FREQ, TONE_DURATION);
        stopPlaybackTimer(); 
    } catch (e) {
        console.error("Erro na reprodução PTT", e);
    }
    
    isPlayingPTT = false;
    isPlaying = false;
    setStatus('PRONTO', 'status-idle'); 
    checkIdleState(true); // Aciona delay de 10s
}

// ==========================================
// ⏰ SISTEMA DE HORA
// ==========================================
async function executarAnuncioDeHora() {
    pendingAnnouncement = false;
    isPlaying = true;
    setStatus('HORA', 'status-playing');
    
    const agora = new Date();
    const h = agora.getHours().toString().padStart(2, '0'), m = agora.getMinutes().toString().padStart(2, '0');
    
    await playBeep(TONE_START_FREQ, TONE_DURATION);
    
    let playedCustom = false;
    if (customAudioData) {
        try {
            const resp = await fetch(customAudioData);
            const buffer = await audioCtx.decodeAudioData(await resp.arrayBuffer());
            await playBuffer(buffer);
            playedCustom = true;
        } catch (e) { playedCustom = false; }
    }
    
    if (!playedCustom) await playAudioFile('chamada.mp3');
    
    await playAudioFile(`${h}h.mp3`); 
    await playAudioFile(`${m}m.mp3`);
    await playBeep(TONE_END_FREQ, TONE_DURATION);
    
    isPlaying = false;
    setStatus('PRONTO', 'status-idle'); 
    checkIdleState(false); // Sem delay
}

function startClockSync() {
    setInterval(() => {
        if (!isSystemReady) return;
        const agora = new Date();
        if (agora.getSeconds() === 0) {
            const config = selectAutoTime.value, min = agora.getMinutes();
            let trigger = (config==='1M') || (config==='5M' && min%5===0) || (config==='15M' && min%15===0) || (config==='30M' && min%30===0) || (config==='1H' && min===0);
            if (trigger) { 
                pendingAnnouncement = true;
                if (!isRecording && !isPlayingPTT && !isPlaying) executarAnuncioDeHora();
            }
        }
    }, 1000);
}

// ==========================================
// 📁 ÁUDIO PERSONALIZADO (30S LIMITE)
// ==========================================
customAudioInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

        if (audioBuffer.duration > MAX_CUSTOM_AUDIO_DURATION) {
            alert("Somente arquivos de até 30 segundos são permitidos.");
            resetCustomAudio();
            return;
        }

        const reader = new FileReader();
        reader.onload = (ev) => {
            customAudioData = ev.target.result;
            customAudioName = file.name;
            localStorage.setItem('ptt_customAudioData', customAudioData);
            localStorage.setItem('ptt_customAudioName', customAudioName);
            updateAudioLabel();
        };
        reader.readAsDataURL(file);
    } catch (err) {
        alert("Erro ao processar áudio.");
        resetCustomAudio();
    }
});

function resetCustomAudio() {
    customAudioData = null; customAudioName = null;
    localStorage.removeItem('ptt_customAudioData');
    localStorage.removeItem('ptt_customAudioName');
    customAudioInput.value = '';
    updateAudioLabel();
}

function updateAudioLabel() {
    if (customAudioData) {
        customAudioLabel.innerText = customAudioName;
        customAudioLabel.style.color = 'var(--accent-color)';
        btnResetAudio.style.display = 'inline-block';
    } else {
        customAudioLabel.innerText = "CHAMADA PADRÃO";
        customAudioLabel.style.color = '#aaa';
        btnResetAudio.style.display = 'none';
    }
}

// ==========================================
// 🚀 BOOT E INICIALIZAÇÃO
// ==========================================
window.onload = () => { loadPreferences(); resetTimerUI(); forceInitialize(); };

async function forceInitialize() {
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        dataArray = new Float32Array(analyser.frequencyBinCount);
        startVUMeter();
        startClockSync();
        
        isPlaying = true;
        setStatus('INICIANDO', 'status-playing');
        await playBeep(TONE_START_FREQ, TONE_DURATION);
        await playAudioFile('boot.mp3'); 
        await playBeep(TONE_END_FREQ, TONE_DURATION);
        isPlaying = false; isSystemReady = true;
        setStatus('PRONTO', 'status-idle');
        checkIdleState(false);
    } catch (err) { setTimeout(forceInitialize, 2000); }
}

// EVENTOS DE TECLADO
window.addEventListener('keydown', async (e) => {
    if (!isSystemReady || isPlaying || isPlayingPTT || e.repeat || isRecording || forceWaitRelease) return;
    if (e.key === 'F7' || e.key === 'F2') { e.preventDefault(); activeKey = e.key; await startRecording(); }
});

window.addEventListener('keyup', (e) => {
    if (e.key === activeKey) {
        e.preventDefault();
        if (forceWaitRelease) { forceWaitRelease = false; activeKey = null; processAndPlayRecording(); }
        else if (isRecording) { activeKey = null; stopRecording(); }
    }
});

document.getElementById('btn-ouvir-hora').onclick = () => {
    if (!isSystemReady || isPlaying || isRecording || isPlayingPTT) return;
    executarAnuncioDeHora();
};

btnChooseFile.onclick = () => customAudioInput.click();
btnResetAudio.onclick = resetCustomAudio;

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
    } catch (e) {}
}

function playBuffer(buf) {
    return new Promise(res => {
        const src = audioCtx.createBufferSource();
        src.buffer = buf; src.connect(analyser); analyser.connect(audioCtx.destination);
        src.onended = res; src.start(0);
    });
}

function startTimer() {
    timeRemaining = MAX_RECORD_TIME; 
    timeLabel.innerText = "TEMPO DISPONÍVEL";
    progressFill.className = 'progress-fill fill-recording';
    recordTimerInterval = setInterval(() => {
        timeRemaining -= 0.1;
        if (timeRemaining <= 0) { 
            stopRecording(); 
            forceWaitRelease = true; 
            setStatus('ESGOTADO', 'status-recording'); 
        }
        timeDisplay.innerText = formatTime(Math.max(0, timeRemaining));
        progressFill.style.width = `${(timeRemaining / MAX_RECORD_TIME) * 100}%`;
    }, 100);
}

function stopTimer() { clearInterval(recordTimerInterval); }

function startPlaybackTimer(dur) {
    playbackCurrentTime = 0; timeLabel.innerText = "REPRODUÇÃO";
    progressFill.className = 'progress-fill fill-playing';
    playbackTimerInterval = setInterval(() => {
        playbackCurrentTime += 0.1;
        timeDisplay.innerText = `${formatTime(playbackCurrentTime)} / ${formatTime(dur)}`;
        progressFill.style.width = `${Math.min(100, (playbackCurrentTime / dur) * 100)}%`;
    }, 100);
}

function stopPlaybackTimer() { clearInterval(playbackTimerInterval); resetTimerUI(); }

function resetTimerUI() {
    timeLabel.innerText = "TEMPO DISPONÍVEL"; timeDisplay.innerText = formatTime(MAX_RECORD_TIME);
    progressFill.className = 'progress-fill fill-ready'; progressFill.style.width = '100%';
}

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

function loadPreferences() {
    const s = localStorage.getItem('ptt_autoHora'); if (s) selectAutoTime.value = s;
    customAudioData = localStorage.getItem('ptt_customAudioData');
    customAudioName = localStorage.getItem('ptt_customAudioName');
    updateAudioLabel();
}
selectAutoTime.onchange = (e) => localStorage.setItem('ptt_autoHora', e.target.value);