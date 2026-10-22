// Shared Playwright entry point for the UI checks.
//
// Uses playwright-core from qa/node_modules (run `npm ci` in qa/) and drives an
// installed Chrome rather than a downloaded browser build. Override with
// PW_CHANNEL (e.g. "msedge", "chromium") or PW_EXECUTABLE (a browser binary).
const { chromium } = require('playwright-core');

const launch = chromium.launch.bind(chromium);
chromium.launch = (options = {}) => {
  const target = process.env.PW_EXECUTABLE
    ? { executablePath: process.env.PW_EXECUTABLE }
    : { channel: process.env.PW_CHANNEL || 'chrome' };
  return launch({ ...target, ...options });
};

module.exports = { chromium };
