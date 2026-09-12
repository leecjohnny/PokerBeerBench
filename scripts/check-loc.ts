import { glob, readFile } from 'node:fs/promises';

const sourceLimit = 5100;
async function report(label: string, folders: string, exclude: string[] = []) {
  let total = 0;
  let count = 0;
  for await (const file of glob(`${folders}/**/*.{ts,tsx,py,sql,sh,css,html}`, {
    exclude: ['**/__pycache__/**', ...exclude],
  })) {
    count++;
    const text = await readFile(file, 'utf8');
    if (/^\s*(?:\/\/|\/\*|<!--)\s*prettier-ignore/m.test(text))
      throw new Error(`Formatting suppression is forbidden: ${file}`);
    total += text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
  }
  console.log(`${total} ${label} LOC (${count} files)`);
  if (label === 'source' && total > sourceLimit)
    throw new Error(`Source LOC exceeds ${sourceLimit}.`);
}

await report('source', '{api,src,web,db,scripts,harbor}', ['harbor/task/tests/**']);
await report('test', '{tests,harbor/task/tests}');
