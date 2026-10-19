import { he } from '../../components/car-advisor/content/he';
import type { TicketStatus } from '../../components/car-advisor/contract/types';

export const STATUS_LABEL: Record<TicketStatus, string> = {
  waiting: he.rep.status.waiting,
  'needs-info': he.rep.status.needsInfo,
  answered: he.rep.status.answered,
};

/** The screenshot uses one wording; urgency is shown by the badge tone (red when overdue). */
export const SLA_LABEL = he.rep.sla.remaining;
