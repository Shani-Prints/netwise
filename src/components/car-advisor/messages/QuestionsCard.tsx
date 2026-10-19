import { he } from '../content/he';
import type { ApiEmployeeQuestion } from '../contract/types';
import { Card } from '../ui/Card';
import styles from './api.module.css';

/** The questions the server sent to the representative and that are still open. Plain text only. */
export function QuestionsCard({ questions }: { questions: ApiEmployeeQuestion[] }) {
  if (questions.length === 0) return null;
  return (
    <Card tone="tint">
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>{he.api.questions.title}</h2>
        <p className={styles.small}>{he.api.questions.intro}</p>
        <ul className={styles.bullets}>
          {questions.map((question) => (
            <li key={question.id}>
              {question.label} · {he.api.questions.sent}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
