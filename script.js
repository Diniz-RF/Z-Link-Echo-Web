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
let isSystemReady = false; // Só libera após o boot
let forceWaitRelease = false; 
let activeKey = null;

let recordTimerInterval;
let timeRemaining = MAX_RECORD_TIME;

let dataArray;
let peakValue = 0;
let peakHoldCounter = 0;

// Elementos da DOM
const statusIndicator = document.getElementById('status-indicator');
const timeDisplay = document.getElementById('time-remaining');
const vuBar = document.getElementById('vu-bar');
const vuPeak = document.getElementById('vu-peak');
const selectAutoTime = document.getElementById('auto-announce');
const btnOuvirHora = document.getElementById('btn-ouvir-hora');

// ==========================================
// 🚀 INICIALIZAÇÃO TOTALMENTE AUTOMÁTICA
// ==========================================

window.onload = () => {
    loadPreferences(); // Carrega localStorage imediatamente
    forceInitialize();
};

async function forceInitialize() {
    try {
        // 1. Criar AudioContext imediatamente
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        
        // 2. Tentar resume imediato (Fallback em loop se o ambiente bloquear)
        const tryResume = async () => {
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
                setTimeout(tryResume, 500); // Tenta novamente em breve se falhar
            }
        };
        tryResume();

        // 3. Solicitar microfone automaticamente
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

        // Configuração técnica do áudio
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        dataArray = new Float32Array(analyser.frequencyBinCount);
        analyser.connect(audioCtx.destination);
        
        startVUMeter();
        startClockSync();

        // 4. Iniciar sequência de boot automaticamente
        await runBootSequence();

    } catch (err) {
        console.warn("Aguardando permissões ou interação do ambiente...");
        // Fallback: Se falhar (ex: permissão negada no momento), tenta novamente em 2 segundos
        setTimeout(forceInitialize, 2000);
    }
}

async function runBootSequence() {
    isPlaying = true; // Bloqueia PTT durante boot
    setStatus('INICIALIZANDO...', 'status-playing');

    await playBeep(TONE_START_FREQ, TONE_DURATION);
    await playAudioFile('boot.mp3'); 
    await playBeep(TONE_END_FREQ, TONE_DURATION);
    
    isPlaying = false;
    isSystemReady = true;
    setStatus('PRONTO', 'status-idle');
}

// ==========================================
// CONTROLE DE TECLADO (PTT) - MANTIDO
// ==========================================
window.addEventListener('keydown', async (e) => {
    if (!isSystemReady || isPlaying) return;
    if (e.key !== 'F7' && e.key !== 'F2') return;
    
    e.preventDefault(); 
    if (e.repeat || isRecording || forceWaitRelease) return;

    activeKey = e.key;
    await startRecording();
});

window.addEventListener('keyup', async (e) => {
    if (!isSystemReady) return;
    if (e.key === activeKey || (!activeKey && (e.key === 'F7' || e.key === 'F2'))) {
        e.preventDefault();
        
        if (forceWaitRelease) {
            forceWaitRelease = false;
            activeKey = null;
            await processAndPlayRecording();
        } else if (isRecording) {
            activeKey = null;
            stopRecording();
        }
    }
});

// ==========================================
// GRAVAÇÃO E REPRODUÇÃO - MANTIDO
// ==========================================
async function startRecording() {
    try {
        isRecording = true;
        audioChunks = [];
        setStatus('GRAVANDO...', 'status-recording');
        
        analyser.disconnect(audioCtx.destination); 
        let micSource = audioCtx.createMediaStreamSource(micStream);
        micSource.connect(analyser);

        mediaRecorder = new MediaRecorder(micStream);
        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
        
        mediaRecorder.onstop = async () => {
            micSource.disconnect(analyser); 
            analyser.connect(audioCtx.destination); 
            if (!forceWaitRelease) await processAndPlayRecording();
        };

        mediaRecorder.start();
        startTimer();
    } catch (err) {
        setStatus('ERRO MICROFONE', 'status-idle');
        isRecording = false;
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    stopTimer();
    isRecording = false;
}

async function processAndPlayRecording() {
    isPlaying = true;
    setStatus('REPRODUZINDO...', 'status-playing');
    
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' }); 
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    await playBeep(TONE_START_FREQ, TONE_DURATION);
    await playBuffer(audioBuffer);
    await playBeep(TONE_END_FREQ, TONE_DURATION);

    isPlaying = false;
    setStatus('PRONTO', 'status-idle');
}

// ==========================================
// SUBTONS E ARQUIVOS - MANTIDO
// ==========================================
function playBeep(frequency, duration) {
    return new Promise((resolve) => {
        if (!audioCtx) return resolve();
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = frequency;
        gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + 0.01);
        gainNode.gain.setValueAtTime(0.5, audioCtx.currentTime + (duration/1000) - 0.01);
        gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + (duration/1000));
        osc.connect(gainNode);
        gainNode.connect(analyser); 
        osc.start();
        osc.stop(audioCtx.currentTime + (duration / 1000));
        setTimeout(resolve, duration + 50); 
    });
}

async function playAudioFile(fileName) {
    try {
        const response = await fetch(fileName);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        await playBuffer(audioBuffer);
    } catch (error) {
        console.warn(`Arquivo ${fileName} não encontrado.`);
        await new Promise(r => setTimeout(r, 500)); 
    }
}

function playBuffer(buffer) {
    return new Promise((resolve) => {
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(analyser);
        source.onended = resolve;
        source.start(0);
    });
}

// ==========================================
// HORA E PERSISTÊNCIA - MANTIDO
// ==========================================
btnOuvirHora.addEventListener('click', () => {
    if (!isSystemReady || isPlaying || isRecording) return;
    executarAnuncioDeHora();
});

async function executarAnuncioDeHora() {
    isPlaying = true;
    setStatus('HORA...', 'status-playing');
    const agora = new Date();
    const hora = agora.getHours().toString().padStart(2, '0');
    const minuto = agora.getMinutes().toString().padStart(2, '0');
    await playBeep(TONE_START_FREQ, TONE_DURATION);
    await playAudioFile('chamada.mp3');
    await playAudioFile(`${hora}h.mp3`);
    await playAudioFile(`${minuto}m.mp3`);
    await playBeep(TONE_END_FREQ, TONE_DURATION);
    isPlaying = false;
    setStatus('PRONTO', 'status-idle');
}

function startClockSync() {
    setInterval(() => {
        if (!isSystemReady || isPlaying || isRecording) return;
        const agora = new Date();
        const config = selectAutoTime.value;
        if (agora.getSeconds() === 0) {
            const currentMinute = agora.getMinutes();
            let deveAnunciar = false;
            if (config === '1M') deveAnunciar = true;
            else if (config === '5M' && currentMinute % 5 === 0) deveAnunciar = true;
            else if (config === '15M' && currentMinute % 15 === 0) deveAnunciar = true;
            else if (config === '30M' && currentMinute % 30 === 0) deveAnunciar = true;
            else if (config === '1H' && currentMinute === 0) deveAnunciar = true;
            if (deveAnunciar) executarAnuncioDeHora();
        }
    }, 1000); 
}

selectAutoTime.addEventListener('change', (e) => localStorage.setItem('ptt_autoHora', e.target.value));
function loadPreferences() {
    const salvo = localStorage.getItem('ptt_autoHora');
    if (salvo) selectAutoTime.value = salvo;
}

// ==========================================
// VU METER E TIMERS - MANTIDO
// ==========================================
function startTimer() {
    timeRemaining = MAX_RECORD_TIME;
    recordTimerInterval = setInterval(() => {
        timeRemaining -= 0.1;
        if (timeRemaining <= 0) {
            stopRecording();
            forceWaitRelease = true; 
            setStatus('SOLTE A TECLA', 'status-recording');
        }
        timeDisplay.innerText = Math.max(0, timeRemaining).toFixed(1);
    }, 100);
}

function stopTimer() {
    clearInterval(recordTimerInterval);
    timeDisplay.innerText = "120.0";
}

function setStatus(text, className) {
    statusIndicator.innerText = text;
    statusIndicator.className = className;
}

function startVUMeter() {
    function draw() {
        requestAnimationFrame(draw);
        if (!analyser) return;
        analyser.getFloatTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) sumSquares += dataArray[i] * dataArray[i];
        let rms = Math.sqrt(sumSquares / dataArray.length);
        let db = 20 * Math.log10(rms);
        let percent = Math.max(0, (db + 60) / 60) * 100;
        vuBar.style.width = `${Math.min(100, percent)}%`;
        if (percent > peakValue) {
            peakValue = percent;
            peakHoldCounter = 30; 
        } else {
            if (peakHoldCounter > 0) peakHoldCounter--;
            else { peakValue -= 1.5; if (peakValue < 0) peakValue = 0; }
        }
        vuPeak.style.left = `${Math.min(100, peakValue)}%`;
    }
    draw();
}