import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Records every npm package whose modules end up in a bundle (renderer, preload, main,
 * workers, web), so THIRD-PARTY-NOTICES.txt lists exactly what we ship — most runtime
 * libraries are devDependencies here because they are bundled, so `pnpm licenses --prod`
 * alone would miss them. Output: a JSON array of package root directories (merged across
 * the builds of one run). Consumed by scripts/third-party-notices.mjs.
 */
export function bundledPackages(outFile: string): Plugin {
  return {
    name: 'calaba:bundled-packages',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const roots = new Set<string>(existsSync(outFile) ? (JSON.parse(readFileSync(outFile, 'utf8')) as string[]) : []);
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) {
          const root = packageRoot(id);
          if (root) roots.add(root);
        }
      }
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, JSON.stringify([...roots].sort(), null, 2));
    },
  };
}

/** `/x/node_modules/.pnpm/a@1/node_modules/@scope/pkg/dist/i.js` → `/x/…/node_modules/@scope/pkg`. */
export function packageRoot(id: string): string | null {
  const clean = id.replace(/^\0/, '').split('?')[0] ?? '';
  const i = clean.lastIndexOf('/node_modules/');
  if (i < 0) return null;
  const rest = clean.slice(i + '/node_modules/'.length).split('/');
  const name = rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1] ?? ''}` : rest[0];
  if (!name || name.startsWith('.')) return null;
  return `${clean.slice(0, i)}/node_modules/${name}`;
}
