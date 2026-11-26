/**
 * Casino Advisor — Background Service Worker
 * Receives card events from the content script bridge and maintains game state.
 * Computes basic strategy + bet sizing recommendations and sends to side panel.
 */

'use strict';

import { parseCard, handTotal, HiLoCounter, basicStrategy, betSizing } from '../shared/card-engine.js';

// ---------------------------------------------------------------------------
// Game State
// ---------------------------------------------------------------------------

/**
 * @typedef {{ cards: string[], total: number, soft: boolean, bust: boolean }} Hand
 *
 * @typedef {{
 *   tableId: string | null,
 *   gameId: string | null,
 *   phase: 'idle' | 'betting' | 'dealing' | 'resolved',
 *   dealerUpcard: string | null,
 *   dealerHand: string[],
 *   playerSeats: Record<string, string[]>,
 *   activeSeats: string[],
 *   counter: HiLoCounter,
 *   lastAdvice: object | null,
 * }} GameState
 */

/** @type {GameState} */
const state = {
  tableId: null,
  gameId: null,
  phase: 'idle',
  dealerUpcard: null,
  dealerHand: [],
  playerSeats: {},        // seatId → card[]
  activeSeats: [],
  counter: new HiLoCounter(),
  lastAdvice: null,
};

// ---------------------------------------------------------------------------
// Event Handlers
// ---------------------------------------------------------------------------

function handleTableState(platform, args) {
  if (!args) return;
  state.tableId = args.tableId ?? state.tableId;

  // Sync shoe penetration
  if (typeof args.shoeCardsOut === 'number') {
    state.counter.syncShoeCardsOut(args.shoeCardsOut);
  }

  // If there's a current game in progress, parse it
  if (args.currentGame?.gameData) {
    parseGameData(args.currentGame.gameData);
  }

  // Determine phase from betting field
  if (args.currentGame?.betting) {
    state.phase = mapPhase(args.currentGame.betting);
  }

  broadcastState();
}

function handleNewGame(platform, args) {
  if (!args) return;
  state.gameId = args.gameId ?? null;
  state.phase = 'betting'; // New game always starts in betting phase
  state.dealerUpcard = null;
  state.dealerHand = [];
  state.playerSeats = {};
  state.activeSeats = [];
  state.lastAdvice = null;

  if (typeof args.shoeCardsOut === 'number') {
    state.counter.syncShoeCardsOut(args.shoeCardsOut);
  }

  broadcastState();
  broadcastAdvice({ phase: 'betting', message: 'New round — place your bet', betAdvice: betSizing(state.counter.trueCount) });
}

function handleGameState(platform, args) {
  if (!args) return;

  if (args.betting) {
    state.phase = mapPhase(args.betting);
  }
  if (args.dealing === 'Dealing') {
    state.phase = 'dealing';
  }

  if (args.gameData) {
    parseGameData(args.gameData);
  }

  broadcastState();

  // When in dealing phase and we have player cards, compute advice
  if (state.phase === 'dealing' && state.dealerUpcard) {
    computeAndBroadcastAdvice();
  }
}

function handleResolved(platform, args) {
  if (!args) return;
  state.phase = 'resolved';
  broadcastState();
}

function handleShoeState(platform, args) {
  if (!args) return;
  // shoeCardsOut may be in args.stats or args directly depending on event
  const shoeCardsOut = args.shoeCardsOut ?? args.stats?.shoeCardsOut;
  if (typeof shoeCardsOut === 'number') {
    state.counter.syncShoeCardsOut(shoeCardsOut);
  }
  broadcastState();
}

// ---------------------------------------------------------------------------
// Game Data Parsing
// ---------------------------------------------------------------------------

/**
 * Parse gameData payload and update state.
 * Handles both Baccarat (playerHand/bankerHand) and Blackjack (seats/dealerHand) schemas.
 * @param {object} gameData
 */
function parseGameData(gameData) {
  // Blackjack schema: seats[] + dealerHand
  if (gameData.seats && Array.isArray(gameData.seats)) {
    state.playerSeats = {};
    state.activeSeats = [];
    for (const seat of gameData.seats) {
      const seatId = String(seat.id ?? seat.seatId ?? 'seat');
      const cards = (seat.cards ?? []).filter(Boolean);
      state.playerSeats[seatId] = cards;
      if (cards.length > 0) state.activeSeats.push(seatId);
    }
  }

  // Blackjack dealer hand
  if (gameData.dealerHand) {
    const dealerCards = (gameData.dealerHand.cards ?? []).filter(Boolean);
    state.dealerHand = dealerCards;
    // Dealer upcard is the first visible card (hole card may be null/hidden)
    state.dealerUpcard = dealerCards[0] ?? null;
  }

  // Baccarat fallback (for testing with available samples)
  if (!gameData.seats && gameData.playerHand) {
    state.playerSeats['player'] = (gameData.playerHand.cards ?? []).filter(Boolean);
    state.activeSeats = state.playerSeats['player'].length > 0 ? ['player'] : [];
  }
  if (!gameData.dealerHand && gameData.bankerHand) {
    const bankerCards = (gameData.bankerHand.cards ?? []).filter(Boolean);
    state.dealerHand = bankerCards;
    state.dealerUpcard = bankerCards[0] ?? null;
  }

  // Track all visible cards in the count
  const allCards = [
    ...state.dealerHand,
    ...Object.values(state.playerSeats).flat(),
  ];

  // Add new cards to running count (avoid double-counting by resetting on newGame)
  // We do a full resync here from game state — count is maintained per shoe, not per hand
  // The counter.syncShoeCardsOut handles shoe-level penetration
}

// ---------------------------------------------------------------------------
// Strategy Computation
// ---------------------------------------------------------------------------

function computeAndBroadcastAdvice() {
  if (!state.dealerUpcard) return;

  const advicePerSeat = {};

  for (const [seatId, cards] of Object.entries(state.playerSeats)) {
    if (cards.length === 0) continue;
    const advice = basicStrategy(cards, state.dealerUpcard);
    const { total, soft, bust } = handTotal(cards);
    advicePerSeat[seatId] = {
      cards,
      handTotal: total,
      soft,
      bust,
      advice,
    };
  }

  const countInfo = state.counter.toJSON();
  const betAdvice = betSizing(countInfo.trueCount);

  state.lastAdvice = {
    phase: state.phase,
    dealerUpcard: state.dealerUpcard,
    seats: advicePerSeat,
    count: countInfo,
    betAdvice,
  };

  broadcastAdvice(state.lastAdvice);
}

// ---------------------------------------------------------------------------
// Side Panel Communication
// ---------------------------------------------------------------------------

function broadcastState() {
  const msg = {
    type: 'STATE_UPDATE',
    state: {
      phase: state.phase,
      tableId: state.tableId,
      gameId: state.gameId,
      dealerUpcard: state.dealerUpcard,
      count: state.counter.toJSON(),
      activeSeats: state.activeSeats,
    },
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function broadcastAdvice(advice) {
  const msg = { type: 'ADVICE_UPDATE', advice };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---------------------------------------------------------------------------
// Message Routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.__casinoAdvisor) return;

  const { platform, msg: wsMsg } = msg;
  if (!wsMsg?.type) return;

  const [, event] = wsMsg.type.split('.');
  const args = wsMsg.args;

  switch (event) {
    case 'tableState':       handleTableState(platform, args); break;
    case 'newGame':          handleNewGame(platform, args); break;
    case 'gameState':        handleGameState(platform, args); break;
    case 'resolved':         handleResolved(platform, args); break;
    case 'encodedShoeState': handleShoeState(platform, args); break;
    default:
      // Unknown event type — log for diagnostics
      console.debug('[CasinoAdvisor] Unknown event:', wsMsg.type);
  }

  sendResponse({ ok: true });
});

// ---------------------------------------------------------------------------
// Side panel open on action click
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapPhase(bettingField) {
  if (bettingField === 'BetsOpen') return 'betting';
  if (bettingField === 'BetsClosed') return 'dealing';
  return 'idle';
}
