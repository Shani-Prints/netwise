import { sameOption } from '../../lib/optionRef';
import type { DisplayMessage } from './chatStore';
import type { ApiCarChoices, ApiComparison } from './contract/types';

/**
 * The order of everything in the conversation. A comparison stays right after the bot message of the turn that produced it, and the
 * chat continues below it: result bubble, comparison, later messages, then the car buttons. Only the latest comparison is expanded.
 * The "live comparison at the end" exists only for a comparison without any snapshot in the timeline (an old conversation, or a car
 * picked through the API without a chat turn): never for a turn that just produced a result.
 */
export type TimelineItem =
  | { kind: 'message'; message: DisplayMessage }
  | { kind: 'comparison'; messageId: string; comparison: ApiComparison; latest: boolean }
  | { kind: 'carChoices'; choices: ApiCarChoices }
  | { kind: 'liveComparison'; comparison: ApiComparison };

export interface TimelineInput {
  messages: DisplayMessage[];
  comparisons: { messageId: string; comparison: ApiComparison }[];
  comparison: ApiComparison | null;
  carChoices: ApiCarChoices | null;
}

export function buildTimeline({ messages, comparisons, comparison, carChoices }: TimelineInput): TimelineItem[] {
  const ids = new Set(messages.map((m) => m.id));
  const anchored = comparisons.filter((c) => ids.has(c.messageId));
  const lastEntry = anchored[anchored.length - 1];
  const latestInTimeline = lastEntry !== undefined && (comparison === null || sameOption(lastEntry.comparison.alternativeRef, comparison.alternativeRef));
  const items: TimelineItem[] = [];
  for (const message of messages) {
    items.push({ kind: 'message', message });
    for (const entry of anchored.filter((c) => c.messageId === message.id)) {
      items.push({ kind: 'comparison', messageId: entry.messageId, comparison: entry.comparison, latest: entry === lastEntry && latestInTimeline });
    }
  }
  if (carChoices) items.push({ kind: 'carChoices', choices: carChoices });
  if (comparison && !latestInTimeline) items.push({ kind: 'liveComparison', comparison });
  return items;
}
