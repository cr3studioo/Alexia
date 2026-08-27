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
      name: 'protocol-stands-alone',
      comment:
        'The contract is Apache-2.0 and describes the wire, not the host. One import of ' +
        'core and it stops being a document a plugin author can build against, and starts ' +
        'being a view of our implementation.',
      severity: 'error',
      from: { path: '^packages/protocol/' },
      to: { path: '^packages/(?!protocol/)' },
    },
    {
      name: 'contract-never-imports-core',
      comment:
        'Everything a plugin author installs is Apache-2.0 and depends only on the ' +
        'contract. Reaching into AGPL core would relicense their plugin by accident.',
      severity: 'error',
      from: { path: '^packages/(sdk|conformance|create-plugin)/' },
      to: { path: '^packages/core/' },
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
