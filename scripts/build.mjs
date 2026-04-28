import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, rm } from 'node:fs/promises'
import { build } from 'esbuild'

const packageJson = JSON.parse(await readFile('package.json', 'utf8'))

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  banner: {
    js: 'import { createRequire as __safeRwCreateRequire } from "node:module"; const require = __safeRwCreateRequire(import.meta.url);',
  },
  define: {
    SAFE_RW_VERSION: JSON.stringify(packageJson.version),
  },
  logLevel: 'info',
}

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })

await Promise.all([
  build({
    ...shared,
    entryPoints: ['src/server.ts'],
    outfile: 'dist/server.js',
  }),
  build({
    ...shared,
    entryPoints: ['src/safe-rw-guard.ts'],
    outfile: 'dist/safe-rw-guard.js',
  }),
])

await Promise.all([
  chmod('dist/server.js', 0o755),
  chmod('dist/safe-rw-guard.js', 0o755),
])

if (existsSync('vendor/ripgrep')) {
  await cp('vendor/ripgrep', 'dist/vendor/ripgrep', { recursive: true })
}
