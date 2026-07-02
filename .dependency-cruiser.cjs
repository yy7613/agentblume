// レイヤ依存ルールの機械的強制（docs/05-dependency-graph.md / ADR-0001）
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-no-application',
      comment: 'domain層はapplication層をimportしてはならない（依存は内向き）',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { path: '^src/application' },
    },
    {
      name: 'domain-no-adapters',
      comment: 'domain層はadapters層をimportしてはならない',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { path: '^src/adapters' },
    },
    {
      name: 'application-no-adapters',
      comment: 'application層はadapter実装ではなくPort(interface)に依存する',
      severity: 'error',
      from: { path: '^src/application' },
      to: { path: '^src/adapters' },
    },
    {
      name: 'no-circular',
      comment: '循環依存を禁止する',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'only-root-imports-composition',
      comment: 'composition(組み立て)をimportできるのはエントリポイント(demo等のsrc直下)だけ',
      severity: 'error',
      from: { path: '^src/(domain|application|adapters)' },
      to: { path: '^src/composition' },
    },
    {
      name: 'entrypoints-use-composition-not-adapters',
      comment: 'エントリポイント(src直下)はadapters実装を直接importせずcompositionを経由する',
      severity: 'error',
      from: { path: '^src/[^/]+\\.ts$' },
      to: { path: '^src/adapters' },
    },
    {
      name: 'inner-layers-no-api',
      comment: 'api(駆動アダプター)をimportできるのはエントリポイントだけ',
      severity: 'error',
      from: { path: '^src/(domain|application|adapters|composition)' },
      to: { path: '^src/api' },
    },
    {
      name: 'api-production-no-adapters-composition',
      comment: 'apiの本体はuse case注入で受け、adapters/compositionを直接importしない（テストは配線のためcomposition可）',
      severity: 'error',
      from: { path: '^src/api', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(adapters|composition)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: ['.ts'] },
  },
};
