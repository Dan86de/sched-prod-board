// Copies app/ to dist/ and stamps the committed build sha into the page (R6).
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--', 'app') && !process.argv.includes('--dirty')) {
  console.error('app/ has uncommitted changes: commit first, so the sha names what is deployed.');
  process.exit(1);
}
const sha = git('rev-parse', 'HEAD');

rmSync('dist', { recursive: true, force: true });
cpSync('app', 'dist', { recursive: true });
const index = 'dist/index.html';
writeFileSync(index, readFileSync(index, 'utf8').replaceAll('__BUILD_SHA__', sha));
console.log(`dist/ built at ${sha}`);
