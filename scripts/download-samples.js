#!/usr/bin/env node
// Downloads public sample call recordings into samples/ for testing.
// These are third-party recordings and are not committed to the repo.
const fs = require('fs');
const path = require('path');
const config = require('../src/core/config');

const MAGELLAN = 'https://www.magellan-solutions.com/wp-content/uploads/2014/09';
const SAMPLES = {
  'outbound_sales_call_1.mp3': `${MAGELLAN}/OUTBOUNDSAMPLE_01.mp3`,
  'outbound_sales_call_2.mp3': `${MAGELLAN}/OUTBOUNDSAMPLE_02.mp3`,
  'inbound_call_1.mp3': `${MAGELLAN}/InboundSampleRecording.mp3`,
  'inbound_call_2.mp3': `${MAGELLAN}/SampleInboundCall2.mp3`,
  'helpline_call.mp3': 'https://archive.org/download/CallCenterAudio/Warid_help_line.mp3',
};

(async () => {
  const dir = path.join(config.root, 'samples');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, url] of Object.entries(SAMPLES)) {
    const dest = path.join(dir, name);
    if (fs.existsSync(dest)) {
      console.log(`✓ ${name} (already present)`);
      continue;
    }
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.error(`✗ ${name}: ${res.status}`);
      continue;
    }
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`✓ ${name}`);
  }
})();
