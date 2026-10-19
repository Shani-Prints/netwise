import { useId } from 'react';
import { he } from '../content/he';
import type { AnswerView } from '../contract/types';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ComparisonTable } from '../ui/ComparisonTable';
import { StepList } from '../ui/StepList';
import styles from './messages.module.css';

interface AnswerCardProps {
  answer: AnswerView;
  onCompareOtherCar: () => void;
  onAnotherQuestion: () => void;
  onTalkToRep: (question: string) => void;
}

/** Screen 2: comparison table, why it comes out this way, how we calculated, next actions. */
export function AnswerCard({ answer, onCompareOtherCar, onAnotherQuestion, onTalkToRep }: AnswerCardProps) {
  const uid = useId();
  const confidenceText = he.answer.howWeCalculated.confidence[answer.howWeCalculated.confidence];
  return (
    <div className={styles.answer}>
      <p>{he.answer.intro}</p>

      <Card>
        <ComparisonTable columns={answer.columns} highlighted={answer.highlightedOption} />
      </Card>

      <section aria-labelledby={`${uid}-why`}>
        <h2 id={`${uid}-why`} className={styles.sectionTitle}>
          {he.answer.why.title}
        </h2>
        <StepList variant="numbered" items={answer.reasons.map((reason) => ({ title: reason }))} />
      </section>

      <Card aria-labelledby={`${uid}-how`}>
        <div className={styles.howHeader}>
          <h2 id={`${uid}-how`} className={styles.sectionTitle}>
            {he.answer.howWeCalculated.title}
          </h2>
          <Badge tone="info">{confidenceText}</Badge>
        </div>
        <p className={styles.sources}>{answer.howWeCalculated.sourcesText}</p>
        {answer.howWeCalculated.definitionPlaceholder ? (
          <p className={styles.placeholderNote}>{answer.howWeCalculated.definitionPlaceholder}</p>
        ) : null}
      </Card>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={onCompareOtherCar}>
          {he.answer.compareOtherCar}
        </Button>
        <Button variant="secondary" onClick={onAnotherQuestion}>
          {he.answer.anotherQuestion}
        </Button>
      </div>

      <div className={styles.linkRow}>
        <Button variant="link" onClick={() => onTalkToRep(answer.questionText)}>
          {he.answer.talkToRep}
        </Button>
      </div>
    </div>
  );
}
