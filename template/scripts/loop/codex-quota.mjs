const MAX_RESUME_LENGTH = 80;
const QUOTA_PREFIX = /^You['’]ve hit your usage limit\.(?:\s|$)/u;
const RESUME_DATE = /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(?:st|nd|rd|th), \d{4} \d{1,2}:\d{2} (?:AM|PM)$/u;

/** Seuls les événements fournisseur caractérisés prouvent un quota ; la date reste sans fuseau. */
export function quotaFailure(message) {
  if (!["error", "turn.failed"].includes(message.type)) return null;
  const diagnostic = message.error?.message || message.message;
  if (typeof diagnostic !== "string" || !QUOTA_PREFIX.test(diagnostic)) return null;
  const announced = /or try again at ([^\r\n]+)\.$/u.exec(diagnostic)?.[1];
  const reprise = announced && announced.length <= MAX_RESUME_LENGTH && RESUME_DATE.test(announced) ? announced : null;
  return { code: "CODEX_QUOTA_EXHAUSTED", reprise };
}

export function quotaDiagnostic(reprise) {
  const resume = reprise === null ? "Reprise non fournie." : `Reprise annoncée : ${reprise}.`;
  return `Quota Codex épuisé. ${resume}`;
}
