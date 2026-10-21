/**
 * Style check for a whole conversation: two consecutive bot messages must not open with the same acknowledgment
 * ("מעולה, תודה" ... "מעולה, תודה"). The acknowledgment words are looked for in the first three words of a message.
 */
const ACK_WORDS = new Set(['מעולה', 'תודה', 'בכיף', 'בסדר', 'סבבה', 'נהדר', 'אחלה', 'יופי', 'מצוין', 'רשמתי', 'הבנתי', 'ברור', 'בשמחה', 'כמובן']);

export function openingAcks(text: string): string[] {
  const words = text.trim().split(/[\s,.!?:;]+/u).filter(Boolean).slice(0, 3);
  return words.filter((w) => ACK_WORDS.has(w));
}

/** The pairs of consecutive bot messages that open with the same acknowledgment word (empty when the conversation reads naturally). */
export function repeatedOpenings(botTexts: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < botTexts.length; i++) {
    const prev = openingAcks(botTexts[i - 1]!);
    const same = openingAcks(botTexts[i]!).filter((w) => prev.includes(w));
    if (same.length > 0) out.push(`messages ${i} and ${i + 1} both open with "${same.join(' ')}"`);
  }
  return out;
}
