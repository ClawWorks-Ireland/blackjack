#!/usr/bin/env node
/**
 * Blackjack Simulator CLI
 *
 * Usage:
 *   node simulator.js --scenario scenarios/basic-stand.json
 *   node simulator.js --scenario scenarios/basic-stand.json --decks 6 --penetration 0.75 --bankroll 1000
 *   node simulator.js --scenario scenarios/basic-stand.json --hands 100 --bet 25 --json
 *
 * Options:
 *   --scenario  <file>    Path to scenario JSON file (required)
 *   --decks     <n>       Number of decks (default: from scenario or 6)
 *   --penetration <f>     Penetration fraction 0-1 (default: from scenario or 0.75)
 *   --bankroll  <n>       Starting bankroll (default: from scenario or 1000)
 *   --bet       <n>       Flat bet per hand (default: from scenario or 25)
 *   --hands     <n>       Max hands to play (default: from scenario or full shoe)
 *   --json                Output raw JSON summary (default: human-readable)
 *   --verbose             Print each hand decision state
 *
 * Scenario file format:
 * {
 *   "description": "Always-stand strategy",
 *   "strategy": "always-stand" | "always-hit" | "basic" | "custom",
 *   "decks": 6,
 *   "penetration": 0.75,
 *   "startingBankroll": 1000,
 *   "bet": 25,
 *   "maxHands": 100,
 *   "minBet": 10,
 *   "maxBet": 500
 * }
 *
 * For strategy="custom", the scenario must include a "decisions" array:
 * [
 *   { "hand": 1, "actions": ["stand"] },
 *   { "hand": 2, "actions": ["hit", "stand"] },
 *   ...
 * ]
 */

'use strict';

import { readFileSync } from 'fs';
import { Shoe } from './src/sim/shoe.js';
import { BlackjackGame, SessionTracker } from './src/sim/game.js';
import { basicStrategy, betSizing, handTotal } from './src/shared/card-engine.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true; // flag
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Strategy implementations
// ---------------------------------------------------------------------------

/**
 * Given game state, return the next action based on the chosen strategy.
 * @param {object} state
 * @param {string} strategy
 * @returns {string}
 */
function pickAction(state, strategy) {
  const { playerHands, activeHandIndex, dealerUpcard, availableActions } = state;
  const hand = playerHands[activeHandIndex];

  if (strategy === 'always-stand') {
    return 'stand';
  }

  if (strategy === 'always-hit') {
    const { total, bust } = handTotal(hand);
    if (bust || total >= 21) return 'stand';
    return availableActions.includes('hit') ? 'hit' : 'stand';
  }

  if (strategy === 'basic') {
    const { action } = basicStrategy(hand, dealerUpcard);
    const actionMap = { 'H': 'hit', 'S': 'stand', 'D': 'double', 'SP': 'split', 'SU': 'surrender' };
    const mapped = actionMap[action] ?? 'stand';
    // Fall back if action not available
    if (availableActions.includes(mapped)) return mapped;
    // Fallback: D -> hit if no double available, SP -> hit, SU -> hit
    if (mapped === 'double' && availableActions.includes('hit')) return 'hit';
    if (mapped === 'split' && availableActions.includes('hit')) return 'hit';
    if (mapped === 'surrender' && availableActions.includes('hit')) return 'hit';
    return 'stand';
  }

  // Default: stand
  return 'stand';
}

/**
 * Pick bet size based on strategy and count.
 * @param {object} state
 * @param {string} strategy
 * @param {number} flatBet
 * @param {number} minBet
 * @param {number} maxBet
 * @returns {number}
 */
function pickBet(state, strategy, flatBet, minBet, maxBet) {
  if (strategy === 'count-aware') {
    const { multiplier } = betSizing(state.trueCount ?? 0);
    return Math.min(Math.max(flatBet * multiplier, minBet), maxBet);
  }
  return flatBet;
}

// ---------------------------------------------------------------------------
// Main simulation loop
// ---------------------------------------------------------------------------
function run(scenarioPath, cliOverrides) {
  // Load scenario
  let scenario = {};
  try {
    scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  } catch (e) {
    console.error(`Failed to load scenario: ${e.message}`);
    process.exit(1);
  }

  // Merge CLI overrides
  const decks = parseInt(cliOverrides.decks ?? scenario.decks ?? 6, 10);
  const penetration = parseFloat(cliOverrides.penetration ?? scenario.penetration ?? 0.75);
  const startingBankroll = parseInt(cliOverrides.bankroll ?? scenario.startingBankroll ?? 1000, 10);
  const flatBet = parseInt(cliOverrides.bet ?? scenario.bet ?? 25, 10);
  const maxHands = parseInt(cliOverrides.hands ?? scenario.maxHands ?? 999999, 10);
  const minBet = parseInt(cliOverrides.minBet ?? scenario.minBet ?? Math.min(flatBet, 10), 10);
  const maxBet = parseInt(cliOverrides.maxBet ?? scenario.maxBet ?? startingBankroll, 10);
  const strategy = cliOverrides.strategy ?? scenario.strategy ?? 'always-stand';
  const verbose = cliOverrides.verbose === true;
  const jsonOutput = cliOverrides.json === true;

  // Custom decisions iterator
  const customDecisions = scenario.decisions ?? [];
  const decisionMap = {};
  for (const d of customDecisions) {
    decisionMap[d.hand] = { actions: [...d.actions], _idx: 0 };
  }

  // Initialise
  const shoe = new Shoe({ decks, penetration });
  const game = new BlackjackGame(shoe, { minBet, maxBet });
  const tracker = new SessionTracker({ startingBankroll, minBet, maxBet });

  if (!jsonOutput) {
    console.log(`📡 Blackjack Simulator`);
    console.log(`   Scenario: ${scenario.description ?? scenarioPath}`);
    console.log(`   Strategy: ${strategy} | Decks: ${decks} | Pen: ${Math.round(penetration * 100)}%`);
    console.log(`   Bankroll: $${startingBankroll} | Bet: $${flatBet} | Max hands: ${maxHands}`);
    console.log(`   ─────────────────────────────────────────────────`);
  }

  let handsThisShoe = 0;

  for (let i = 0; i < maxHands; i++) {
    if (tracker.isBankrupt) {
      if (!jsonOutput) console.log(`   ⚠ Bankrupt after hand ${tracker.handsPlayed}. Session ended.`);
      break;
    }

    // Bet for this hand
    const dummyState = { trueCount: game.counter.trueCount };
    const bet = Math.min(pickBet(dummyState, strategy, flatBet, minBet, maxBet), tracker.bankroll);

    // Start hand
    let state = game.startHand(bet, tracker.bankroll);
    handsThisShoe++;

    // Custom decision lookup
    const customEntry = decisionMap[state.hand];
    let customIdx = 0;

    // Play out the hand
    while (state.phase === 'player_decision') {
      let action;
      if (strategy === 'custom' && customEntry) {
        action = customEntry.actions[customIdx++] ?? 'stand';
      } else {
        action = pickAction(state, strategy);
      }

      if (verbose && !jsonOutput) {
        const hand = state.playerHands[state.activeHandIndex];
        const { total } = handTotal(hand);
        console.log(`   Hand ${state.hand}: ${hand.join(' ')} (${total}) vs ${state.dealerUpcard} → ${action} | count: ${state.runningCount}/${state.trueCount}`);
      }

      state = game.step(state, action);
    }

    // Record outcome
    tracker.recordHand(state);

    if (verbose && !jsonOutput) {
      const outcome = state.outcomes?.[0]?.outcome ?? '?';
      const pnl = state.totalPayout >= 0 ? `+$${state.totalPayout}` : `-$${Math.abs(state.totalPayout)}`;
      console.log(`   Hand ${state.hand}: ${outcome} ${pnl} → bankroll $${tracker.bankroll}`);
    }

    // Check for reshuffle marker
    if (shoe.shouldReshuffle) {
      if (verbose && !jsonOutput) {
        console.log(`   ─── Reshuffle after hand ${tracker.handsPlayed} (${Math.round(shoe.penetrationReached * 100)}% pen) ───`);
      }
      handsThisShoe = 0;
    }
  }

  // Final summary
  const summary = tracker.summary();

  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const pnlSign = summary.pnl >= 0 ? '+' : '';
    console.log(`\n📊 Session Summary`);
    console.log(`   Hands:       ${summary.handsPlayed}`);
    console.log(`   Wins:        ${summary.wins} (${summary.winRate}%)`);
    console.log(`   Losses:      ${summary.losses}`);
    console.log(`   Pushes:      ${summary.pushes} (${summary.pushRate}%)`);
    console.log(`   Surrenders:  ${summary.surrenders}`);
    console.log(`   Blackjacks:  ${summary.blackjacks}`);
    console.log(`   Busts:       ${summary.busts}`);
    console.log(`   Avg bet:     $${summary.avgBet}`);
    console.log(`   Bankroll:    $${summary.startingBankroll} → $${summary.endingBankroll}`);
    console.log(`   P&L:         ${pnlSign}$${summary.pnl} (${pnlSign}${summary.pnlPercent}%)`);
    console.log(`   Peak:        $${summary.maxBankroll} | Floor: $${summary.minBankroll}`);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));

if (!args.scenario) {
  console.error('Usage: node simulator.js --scenario <file> [options]');
  process.exit(1);
}

run(args.scenario, args);
