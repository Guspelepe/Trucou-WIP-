const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static('public'));

// --- Baralho e lógica (Truco Paulista) ---
const SUITS = ['ouros', 'espadas', 'copas', 'paus'];
const RANKS = ['4', '5', '6', '7', 'Q', 'J', 'K', 'A', '2', '3'];
const MANILHA_SUIT_ORDER = ['ouros', 'espadas', 'copas', 'paus']; // ouros fraca → paus (zap) forte

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
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

// --- Estado ---
let game = null;
let maxPlayers = null;
let hostId = null;

// Posições absolutas: 0=Norte, 1=Leste, 2=Sul, 3=Oeste
// Times: 0+2 = Norte/Sul | 1+3 = Leste/Oeste
const POSITION_NAMES = ['Norte', 'Leste', 'Sul', 'Oeste'];

function createPlayers(count) {
  const players = [];
  for (let i = 0; i < count; i++) {
    players.push({
      id: '',
      name: `Jogador ${i + 1}`,
      team: count === 2 ? i : (i % 2 === 0 ? 0 : 1),
      position: count === 4 ? POSITION_NAMES[i] : null,
      hand: [],
      connected: false
    });
  }
  return players;
}

function initGame() {
  const deck = createDeck();
  const players = createPlayers(maxPlayers);

  for (const player of players) {
    player.hand = [deck.pop(), deck.pop(), deck.pop()];
  }

  const vira = deck.pop();
  const manilhaRank = RANKS[(RANKS.indexOf(vira.rank) + 1) % RANKS.length];
  const starterIndex = Math.floor(Math.random() * maxPlayers);

  game = {
    players,
    deck,
    vira,
    manilhaRank,
    currentHandValue: 1,
    rounds: [],
    currentRound: 0,
    turnPlayerIndex: starterIndex,
    roundStarter: starterIndex,
    handWinnerTeam: null,
    challenge: null,
    gameOver: false,
    winnerTeam: null,
    scores: [0, 0],
    handStarter: starterIndex
  };
}

function endHand() {
  if (!game || game.gameOver) return;

  const scores = [...game.scores];
  const oldPlayers = game.players.map(p => ({
    id: p.id,
    name: p.name,
    connected: p.connected
  }));

  // Próximo a começar a mão (anti-horário)
  const nextStarter = (game.handStarter - 1 + maxPlayers) % maxPlayers;

  initGame();

  for (let i = 0; i < maxPlayers; i++) {
    game.players[i].id = oldPlayers[i].id;
    game.players[i].name = oldPlayers[i].name;
    game.players[i].connected = oldPlayers[i].connected;
  }

  game.scores = scores;
  game.handStarter = nextStarter;
  game.turnPlayerIndex = nextStarter;
  game.roundStarter = nextStarter;
}

function getStateForPlayer(playerId) {
  if (!game) return null;

  const playerIndex = game.players.findIndex(p => p.id === playerId);
  if (playerIndex === -1) return null;

  let partnerIndex = -1;
  let partnerName = null;
  if (maxPlayers === 4) {
    partnerIndex = game.players.findIndex(
      (p, idx) => p.team === game.players[playerIndex].team && idx !== playerIndex
    );
    if (partnerIndex >= 0) partnerName = game.players[partnerIndex].name;
  }

  let teamNames = null;
  if (maxPlayers === 4) {
    teamNames = [
      game.players.filter(p => p.team === 0).map(p => p.name).join(' & '),
      game.players.filter(p => p.team === 1).map(p => p.name).join(' & ')
    ];
  }

  return {
    yourIndex: playerIndex,
    yourTeam: game.players[playerIndex].team,
    yourHand: game.players[playerIndex].hand,
    partnerIndex,
    partnerName,
    teamNames,
    players: game.players.map(p => ({
      name: p.name,
      team: p.team,
      position: p.position,
      connected: p.connected,
      cardCount: p.hand.length
    })),
    vira: game.vira,
    manilhaRank: game.manilhaRank,
    currentHandValue: game.currentHandValue,
    rounds: game.rounds,
    currentRound: game.currentRound,
    turn: game.turnPlayerIndex,
    turnPlayerName: game.players[game.turnPlayerIndex]?.name || '?',
    roundStarter: game.roundStarter,
    handWinnerTeam: game.handWinnerTeam,
    challenge: game.challenge,
    scores: game.scores,
    gameOver: game.gameOver,
    winnerTeam: game.winnerTeam,
    maxPlayers
  };
}

function playCard(playerIndex, card) {
  if (!game || game.gameOver || game.handWinnerTeam !== null || game.challenge) return false;
  if (playerIndex !== game.turnPlayerIndex) return false;

  const player = game.players[playerIndex];
  const cardIndex = player.hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
  if (cardIndex === -1) return false;

  const playedCard = player.hand.splice(cardIndex, 1)[0];

  if (!game.rounds[game.currentRound]) {
    game.rounds[game.currentRound] = { cards: [], winnerPlayer: null };
  }

  game.rounds[game.currentRound].cards.push({ player: playerIndex, card: playedCard });

  if (game.rounds[game.currentRound].cards.length === maxPlayers) {
    const cards = game.rounds[game.currentRound].cards;

    let bestIdx = 0;
    for (let i = 1; i < cards.length; i++) {
      const result = compareCards(cards[bestIdx].card, cards[i].card, game.manilhaRank);
      if (result === 'B') bestIdx = i;
    }

    let hasTie = false;
    for (let i = 0; i < cards.length; i++) {
      if (i === bestIdx) continue;
      if (compareCards(cards[bestIdx].card, cards[i].card, game.manilhaRank) === 'tie') {
        hasTie = true;
        break;
      }
    }

    const roundWinner = hasTie ? null : cards[bestIdx].player;
    game.rounds[game.currentRound].winnerPlayer = roundWinner;

    const teamRoundWins = [0, 0];
    game.rounds.forEach(r => {
      if (r.winnerPlayer !== null) {
        const team = game.players[r.winnerPlayer].team;
        teamRoundWins[team]++;
      }
    });

    if (teamRoundWins[0] >= 2 || teamRoundWins[1] >= 2 || game.rounds.length === 3) {
      let winningTeam = null;
      if (teamRoundWins[0] > teamRoundWins[1]) winningTeam = 0;
      else if (teamRoundWins[1] > teamRoundWins[0]) winningTeam = 1;

      game.handWinnerTeam = winningTeam;

      if (winningTeam !== null) {
        game.scores[winningTeam] += game.currentHandValue;
        if (game.scores[winningTeam] >= 12) {
          game.gameOver = true;
          game.winnerTeam = winningTeam;
        }
      }
      return true;
    }

    // Vencedor da rodada começa a próxima
    if (roundWinner !== null) {
      game.roundStarter = roundWinner;
      game.turnPlayerIndex = roundWinner;
    } else {
      game.turnPlayerIndex = game.roundStarter;
    }
    game.currentRound++;
  } else {
    // ANTI-HORÁRIO
    game.turnPlayerIndex = (playerIndex - 1 + maxPlayers) % maxPlayers;
  }

  return true;
}

function processTrucoResponse(playerIndex, response) {
  if (!game || !game.challenge || game.gameOver || game.handWinnerTeam !== null) return false;

  const { level, previousValue, challenger, waitingOn } = game.challenge;
  if (playerIndex !== waitingOn) return false;

  if (response === 'flee') {
    const challengerTeam = game.players[challenger].team;
    game.scores[challengerTeam] += previousValue;
    if (game.scores[challengerTeam] >= 12) {
      game.gameOver = true;
      game.winnerTeam = challengerTeam;
    }
    game.challenge = null;
    endHand();
    return true;
  }

  if (response === 'accept') {
    game.currentHandValue = level;
    game.challenge = null;
    return true;
  }

  if (response === 'raise') {
    if (level >= 12) return false;
    const newLevel = level === 3 ? 6 : level === 6 ? 9 : 12;

    game.challenge = {
      level: newLevel,
      previousValue: level,
      challenger: playerIndex,
      waitingOn: challenger
    };
    return true;
  }

  return false;
}

function sendStateToAll() {
  if (!game) return;
  game.players.forEach(p => {
    if (p.id && p.connected) {
      const sock = io.sockets.sockets.get(p.id);
      if (sock) sock.emit('gameState', getStateForPlayer(p.id));
    }
  });
}

// --- Conexões ---
io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  if (!hostId) {
    socket.emit('requestConfig');

    socket.on('setModeAndName', (data) => {
      if (hostId) return;
      const { mode, name } = data;
      if (!name || !name.trim()) return;

      maxPlayers = mode === 'duplas' ? 4 : 2;
      hostId = socket.id;
      initGame();

      game.players[0].id = socket.id;
      game.players[0].name = name.trim();
      game.players[0].connected = true;

      socket.emit('playerAssigned', { index: 0, name: game.players[0].name, isHost: true });
      socket.emit('gameState', getStateForPlayer(socket.id));
      io.emit('message', `${name.trim()} criou a sala (${maxPlayers} jogadores). Aguardando...`);
    });
  } else if (game) {
    const freeSlot = game.players.findIndex(p => !p.connected);

    if (freeSlot !== -1) {
      game.players[freeSlot].name = `Jogador ${freeSlot + 1}`;
      game.players[freeSlot].id = socket.id;
      game.players[freeSlot].connected = true;

      socket.emit('playerAssigned', {
        index: freeSlot,
        name: game.players[freeSlot].name,
        isHost: false
      });
      socket.emit('gameState', getStateForPlayer(socket.id));
      io.emit('message', `${game.players[freeSlot].name} entrou (${game.players[freeSlot].position || 'slot ' + (freeSlot + 1)}).`);
      sendStateToAll();

      if (game.players.every(p => p.connected)) {
        io.emit('message', 'Todos conectados! Jogo iniciado.');
      }
    } else {
      socket.emit('message', 'Sala cheia. Você é espectador.');
      socket.emit('spectator', {
        players: game.players.map(p => ({
          name: p.name, team: p.team, position: p.position,
          connected: p.connected, cardCount: p.hand.length
        })),
        vira: game.vira, manilhaRank: game.manilhaRank,
        scores: game.scores, currentHandValue: game.currentHandValue,
        maxPlayers, turnPlayerName: game.players[game.turnPlayerIndex]?.name
      });
    }
  }

  socket.on('setName', (name) => {
    if (!game || !name || !name.trim()) return;
    const player = game.players.find(p => p.id === socket.id);
    if (player) {
      const oldName = player.name;
      player.name = name.trim();
      io.emit('message', `${oldName} agora é ${player.name}`);
      sendStateToAll();
    }
  });

  socket.on('playCard', (card) => {
    const playerIndex = game?.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;
    if (playCard(playerIndex, card)) sendStateToAll();
    else socket.emit('message', 'Jogada inválida.');
  });

  socket.on('truco', () => {
    const playerIndex = game?.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;

    if (!game || game.gameOver || game.challenge || game.handWinnerTeam !== null) {
      socket.emit('message', 'Não pode pedir truco agora.');
      return;
    }
    if (playerIndex !== game.turnPlayerIndex) {
      socket.emit('message', 'Não é sua vez de pedir truco.');
      return;
    }

    // Desafia o próximo adversário no sentido anti-horário
    let opponentIndex = (playerIndex - 1 + maxPlayers) % maxPlayers;
    while (game.players[opponentIndex].team === game.players[playerIndex].team) {
      opponentIndex = (opponentIndex - 1 + maxPlayers) % maxPlayers;
    }

    game.challenge = {
      level: 3,
      previousValue: game.currentHandValue,
      challenger: playerIndex,
      waitingOn: opponentIndex
    };
    sendStateToAll();
  });

  socket.on('respondTruco', (response) => {
    const playerIndex = game?.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;
    if (processTrucoResponse(playerIndex, response)) sendStateToAll();
    else socket.emit('message', 'Resposta inválida (não pode aumentar além de 12).');
  });

  socket.on('nextHand', () => {
    if (!game || game.gameOver || game.handWinnerTeam === null) return;
    endHand();
    sendStateToAll();
    io.emit('message', 'Nova mão!');
  });

  socket.on('restart', () => {
    if (!game?.gameOver) return;
    const oldPlayers = game.players.map(p => ({
      id: p.id, name: p.name, connected: p.connected
    }));
    initGame();
    for (let i = 0; i < maxPlayers; i++) {
      game.players[i].id = oldPlayers[i].id;
      game.players[i].name = oldPlayers[i].name;
      game.players[i].connected = oldPlayers[i].connected;
    }
    sendStateToAll();
    io.emit('message', 'Nova partida iniciada!');
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (player) {
      player.connected = false;
      io.emit('message', `${player.name} saiu.`);
      sendStateToAll();
    }

    if (socket.id === hostId) {
      hostId = null;
      maxPlayers = null;
      game = null;
      io.emit('message', 'Anfitrião saiu. Sala encerrada. Recarregue a página.');
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});