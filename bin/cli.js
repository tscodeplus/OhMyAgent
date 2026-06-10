#!/usr/bin/env node
import('../dist/src/cli/index.js').catch((err) => {
  console.error('Failed to start ohmyagent CLI:', err.message);
  process.exit(1);
});
