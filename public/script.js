const socket = io({ transports: ['websocket', 'polling'] });

let myIndex = -1;
let myToken = null;
let roomCode = null;
let isSpectator = false;
let currentState = null;
let isHost = false;
let turnTimerInterval = null;
let turnTimeLeft = 0;

const STORAGE_KEY = 'truco_escola_session';

// Referências do chat
const chatContainer = document.getElementById('chat-container');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatToggle = document.getElementById('chat-toggle');
let chatMinimized = false;

// Referências dos logs
const logsToggle = document.getElementById('logs-toggle');
const logsPanel = document.getElementById('logs-panel');
const logsContent = document.getElementById('logs-content');
const logsClose = document.getElementById('logs-close');

// Referências do overlay de truco
const trucoOverlay = document.getElementById('truco-overlay');
const trucoText = document.getElementById('truco-text');

// Timer de turno
const turnTimerEl = document.createElement('div');
turnTimerEl.id = 'turn-timer';
document.body.appendChild(turnTimerEl);

// Mostrar/ocultar chat
chatToggle.addEventListener('click', () => {
  const messagesDiv = chatMessages;
  const inputDiv = chatInput.parentElement;
  if (chatMinimized) {
    messagesDiv.style.display = 'flex';
    inputDiv.style.display = 'flex';
    chatToggle.textContent = '−';
    chatMinimized = false;
  } else {
    messagesDiv.style.display = 'none';
    inputDiv.style.display = 'none';
    chatToggle.textContent = '+';
    chatMinimized = true;
  }
});

function sendChatMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chatMessage', { message: msg });
  chatInput.value = '';
  chatInput.focus();
}

chatSend.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});

function addChatMessage(name, message, isSpectator) {
  const div = document.createElement('div');
  const prefix = isSpectator ? '<espectador>' : '<player>';
  const color = isSpectator ? '#ef5350' : '#42a5f5';
  div.innerHTML = `<span style="color:${color};">${prefix}</span>${name}: ${message}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Sessão
function saveSession(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
}
function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
}

function toast(msg) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// Navegação
function hideAllMenus() {
  ['main-menu', 'create-menu', 'join-menu', 'waiting-screen'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  document.getElementById('game-table').style.display = 'none';
}

function backToMain() {
  hideAllMenus();
  document.getElementById('main-menu').style.display = 'block';
  document.getElementById('room-badge').style.display = 'none';
  document.getElementById('leave-room-btn').style.display = 'none';
  chatContainer.style.display = 'none';
  chatMessages.innerHTML = '';
  logsToggle.style.display = 'none';
  logsPanel.style.display = 'none';
  turnTimerEl.style.display = 'none';
  if (turnTimerInterval) clearInterval(turnTimerInterval);
}

function showCreate() {
  const name = document.getElementById('player-name').value.trim();
  if (!name) { toast('Digite seu nome primeiro!'); return; }
  hideAllMenus();
  document.getElementById('create-menu').style.display = 'block';
}

function showJoin() {
  const name = document.getElementById('player-name').value.trim();
  if (!name) { toast('Digite seu nome primeiro!'); return; }
  hideAllMenus();
  document.getElementById('join-menu').style.display = 'block';
}

function createRoom(mode) {
  const name = document.getElementById('player-name').value.trim();
  if (!name) { toast('Digite seu nome!'); return; }
  socket.emit('createRoom', { mode, name });
}

function joinRoom() {
  const name = document.getElementById('player-name').value.trim();
  const code = document.getElementById('join-code').value.trim();
  if (!name) { toast('Digite seu nome!'); return; }
  if (!code) { toast('Digite o código da sala!'); return; }
  socket.emit('joinRoom', { code, name });
}

function leaveRoom() {
  socket.emit('leaveRoom');
  clearSession();
  myIndex = -1;
  myToken = null;
  roomCode = null;
  isSpectator = false;
  currentState = null;
  isHost = false;
  if (turnTimerInterval) clearInterval(turnTimerInterval);
  turnTimerEl.style.display = 'none';
  backToMain();
  toast('Você saiu da sala.');
}

// Logs
logsToggle.addEventListener('click', () => {
  if (logsPanel.style.display === 'block') {
    logsPanel.style.display = 'none';
  } else {
    logsPanel.style.display = 'block';
    if (currentState && currentState.logs) {
      renderLogs(currentState.logs);
    }
  }
});
logsClose.addEventListener('click', () => {
  logsPanel.style.display = 'none';
});

function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    logsContent.innerHTML = '<p style="color:#999;">Nenhuma ação registrada ainda.</p>';
    return;
  }
  logsContent.innerHTML = logs.map(log => `
    <div class="log-entry">
      <span class="log-time">[${log.timestamp}]</span>
      <span class="log-player">${log.player}</span>
      <span class="log-action">${log.action}</span>
      ${log.details ? `<span class="log-details">${log.details}</span>` : ''}
    </div>
  `).join('');
  logsContent.scrollTop = logsContent.scrollHeight;
}

// Timer de turno
function startTurnTimer(seconds) {
  if (turnTimerInterval) clearInterval(turnTimerInterval);
  if (!seconds || seconds <= 0) {
    turnTimerEl.style.display = 'none';
    return;
  }
  turnTimeLeft = seconds;
  turnTimerEl.style.display = 'block';
  turnTimerEl.classList.remove('warning');
  updateTurnTimerDisplay();

  turnTimerInterval = setInterval(() => {
    turnTimeLeft--;
    if (turnTimeLeft <= 0) {
      clearInterval(turnTimerInterval);
      turnTimerEl.textContent = '⏱️ 0s';
      turnTimerEl.classList.add('warning');
      socket.emit('turnTimeout');
      toast('⏰ Tempo esgotado!');
      setTimeout(() => {
        turnTimerEl.style.display = 'none';
      }, 2000);
    } else {
      updateTurnTimerDisplay();
      if (turnTimeLeft <= 5) {
        turnTimerEl.classList.add('warning');
      } else {
        turnTimerEl.classList.remove('warning');
      }
    }
  }, 1000);
}

function updateTurnTimerDisplay() {
  turnTimerEl.textContent = `⏱️ ${turnTimeLeft}s`;
}

// Socket events
socket.on('connect', () => {
  const session = loadSession();
  if (session?.code && session?.token) {
    socket.emit('reconnectRoom', { code: session.code, token: session.token });
  }
});

socket.on('reconnectFailed', () => {
  clearSession();
  toast('Não foi possível reconectar. Entre novamente.');
  backToMain();
});

socket.on('toast', msg => toast(msg));

socket.on('roomJoined', (data) => {
  roomCode = data.roomCode;
  myToken = data.token;
  myIndex = data.index;
  isSpectator = !!data.spectator;
  isHost = data.isHost || false;

  if (myToken) {
    saveSession({ code: roomCode, token: myToken, name: document.getElementById('player-name').value.trim() });
  }

  document.getElementById('room-badge').style.display = 'block';
  document.getElementById('room-code-label').textContent = roomCode;
  document.getElementById('leave-room-btn').style.display = 'block';

  chatContainer.style.display = 'flex';
  chatMessages.innerHTML = '';
  logsToggle.style.display = 'block';

  hideAllMenus();

  if (isSpectator) {
    return;
  }

  if (data.reconnected) {
    toast('Reconectado com sucesso!');
  }

  if (isHost) {
    document.getElementById('host-controls').style.display = 'block';
    document.getElementById('start-game-btn').addEventListener('click', () => {
      const selected = document.querySelector('input[name="timeLimit"]:checked');
      let timeLimit = selected ? parseInt(selected.value) : 0;
      if (timeLimit === 0) timeLimit = null;
      socket.emit('startGame', { timeLimit });
    });
  } else {
    document.getElementById('host-controls').style.display = 'none';
  }
});

socket.on('gameStarted', (data) => {
  toast('🎮 Partida iniciada!');
});

// Timer de turno vindo do servidor
socket.on('turnTimer', (data) => {
  if (data.timeLimit) {
    startTurnTimer(data.timeLimit);
  } else {
    turnTimerEl.style.display = 'none';
  }
});

// Efeito Truco CORRIGIDO
socket.on('trucoEffect', (data) => {
  const levelNames = {
    1: 'TRUCO',  // fallback
    3: 'TRUCO',
    6: 'SEIS',
    9: 'NOVE',
    12: 'DOZE'
  };
  const levelName = levelNames[data.level] || `Nível ${data.level}`;
  trucoText.innerHTML = `${levelName}!<small>${data.player}</small>`;
  trucoOverlay.style.display = 'flex';
  trucoText.style.animation = 'none';
  setTimeout(() => {
    trucoText.style.animation = 'pop 0.5s forwards';
  }, 10);
  setTimeout(() => {
    trucoOverlay.style.display = 'none';
  }, 2500);
});

// Atualiza estado do jogo
socket.on('gameState', (state) => {
  currentState = state;
  renderGame(state);
  if (logsPanel.style.display === 'block' && state.logs) {
    renderLogs(state.logs);
  }
  if (state.started && state.turn === state.yourIndex && state.turnTimeLimit && !state.gameOver && !state.challenge) {
    startTurnTimer(state.turnTimeLimit);
  } else if (state.turn !== state.yourIndex || state.challenge || state.gameOver) {
    if (turnTimerInterval) clearInterval(turnTimerInterval);
    turnTimerEl.style.display = 'none';
  }
});

socket.on('spectator', (state) => {
  currentState = state;
  renderSpectator(state);
  if (logsPanel.style.display === 'block' && state.logs) {
    renderLogs(state.logs);
  }
  if (turnTimerInterval) clearInterval(turnTimerInterval);
  turnTimerEl.style.display = 'none';
});

socket.on('chatMessage', (data) => {
  addChatMessage(data.name, data.message, data.isSpectator);
});

// Funções auxiliares
function suitSymbol(suit) {
  return { ouros: '♦️', espadas: '♠️', copas: '♥️', paus: '♣️' }[suit] || '?';
}
function isRedSuit(suit) {
  return suit === 'copas' || suit === 'ouros';
}

function getRelativePosClass(idx, myIdx, maxPlayers) {
  if (maxPlayers === 2) return idx === myIdx ? 'pos-bottom' : 'pos-top';
  const rel = (idx - myIdx + 4) % 4;
  return ['pos-bottom', 'pos-right', 'pos-top', 'pos-left'][rel];
}

function canPlay(state) {
  return state.started &&
    state.turn === state.yourIndex &&
    !state.challenge &&
    state.handWinnerTeam === null &&
    !state.gameOver;
}

// Renderizações (renderWaiting, renderGame, renderSpectator)
function renderWaiting(state) {
  hideAllMenus();
  const wait = document.getElementById('waiting-screen');
  wait.style.display = 'block';
  document.getElementById('wait-code').textContent = state.roomCode || roomCode;

  const list = document.getElementById('waiting-list');
  list.innerHTML = state.players.map((p, i) => {
    const ready = p.connected && p.name && !p.name.startsWith('Jogador ');
    return `<li class="${ready ? 'ok' : 'wait'}">${ready ? '✅' : '⏳'} ${p.name}${p.connected ? '' : ' (offline)'}</li>`;
  }).join('');
}

function renderGame(state) {
  if (!state) return;
  currentState = state;
  myIndex = state.yourIndex;

  if (!state.started) {
    renderWaiting(state);
    return;
  }

  hideAllMenus();
  const table = document.getElementById('game-table');
  table.style.display = 'grid';
  table.innerHTML = '';

  document.getElementById('room-badge').style.display = 'block';
  document.getElementById('room-code-label').textContent = state.roomCode || roomCode;

  const playable = canPlay(state);

  state.players.forEach((p, idx) => {
    const div = document.createElement('div');
    const posClass = getRelativePosClass(idx, state.yourIndex, state.maxPlayers);
    div.className = `player-area ${posClass} team${p.team}`;

    const isMe = idx === state.yourIndex;
    const isTurn = idx === state.turn;
    const isPartner = state.maxPlayers === 4 && idx === state.partnerIndex;

    if (isTurn) div.classList.add('current-turn');
    if (isMe) div.classList.add('me');
    if (isPartner) div.classList.add('partner');

    let badges = '';
    if (isTurn) badges += '<span class="turn-badge">⭐ VEZ</span>';
    if (isMe) badges += ' 🧑‍🎓';
    if (isPartner) badges += ' 🤝';

    const teamLabel = state.maxPlayers === 2
      ? 'Individual'
      : `<span class="team-badge t${p.team}">Time ${p.team + 1}</span>`;

    div.innerHTML = `
      <div class="player-name">${p.name}${badges}</div>
      <div class="player-team">${teamLabel}${!p.connected ? ' 💤' : ''}</div>
      <div class="cards" id="hand-${idx}"></div>
    `;
    table.appendChild(div);

    const handDiv = document.getElementById(`hand-${idx}`);
    if (isMe && state.yourHand) {
      state.yourHand.forEach(card => {
        const cardEl = document.createElement('div');
        cardEl.className = `card ${isRedSuit(card.suit) ? 'red' : ''} yours${playable ? '' : ' disabled'}`;
        cardEl.innerHTML = `<div>${card.rank}</div><div>${suitSymbol(card.suit)}</div>`;
        if (playable) {
          cardEl.onclick = () => socket.emit('playCard', { suit: card.suit, rank: card.rank });
        }
        handDiv.appendChild(cardEl);
      });
    } else {
      for (let i = 0; i < (p.cardCount || 0); i++) {
        const hidden = document.createElement('div');
        hidden.className = 'card hidden';
        handDiv.appendChild(hidden);
      }
    }
  });

  const centerDiv = document.createElement('div');
  centerDiv.className = 'center-area';

  const viraIsRed = state.vira && isRedSuit(state.vira.suit);
  const viraHtml = state.vira
    ? `<div class="card vira-card ${viraIsRed ? 'red' : ''}"><div>${state.vira.rank}</div><div>${suitSymbol(state.vira.suit)}</div></div>`
    : '<div class="card vira-card">?</div>';

  let partnerHtml = '';
  if (state.maxPlayers === 4 && state.partnerName) {
    partnerHtml = `<div class="partner-info">Parceiro: <strong>${state.partnerName}</strong></div>`;
  }

  const s0 = state.scores[0];
  const s1 = state.scores[1];
  let name0 = state.maxPlayers === 2 ? (state.players[0]?.name || 'J1') : (state.teamNames?.[0] || 'Time 1');
  let name1 = state.maxPlayers === 2 ? (state.players[1]?.name || 'J2') : (state.teamNames?.[1] || 'Time 2');

  const scoreHtml = `
    <div class="score-board">
      <div class="score-team team0 ${s0 > s1 ? 'winning' : ''}">${name0}<br><span style="font-size:1.4em">🏆 ${s0}</span></div>
      <div class="score-team team1 ${s1 > s0 ? 'winning' : ''}">${name1}<br><span style="font-size:1.4em">🏆 ${s1}</span></div>
    </div>
  `;

  let historyHtml = '';
  if (state.roundHistory && state.roundHistory.length) {
    historyHtml = `<div class="round-history">${state.roundHistory.map(r => {
      const cls = r.team === 0 ? 'win0' : r.team === 1 ? 'win1' : 'tie';
      return `<span class="round-chip ${cls}">R${r.round}: ${r.winnerLabel}</span>`;
    }).join('')}</div>`;
  }

  const isMyTurn = state.turn === state.yourIndex;
  const turnName = state.turnPlayerName || '?';

  centerDiv.innerHTML = `
    <div class="vira-area">
      ${viraHtml}
      <div style="text-align:left;">
        <div style="font-size:0.8em; opacity:0.85; text-transform:uppercase;">Carta Vira</div>
        <div style="font-size:1.05em; margin-top:2px;">Manilha:<br><strong class="manilha-highlight">${state.manilhaRank || '?'}</strong></div>
      </div>
    </div>
    ${partnerHtml}
    ${scoreHtml}
    ${historyHtml}
    <div style="font-size:0.95rem; background:rgba(0,0,0,0.45); padding:5px 10px; border-radius:9px; display:inline-block; margin:0 auto;">
      Pontos da rodada: <strong style="color:#ffeb3b;">${state.currentHandValue}</strong>
    </div>
    <div class="turn-info ${isMyTurn && !state.challenge && !state.handWinnerTeam && !state.gameOver ? 'my-turn' : ''}">
      ${isMyTurn && !state.challenge && !state.handWinnerTeam && !state.gameOver
        ? '👉 <strong>É A SUA VEZ DE JOGAR!</strong>'
        : `Vez de: <strong>${turnName}</strong>`}
    </div>
    <div class="board-cards" id="board-cards"></div>
    <div id="challenge-area"></div>
    <div id="action-buttons"></div>
  `;
  table.appendChild(centerDiv);

  const boardDiv = document.getElementById('board-cards');
  if (state.rounds && state.rounds[state.currentRound]) {
    state.rounds[state.currentRound].cards.forEach(play => {
      const playedDiv = document.createElement('div');
      playedDiv.className = 'played-card';
      const red = isRedSuit(play.card.suit);
      playedDiv.innerHTML = `
        <small>${state.players[play.player]?.name || '?'}</small>
        <div class="card ${red ? 'red' : ''}"><div>${play.card.rank}</div><div>${suitSymbol(play.card.suit)}</div></div>
      `;
      boardDiv.appendChild(playedDiv);
    });
  }

  const challengeArea = document.getElementById('challenge-area');
  if (state.challenge) {
    const ch = state.challenge;
    const levelName = { 3: 'TRUCO', 6: 'SEIS', 9: 'NOVE', 12: 'DOZE' }[ch.level] || ch.level;
    if (ch.waitingOn === state.yourIndex) {
      let raiseBtn = '';
      if (ch.level < 12) {
        raiseBtn = `<button class="btn" onclick="socket.emit('respondTruco','raise')">AUMENTAR ⬆️</button>`;
      }
      challengeArea.innerHTML = `
        <div class="challenge-box">
          <p style="margin-bottom:8px; font-size:1.05em;">💥 <strong>${state.players[ch.challenger]?.name}</strong> pediu <strong>${levelName}</strong>!</p>
          <button class="btn" onclick="socket.emit('respondTruco','accept')">ACEITAR 👍</button>
          ${raiseBtn}
          <button class="btn" style="background:#fff;color:#c62828;" onclick="socket.emit('respondTruco','flee')">FUGIR 🏃</button>
        </div>
      `;
    } else {
      challengeArea.innerHTML = `<p style="color:#ffeb3b; font-weight:700;">⏳ Aguardando <strong>${state.players[ch.waitingOn]?.name}</strong>...</p>`;
    }
  }

  const actionDiv = document.getElementById('action-buttons');
  if (playable) {
    const nextLevel = { 1: 3, 3: 6, 6: 9, 9: 12 }[state.currentHandValue];
    if (nextLevel) {
      actionDiv.innerHTML = `<button class="btn truco" onclick="socket.emit('truco')">🗣️ PEDIR TRUCO!</button>`;
    } else {
      actionDiv.innerHTML = `<button class="btn truco" disabled title="Máximo atingido">Truco (máx.)</button>`;
    }
  }

  if (state.handWinnerTeam !== null && !state.gameOver) {
    const winnerName = state.maxPlayers === 2
      ? state.players[state.handWinnerTeam]?.name
      : (state.teamNames?.[state.handWinnerTeam] || `Time ${state.handWinnerTeam + 1}`);
    toast(`🎉 ${winnerName} venceu a mão! (+${state.currentHandValue})`);
    actionDiv.innerHTML = `<button class="btn next" onclick="socket.emit('nextHand')">Próxima Mão ➡️</button>`;
  }

  if (state.gameOver) {
    const vencedor = state.maxPlayers === 2
      ? state.players[state.winnerTeam]?.name
      : (state.teamNames?.[state.winnerTeam] || `Time ${state.winnerTeam + 1}`);
    toast(`🌟 ${vencedor} VENCEU O JOGO!`);
    actionDiv.innerHTML = `<button class="btn" onclick="socket.emit('restart')">🔄 Jogar Novamente</button>`;
  }
}

function renderSpectator(state) {
  hideAllMenus();
  const table = document.getElementById('game-table');
  table.style.display = 'grid';
  document.getElementById('room-badge').style.display = 'block';
  document.getElementById('room-code-label').textContent = state.roomCode || roomCode;

  const viraIsRed = state.vira && isRedSuit(state.vira.suit);
  const viraHtml = state.vira
    ? `<div class="card vira-card ${viraIsRed ? 'red' : ''}"><div>${state.vira.rank}</div><div>${suitSymbol(state.vira.suit)}</div></div>`
    : '';

  let boardHtml = '';
  if (state.rounds && state.rounds[state.currentRound]) {
    boardHtml = state.rounds[state.currentRound].cards.map(play => {
      const red = isRedSuit(play.card.suit);
      return `<div class="played-card">
        <small>${state.players[play.player]?.name || '?'}</small>
        <div class="card ${red ? 'red' : ''}"><div>${play.card.rank}</div><div>${suitSymbol(play.card.suit)}</div></div>
      </div>`;
    }).join('');
  }

  let historyHtml = '';
  if (state.roundHistory?.length) {
    historyHtml = `<div class="round-history">${state.roundHistory.map(r => {
      const cls = r.team === 0 ? 'win0' : r.team === 1 ? 'win1' : 'tie';
      return `<span class="round-chip ${cls}">R${r.round}: ${r.winnerLabel}</span>`;
    }).join('')}</div>`;
  }

  let challengeHtml = '';
  if (state.challenge) {
    const levelName = { 3: 'TRUCO', 6: 'SEIS', 9: 'NOVE', 12: 'DOZE' }[state.challenge.level] || state.challenge.level;
    challengeHtml = `<p style="color:#ffeb3b; font-weight:700;">🗣️ Truco em andamento: ${levelName}</p>`;
  }

  const s0 = state.scores[0];
  const s1 = state.scores[1];
  const name0 = state.maxPlayers === 2 ? (state.players[0]?.name || 'J1') : (state.teamNames?.[0] || 'Time 1');
  const name1 = state.maxPlayers === 2 ? (state.players[1]?.name || 'J2') : (state.teamNames?.[1] || 'Time 2');

  table.innerHTML = `
    <div class="center-area" style="grid-column:1/4; grid-row:1/4;">
      <h2 style="color:#ffeb3b; margin-bottom:8px;">👀 Modo Espectador</h2>
      <div class="vira-area">
        ${viraHtml}
        <div>Manilha: <strong class="manilha-highlight">${state.manilhaRank || '?'}</strong></div>
      </div>
      <div class="score-board" style="margin:8px 0;">
        <div class="score-team team0">${name0}<br>🏆 ${s0}</div>
        <div class="score-team team1">${name1}<br>🏆 ${s1}</div>
      </div>
      ${historyHtml}
      <div class="turn-info">Vez de: <strong>${state.turnPlayerName || '?'}</strong> · Rodada vale <strong style="color:#ffeb3b;">${state.currentHandValue}</strong></div>
      ${challengeHtml}
      <div class="board-cards">${boardHtml || '<span style="opacity:0.6;">Aguardando cartas...</span>'}</div>
      <p style="margin-top:8px; opacity:0.8; font-size:0.9rem;">Assista e aprenda as estratégias!</p>
    </div>
  `;
}

// Enter no código
document.getElementById('join-code').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinRoom();
});
document.getElementById('player-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') showCreate();
});