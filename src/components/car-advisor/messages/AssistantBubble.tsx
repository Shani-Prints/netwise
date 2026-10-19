import styles from './api.module.css';

/** What the bot wrote. Server text is shown as plain text only (React escapes it; there is no HTML path). */
export function AssistantBubble({ text }: { text: string }) {
  return <p className={styles.assistantBubble}>{text}</p>;
}
