#!/usr/bin/env node
/**
 * Agent feedback queue (CLA-116). Local-model players (agent/local-player.js)
 * append findings to server/data/agent-feedback.jsonl; this file writes
 * them (deduplicated) and is the command line for triage:
 *
 *   node agent/feedback.js pending            findings not filed yet, grouped, most frequent first
 *   node agent/feedback.js mark <fp>... --as CLA-123|dismissed
 *
 * Triage is done by Claude on request: read `pending`, check each finding
 * against the code (small models get things wrong), file the real ones in
 * Linear with the "agent feedback" label, then `mark` them. The queue and
 * the filed list stay local (server/data/, git-ignored).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, '..', 'server', 'data');
const QUEUE = path.join(DATA, 'agent-feedback.jsonl');
const FILED = path.join(DATA, 'agent-feedback-filed.json');

/** Same finding, same fingerprint: lower-case words of the title, sorted, first eight. */
function fingerprint(title) {
  const words = String(title).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2).sort().slice(0, 8);
  return crypto.createHash('sha1').update(words.join(' ')).digest('hex').slice(0, 8);
}

/** Appends findings, skipping one already queued in the last `withinMs`. */
class FeedbackQueue {
  constructor({ file = QUEUE, withinMs = 24 * 3600 * 1000 } = {}) {
    this.file = file;
    this.withinMs = withinMs;
    this.lastSeen = new Map();
    for (const f of readQueue(file)) this.lastSeen.set(f.fingerprint, Date.parse(f.at));
  }

  /** {source: harness|model, kind: bug|feedback, title, detail, evidence, agent, model, table, round}; true if written. */
  add(finding) {
    const at = new Date();
    const fp = fingerprint(finding.title);
    const prev = this.lastSeen.get(fp);
    if (prev && at - prev < this.withinMs) return false;
    this.lastSeen.set(fp, at.getTime());
    const row = { at: at.toISOString(), fingerprint: fp, ...finding, title: String(finding.title).slice(0, 140), detail: String(finding.detail || '').slice(0, 1200), evidence: String(finding.evidence || '').slice(0, 1200) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
    return true;
  }
}

function readQueue(file = QUEUE) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

const readFiled = (file = FILED) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});

/** Findings not filed or dismissed, grouped by fingerprint, most frequent first. */
function pending({ queue = QUEUE, filed = FILED } = {}) {
  const done = readFiled(filed);
  const groups = new Map();
  for (const f of readQueue(queue)) {
    if (done[f.fingerprint]) continue;
    const g = groups.get(f.fingerprint) || { fingerprint: f.fingerprint, count: 0, kind: f.kind, source: f.source, title: f.title, first: f.at, last: f.at, examples: [] };
    g.count++;
    g.last = f.at;
    if (g.examples.length < 3) g.examples.push({ at: f.at, agent: f.agent, detail: f.detail, evidence: f.evidence });
    groups.set(f.fingerprint, g);
  }
  return [...groups.values()].sort((a, b) => (a.kind === 'bug' ? 0 : 1) - (b.kind === 'bug' ? 0 : 1) || b.count - a.count);
}

function mark(fps, as, { filed = FILED } = {}) {
  const done = readFiled(filed);
  for (const fp of fps) done[fp] = { as, at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(filed), { recursive: true });
  fs.writeFileSync(filed, JSON.stringify(done, null, 1));
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'pending') {
    const groups = pending();
    if (!groups.length) console.log('No pending agent feedback.');
    for (const g of groups) {
      console.log(`[${g.fingerprint}] ${g.kind} (${g.source}) x${g.count}, ${g.first.slice(0, 16)} to ${g.last.slice(0, 16)}: ${g.title}`);
      for (const e of g.examples) console.log(`    ${e.agent}: ${e.detail}${e.evidence ? `\n      evidence: ${e.evidence}` : ''}`);
    }
  } else if (cmd === 'mark') {
    const i = rest.indexOf('--as');
    if (i === -1 || !rest[i + 1]) { console.error('usage: mark <fingerprint>... --as CLA-123|dismissed'); process.exit(1); }
    mark(rest.slice(0, i), rest[i + 1]);
    console.log(`marked ${rest.slice(0, i).join(', ')} as ${rest[i + 1]}`);
  } else {
    console.error('usage: node agent/feedback.js pending | mark <fingerprint>... --as CLA-123|dismissed');
    process.exit(1);
  }
}

module.exports = { FeedbackQueue, fingerprint, readQueue, pending, mark, QUEUE, FILED };
