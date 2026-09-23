// Bounded-context ownership (spec 4.2). A module imports only the schema file(s) it owns.
const OWNERSHIP = {
  access: ['access'],
  brand: ['brand'],
  assets: ['assets'],
  creative: ['creative'],
  content: ['content'],
  review: ['review'],
  skills: ['skills'],
  agents: ['agents'],
  publishing: ['publishing'],
  measurement: ['measurement'],
  intelligence: ['intelligence'],
  experiments: ['experiments'],
  community: ['community'],
  billing: ['billing'],
  operations: ['operations'],
};

export const moduleTableOwnership = {
  meta: {
    type: 'problem',
    docs: { description: 'Modules never reach into another module’s tables (spec 4.2).' },
    schema: [],
    messages: {
      foreign:
        'Module "{{module}}" imports schema "{{schema}}" owned by another module. Call that module’s public service interface instead.',
    },
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename()).replace(/\\/g, '/');
    const m = filename.match(/\/packages\/modules\/([a-z-]+)\/src\//);
    if (!m) return {};
    if (/\.(test|spec)\.ts$/.test(filename)) return {}; // test seeds insert fixture rows directly
    const moduleName = m[1];
    const owned = OWNERSHIP[moduleName] ?? [];
    return {
      ImportDeclaration(node) {
        const source = String(node.source.value);
        const sm = source.match(/^@oremedia\/db\/schema\/([a-z_-]+)$/);
        if (!sm) return;
        const schemaName = sm[1];
        if (schemaName.startsWith('_')) return;
        if (!owned.includes(schemaName)) {
          context.report({ node, messageId: 'foreign', data: { module: moduleName, schema: schemaName } });
        }
      },
    };
  },
};
