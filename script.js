// ==========================================
// CONFIGURAÇÕES E VARIÁVEIS DE ESTADO
// ==========================================
const MAX_RECORD_TIME = 120; // Segundos
const TONE_START_FREQ = 18500;
const TONE_END_FREQ = 17500;
const TONE_DURATION = 100; // ms

let audioCtx, analyser, micStream, mediaRecorder;
let audioChunks = [];
let isRecording = false;
let isPlaying = false;
let isSystemReady = false;
let forceWaitRelease = false; 
let activeKey = null;

let recordTimerInterval;
let timeRemaining = MAX_RECORD_TIME;

// Variáveis do VU Meter
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
// INICIALIZAÇÃO AUTOMÁTICA DO SISTEMA
// ==========================================
let hasInitialized = false;

async function autoInitializeSystem(e) {
    if (hasInitialized) return;

    // Se for acionado por teclado, aceitar apenas F7 ou F2
    if (e.type === 'keydown' && e.key !== 'F7' && e.key !== 'F2') return;

    hasInitialized = true; // Impede múltiplas execuções

    // Remove os listeners de boot imediatamente
    window.removeEventListener('click', autoInitializeSystem);
    window.removeEventListener('touchstart', autoInitializeSystem);
    window.removeEventListener('keydown', autoInitializeSystem);

    isPlaying = true; // Bloqueia o PTT durante o boot
    setStatus('INICIALIZANDO...', 'status-playing');

    try {
        // 1 e 2: Criar e forçar o resume do AudioContext a partir de uma interação de usuário (Compatibilidade Chrome)
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        // 3: Solicitar acesso ao microfone automaticamente
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        dataArray = new Float32Array(analyser.frequencyBinCount);
        
        analyser.connect(audioCtx.destination);
        
        startVUMeter();
        loadPreferences();
        startClockSync();

        // 4: Sequência de Boot do Z-Link Echo
        await playBeep(TONE_START_FREQ, TONE_DURATION);
        await playAudioFile('boot.mp3'); 
        await playBeep(TONE_END_FREQ, TONE_DURATION);
        
    } catch (err) {
        console.error("Erro na inicialização (Verifique permissão de microfone): ", err);
        setStatus('ERRO INICIAL', 'status-idle');
    }

    // 5: Libera o uso das teclas
    isPlaying = false;
    isSystemReady = true;
    setStatus('AGUARDANDO', 'status-idle');
}

// Listeners globais aguardando a primeira interação
window.addEventListener('click', autoInitializeSystem);
window.addEventListener('touchstart', autoInitializeSystem);
window.addEventListener('keydown', autoInitializeSystem);

// ==========================================
// CONTROLE DE TECLADO (PTT)
// ==========================================
window.addEventListener('keydown', async (e) => {
    // Se não estiver pronto ou estiver no meio do boot, ignora
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
// LÓGICA DE GRAVAÇÃO E REPRODUÇÃO
// ==========================================
async function startRecording() {
    try {
        if (!micStream) {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        
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
            
            if (!forceWaitRelease) {
                await processAndPlayRecording();
            }
        };

        mediaRecorder.start();
        startTimer();

    } catch (err) {
        console.error("Erro ao acessar microfone: ", err);
        isRecording = false;
        setStatus('ERRO MICROFONE', 'status-idle');
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
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
    setStatus('AGUARDANDO', 'status-idle');
}

// ==========================================
// FUNÇÕES DE ÁUDIO E SUBTONS
// ==========================================
function playBeep(frequency, duration) {
    return new Promise((resolve) => {
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
        if (!response.ok) throw new Error("Arquivo não encontrado");
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        await playBuffer(audioBuffer);
    } catch (error) {
        console.warn(`Aviso: Falha ao reproduzir ${fileName}. Verifique se o arquivo existe na pasta.`);
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
// FUNÇÃO OUVIR HORA E ANÚNCIO AUTOMÁTICO
// ==========================================
btnOuvirHora.addEventListener('click', () => {
    // Se o usuário clicar aqui como primeira ação, o autoInitializeSystem já rodou e está 'playing' o boot
    if (!isSystemReady || isPlaying || isRecording) return;
    executarAnuncioDeHora();
});

async function executarAnuncioDeHora() {
    isPlaying = true;
    setStatus('ANUNCIANDO HORA...', 'status-playing');

    const agora = new Date();
    const hora = agora.getHours().toString().padStart(2, '0');
    const minuto = agora.getMinutes().toString().padStart(2, '0');

    await playBeep(TONE_START_FREQ, TONE_DURATION);
    await playAudioFile('chamada.mp3');
    await playAudioFile(`${hora}h.mp3`);
    await playAudioFile(`${minuto}m.mp3`);
    await playBeep(TONE_END_FREQ, TONE_DURATION);

    isPlaying = false;
    setStatus('AGUARDANDO', 'status-idle');
}

let lastAnnouncedMinute = -1;

function startClockSync() {
    setInterval(() => {
        if (!isSystemReady || isPlaying || isRecording) return;

        const agora = new Date();
        const config = selectAutoTime.value;
        const currentMinute = agora.getMinutes();
        
        if (agora.getSeconds() === 0 && lastAnnouncedMinute !== currentMinute) {
            let deveAnunciar = false;

            if (config === '1M') deveAnunciar = true;
            else if (config === '5M' && currentMinute % 5 === 0) deveAnunciar = true;
            else if (config === '15M' && currentMinute % 15 === 0) deveAnunciar = true;
            else if (config === '30M' && currentMinute % 30 === 0) deveAnunciar = true;
            else if (config === '1H' && currentMinute === 0) deveAnunciar = true;

            if (deveAnunciar) {
                lastAnnouncedMinute = currentMinute;
                executarAnuncioDeHora();
            }
        }
    }, 500); 
}

// Persistência
selectAutoTime.addEventListener('change', (e) => {
    localStorage.setItem('ptt_autoHora', e.target.value);
});

function loadPreferences() {
    const salvo = localStorage.getItem('ptt_autoHora');
    if (salvo) selectAutoTime.value = salvo;
}

// ==========================================
// TIMERS E VU METER PROFISSIONAL (RMS)
// ==========================================
function startTimer() {
    timeRemaining = MAX_RECORD_TIME;
    updateTimeDisplay();
    
    recordTimerInterval = setInterval(() => {
        timeRemaining -= 0.1;
        
        if (timeRemaining <= 0) {
            timeRemaining = 0;
            stopTimer();
            stopRecording();
            forceWaitRelease = true; 
            setStatus('SOLTE A TECLA', 'status-recording');
        }
        updateTimeDisplay();
    }, 100);
}

function stopTimer() {
    clearInterval(recordTimerInterval);
    timeRemaining = MAX_RECORD_TIME;
    updateTimeDisplay();
}

function updateTimeDisplay() {
    timeDisplay.innerText = timeRemaining.toFixed(1);
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
        for (let i = 0; i < dataArray.length; i++) {
            sumSquares += dataArray[i] * dataArray[i];
        }
        let rms = Math.sqrt(sumSquares / dataArray.length);
        
        let db = 20 * Math.log10(rms);
        
        let minDb = -60;
        let percent = Math.max(0, (db - minDb) / (0 - minDb)) * 100;
        if (percent > 100) percent = 100;

        vuBar.style.width = `${percent}%`;

        if (percent > peakValue) {
            peakValue = percent;
            peakHoldCounter = 30; 
        } else {
            if (peakHoldCounter > 0) {
                peakHoldCounter--;
            } else {
                peakValue -= 1.5; 
                if (peakValue < 0) peakValue = 0;
            }
        }
        vuPeak.style.left = `${peakValue}%`;
    }
    draw();
}