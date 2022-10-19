import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

(async function main() {
  const actionDir = dirname(fileURLToPath(import.meta.url));

  console.log(`Starting...`);
  console.log('Resolve packages...');
  execSync(`npm install --prefix=${actionDir}`);
  console.log('Packages installed');

  const run = (await import(`${actionDir}/src/main.js`)).default;
  await run();
})();
