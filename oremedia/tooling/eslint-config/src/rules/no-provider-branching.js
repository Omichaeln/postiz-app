// Provider keys that must never be compared against in generic code (spec 2.2, 5.4).
const PROVIDER_KEY_PATTERN =
  /^(linkedin(_page)?|instagram(_business|_standalone)?|facebook(_page)?|x|twitter|tiktok(_business)?|youtube|threads|pinterest|reddit|bluesky|mastodon|discord|slack|telegram)$/i;

export const noProviderBranching = {
  meta: {
    type: 'problem',
    docs: { description: 'No provider-specific branches in generic code (spec 2.2).' },
    schema: [],
    messages: {
      branch:
        'Comparison against provider key "{{key}}" outside packages/providers. Move the behaviour into the provider adapter or its capability definition.',
    },
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename()).replace(/\\/g, '/');
    if (/\/packages\/providers\//.test(filename)) return {};
    if (/\/tooling\/|\.test\.ts$|\.spec\.ts$/.test(filename)) return {};
    const check = (node, literal) => {
      if (
        literal &&
        literal.type === 'Literal' &&
        typeof literal.value === 'string' &&
        PROVIDER_KEY_PATTERN.test(literal.value)
      ) {
        context.report({ node, messageId: 'branch', data: { key: literal.value } });
      }
    };
    return {
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        check(node, node.left);
        check(node, node.right);
      },
      SwitchCase(node) {
        check(node, node.test);
      },
    };
  },
};
