import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Builds the programs once, before the tests that run them from dist/. */
export default function setup(): void {
  execFileSync('npm', ['run', 'build'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'ignore',
  });
}
