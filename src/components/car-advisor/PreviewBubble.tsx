import styles from './FloatingChat.module.css';

/** Small preview bubble above the closed launcher ("the rep answered"). Clicking it opens the window. */
export function PreviewBubble({ text, onOpen }: { text: string; onOpen: () => void }) {
  return (
    <div role="status">
      <button type="button" className={styles.bubble} onClick={onOpen}>
        {text}
      </button>
    </div>
  );
}
