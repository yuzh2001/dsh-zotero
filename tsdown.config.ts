/**
 * tsdown build for dsa-zotero-sidebar:
 *
 * - `lib/index.js` — the host half (ESM Node), importing `src/index.ts` which
 *   registers the /zotero/api route and runs zotero-cli.
 * - `lib/client.js` — the browser client bundle (CJS closure factory) from
 *   `src/client/index.tsx`, registering with the package-name id
 *   `dsa-zotero-sidebar` (the client-modules compose keys on the package
 *   name, matching `dsh.profile.bundles`).
 *
 * The client bundle replicates the official DSH client-bundle preset:
 * - `externals` resolve through the loader module table at runtime (react,
 *   cordis, ...);
 * - everything else (including @pierre/trees and its preact/theming deps) is
 *   inlined via `noExternal`;
 * - the purity gate rejects any other @deepseek-ai value import;
 * - CSS Modules compile to hashed class maps and inject <style data-plugin>.
 *
 * Types ship from lib/types (tsc -p tsconfig.build.json), not from tsdown.
 */
import type { UserConfig } from 'tsdown'

/** Module specifiers the web shell shares into the frozen module table (the official PLATFORM_MODULES list, plus the runtime/client exemption). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Wire/type layers a client bundle may inline (mirror of the official INLINE_SAFE list). */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/

/** Client bundle for the official profile channel: id = package name. */
const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    // External wins for module-table entries; @pierre/trees + deps inline.
    alwaysBundle: ['@pierre/trees', 'preact', 'preact-render-to-string', '@pierre/theming'],
    onlyBundle: false,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  inputOptions: {
    resolve: {
      conditionNames: ['browser', 'import', 'require', 'default'],
    },
  },
  plugins: [purityGatePlugin()],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: "dsa-zotero-sidebar", factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

/** The host-half entry. */
const hostEntry: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  fixedExtension: false,
  clean: false,
}

/** A rolldown plugin as tsdown's config accepts it. */
type BuildPlugin = NonNullable<UserConfig['plugins']>

/** The shared client-bundle purity gate (reject Node builtins + foreign @deepseek-ai value imports). */
function purityGatePlugin(): BuildPlugin {
  return {
    name: 'dsa-client-bundle-purity',
    resolveId(source: string) {
      if ('fs|path|child_process|os|crypto|stream|util|events|http|node:'.split('|')
        .filter(Boolean)
        .some((m) => source === m || source === `node:${m}`)) {
        throw new Error(
          `client bundle purity: Node builtin "${source}" cannot run in the browser module table — `
          + 'select the dependency browser export or add an explicit browser implementation',
        )
      }
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      if (INLINE_SAFE.test(source)) return null
      throw new Error(
        'client bundle purity: "'
        + source
        + '" is not a platform module (CLIENT_EXTERNALS) and not an inline-safe wire layer — '
        + 'cross-plugin value imports are forbidden',
      )
    },
  }
}

export default [hostEntry, clientBundle] satisfies UserConfig[]
