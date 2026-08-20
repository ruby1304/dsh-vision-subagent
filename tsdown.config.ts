import type { UserConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-vision-subagent'
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|file-reference|session|llm|tools|brand)(\/|$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

const config: UserConfig = {
  name: PACKAGE_NAME + '/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  deps: {
    neverBundle: (specifier: string) => CLIENT_EXTERNALS.includes(specifier),
    alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.includes(specifier),
  },
  plugins: [{
    name: 'dsh-vision-subagent-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      if (INLINE_SAFE.test(source) || VENDORED_LIBRARY.test(source) || GENERATED_REMOTE.test(source)) return null
      throw new Error(`client bundle purity: undeclared DSH value import ${JSON.stringify(source)}`)
    },
  }],
  dts: false,
  sourcemap: false,
  clean: false,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: \'' + PACKAGE_NAME + '\', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default config
