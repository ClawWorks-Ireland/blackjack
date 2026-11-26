/**
 * Casino Advisor — Side Panel UI Controller
 * Listens for messages from the background service worker and updates the UI.
 */

'use strict';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const phaseBadge = document.getElementById('phase-badge');
const runningCountEl = document.getElementById('running-count');
const trueCountEl = document.getElementById('true-count');
const decksRemainingEl = document.getElementById('decks-remaining');
const penetrationEl = document.getElementById('penetration');
const betAdviceSection = document.getElementById('bet-advice-section');
const betAdviceEl = document.getElementById('bet-advice');
const handAdviceSection = document.getElementById('hand-advice-section');
const dealerUpcardEl = document.getElementById('dealer-upcard');
const seatsContainer = document.getElementById('seats-container');
const noTableEl = document.getElementById('no-table');

let tableActive = false;

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.type) return;

  switch (msg.type) {
    case 'STATE_UPDATE':
      handleStateUpdate(msg.state);
      break;
    case 'ADVICE_UPDATE':
      handleAdviceUpdate(msg.advice);
      break;
  }
});

// ---------------------------------------------------------------------------
// State update
// ---------------------------------------------------------------------------

function handleStateUpdate(state) {
  if (!state) return;
  tableActive = true;
  noTableEl.classList.add('hidden');

  // Phase badge
  updatePhaseBadge(state.phase);

  // Count display
  if (state.count) {
    runningCountEl.textContent = formatSignedNumber(state.count.runningCount);
    trueCountEl.textContent = formatSignedNumber(state.count.trueCount);
    decksRemainingEl.textContent = state.count.decksRemaining.toFixed(1);
    penetrationEl.textContent = state.count.penetration.toFixed(1) + '%';

    // Color-code true count
    colorCodeCount(trueCountEl, state.count.trueCount);
    colorCodeCount(runningCountEl, state.count.runningCount);
  }
}

// ---------------------------------------------------------------------------
// Advice update
// ---------------------------------------------------------------------------

function handleAdviceUpdate(advice) {
  if (!advice) return;

  // Bet advice
  if (advice.betAdvice) {
    betAdviceSection.classList.remove('hidden');
    betAdviceEl.textContent = `${advice.betAdvice.multiplier}× unit — ${advice.betAdvice.label}`;
  }

  // Hand advice
  if (advice.dealerUpcard || (advice.seats && Object.keys(advice.seats).length > 0)) {
    handAdviceSection.classList.remove('hidden');

    if (advice.dealerUpcard) {
      dealerUpcardEl.textContent = formatCard(advice.dealerUpcard);
    }

    if (advice.seats) {
      renderSeats(advice.seats);
    }
  }

  // Betting phase — show bet advice, hide hand advice
  if (advice.phase === 'betting') {
    handAdviceSection.classList.add('hidden');
    betAdviceSection.classList.remove('hidden');
    if (advice.message) {
      betAdviceEl.textContent = advice.message + (advice.betAdvice ? ` · ${advice.betAdvice.multiplier}× unit` : '');
    }
  }
}

// ---------------------------------------------------------------------------
// Seat rendering
// ---------------------------------------------------------------------------

function renderSeats(seats) {
  seatsContainer.innerHTML = '';

  for (const [seatId, seatData] of Object.entries(seats)) {
    if (!seatData.cards?.length) continue;

    const row = document.createElement('div');
    row.className = 'seat-row';

    const infoDiv = document.createElement('div');
    infoDiv.className = 'seat-info';

    const labelEl = document.createElement('span');
    labelEl.className = 'seat-label';
    labelEl.textContent = `Seat ${seatId}`;

    const cardsEl = document.createElement('span');
    cardsEl.className = 'seat-cards';
    cardsEl.textContent = seatData.cards.map(formatCard).join(' ');

    const totalEl = document.createElement('span');
    totalEl.className = 'seat-total';
    const totalText = seatData.soft ? `Soft ${seatData.handTotal}` : `Hard ${seatData.handTotal}`;
    totalEl.textContent = seatData.bust ? 'Bust' : totalText;

    infoDiv.append(labelEl, cardsEl, totalEl);

    const adviceDiv = document.createElement('div');
    adviceDiv.className = 'seat-advice';

    if (seatData.advice) {
      const badge = document.createElement('span');
      badge.className = `action-badge action-${seatData.advice.action}`;
      badge.textContent = seatData.advice.label;

      const reason = document.createElement('span');
      reason.className = 'action-reason';
      reason.textContent = seatData.advice.reason;

      adviceDiv.append(badge, reason);
    }

    row.append(infoDiv, adviceDiv);
    seatsContainer.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updatePhaseBadge(phase) {
  phaseBadge.className = `phase-badge phase-${phase}`;
  const labels = { idle: 'Idle', betting: 'Betting Open', dealing: 'Dealing', resolved: 'Resolved' };
  phaseBadge.textContent = labels[phase] ?? phase;
}

function formatCard(card) {
  if (!card || card.length !== 2) return card;
  const rank = card[0];
  const suit = card[1];
  const suitSymbols = { H: '♥', D: '♦', C: '♣', S: '♠' };
  return `${rank}${suitSymbols[suit] ?? suit}`;
}

function formatSignedNumber(n) {
  if (n === null || n === undefined || n === '—') return '—';
  const num = parseFloat(n);
  if (isNaN(num)) return '—';
  return num >= 0 ? `+${num}` : `${num}`;
}

function colorCodeCount(el, value) {
  el.style.color = '';
  if (value > 2)  el.style.color = 'var(--accent-green)';
  else if (value < -2) el.style.color = 'var(--accent)';
  else el.style.color = 'var(--text)';
}
