// Bundles the SDK for plain `node`: @calaba/protocol (TypeScript sources of the generated contract) and
// @bufbuild/protobuf are inlined; `ws` stays an external runtime dependency.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['ws'],
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});
