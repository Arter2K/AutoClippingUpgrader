# Repository Guidelines

## Project Structure & Module Organization

- `src/main/`: Electron lifecycle, editor persistence, FFmpeg engine, and publishing services.
- `src/preload/`: narrow, typed IPC bridge; keep filesystem access and credentials in main.
- `src/renderer/`: React features, reusable components, Canvas preview, and Zustand stores.
- `src/shared/`: Zod template schemas, IPC contracts, geometry, and shared effect calculations.
- `tests/`: Node tests; `tests/integration/` exercises FFmpeg; `tests/electron/` exercises native workflows.
- `templates/`: example JSON compositions. `build/`: icons and licensing notices. `docs/`: architecture and usage guides.

Outputs: ignored `dist/`, `dist-electron/`, `out/`, `release/`. Tools/models: `.tools/`, `build/ai-assets/`.

## Build, Test, and Development Commands

Install dependencies using Node.js ≥22.12 and npm or pnpm.

- `npm run prepare:ai`: download/cache official model assets for offline operation.
- `npm run dev`: start Electron with Vite development tooling.
- `npm run build`: typecheck and bundle main, preload, and renderer.
- `npm test`: run root `*.test.ts` files through `tsx` and Node’s test runner.
- `npm run test:integration`: render actual FFmpeg fixtures.
- `npm run test:electron`, `test:editor`, `test:effects`: verify IPC/storage, editor workflows, and local AI respectively.
- `npm run dist:win`: produce Windows installer/portable EXEs; `test:package` verifies packaged workflows.

Windows alternative: `.\scripts\run.ps1 <script>` locates the available package manager and local FFmpeg tools. Configure `FFMPEG_PATH` and `FFPROBE_PATH` when needed.

## Coding Style & Naming Conventions

Use two-space indentation, single quotes, and semicolons. TypeScript enables strict checking and unchecked-index protection. Use PascalCase components, camelCase functions, and kebab-case utility modules. Preserve JSON field names. No ESLint or Prettier configuration exists; avoid unrelated formatting changes.

## Testing Guidelines

Write automated tests for every new function and feature, and regression tests for fixes. After every task, run the test suite (`npm test` or `.\scripts\run.ps1 test`) and any integration/native checks relevant to the changed behavior. Record the commands, results, and any checks that could not run in `docs/development-log.md`; never describe an unexecuted check as passed.

Name Node tests `*.test.ts` and native smoke scripts `*-smoke.cjs`. Add regression coverage for changed behavior, especially schema compatibility, generated filters, alpha handling, and IPC validation. Run the relevant native/render checks after affected changes. No numeric coverage threshold is configured; report skipped hardware checks and distinguish mocked OAuth tests from live account verification.

## Functional Documentation and Task Log

Maintain `docs/development-log.md` after every task. Record the date, purpose, important functionality added or changed, affected files, verification results, and known limitations or follow-up work. Keep a concise overview of the program's main capabilities there and update the detailed guides in `docs/` when behavior changes. Describe what the program actually does and distinguish implemented behavior from planned or unverified behavior. Never put credentials, tokens, or private media contents in logs.

## Commit & Pull Request Guidelines

The default branch is `main`. Use imperative subjects, such as `Add chromakey alpha regression test`. PRs should describe behavior changes, validation results, relevant issues, and screenshots for UI changes. Document schema migrations and new runtime assets.

## Security & Configuration

Keep secrets out of commits and EXEs; use `.env.example` as documentation. Preserve sandboxing, sender validation, registered media URLs, and encrypted credential storage. Keep preview/export calculations shared and retain legacy template compatibility. Update third-party notices when changing bundled libraries, FFmpeg, or AI assets.
