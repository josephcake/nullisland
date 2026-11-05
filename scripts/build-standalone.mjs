/**
 * Inlines the library bundle, CSS and demo script into one HTML file that can
 * be opened directly from disk (no server, no module imports).
 */
import {readFileSync, writeFileSync} from 'node:fs';

const bundle = readFileSync('demo/nullisland.js', 'utf8').replace(/export \{[\s\S]*?\};\s*$/, '');
const css = readFileSync('demo/styles.css', 'utf8');
let demo = readFileSync('demo/demo.js', 'utf8');

demo = demo.replace("const LIBRARY = './nullisland.js';", '');
demo = demo.replace(
  /async function loadLibrary\(\) \{[\s\S]*?\n\}/,
  'async function loadLibrary() { return window.__nullislandClass; }',
);
demo = demo.replace('const NullIsland = await loadLibrary();', 'const NullIsland = window.__nullislandClass;');

const script = `${bundle}
window.__nullislandClass = NullIsland;
{
${demo}
}`;

const html = readFileSync('demo/index.html', 'utf8')
  .replace('<link rel="stylesheet" href="styles.css" />', `<style>\n${css}\n</style>`)
  .replace(
    '<script type="module" src="demo.js?v=2"></script>',
    `<script type="module">\n${script}\n</script>`,
  );

writeFileSync('demo/standalone.html', html);
console.log('wrote demo/standalone.html', (html.length / 1024).toFixed(0) + ' kB');
