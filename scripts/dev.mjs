import { spawn } from 'node:child_process';

const children = [];
function run(name, command, args) {
  const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  children.push(child);
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`${name} exited with code ${code}`);
  });
}

run('api', 'node', ['scripts/api-dev-server.mjs']);
run('vite', 'vite', ['--host', '0.0.0.0']);

function shutdown() {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
