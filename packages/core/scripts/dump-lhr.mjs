// Dev helper: save a raw Lighthouse result for inspecting/test fixtures.
//   node packages/core/scripts/dump-lhr.mjs <url> <out.json> [desktop]
import fs from 'node:fs';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse, { desktopConfig } from 'lighthouse';

const [url, out, preset] = process.argv.slice(2);
const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new'] });
try {
  const result = await lighthouse(
    url,
    { port: chrome.port, logLevel: 'error', onlyCategories: ['performance'] },
    preset === 'desktop' ? desktopConfig : undefined,
  );
  fs.writeFileSync(out, JSON.stringify(result.lhr, null, 2));
  console.log(`wrote ${out}`);
} finally {
  chrome.kill();
}
