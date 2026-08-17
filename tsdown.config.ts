import type { UserConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-vision-subagent'

const config: UserConfig = {
  name: PACKAGE_NAME + '/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  deps: { neverBundle: ['react'] },
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
