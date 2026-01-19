# Changelog

## [1.3.1] - 2026-01-19

### Changed

- Upgraded to Zod v4 and adjusted schema generation for compatibility

### Fixed

- **`keep_thinking=true` now works without debug mode** - Fixed Claude multi-turn conversations failing with "Failed to process error response" when `keep_thinking=true` after tool calls, unless debug mode was enabled
  - Root cause: `filterContentArray` trusted any signature >= 50 chars for last assistant messages, but Claude returns its own signatures that Antigravity doesn't recognize
  - Fix: Now verifies signatures against our cache via `isOurCachedSignature()` before passing through. Foreign/missing signatures get replaced with `SKIP_THOUGHT_SIGNATURE` sentinel
  - Why debug worked: Debug mode injects synthetic thinking with no signature, triggering sentinel injection correctly

- **Fixed tool calls failing for tools with no parameters** - Tools like `hive_plan_read`, `hive_status`, and `hive_feature_list` that have no required parameters would fail with Zod validation error `state.input: expected record, received undefined`
  - Root cause: When Claude calls a tool with no parameters, it returns `functionCall` without an `args` field. The response transformation only processed parts where `functionCall.args` was defined, leaving `args` as `undefined`
  - Fix: Changed condition to handle all `functionCall` parts, defaulting `args` to `{}` when missing, ensuring opencode's `state.input` always receives a valid record

- **Auth headers aligned with official Gemini CLI** - Updated authentication headers to match the official Antigravity/Gemini CLI behavior, reducing "account ineligible" errors and potential bans ([#178](https://github.com/NoeFabris/opencode-antigravity-auth/issues/178))
  - `GEMINI_CLI_HEADERS["User-Agent"]`: `9.15.1` → `10.3.0`
  - `GEMINI_CLI_HEADERS["X-Goog-Api-Client"]`: `gl-node/22.17.0` → `gl-node/22.18.0`
  - `ANTIGRAVITY_HEADERS["User-Agent"]`: Updated to full Chrome/Electron user agent string
  - Token exchange now includes `Accept`, `Accept-Encoding`, `User-Agent`, `X-Goog-Api-Client` headers
  - Userinfo fetch now includes `User-Agent`, `X-Goog-Api-Client` headers
  - `fetchProjectID` now uses centralized constants instead of hardcoded strings

- **`quiet_mode` now properly suppresses all toast notifications** - Fixed `quiet_mode: true` in `antigravity.json` not suppressing "Status dialog dismissed" and other toast notifications ([#207](https://github.com/NoeFabris/opencode-antigravity-auth/issues/207))
  - Root cause: The `showToast` helper function didn't check `quietMode`, and only some call sites had manual `!quietMode &&` guards
  - Fix: Moved `quietMode` check inside `showToast` helper so all toasts are automatically suppressed when `quiet_mode: true`

## [1.3.0] - Previous Release

See [releases](https://github.com/NoeFabris/opencode-antigravity-auth/releases) for previous versions.
