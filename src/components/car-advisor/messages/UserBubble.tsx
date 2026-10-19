import styles from './messages.module.css';

export function UserBubble({ text }: { text: string }) {
  return <p className={styles.userBubble}>{text}</p>;
}
