#!/usr/bin/env node
// Import-time smoke check: every orchestrator module must load and the pipeline
// graph must compile. This class of failure is otherwise invisible until the
// server refuses to boot — `addNode('voice')` once collided with the `voice`
// state channel and made `npm start` die with an unhandled throw.
//
// Note: src/server.js is deliberately not required here, because importing it
// binds a port as a side effect.
//
// Run: node scripts/check-startup.js   (or `npm test`)
try {
  require('../src/graph');
  require('../src/orchestrator');
  console.log('✓ orchestrator modules load and the pipeline graph compiles');
} catch (err) {
  console.error(`✗ orchestrator failed to start:\n  ${err.message}`);
  if (process.env.PITCHLENS_VERBOSE) console.error(err.stack);
  process.exit(1);
}