const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Constantes ---
const WINNING_SCORE = 12;
const SUITS = ['ouros', 'espadas', 'copas', 'paus'];
const RANKS = ['4', '5', '6', '7', 'Q', 'J', 'K', 'A', '2', '3'];
const MANILHA_SUIT_ORDER = ['ouros', 'espadas', 'copas', 'paus'];
const HAND_VALUE_STEPS = { 1: 3, 3: 6, 6: 9, 9: 12 };
const ROOM_CODE_LENGTH = 4;
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;

// --- Utilitários ---
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ suit, rank });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getCardValue(card, manilhaRank) {
  if (card.rank === manilhaRank) {
    return { type: 'manilha', suitStrength: MANILHA_SUIT_ORDER.indexOf(card.suit) };
  }
  return { type: 'normal', rankStrength: RANKS.indexOf(card.rank) };
}

function compareCards(cardA, cardB, manilhaRank) {
  const valA = getCardValue(cardA, manilhaRank);
  const valB = getCardValue(cardB, manilhaRank);
  if (valA.type === 'manilha' && valB.type === 'manilha') {
    if (valA.suitStrength > valB.suitStrength) return 'A';
    if (valA.suitStrength < valB.suitStrength) return 'B';
    return 'tie';
  }
  if (valA.type === 'manilha') return 'A';
  if (valB.type === 'manilha') return 'B';
  if (valA.rankStrength > valB.rankStrength) return 'A';
  if (valA.rankStrength < valB.rankStrength) return 'B';
  return 'tie';
}

function nextTrucoLevel(currentValue) {
  return HAND_VALUE_STEPS[currentValue] || null;
}

function evaluateHandWinner(roundResults, starterTeam) {
  const [r1, r2, r3] = roundResults;
  if (roundResults.length >= 2) {
    if (r1 !== null && (r2 === r1 || r2 === null)) return r1;
    if (r1 === null && r2 !== null) return r2;
  }
  if (roundResults.length === 3) {
    if (r3 !== null) return r3;
    if (r1 !== null) return r1;
    return starterTeam;
  }
  return null;
}

function sanitizeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[<>]/g, '').trim().slice(0, 18);
  return cleaned || fallback;
}

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function sortHand(hand, manilhaRank) {
  return [...hand].sort((a, b) => {
    const va = getCardValue(a, manilhaRank);
    const vb = getCardValue(b, manilhaRank);
    if (va.type === 'manilha' && vb.type === 'manilha') return vb.suitStrength - va.suitStrength;
    if (va.type === 'manilha') return -1;
    if (vb.type === 'manilha') return 1;
    return vb.rankStrength - va.rankStrength;
  });
}

// --- Salas ---
const rooms = new Map();

function touchRoom(room) {
  room.lastActivity = Date.now();
}

function createPlayers(count) {
  const players = [];
  for (let i = 0; i < count; i++) {
    players.push({
      id: '',
      token: '',
      name: `Jogador ${i + 1}`,
      team: count === 2 ? i : (i % 2 === 0 ? 0 : 1),
      hand: [],
      connected: false
    });
  }
  return players;
}

function initGameState(maxPlayers) {
  const deck = createDeck();
  const players = createPlayers(maxPlayers);
  for (const p of players) {
    p.hand = [deck.pop(), deck.pop(), deck.pop()];
  }
  const vira = deck.pop();
  const manilhaRank = RANKS[(RANKS.indexOf(vira.rank) + 1) % RANKS.length];
  const starterIndex = Math.floor(Math.random() * maxPlayers);

  return {
    players,
    deck,
    vira,
    manilhaRank,
    currentHandValue: 1,
    rounds: [],
    roundResults: [],
    currentRound: 0,
    turnPlayerIndex: starterIndex,
    roundStarter: starterIndex,
    handWinnerTeam: null,
    challenge: null,
    gameOver: false,
    winnerTeam: null,
    scores: [0, 0],
    handStarter: starterIndex,
    started: false,
    logs: [],
    turnTimeLimit: null // em segundos
  };
}

function addLog(game, playerName, action, details = '') {
  const entry = {
    timestamp: new Date().toLocaleTimeString(),
    player: playerName,
    action: action,
    details: details
  };
  game.logs.push(entry);
  if (game.logs.length > 200) game.logs.shift();
  return entry;
}

function endHand(room) {
  const g = room.game;
  if (!g || g.gameOver) return;

  const scores = [...g.scores];
  const oldPlayers = g.players.map(p => ({
    id: p.id,
    token: p.token,
    name: p.name,
    connected: p.connected
  }));

  const nextStarter = (g.handStarter - 1 + room.maxPlayers) % room.maxPlayers;
  room.game = initGameState(room.maxPlayers);
  room.game.started = true;
  room.game.turnTimeLimit = g.turnTimeLimit;

  for (let i = 0; i < room.maxPlayers; i++) {
    room.game.players[i].id = oldPlayers[i].id;
    room.game.players[i].token = oldPlayers[i].token;
    room.game.players[i].name = oldPlayers[i].name;
    room.game.players[i].connected = oldPlayers[i].connected;
  }

  room.game.scores = scores;
  room.game.handStarter = nextStarter;
  room.game.turnPlayerIndex = nextStarter;
  room.game.roundStarter = nextStarter;
  room.game.logs = g.logs;
}

// Nova função: encerrar a partida e voltar ao lobby
function abortGame(room) {
  const g = room.game;
  if (!g) return;
  
  // Se a partida já foi encerrada, não fazer nada
  if (!g.started) return;
  
  // Marcar como não iniciada e resetar o estado
  g.started = false;
  g.gameOver = false;
  g.currentHandValue = 1;
  g.scores = [0, 0];
  g.rounds = [];
  g.roundResults = [];
  g.currentRound = 0;
  g.logs = [];
  g.challenge = null;
  g.handWinnerTeam = null;
  
  // Reembaralhar e redistribuir cartas para todos
  const deck = createDeck();
  for (const p of g.players) {
    p.hand = [deck.pop(), deck.pop(), deck.pop()];
  }
  g.vira = deck.pop();
  g.manilhaRank = RANKS[(RANKS.indexOf(g.vira.rank) + 1) % RANKS.length];
  const starterIndex = Math.floor(Math.random() * room.maxPlayers);
  g.turnPlayerIndex = starterIndex;
  g.roundStarter = starterIndex;
  g.handStarter = starterIndex;
  
  addLog(g, 'Sistema', 'Partida interrompida por saída de jogador', 'Voltando ao lobby');
  
  emitRoomMessage(room, '🔄 Jogador saiu. Partida interrompida. Aguardando novos jogadores.');
  sendStateToRoom(room);
}

function getRoundHistory(game) {
  if (!game.rounds || game.rounds.length === 0) return [];
  return game.rounds.map((round, idx) => {
    const result = game.roundResults[idx];
    let label = 'Empate';
    if (result !== null && result !== undefined) {
      label = `Time ${result + 1}`;
      if (round.winnerPlayer !== null && round.winnerPlayer !== undefined) {
        const name = game.players[round.winnerPlayer]?.name;
        if (name) label = name;
      }
    }
    return {
      round: idx + 1,
      winnerLabel: result === null ? 'Empate' : label,
      team: result
    };
  });
}

function getStateForPlayer(room, playerId) {
  const g = room.game;
  if (!g) return null;

  const playerIndex = g.players.findIndex(p => p.id === playerId);
  if (playerIndex === -1) return null;

  let partnerIndex = -1;
  let partnerName = null;
  if (room.maxPlayers === 4) {
    partnerIndex = g.players.findIndex(
      (p, idx) => p.team === g.players[playerIndex].team && idx !== playerIndex
    );
    if (partnerIndex >= 0) partnerName = g.players[partnerIndex].name;
  }

  let teamNames = null;
  if (room.maxPlayers === 4) {
    teamNames = [
      g.players.filter(p => p.team === 0).map(p => p.name).join(' & '),
      g.players.filter(p => p.team === 1).map(p => p.name).join(' & ')
    ];
  }

  const sortedHand = sortHand(g.players[playerIndex].hand, g.manilhaRank);

  return {
    roomCode: room.code,
    yourIndex: playerIndex,
    yourTeam: g.players[playerIndex].team,
    yourHand: sortedHand,
    partnerIndex,
    partnerName,
    teamNames,
    players: g.players.map(p => ({
      name: p.name,
      team: p.team,
      connected: p.connected,
      cardCount: p.hand.length
    })),
    vira: g.vira,
    manilhaRank: g.manilhaRank,
    currentHandValue: g.currentHandValue,
    rounds: g.rounds,
    currentRound: g.currentRound,
    roundHistory: getRoundHistory(g),
    turn: g.turnPlayerIndex,
    turnPlayerName: g.players[g.turnPlayerIndex]?.name || '?',
    roundStarter: g.roundStarter,
    handWinnerTeam: g.handWinnerTeam,
    challenge: g.challenge,
    scores: g.scores,
    gameOver: g.gameOver,
    winnerTeam: g.winnerTeam,
    maxPlayers: room.maxPlayers,
    started: g.started,
    yourToken: g.players[playerIndex].token,
    turnTimeLimit: g.turnTimeLimit,
    logs: g.logs.slice(-50)
  };
}

function getSpectatorState(room) {
  const g = room.game;
  if (!g) return null;
  return {
    roomCode: room.code,
    players: g.players.map(p => ({
      name: p.name,
      team: p.team,
      connected: p.connected,
      cardCount: p.hand.length
    })),
    vira: g.vira,
    manilhaRank: g.manilhaRank,
    scores: g.scores,
    currentHandValue: g.currentHandValue,
    maxPlayers: room.maxPlayers,
    turn: g.turnPlayerIndex,
    turnPlayerName: g.players[g.turnPlayerIndex]?.name || '?',
    rounds: g.rounds,
    currentRound: g.currentRound,
    roundHistory: getRoundHistory(g),
    challenge: g.challenge,
    handWinnerTeam: g.handWinnerTeam,
    gameOver: g.gameOver,
    winnerTeam: g.winnerTeam,
    started: g.started,
    teamNames: room.maxPlayers === 4
      ? [
          g.players.filter(p => p.team === 0).map(p => p.name).join(' & '),
          g.players.filter(p => p.team === 1).map(p => p.name).join(' & ')
        ]
      : null,
    turnTimeLimit: g.turnTimeLimit,
    logs: g.logs.slice(-50)
  };
}

function playCard(room, playerIndex, card) {
  const g = room.game;
  if (!g || g.gameOver || g.handWinnerTeam !== null || g.challenge || !g.started) return false;
  if (playerIndex !== g.turnPlayerIndex) return false;

  const player = g.players[playerIndex];
  const cardIndex = player.hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
  if (cardIndex === -1) return false;

  const playedCard = player.hand.splice(cardIndex, 1)[0];
  addLog(g, player.name, 'Jogou carta', `${playedCard.rank} de ${playedCard.suit}`);

  if (!g.rounds[g.currentRound]) {
    g.rounds[g.currentRound] = { cards: [], winnerPlayer: null };
  }
  g.rounds[g.currentRound].cards.push({ player: playerIndex, card: playedCard });

  if (g.rounds[g.currentRound].cards.length === room.maxPlayers) {
    const cards = g.rounds[g.currentRound].cards;
    let bestIdx = 0;
    for (let i = 1; i < cards.length; i++) {
      if (compareCards(cards[bestIdx].card, cards[i].card, g.manilhaRank) === 'B') bestIdx = i;
    }

    let hasTie = false;
    for (let i = 0; i < cards.length; i++) {
      if (i === bestIdx) continue;
      if (compareCards(cards[bestIdx].card, cards[i].card, g.manilhaRank) === 'tie') {
        hasTie = true;
        break;
      }
    }

    const roundWinner = hasTie ? null : cards[bestIdx].player;
    g.rounds[g.currentRound].winnerPlayer = roundWinner;
    g.roundResults.push(roundWinner !== null ? g.players[roundWinner].team : null);

    const starterTeam = g.players[g.handStarter].team;
    const decidedTeam = evaluateHandWinner(g.roundResults, starterTeam);

    if (decidedTeam !== null) {
      g.handWinnerTeam = decidedTeam;
      g.scores[decidedTeam] += g.currentHandValue;
      const winnerName = g.players[decidedTeam]?.name || `Time ${decidedTeam+1}`;
      addLog(g, winnerName, 'Venceu a mão', `+${g.currentHandValue} pontos`);
      if (g.scores[decidedTeam] >= WINNING_SCORE) {
        g.gameOver = true;
        g.winnerTeam = decidedTeam;
        addLog(g, winnerName, 'Venceu a partida!', '');
      }
      return true;
    }

    if (roundWinner !== null) {
      g.roundStarter = roundWinner;
      g.turnPlayerIndex = roundWinner;
    } else {
      g.turnPlayerIndex = g.roundStarter;
    }
    g.currentRound++;
  } else {
    g.turnPlayerIndex = (playerIndex - 1 + room.maxPlayers) % room.maxPlayers;
  }
  return true;
}

function processTrucoResponse(room, playerIndex, response) {
  const g = room.game;
  if (!g || !g.challenge || g.gameOver || g.handWinnerTeam !== null) return false;

  const { level, previousValue, challenger, waitingOn } = g.challenge;
  if (playerIndex !== waitingOn) return false;

  if (response === 'flee') {
    const challengerTeam = g.players[challenger].team;
    g.scores[challengerTeam] += previousValue;
    const name = g.players[challenger].name;
    addLog(g, name, 'Fugiu do truco', `perdeu ${previousValue} pontos`);
    if (g.scores[challengerTeam] >= WINNING_SCORE) {
      g.gameOver = true;
      g.winnerTeam = challengerTeam;
      addLog(g, name, 'Venceu a partida!', '');
    }
    g.challenge = null;
    endHand(room);
    return true;
  }

  if (response === 'accept') {
    g.currentHandValue = level;
    const name = g.players[playerIndex].name;
    addLog(g, name, 'Aceitou o truco', `nível ${level}`);
    g.challenge = null;
    return true;
  }

  if (response === 'raise') {
    const newLevel = nextTrucoLevel(level);
    if (!newLevel) return false;
    g.challenge = {
      level: newLevel,
      previousValue: level,
      challenger: playerIndex,
      waitingOn: challenger
    };
    const name = g.players[playerIndex].name;
    addLog(g, name, 'Aumentou o truco', `nível ${newLevel}`);
    return true;
  }
  return false;
}

function sendStateToRoom(room) {
  const g = room.game;
  if (!g) return;
  touchRoom(room);

  g.players.forEach(p => {
    if (p.id && p.connected) {
      const sock = io.sockets.sockets.get(p.id);
      if (sock) sock.emit('gameState', getStateForPlayer(room, p.id));
    }
  });

  room.spectators.forEach(id => {
    const sock = io.sockets.sockets.get(id);
    if (sock) sock.emit('spectator', getSpectatorState(room));
  });
}

function emitRoomMessage(room, msg) {
  const ids = new Set([
    ...room.game.players.filter(p => p.id).map(p => p.id),
    ...room.spectators
  ]);
  ids.forEach(id => {
    const sock = io.sockets.sockets.get(id);
    if (sock) sock.emit('toast', msg);
  });
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.game?.players.some(p => p.id === socketId)) return room;
    if (room.spectators.has(socketId)) return room;
  }
  return null;
}

function findPlayerInRoom(room, socketId) {
  return room.game ? room.game.players.findIndex(p => p.id === socketId) : -1;
}

// Limpeza periódica
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > ROOM_IDLE_MS) {
      rooms.delete(code);
      console.log('Sala removida por inatividade:', code);
    }
  }
}, 15 * 60 * 1000);

// --- Socket ---
io.on('connection', (socket) => {
  console.log('Conectado:', socket.id);

  socket.on('createRoom', ({ mode, name }) => {
    const cleanName = sanitizeName(name, null);
    if (!cleanName) {
      socket.emit('toast', 'Digite um nome válido.');
      return;
    }

    let code;
    do {
      code = generateRoomCode();
    } while (rooms.has(code));

    const maxPlayers = mode === 'duplas' ? 4 : 2;
    const game = initGameState(maxPlayers);
    const token = generateToken();

    game.players[0].id = socket.id;
    game.players[0].token = token;
    game.players[0].name = cleanName;
    game.players[0].connected = true;

    const room = {
      code,
      maxPlayers,
      hostId: socket.id,
      game,
      spectators: new Set(),
      lastActivity: Date.now()
    };
    rooms.set(code, room);

    socket.join(code);
    socket.emit('roomJoined', {
      roomCode: code,
      token,
      index: 0,
      isHost: true,
      maxPlayers
    });
    socket.emit('gameState', getStateForPlayer(room, socket.id));
    socket.emit('toast', `Sala ${code} criada! Compartilhe o código.`);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const roomCode = (code || '').toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('toast', 'Sala não encontrada. Verifique o código.');
      return;
    }

    const cleanName = sanitizeName(name, null);
    if (!cleanName) {
      socket.emit('toast', 'Digite um nome válido.');
      return;
    }

    const freeSlot = room.game.players.findIndex(p => !p.connected);
    if (freeSlot === -1) {
      socket.name = cleanName;
      socket.isSpectator = true;
      room.spectators.add(socket.id);
      socket.join(roomCode);
      socket.emit('roomJoined', {
        roomCode,
        token: null,
        index: -1,
        isHost: false,
        maxPlayers: room.maxPlayers,
        spectator: true
      });
      socket.emit('spectator', getSpectatorState(room));
      socket.emit('toast', 'Sala cheia. Você entrou como espectador.');
      return;
    }

    const token = generateToken();
    room.game.players[freeSlot].id = socket.id;
    room.game.players[freeSlot].token = token;
    room.game.players[freeSlot].name = cleanName;
    room.game.players[freeSlot].connected = true;
    socket.name = cleanName;
    socket.isSpectator = false;

    socket.join(roomCode);
    socket.emit('roomJoined', {
      roomCode,
      token,
      index: freeSlot,
      isHost: false,
      maxPlayers: room.maxPlayers
    });
    emitRoomMessage(room, `${cleanName} entrou na sala!`);
    sendStateToRoom(room);
  });

  socket.on('reconnectRoom', ({ code, token }) => {
    const roomCode = (code || '').toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room || !token) {
      socket.emit('reconnectFailed');
      return;
    }

    const playerIndex = room.game.players.findIndex(p => p.token === token);
    if (playerIndex === -1) {
      socket.emit('reconnectFailed');
      return;
    }

    const player = room.game.players[playerIndex];
    if (player.id && player.id !== socket.id) {
      const oldSock = io.sockets.sockets.get(player.id);
      if (oldSock) {
        oldSock.emit('toast', 'Você reconectou em outro dispositivo.');
        oldSock.disconnect(true);
      }
    }

    player.id = socket.id;
    player.connected = true;
    socket.name = player.name;
    socket.isSpectator = false;
    room.spectators.delete(socket.id);
    socket.join(roomCode);

    socket.emit('roomJoined', {
      roomCode,
      token,
      index: playerIndex,
      isHost: room.hostId === player.id || room.game.players[0].token === token,
      maxPlayers: room.maxPlayers,
      reconnected: true
    });
    socket.emit('gameState', getStateForPlayer(room, socket.id));
    emitRoomMessage(room, `${player.name} reconectou.`);
    sendStateToRoom(room);
  });

  socket.on('playCard', (card) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const playerIndex = findPlayerInRoom(room, socket.id);
    if (playerIndex === -1) return;
    if (playCard(room, playerIndex, card)) {
      sendStateToRoom(room);
      const g = room.game;
      if (g && g.turnTimeLimit && g.started && !g.gameOver) {
        const turnPlayer = g.players[g.turnPlayerIndex];
        if (turnPlayer && turnPlayer.id) {
          io.to(turnPlayer.id).emit('turnTimer', { timeLimit: g.turnTimeLimit });
        }
      }
    } else {
      socket.emit('toast', 'Jogada inválida.');
    }
  });

  socket.on('truco', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const playerIndex = findPlayerInRoom(room, socket.id);
    if (playerIndex === -1) return;

    const g = room.game;
    if (!g || !g.started || g.gameOver || g.challenge || g.handWinnerTeam !== null) {
      socket.emit('toast', 'Não pode pedir truco agora.');
      return;
    }
    if (playerIndex !== g.turnPlayerIndex) {
      socket.emit('toast', 'Não é sua vez de pedir truco.');
      return;
    }

    const nextLevel = nextTrucoLevel(g.currentHandValue);
    if (!nextLevel) {
      socket.emit('toast', 'A mão já vale o máximo (12).');
      return;
    }

    let opponentIndex = (playerIndex - 1 + room.maxPlayers) % room.maxPlayers;
    while (g.players[opponentIndex].team === g.players[playerIndex].team) {
      opponentIndex = (opponentIndex - 1 + room.maxPlayers) % room.maxPlayers;
    }

    g.challenge = {
      level: nextLevel,
      previousValue: g.currentHandValue,
      challenger: playerIndex,
      waitingOn: opponentIndex
    };
    const levelName = { 3: 'TRUCO', 6: 'SEIS', 9: 'NOVE', 12: 'DOZE' }[nextLevel] || nextLevel;
    const playerName = g.players[playerIndex].name;
    addLog(g, playerName, 'Pediu truco', levelName);
    emitRoomMessage(room, `🗣️ ${playerName} pediu ${levelName}!`);
    
    // Envia o efeito com o nível CORRETO (o cliente decide o nome)
    io.to(room.code).emit('trucoEffect', { level: nextLevel, player: playerName });
    sendStateToRoom(room);
  });

  socket.on('respondTruco', (response) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const playerIndex = findPlayerInRoom(room, socket.id);
    if (playerIndex === -1) return;
    if (processTrucoResponse(room, playerIndex, response)) {
      const labels = { accept: 'aceitou', flee: 'fugiu', raise: 'aumentou' };
      const name = room.game.players[playerIndex]?.name || '?';
      if (labels[response]) emitRoomMessage(room, `${name} ${labels[response]} o truco.`);
      if (response === 'accept' || response === 'raise') {
        const g = room.game;
        // Envia o nível atual (já atualizado)
        io.to(room.code).emit('trucoEffect', { level: g.currentHandValue, player: name });
      }
      sendStateToRoom(room);
    } else {
      socket.emit('toast', 'Resposta inválida.');
    }
  });

  socket.on('nextHand', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const g = room.game;
    if (!g || g.gameOver || g.handWinnerTeam === null) return;
    endHand(room);
    emitRoomMessage(room, 'Nova mão!');
    sendStateToRoom(room);
    if (g.turnTimeLimit && g.started && !g.gameOver) {
      const turnPlayer = g.players[g.turnPlayerIndex];
      if (turnPlayer && turnPlayer.id) {
        io.to(turnPlayer.id).emit('turnTimer', { timeLimit: g.turnTimeLimit });
      }
    }
  });

  socket.on('restart', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const g = room.game;
    if (!g?.gameOver) return;

    const oldPlayers = g.players.map(p => ({
      id: p.id,
      token: p.token,
      name: p.name,
      connected: p.connected
    }));

    const oldLogs = g.logs;
    room.game = initGameState(room.maxPlayers);
    room.game.started = true;
    room.game.logs = oldLogs;
    room.game.turnTimeLimit = g.turnTimeLimit;
    for (let i = 0; i < room.maxPlayers; i++) {
      room.game.players[i].id = oldPlayers[i].id;
      room.game.players[i].token = oldPlayers[i].token;
      room.game.players[i].name = oldPlayers[i].name;
      room.game.players[i].connected = oldPlayers[i].connected;
    }
    addLog(room.game, 'Sistema', 'Nova partida iniciada', '');
    emitRoomMessage(room, '🔄 Nova partida iniciada!');
    sendStateToRoom(room);
    if (room.game.turnTimeLimit && room.game.started) {
      const turnPlayer = room.game.players[room.game.turnPlayerIndex];
      if (turnPlayer && turnPlayer.id) {
        io.to(turnPlayer.id).emit('turnTimer', { timeLimit: room.game.turnTimeLimit });
      }
    }
  });

  socket.on('startGame', ({ timeLimit }) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const g = room.game;
    if (!g) return;
    
    if (room.hostId !== socket.id) {
      socket.emit('toast', 'Apenas o criador da sala pode iniciar a partida.');
      return;
    }

    const allConnected = g.players.every(p => p.connected && p.name && !p.name.startsWith('Jogador '));
    if (!allConnected) {
      socket.emit('toast', 'Aguardando todos os jogadores se conectarem.');
      return;
    }

    if (g.started) {
      socket.emit('toast', 'A partida já foi iniciada.');
      return;
    }

    g.turnTimeLimit = timeLimit || null;
    g.started = true;
    addLog(g, 'Sistema', 'Partida iniciada', timeLimit ? `${timeLimit}s por turno` : 'sem limite de tempo');
    emitRoomMessage(room, `🎮 Partida iniciada! ${timeLimit ? `Tempo por turno: ${timeLimit}s` : 'Sem limite de tempo'}`);
    
    io.to(room.code).emit('gameStarted', { timeLimit: g.turnTimeLimit });
    sendStateToRoom(room);
    
    if (g.turnTimeLimit && g.started) {
      const turnPlayer = g.players[g.turnPlayerIndex];
      if (turnPlayer && turnPlayer.id) {
        io.to(turnPlayer.id).emit('turnTimer', { timeLimit: g.turnTimeLimit });
      }
    }
  });

  socket.on('turnTimeout', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const playerIndex = findPlayerInRoom(room, socket.id);
    if (playerIndex === -1) return;
    const g = room.game;
    if (!g || g.gameOver || g.handWinnerTeam !== null || g.challenge) return;
    if (playerIndex !== g.turnPlayerIndex) return;

    const player = g.players[playerIndex];
    addLog(g, player.name, 'Tempo esgotado', 'perdeu a mão');
    emitRoomMessage(room, `⏰ ${player.name} perdeu a mão por tempo!`);
    
    const opponentTeam = g.players.find((p, idx) => idx !== playerIndex && p.team !== player.team);
    if (opponentTeam) {
      g.handWinnerTeam = opponentTeam.team;
      g.scores[opponentTeam.team] += g.currentHandValue;
      if (g.scores[opponentTeam.team] >= WINNING_SCORE) {
        g.gameOver = true;
        g.winnerTeam = opponentTeam.team;
        addLog(g, opponentTeam.name, 'Venceu a partida por tempo!', '');
      }
    }
    g.challenge = null;
    sendStateToRoom(room);
    endHand(room);
    sendStateToRoom(room);
  });

  socket.on('leaveRoom', () => {
    handleDisconnect(socket, true);
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket, false);
  });

  // --- Chat ---
  socket.on('chatMessage', (data) => {
    const { message } = data;
    if (!message || message.trim() === '') return;

    const room = findRoomBySocket(socket.id);
    if (!room) return;

    let name = socket.name || 'Anônimo';
    let isSpectator = socket.isSpectator || false;

    const playerIndex = findPlayerInRoom(room, socket.id);
    if (playerIndex !== -1) {
      name = room.game.players[playerIndex].name;
    } else {
      if (!name || name === 'Anônimo') name = 'Espectador';
    }

    io.to(room.code).emit('chatMessage', {
      name: name,
      message: message.trim(),
      isSpectator: isSpectator
    });
  });

  function handleDisconnect(socket, voluntary) {
    console.log('Desconectado:', socket.id);

    for (const room of rooms.values()) {
      if (room.spectators.has(socket.id)) {
        room.spectators.delete(socket.id);
        return;
      }

      const player = room.game?.players.find(p => p.id === socket.id);
      if (player) {
        player.connected = false;
        if (voluntary) {
          player.id = '';
          player.token = '';
          player.name = `Jogador ${room.game.players.indexOf(player) + 1}`;
          emitRoomMessage(room, `${player.name} saiu da sala.`);
        } else {
          emitRoomMessage(room, `${player.name} desconectou. Pode reconectar.`);
        }
        
        // Verificar se a partida estava em andamento e agora tem menos de 2 jogadores conectados
        const g = room.game;
        if (g && g.started) {
          const connectedCount = g.players.filter(p => p.connected).length;
          // Se menos de 2 jogadores conectados, abortar a partida
          if (connectedCount < 2) {
            abortGame(room);
            // Não encerrar a sala, apenas voltar ao lobby
            sendStateToRoom(room);
          } else {
            sendStateToRoom(room);
          }
        } else {
          sendStateToRoom(room);
        }

        const anyone = room.game.players.some(p => p.connected);
        if (!anyone && room.spectators.size === 0) {
          rooms.delete(room.code);
          console.log('Sala encerrada:', room.code);
        }
        return;
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Truco na Escola rodando na porta ${PORT}`);
});