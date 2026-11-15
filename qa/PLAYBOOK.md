# QA round playbook

How to QA one commit of the game. Ported from the original KiroCrew
creator/player loop (see `handoff-history/` and the top-level `HANDOVER.md`);
the crons, session notifications and handoff publishing were left behind.
A round is now started by hand (or by any scheduler you choose to set up).

## Setup (once per machine)

- Node 18+ and Google Chrome.
- `cd qa && npm ci` installs `playwright-core` only. It drives the installed
  Chrome (`channel: 'chrome'`); no browser download. Override with
  `PW_CHANNEL=msedge` or `PW_EXECUTABLE=/path/to/browser`.

## Run a round

```bash
node qa/run-round.js            # HEAD
node qa/run-round.js 6ec4a0e    # a specific commit
```

It snapshots the commit into `qa/.snapshots/<sha7>/` (`git archive`, never the
working tree), serves it with `qa/serve.js`, runs every check whose module
exists in that commit, and writes `qa/reports/<sha7>/summary.json` plus each
step's raw output. Exit 0 = all passed, 1 = a check failed, 2 = harness error.
Running it uses no model; only reading a failure needs one.

Do not serve snapshots with `python3 -m http.server`: it resets connections
when Chrome loads the game's scripts in parallel, and app.js then throws at
startup (T2).

## After the run

1. Read `summary.json`. For each failure, open the step's `.out`/`.json` and the
   screenshots in `qa/reports/<sha7>/`, and decide: game bug, harness bug, or
   flake (re-run that step once before calling it a flake).
2. Review `git log <last_tested>..<sha>` and the diff. Exercise every claimed
   fix/feature; extend the harness where it can't reach them (keep selectors in
   one place per script).
3. Optional live check: play 5 coach-guided hands in a real browser (the
   built-in browser or Claude in Chrome), including chips, Rebet, insurance and
   the hint, with a screenshot per hand. `live_play.sh`/`live_drills.sh` are the
   old playwright-cli versions of this and are kept for reference only.
4. Update GitHub Issues on this repo, the source of truth for open work
   (Linear is history since 2026-11-14): a new finding is a new issue (label
   `bug`, or `enhancement` for a harness fix) with repro + expected/actual; an
   issue verified by this round is closed with the SHA; a regression reopens
   its issue. `qa/backlog.md`
   is the closed archive up to round 14: don't add to it.
5. Write `qa/reports/<sha7>.md` (the per-round summary that is committed;
   screenshots and raw output stay local, see `qa/.gitignore`).
6. Update `qa/state.json` (`last_tested`, `round`).

## Guards

- A bug still open after 3 fix attempts goes to Delmar rather than another try.
- If fixes land but no issue changes across two rounds, flag it.
