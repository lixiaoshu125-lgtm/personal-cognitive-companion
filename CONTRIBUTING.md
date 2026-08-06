# Contributing

Contributions are welcome. Please keep changes small, testable, and explicit about privacy impact.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Ground rules

- Add a failing test before changing behavior.
- Never use real private notes, API keys, conversation exports, or cognitive-model data as fixtures.
- Source notes are read-only. Plugin-managed writes must stay inside the configured system directory or Obsidian plugin data.
- Do not log prompts, note bodies, model responses, or credentials.
- Distinguish user-confirmed viewpoints from AI inference and ideas that still need verification.
- Describe real limitations honestly in user-facing documentation.

Before opening a pull request, run the full test suite, typecheck, and production build.
