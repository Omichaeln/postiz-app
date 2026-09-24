# Malicious skill package fixtures (spec 18: skill package → runtime)

Each file is one Agent Skills package that tries to escape the declarative-only rule of spec 10.1: path traversal,
absolute and drive paths, symlink entries, a `scripts/` directory, executable extensions, shebangs, a manifest
`scripts` field, links that fetch on render or leave the package, duplicate paths, undecodable text and an oversized
package.

- `files` are added to a valid base package (`SKILL.md` + `manifest.json`); a `SKILL.md` entry replaces the base one.
  `contentBase64` is raw bytes decoded the way a lossy importer would (UTF-8 with replacement); `repeat` generates
  `bytes` of `text`.
- `manifestPatch` is merged into the base manifest.
- `expected` is the exact set of `ValidationFailedError` details the import must refuse with.

`packages/modules/skills/src/package-format.test.ts` parses every fixture; `skills.integration.test.ts` imports every
fixture through `skillsService.import` against MySQL and asserts that nothing was written.
