import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApiComparison, ApiEmployeeQuestion } from '../components/car-advisor/contract/apiTypes';
import { ComparisonPanel } from '../components/car-advisor/messages/ComparisonPanel';
import { QuestionsCard } from '../components/car-advisor/messages/QuestionsCard';
import type { EmployeeStateResponse } from '../lib/service';

/**
 * Renders the employee panels (the comparison and the open-questions card) from the server state, exactly as the UI does, so
 * the invariant checker can look for empty cards and empty headings in the real markup. Loads React components with CSS
 * modules: usable under vitest (vite), not under plain tsx.
 */
export function renderPanels(state: EmployeeStateResponse): string[] {
  const out: string[] = [];
  if (state.comparison) out.push(renderToStaticMarkup(createElement(ComparisonPanel, { comparison: state.comparison as unknown as ApiComparison })));
  out.push(renderToStaticMarkup(createElement(QuestionsCard, { questions: state.questions.filter((q) => q.status === 'open') as unknown as ApiEmployeeQuestion[] })));
  return out;
}
