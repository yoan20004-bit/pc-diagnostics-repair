// Copies non-TypeScript assets into dist/ after tsc.
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist/server', { recursive: true });
copyFileSync('src/server/panel.html', 'dist/server/panel.html');
console.log('assets copied');
