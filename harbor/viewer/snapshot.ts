import { Sandbox } from '@vercel/sandbox';
import { readFile } from 'node:fs/promises';

const sandbox = await Sandbox.create({ runtime: 'python3.13', persistent: false });
try {
  await sandbox.fs.writeFile('viewer.py', await readFile(new URL('./server.py', import.meta.url)));
  const install = await sandbox.runCommand('uv', ['sync', '--script', 'viewer.py']);
  if (install.exitCode) throw new Error('Harbor installation failed.');
  console.log((await sandbox.snapshot({ expiration: 0 })).snapshotId);
} finally {
  await sandbox.stop();
}
