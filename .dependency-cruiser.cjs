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
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: ['.ts'] },
  },
};
