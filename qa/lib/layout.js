// Where things live in a snapshot. Commits up to the shared-engine move keep
// every file at the top level; later ones split them into engine/ and web/.
// The harness serves the snapshot root either way and opens pagePath().
const fs = require('fs');
const path = require('path');

const split = (dir) => fs.existsSync(path.join(dir, 'engine'));

/** Path of an engine module (blackjack.js, counting.js, ...) in a snapshot. */
const engineFile = (dir, file) => path.join(dir, split(dir) ? 'engine' : '', file);

/** URL path of the game page, relative to the snapshot root. */
const pagePath = (dir) => (split(dir) ? '/web/index.html' : '/index.html');

/** Whether a snapshot has a module, wherever it lives. */
const hasFile = (dir, file) => ['', 'engine', 'web'].some((sub) => fs.existsSync(path.join(dir, sub, file)));

module.exports = { engineFile, pagePath, hasFile };
