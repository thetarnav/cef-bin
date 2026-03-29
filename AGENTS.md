# AGENTS Guide

This file is for coding agents working in this repository.
It documents practical conventions observed in the codebase.

## Import and Module Conventions

- Use ESM imports only.
- Prefer namespace imports for local modules:
  `import * as cef from './cef.ts'`
- Use explicit `.ts` extension in local imports
- Node builtins are imported as `node:*` modules
- Avoid default exports; project uses named exports

## Formatting and File Style

- Indentation: 4 spaces
- Keep files ASCII unless non-ASCII is clearly needed
- Prefer `let` for variables, use `const` only for static constants
- Single quite strings
- No semicolons
- No spacing around brackets, parens and curly braces (`{a = b, c = d}`)
- Match quote style of the file being edited; do not mass-convert quotes
- Preserve existing section divider comments (`/*--------------------------------------------------------------*`)
- Avoid broad reformatting of untouched code
- Keep line wrapping and alignment consistent with surrounding code
- Avoid trailing whitespace
- Use blank lines to separate logical sections of code
- Follow editor formating rules in @.editorconfig.

## Comments and Documentation

- Keep comments concise and focused
- Use inline comments to explain non-obvious logic
- Add comments to if/else branches to clarify the condition or the intent of the branch
- Include small examples/code snippets to graphically illustrate concepts

## Naming Conventions

- Functions/variables: `snake_case` (for example `token_next`, `parse_src`)
- Types/classes: `Ada_Case` with underscores (for example `Token_Kind`, `Node_World`)
- Constants: `SCREAMING_SNAKE_CASE` (`TOKEN_EOF`, `MAX_ID`)
- Exported aliases may coexist for compatibility; do not remove them casually

## Change Management for Agents

- Make minimal diffs; avoid unrelated cleanup
- If touching complex logic, add or update tests in the same change
- Preserve backward-compatible exported APIs unless explicitly changing them
- When behavior changes, update `README.md` examples if needed

## Quick Pre-Handoff Checklist

- `bun run latest` works
- `bun run download --platform=linux64` works
- `bun run workflow --platform=linux64` works
- no accidental dependency additions
- no unrelated file reformatting
- docs (`AGENTS.md`, `README.md`) updated if API changed
