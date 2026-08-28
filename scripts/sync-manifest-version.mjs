import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('Usage: sync-manifest-version.mjs <version>');
  process.exit(1);
}

const path = new URL('../manifest.json', import.meta.url);
const raw = readFileSync(path, 'utf8');

const versionLine = /^(\s*"version":\s*")[^"]*(")/m;
if (!versionLine.test(raw)) {
  console.error('Could not find a top-level "version" field in manifest.json');
  process.exit(1);
}

writeFileSync(path, raw.replace(versionLine, `$1${version}$2`));
