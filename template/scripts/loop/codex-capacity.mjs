import { setTimeout as sleep } from "node:timers/promises";

// Borne technique : trois reprises, sans supposer le temps de retour du fournisseur.
const CAPACITY_RETRY_DELAYS_MS = Object.freeze([15000, 30000, 60000]);
const CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";

export function capacityFailure(message) {
  if (!["error", "turn.failed"].includes(message.type)) return null;
  const diagnostic = message.error?.message || message.message;
  return diagnostic === CAPACITY_MESSAGE ? { code: "CODEX_CAPACITY", diagnostic } : null;
}

const deadlineFailure = () => ({ code: 1, problem: "Codex : délai maximal dépassé.", resumeImpossible: false });

/** Une invocation logique et ses reprises partagent une échéance ; invoke attend la fermeture de son enfant. */
export async function retryCapacity(invoke, {
  timeoutMs, session = null, now = Date.now, wait = sleep, onRetry = () => {},
}) {
  const deadline = now() + timeoutMs;
  for (let retry = 0; ; retry++) {
    const remaining = deadline - now();
    if (remaining <= 0) return deadlineFailure();
    const result = await invoke({ session, timeoutMs: remaining, retry });
    if (result.quota) return result;
    if (now() >= deadline) return deadlineFailure();
    if (!result.capacity || result.code === 0) return result;
    const delay = CAPACITY_RETRY_DELAYS_MS[retry];
    if (delay === undefined) return { ...result, exhausted: "limit", resumeImpossible: false };
    if (deadline - now() <= delay) return { ...deadlineFailure(), exhausted: "deadline" };
    session = result.session;
    onRetry({ result, retry: retry + 1, delay });
    await wait(delay);
  }
}
