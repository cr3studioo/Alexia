/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'core-names-no-plugin',
      comment:
        'Rule 1 of the invariant: core may never know a plugin exists. The grep in ' +
        'packages/core/test/invariants catches the string; this catches the import edge.',
      severity: 'error',
      from: { path: '^packages/core' },
      to: { path: '^plugins/' },
    },
    {
      name: 'no-circular',
      comment: 'A cycle is a boundary that was not drawn.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '(^|/)dist/' },
  },
}
