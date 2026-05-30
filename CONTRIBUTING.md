# Contributing

Thanks for helping! The most useful contributions are real-world `jest.config` files that the converter handles incorrectly.

## Reporting a broken config

[Open an issue](https://github.com/JustShift/jest-to-vitest/issues/new?template=broken-config.yml) with:

1. The exact `jest.config.{js,ts,cjs,mjs}` source
2. The actual output the converter produced
3. The output you expected

Reproduction-ready issues get fixed fastest.

## Local development

```bash
npm install
npm test          # one-shot
npm run test:watch
npm run build
```

## Adding a fixture

Tests live in `tests/converter.test.ts`. Each input shape has a focused `it(...)` block. To add a regression test:

1. Add a new `it('handles ...')` with the input as a string and assertions on `result.output` / `result.warnings`.
2. Run `npm test` and confirm it fails.
3. Edit `src/converter.ts` to make it pass.

## Submitting a PR

- One change per PR
- Include the test
- Update `CHANGELOG.md` under an `## Unreleased` section
- The CI must pass (lint + tests)

## Releases

Maintainers only:

```bash
# bump version, tag, push
npm version <patch|minor|major>
git push --follow-tags
# the release workflow publishes to npm on tag push
```
