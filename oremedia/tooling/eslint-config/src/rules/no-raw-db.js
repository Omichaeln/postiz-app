const RAW_CLIENT_SPECIFIERS = [
  /^@oremedia\/db\/client$/,
  /(^|\/)packages\/db\/src\/client(\.ts|\.js)?$/,
  /(^|\/)db\/src\/client(\.ts|\.js)?$/,
];

// The outbox dispatcher is platform-level code that legitimately spans tenants (section 14.2).
const ALLOWLISTED_FILES = [/packages\/modules\/operations\/src\/outbox-dispatcher\.ts$/];

export const noRawDb = {
  meta: {
    type: 'problem',
    docs: { description: 'Feature code never touches the raw Drizzle handle (spec 5.3, 5.4).' },
    schema: [],
    messages: {
      raw: 'Importing the raw database client is only allowed inside packages/db. Extend a scoped repository instead.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const normalised = filename.replace(/\\/g, '/');
    if (/\/packages\/db\//.test(normalised)) return {};
    if (ALLOWLISTED_FILES.some((re) => re.test(normalised))) return {};
    return {
      ImportDeclaration(node) {
        const source = String(node.source.value);
        if (RAW_CLIENT_SPECIFIERS.some((re) => re.test(source))) {
          context.report({ node, messageId: 'raw' });
        }
      },
    };
  },
};
