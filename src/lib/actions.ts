/**
 * Conventions for server actions in this app:
 *  - Always return `{ ok: true, ... }` or `{ ok: false, error: string }`.
 *  - Always call `requireUser()` (or `requireAdmin()`) at the top.
 *  - Always log an event via `logEvent()` for any state-changing op.
 *  - Always `revalidatePath()` after mutations.
 */

export type ActionResult<T = void> =
  | ({ ok: true } & (T extends void ? unknown : T))
  | { ok: false; error: string };

export function actionError(error: unknown): { ok: false; error: string } {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: message };
}
