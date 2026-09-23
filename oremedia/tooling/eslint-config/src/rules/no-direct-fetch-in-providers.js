export const noDirectFetchInProviders = {
  meta: {
    type: 'problem',
    docs: { description: 'Provider adapters perform network I/O only through ProviderIO (spec 14.5).' },
    schema: [],
    messages: {
      fetch:
        'Adapters never call {{name}} directly. Use ProviderIO.request so timeouts, SSRF protection and send tracking apply.',
    },
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename()).replace(/\\/g, '/');
    if (!/\/packages\/providers\/src\//.test(filename)) return {};
    // io.ts and ssrf.ts implement the dispatcher itself.
    if (/\/packages\/providers\/src\/(io|ssrf)(\.test)?\.ts$/.test(filename)) return {};
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === 'Identifier' && callee.name === 'fetch') {
          context.report({ node, messageId: 'fetch', data: { name: 'fetch' } });
        }
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          ['axios', 'undici', 'got'].includes(callee.object.name)
        ) {
          context.report({ node, messageId: 'fetch', data: { name: callee.object.name } });
        }
      },
      ImportDeclaration(node) {
        const source = String(node.source.value);
        if (['axios', 'undici', 'got', 'node-fetch'].includes(source)) {
          context.report({ node, messageId: 'fetch', data: { name: source } });
        }
      },
    };
  },
};
