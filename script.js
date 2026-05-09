// ==========================================
// CONFIGURAÇÕES E ESTADO
// ==========================================
const MAX_RECORD_TIME = 120;
const MAX_CUSTOM_AUDIO_DURATION = 30;
const TONE_START_FREQ = 18500;
const TONE_END_FREQ = 17500;
const TONE_DURATION = 100;

let dtmfCommand = null; 
let dtmfAudioFile = null;
let lastRecording = null; 
let echoEnabled = true;

let audioCtx, analyser, micStream, mediaRecorder;
let micSourceGlobal, dtmfSource;
let audioChunks = [];
let isRecording = false;
let isPlaying = false; 
let isPlayingPTT = false; 
let isSystemReady = false; 
let forceWaitRelease = false; 
let discardCurrentRecording = false;
let activeKey = null;
let pttReleaseTimer = null; 

let recordTimerInterval, playbackTimerInterval;
let timeRemaining = MAX_RECORD_TIME;
let playbackCurrentTime = 0;

let dataArray, peakValue = 0, peakHoldCounter = 0;
let pendingAnnouncement = false, idleTimer = null;

let customAudioData = null;
let customAudioName = null;
let pendingTimeConfirmation = null;

let waitingTimeConfig = false;
let timeConfigTimeout = null;
const TIME_CONFIG_TIMEOUT = 15000;
let timeConfigRemaining = TIME_CONFIG_TIMEOUT;
let timeConfigInterval = null;
let timeConfigSequence = "";
let timeConfigCompleted = false;
let appStartTime = Date.now();
let virtualBaseTime = Date.now();

// ==========================================
// 🧠 VARIÁVEIS DTMF
// ==========================================
let dtmfSequence = "";
let dtmfLocked = false;
let lastDetectedKey = null;
let lastKeyTime = 0;

let toneActive = false; 
const RELEASE_TIMEOUT = 100; 

let stableKey = null;
let stableCount = 0;
const STABLE_MIN = 3;

const dtmfResult = document.getElementById('dtmf-result');
let dtmfAnalyser, dtmfDataArray;

const dbgKey = document.getElementById('dbg-key');
const dbgRow = document.getElementById('dbg-row');
const dbgCol = document.getElementById('dbg-col');
const dbgSeq = document.getElementById('dbg-seq');

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

function getVirtualDate() {
    const elapsed = Date.now() - appStartTime;
    return new Date(virtualBaseTime + elapsed);
}

// ==========================================
// 🕒 RELÓGIO E AUXILIARES DE RESET
// ==========================================
function formatTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function resetDTMFUI() {
    dtmfResult.innerText = "AGUARDANDO";
    dtmfSequence = "";
    dbgSeq.innerText = "";
    dtmfLocked = false;
}

function resetToIdle() {
    setStatus('PRONTO', 'status-idle');
    resetDTMFUI();
}

setInterval(() => {
    const agora = getVirtualDate();
    clockDisplay.innerText = agora.getHours().toString().padStart(2, '0') + ':' + 
                             agora.getMinutes().toString().padStart(2, '0') + ':' + 
                             agora.getSeconds().toString().padStart(2, '0');
}, 1000);

function setStatus(txt, cls) { 
    statusIndicator.innerText = txt; 
    statusIndicator.className = cls; 
}

function resetIdleTimer() { 
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } 
}

function checkIdleState(isFromPTT = false) {
    if (!pendingAnnouncement) return;
    resetIdleTimer();
    
    if (isFromPTT) {
        idleTimer = setTimeout(() => {
            if (pendingAnnouncement && !isRecording && !isPlayingPTT && !isPlaying) {
                executarAnuncioDeHora().finally(resetToIdle);
            }
        }, 10000);
    } else {
        if (!isRecording && !isPlayingPTT && !isPlaying) {
            executarAnuncioDeHora().finally(resetToIdle);
        }
    }
}

// ==========================================
// 🎛️ DETECÇÃO DTMF
// ==========================================
async function processDTMFFrame(buffer, sampleRate) {
    if (!sampleRate) return null;

    if (!isRecording && !waitingTimeConfig) {
        lastDetectedKey = null;
        stableKey = null;
        stableCount = 0;
        return null;
    }

    const rows = [697, 770, 852, 941];
    const cols = [1209, 1336, 1477];
    const keypad = [
        ['1','2','3'],
        ['4','5','6'],
        ['7','8','9'],
        ['*','0','#']
    ];

    function getGoertzelMag(freq) {
        const k = Math.floor(0.5 + (buffer.length * freq) / sampleRate);
        const omega = (2.0 * Math.PI * k) / buffer.length;
        const cosine = Math.cos(omega);
        const coeff = 2.0 * cosine;
        let q1 = 0, q2 = 0;
        for (let i = 0; i < buffer.length; i++) {
            const sample = buffer[i] * 32768;
            const q0 = coeff * q1 - q2 + sample;
            q2 = q1;
            q1 = q0;
        }
        return Math.sqrt(q1 * q1 + q2 * q2 - q1 * q2 * coeff);
    }

    let maxRowMag = 0, rowIdx = -1;
    for (let i = 0; i < rows.length; i++) {
        let mag = getGoertzelMag(rows[i]);
        if (mag > maxRowMag) { maxRowMag = mag; rowIdx = i; }
    }

    let maxColMag = 0, colIdx = -1;
    for (let i = 0; i < cols.length; i++) {
        let mag = getGoertzelMag(cols[i]);
        if (mag > maxColMag) { maxColMag = mag; colIdx = i; }
    }

    dbgRow.innerText = Math.round(maxRowMag);
    dbgCol.innerText = Math.round(maxColMag);

    const MIN_LEVEL = 3000;
    const DOMINANCE = 2.0;

    let secondRowMag = 0;
    for (let i = 0; i < rows.length; i++) {
        if (i !== rowIdx) {
            const mag = getGoertzelMag(rows[i]);
            if (mag > secondRowMag) secondRowMag = mag;
        }
    }

    let secondColMag = 0;
    for (let i = 0; i < cols.length; i++) {
        if (i !== colIdx) {
            const mag = getGoertzelMag(cols[i]);
            if (mag > secondColMag) secondColMag = mag;
        }
    }

    if (
        rowIdx !== -1 &&
        colIdx !== -1 &&
        maxRowMag > MIN_LEVEL &&
        maxColMag > MIN_LEVEL &&
        maxRowMag > secondRowMag * DOMINANCE &&
        maxColMag > secondColMag * DOMINANCE
    ) {
        toneActive = true;
        let currentKey = keypad[rowIdx][colIdx];
        
        if (!/^[0-9*#]$/.test(currentKey)) {
            dbgKey.innerText = "BLOQ";
            return null;
        }

        dbgKey.innerText = currentKey;

        if (currentKey === stableKey) {
            stableCount++;
        } else {
            stableKey = currentKey;
            stableCount = 1;
        }

        if (stableCount >= STABLE_MIN) {
            if (waitingTimeConfig) {
                if (timeConfigCompleted) {
                    if (performance.now() - lastKeyTime > RELEASE_TIMEOUT) {
                        lastDetectedKey = null;
                    }
                    return null;
                }
                
                if (lastDetectedKey === null) {
                    lastDetectedKey = stableKey;
                    lastKeyTime = performance.now();
                    
                    if (stableKey === "#") {
                        return null;
                    }
                    
                    timeConfigSequence += stableKey;

                    function isValidTimePrefix(seq) {
                        if (seq === "7" || seq === "78" || seq === "788" || seq === "7886") {
                            return true;
                        }
                        if (!/^[0-9]+$/.test(seq)) return false;
                        if (seq.length === 1) return ["0", "1", "2"].includes(seq);
                        if (seq.length === 2) {
                            const hh = parseInt(seq);
                            return hh >= 0 && hh <= 23;
                        }
                        if (seq.length === 3) {
                            const hh = parseInt(seq.slice(0, 2));
                            const mm1 = parseInt(seq[2]);
                            return (hh >= 0 && hh <= 23 && mm1 >= 0 && mm1 <= 5);
                        }
                        if (seq.length === 4) {
                            const hh = parseInt(seq.slice(0, 2));
                            const mm = parseInt(seq.slice(2, 4));
                            return (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59);
                        }
                        return false;
                    }

                    if (!isValidTimePrefix(timeConfigSequence)) {
                        timeConfigSequence = "";
                        pendingTimeConfirmation = null;
                        timeConfigCompleted = false;
                        timeConfigRemaining = TIME_CONFIG_TIMEOUT;
                        audioChunks = []; lastRecording = null;
                        isPlaying = true;
                        setStatus('AJUSTE HORA', 'status-playing');
                        await playBeep(TONE_START_FREQ, TONE_DURATION);
                        await playAudioFile("reentry.mp3");
                        await playBeep(TONE_END_FREQ, TONE_DURATION);
                        await new Promise(resolve => setTimeout(resolve, 500));
                        isPlaying = false;
                        setStatus('AJUSTE HORA', 'status-playing');
                        return null;
                    }

                    timeConfigRemaining = TIME_CONFIG_TIMEOUT;
                    timeConfigSequence = timeConfigSequence.replace(/[^0-9]/g, '');

                    if (timeConfigSequence.length > 4) {
                        timeConfigSequence = timeConfigSequence.slice(-4);
                    }

                    dbgSeq.innerText = timeConfigSequence;

                    if (timeConfigSequence === "7886") {
                        waitingTimeConfig = false;
                        timeConfigCompleted = false;
                        timeConfigSequence = "";
                        pendingTimeConfirmation = null;
                        lastDetectedKey = null;
                        stableKey = null;
                        stableCount = 0;
                        dtmfSequence = "";
                        dtmfLocked = false;
                        dbgSeq.innerText = "";
                        clearInterval(timeConfigInterval);
                        timeConfigInterval = null;
                        timeConfigRemaining = TIME_CONFIG_TIMEOUT;
                        virtualBaseTime = Date.now();
                        appStartTime = Date.now();
                        discardCurrentRecording = true;
                        audioChunks = []; lastRecording = null;
                        isPlaying = true;
                        setStatus('RESET HORA', 'status-playing');
                        await playBeep(TONE_START_FREQ, TONE_DURATION);
                        await playAudioFile("resettime.mp3");
                        await playBeep(TONE_END_FREQ, TONE_DURATION);
                        await new Promise(resolve => setTimeout(resolve, 500));
                        isPlaying = false;
                        resetTimerUI();
                        resetToIdle();
                        return null;
                    }

                    if (timeConfigSequence.length === 4) {
                        const hora = parseInt(timeConfigSequence.slice(0, 2));
                        const minuto = parseInt(timeConfigSequence.slice(2, 4));
                        if (hora >= 0 && hora <= 23 && minuto >= 0 && minuto <= 59) {
                            const target = getVirtualDate();
                            target.setHours(hora); target.setMinutes(minuto); target.setSeconds(0);
                            virtualBaseTime = target.getTime();
                            appStartTime = Date.now();
                            pendingTimeConfirmation = { hora, minuto };
                            timeConfigCompleted = true;
                        } else {
                            timeConfigSequence = "";
                            pendingTimeConfirmation = null;
                            timeConfigCompleted = false;
                            timeConfigRemaining = TIME_CONFIG_TIMEOUT;
                            isPlaying = true;
                            setStatus('AJUSTE HORA', 'status-playing');
                            await playBeep(TONE_START_FREQ, TONE_DURATION);
                            await playAudioFile("reentry.mp3");
                            await playBeep(TONE_END_FREQ, TONE_DURATION);
                            await new Promise(resolve => setTimeout(resolve, 500));
                            isPlaying = false;
                            setStatus('AJUSTE HORA', 'status-playing');
                            return null;
                        }
                    }
                }
                if (performance.now() - lastKeyTime > RELEASE_TIMEOUT) {
                    lastDetectedKey = null;
                }
                return null;
            }

            if (lastDetectedKey === null) {
                lastDetectedKey = stableKey;
                lastKeyTime = performance.now();

                if (!dtmfLocked) {
                    dtmfSequence += stableKey;
                    dtmfSequence = dtmfSequence.replace(/[^0-9]/g, '');
                    if (dtmfSequence.length > 10) {
                        dtmfSequence = dtmfSequence.slice(-10);
                    }
                    dbgSeq.innerText = dtmfSequence;
                }

                if (dtmfSequence.endsWith("7375")) {
                    dtmfResult.innerText = "REPLAY IDENTIFICADO";
                    dtmfCommand = "REPLAY";
                    dtmfLocked = true;
                }
                if (dtmfSequence.endsWith("4672")) {
                    dtmfResult.innerText = "HORA IDENTIFICADA";
                    dtmfCommand = "HORA";
                    dtmfLocked = true;
                }
                if (dtmfSequence.endsWith("3263")) {
                    dtmfResult.innerText = "ECHO DESATIVADO";
                    dtmfCommand = "ECHO_OFF";
                    dtmfLocked = true;
                }
                if (dtmfSequence.endsWith("3266")) {
                    dtmfResult.innerText = "ECHO ATIVADO";
                    dtmfCommand = "ECHO_ON";
                    dtmfLocked = true;
                }
                if (dtmfSequence.endsWith("2586")) {
                    dtmfResult.innerText = "AJUSTE DE HORA";
                    dtmfCommand = "TIME_CONFIG";
                    dtmfLocked = true;
                }
                
                const autoMap = {
                    "0000": { label: "AUTO OFF", val: "OFF" },
                    "0001": { label: "AUTO 1 MIN", val: "1M" },
                    "0005": { label: "AUTO 5 MIN", val: "5M" },
                    "0015": { label: "AUTO 15 MIN", val: "15M" },
                    "0030": { label: "AUTO 30 MIN", val: "30M" },
                    "0060": { label: "AUTO HORA CHEIA", val: "1H" }
                };
                for (let code in autoMap) {
                    if (dtmfSequence.endsWith(code)) {
                        dtmfResult.innerText = autoMap[code].label;
                        dtmfCommand = "AUTO";
                        dtmfLocked = true;
                        dtmfAudioFile = `${code}.mp3`;
                        selectAutoTime.value = autoMap[code].val;
                        localStorage.setItem('ptt_autoHora', autoMap[code].val);
                    }
                }
            }
        }
    } else {
        dbgKey.innerText = "-";
        toneActive = false;
        if (!toneActive) {
            lastDetectedKey = null;
            stableKey = null;
            stableCount = 0;
        }
    }
    return null;
}

function startContinuousDTMF() {
    function scan() {
        requestAnimationFrame(scan);
        if (!isSystemReady || !dtmfAnalyser) return;
        dtmfAnalyser.getFloatTimeDomainData(dtmfDataArray);
        processDTMFFrame(dtmfDataArray, audioCtx.sampleRate);
    }
    scan();
}

// ==========================================
// 🎤 CORE: GRAVAÇÃO E PTT
// ==========================================
async function startRecording() {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    try {
        resetIdleTimer(); isRecording = true; audioChunks = [];
        setStatus('RECEBENDO', 'status-recording');
        analyser.disconnect();
        let recSource = audioCtx.createMediaStreamSource(micStream);
        recSource.connect(analyser);
        mediaRecorder = new MediaRecorder(micStream);
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = async () => {
            recSource.disconnect();
            if (dtmfCommand !== null) {
                audioChunks = [];
                resetTimerUI();
                timeRemaining = MAX_RECORD_TIME;
                if (dtmfCommand === "REPLAY") executarReplay().finally(resetToIdle);
                if (dtmfCommand === "HORA") executarAnuncioDeHoraDTMF().finally(resetToIdle);
                if (dtmfCommand === "AUTO") executarAutoConfirmacao(dtmfAudioFile).finally(resetToIdle);
                if (dtmfCommand === "ECHO_OFF") { echoEnabled = false; executarEchoOff().finally(resetToIdle); }
                if (dtmfCommand === "ECHO_ON") { echoEnabled = true; executarEchoOn().finally(resetToIdle); }
                if (dtmfCommand === "TIME_CONFIG") await iniciarModoAjusteHora();
                dtmfCommand = null;
                return;
            }
            if (waitingTimeConfig && !pendingTimeConfirmation) {
                audioChunks = []; lastRecording = null; return;
            }
            if (pendingTimeConfirmation) {
                const { hora, minuto } = pendingTimeConfirmation;
                pendingTimeConfirmation = null; timeConfigCompleted = false;
                audioChunks = []; lastRecording = null;
                waitingTimeConfig = false; clearInterval(timeConfigInterval);
                timeConfigInterval = null; timeConfigRemaining = TIME_CONFIG_TIMEOUT;
                await confirmarHoraConfigurada(hora, minuto);
                return;
            }
            if (discardCurrentRecording) {
                discardCurrentRecording = false;
                audioChunks = [];
                lastRecording = null;
                return;
            }
            if (audioChunks.length > 0) {
                lastRecording = audioChunks.slice();
            }
            processAndPlayRecording();
        };
        mediaRecorder.start(); 
        startTimer();
    } catch (err) { setStatus('MIC ERRO', 'status-idle'); isRecording = false; }
}

function stopRecording() { 
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop(); 
    stopTimer(); isRecording = false; 
}

async function processAndPlayRecording() {
    if (!echoEnabled) { isPlayingPTT = false; isPlaying = false; resetToIdle(); checkIdleState(true); return; }
    isPlaying = true; isPlayingPTT = true; 
    setStatus('REPRODUÇÃO', 'status-playing');
    try {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const audioBuffer = await audioCtx.decodeAudioData(await audioBlob.arrayBuffer());
        const totalDur = (TONE_DURATION / 1000) * 2 + audioBuffer.duration;
        startPlaybackTimer(totalDur);
        await playBeep(TONE_START_FREQ, TONE_DURATION);
        await playBuffer(audioBuffer);
        await playBeep(TONE_END_FREQ, TONE_DURATION);
        await new Promise(resolve => setTimeout(resolve, 500));
        stopPlaybackTimer(); 
    } catch (e) { console.error(e); }
    isPlayingPTT = false; isPlaying = false;
    resetToIdle(); checkIdleState(true); 
}

// ==========================================
// ⏰ AUXILIARES E EVENTOS
// ==========================================
async function executarEchoOff() {
    isPlaying = true; setStatus('ECHO OFF', 'status-playing');
    await playBeep(TONE_START_FREQ, TONE_DURATION);
    await playAudioFile("echo_off.mp3");
    await playBeep(TONE_END_FREQ, TONE_DURATION);
    await new Promise(resolve => setTimeout(resolve, 500));
    isPlaying = false;
}

async function executarEchoOn() {
    isPlaying = true; setStatus('ECHO ON', 'status-playing');
    await playBeep(TONE_START_FREQ, TONE_DURATION);
    await playAudioFile("echo_on.mp3");
    await playBeep(TONE_END_FREQ, TONE_DURATION);
    await new Promise(resolve => setTimeout(resolve, 500));
    isPlaying = false;
}

async function executarAnuncioDeHora() {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    pendingAnnouncement = false; isPlaying = true;
    setStatus('HORA', 'status-playing');
    const agora = getVirtualDate();
    const h = agora.getHours().toString().padStart(2, '0'), m = agora.getMinutes().toString().padStart(2, '0');
    await playBeep(TONE_START_FREQ, TONE_DURATION);
    let playedCustom = false;
    if (customAudioData) {
        try {
            const resp = await fetch(customAudioData);
            const buffer = await audioCtx.decodeAudioData(await resp.arrayBuffer());
            await playBuffer(buffer); playedCustom = true;
        } catch (e) { playedCustom = false; }
    }
    if (!playedCustom) await playAudioFile('chamada.mp3');
    await playAudioFile(`${h}h.mp3`); await playAudioFile(`${m}m.mp3`);
    await playBeep(TONE_END_FREQ, TONE_DURATION);
    await new Promise(resolve => setTimeout(resolve, 500));
    isPlaying = false; 
}

async function executarAnuncioDeHoraDTMF() {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    pendingAnnouncement = false; isPlaying = true;
    setStatus('HORA', 'status-playing');
    const agora = getVirtualDate();
    const hora = agora.getHours();
    let saudacao = (hora >= 0 && hora <= 11) ? "dia.mp3" : (hora >= 12 && hora <= 17) ? "tarde.mp3" : "noite.mp3";
    const h = hora.toString().padStart(2, '0'), m = agora.getMinutes().toString().padStart(2, '0');
    await playBeep(TONE_START_FREQ, TONE_DURATION);
    await playAudioFile(saudacao); await playAudioFile(`${h}h.mp3`); await playAudioFile(`${m}m.mp3`);
    await playBeep(TONE_END_FREQ, TONE_DURATION);
    await new Promise(resolve => setTimeout(resolve, 500));
    isPlaying = false;
}

async function executarReplay() {
    if (isPlaying) return;
    isPlaying = true; setStatus('REPLAY', 'status-playing');
    try {
        if (!lastRecording || lastRecording.length === 0) { isPlaying = false; return; }
        const audioBlob = new Blob(lastRecording, { type: 'audio/webm' });
        const audioBuffer = await audioCtx.decodeAudioData(await audioBlob.arrayBuffer());
        await playBeep(TONE_START_FREQ, TONE_DURATION);
        await playAudioFile("replay.mp3");
        startPlaybackTimer(audioBuffer.duration);
        await playBuffer(audioBuffer);
        await playBeep(TONE_END_FREQ, TONE_DURATION);
        await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) { console.error(e); }
    stopPlaybackTimer(); isPlaying = false;
}

async function executarAutoConfirmacao(file) {
    if (isPlaying) return;
    isPlaying = true; setStatus('CONFIRMAÇÃO', 'status-playing');
    try {
        await playBeep(TONE_START_FREQ, TONE_DURATION); await playAudioFile(file); await playBeep(TONE_END_FREQ, TONE_DURATION);
        await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) { console.error(e); }
    isPlaying = false;
}

async function iniciarModoAjusteHora() {
    timeConfigSequence = ""; resetDTMFUI(); resetTimerUI();
    timeConfigCompleted = false; pendingTimeConfirmation = null;
    isPlaying = true; setStatus('AJUSTE HORA', 'status-playing');
    await playBeep(TONE_START_FREQ, TONE_DURATION); await playAudioFile("ajtm.mp3"); await playBeep(TONE_END_FREQ, TONE_DURATION);
    await new Promise(resolve => setTimeout(resolve, 500));
    isPlaying = false; waitingTimeConfig = true;
    timeConfigRemaining = TIME_CONFIG_TIMEOUT;
    clearInterval(timeConfigInterval);
    timeConfigInterval = setInterval(async () => {
        if (!waitingTimeConfig) { clearInterval(timeConfigInterval); return; }
        if (isRecording) return;
        timeConfigRemaining -= 100;
        if (timeConfigRemaining <= 0) {
            clearInterval(timeConfigInterval);
            waitingTimeConfig = false; timeConfigSequence = ""; timeConfigCompleted = false; pendingTimeConfirmation = null;
            await playBeep(TONE_START_FREQ, TONE_DURATION); await playAudioFile("end.mp3"); await playBeep(TONE_END_FREQ, TONE_DURATION);
            await new Promise(resolve => setTimeout(resolve, 500));
            resetTimerUI(); resetToIdle();
        }
    }, 100);
}

async function confirmarHoraConfigurada(hora, minuto) {
    isPlaying = true; setStatus('HORA AJUSTADA', 'status-playing');
    await playBeep(TONE_START_FREQ, TONE_DURATION);
    await playAudioFile("confirmado.mp3");
    await playAudioFile(`${hora.toString().padStart(2,'0')}h.mp3`);
    await playAudioFile(`${minuto.toString().padStart(2,'0')}m.mp3`);
    await playBeep(TONE_END_FREQ, TONE_DURATION);
    await new Promise(resolve => setTimeout(resolve, 500));
    isPlaying = false; timeConfigSequence = ""; resetTimerUI(); resetToIdle();
}

function startClockSync() {
    setInterval(() => {
        if (!isSystemReady) return;
        const agora = getVirtualDate();
        if (agora.getSeconds() === 0) {
            const config = selectAutoTime.value, min = agora.getMinutes();
            let trigger = (config==='1M') || (config==='5M' && min%5===0) || (config==='15M' && min%15===0) || (config==='30M' && min%30===0) || (config==='1H' && min===0);
            if (trigger) { 
                pendingAnnouncement = true;
                if (!isRecording && !isPlayingPTT && !isPlaying) executarAnuncioDeHora().finally(resetToIdle);
            }
        }
    }, 1000);
}

customAudioInput.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const buffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
        if (buffer.duration > MAX_CUSTOM_AUDIO_DURATION) { alert("Limite 30s."); resetCustomAudio(); return; }
        const reader = new FileReader();
        reader.onload = (ev) => {
            customAudioData = ev.target.result; customAudioName = file.name;
            localStorage.setItem('ptt_customAudioData', customAudioData);
            localStorage.setItem('ptt_customAudioName', customAudioName);
            updateAudioLabel();
        };
        reader.readAsDataURL(file);
    } catch (err) { resetCustomAudio(); }
});

function resetCustomAudio() {
    customAudioData = null; customAudioName = null;
    localStorage.removeItem('ptt_customAudioData'); localStorage.removeItem('ptt_customAudioName');
    customAudioInput.value = ''; updateAudioLabel();
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

window.onload = () => { loadPreferences(); resetTimerUI(); forceInitialize(); };

async function forceInitialize() {
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        dtmfAnalyser = audioCtx.createAnalyser(); dtmfAnalyser.fftSize = 2048;
        dtmfDataArray = new Float32Array(dtmfAnalyser.fftSize);
        dtmfSource = audioCtx.createMediaStreamSource(micStream); dtmfSource.connect(dtmfAnalyser);
        analyser = audioCtx.createAnalyser(); analyser.fftSize = 2048;
        dataArray = new Float32Array(analyser.frequencyBinCount);
        startVUMeter(); startContinuousDTMF(); startClockSync();
        isPlaying = true; setStatus('INICIANDO', 'status-playing');
        await playBeep(TONE_START_FREQ, TONE_DURATION);
        try { await playAudioFile('boot.mp3'); } catch(e) {}
        await playBeep(TONE_END_FREQ, TONE_DURATION);
        await new Promise(resolve => setTimeout(resolve, 500));
        isPlaying = false; isSystemReady = true; resetToIdle();
    } catch (err) { setTimeout(forceInitialize, 2000); }
}

window.addEventListener('keydown', async (e) => {
    if (pttReleaseTimer) { clearTimeout(pttReleaseTimer); pttReleaseTimer = null; }
    if (!isSystemReady || isPlaying || isPlayingPTT || e.repeat || isRecording || forceWaitRelease) return;
    if (e.key === 'F7' || e.key === 'F2') { e.preventDefault(); activeKey = e.key; await startRecording(); }
});

window.addEventListener('keyup', (e) => {
    if (e.key === activeKey) {
        e.preventDefault();
        if (pttReleaseTimer) clearTimeout(pttReleaseTimer);
        pttReleaseTimer = setTimeout(() => {
            if (forceWaitRelease) { 
                forceWaitRelease = false; 
                activeKey = null;
                dtmfSequence = "";
                dtmfLocked = false;
                lastDetectedKey = null;
                stableKey = null;
                stableCount = 0;
                dbgSeq.innerText = "";
                processAndPlayRecording(); 
            } 
            else if (isRecording) { 
                activeKey = null;
                dtmfSequence = "";
                dtmfLocked = false;
                lastDetectedKey = null;
                stableKey = null;
                stableCount = 0;
                dbgSeq.innerText = "";
                stopRecording(); 
            }
        }, 400);
    }
});

document.getElementById('btn-ouvir-hora').onclick = () => {
    if (!isSystemReady || isPlaying || isRecording || isPlayingPTT) return;
    executarAnuncioDeHora().finally(resetToIdle);
};

btnChooseFile.onclick = () => customAudioInput.click();
btnResetAudio.onclick = resetCustomAudio;

function playBeep(freq, dur) {
    return new Promise(resolve => {
        const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
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
    const resp = await fetch(file);
    const buffer = await audioCtx.decodeAudioData(await resp.arrayBuffer());
    await playBuffer(buffer);
}

function playBuffer(buf) {
    return new Promise(res => {
        const src = audioCtx.createBufferSource(); src.buffer = buf;
        src.connect(analyser); analyser.connect(audioCtx.destination);
        src.onended = res; src.start(0);
    });
}

function startTimer() {
    timeRemaining = MAX_RECORD_TIME; timeLabel.innerText = "TEMPO DISPONÍVEL";
    progressFill.className = 'progress-fill fill-recording';
    recordTimerInterval = setInterval(() => {
        timeRemaining -= 0.1;
        if (timeRemaining <= 0) { stopRecording(); forceWaitRelease = true; setStatus('ESGOTADO', 'status-recording'); }
        timeDisplay.innerText = formatTime(Math.max(0, timeRemaining));
        progressFill.style.width = `${(timeRemaining / MAX_RECORD_TIME) * 100}%`;
    }, 100);
}

function stopTimer() { clearInterval(recordTimerInterval); }

function startPlaybackTimer(dur) {
    clearInterval(playbackTimerInterval);
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
    } 
    draw();
}

function loadPreferences() {
    const s = localStorage.getItem('ptt_autoHora'); if (s) selectAutoTime.value = s;
    customAudioData = localStorage.getItem('ptt_customAudioData');
    customAudioName = localStorage.getItem('ptt_customAudioName');
    updateAudioLabel();
}

selectAutoTime.onchange = (e) => localStorage.setItem('ptt_autoHora', e.target.value);