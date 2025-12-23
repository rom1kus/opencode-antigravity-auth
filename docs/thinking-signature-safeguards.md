# Thinking Signature Safeguards

## Problem
Switching from non-Claude providers to Antigravity Claude can carry foreign thinking signatures. Claude rejects those with "Invalid signature in thinking block." The safeguards below keep only signatures minted by our Antigravity session.

## Core Behaviors
1. **Signature gate**
   - Thinking/reasoning blocks are kept only when the signature matches the cached signature for the same text.
   - If a block is missing a signature but the text exists in cache, the signature is restored before sending.
   - Everything else is dropped to avoid invalid signature errors.
2. **Deep filtering**
   - The payload is walked recursively and any nested `messages[]` or `contents[]` arrays are filtered.
   - This prevents foreign signatures hidden in `extra_body` or nested `request` objects from bypassing validation.
3. **Scoped cache key**
   - Cached signatures are scoped by `sessionId + model + projectKey + conversationKey`.
   - Project key prevents cross-project signature contamination when switching between projects.
   - The conversation key uses explicit IDs when available (conversationId/threadId/etc.).
   - If no IDs exist, a stable hash from system + user text is used as a fallback seed.
4. **Tool block preservation**
   - Tool blocks (tool_use/tool_result, nested tool formats, functionCall/functionResponse) are always preserved.
   - This prevents breaking tool call/result pairing while filtering thinking blocks.

## Implementation Notes
- Filtering only touches thinking/reasoning blocks; non-thinking content is left unchanged.
- Signature matching is based on the exact thinking text used to generate the signature.
- Cache behavior (TTL, max entries) is defined in `src/plugin/cache.ts`.

## Related Files
- `src/plugin/request-helpers.ts`
- `src/plugin/request.ts`
- `src/plugin/cache.ts`
