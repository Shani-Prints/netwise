import './styles/tokens.css';
import './styles/base.css';
import styles from './ScopeRoot.module.css';

interface ScopeRootProps extends React.HTMLAttributes<HTMLDivElement> {
  /** "fill": width and height 100% of the container. "contents": no box, used for the portal container. */
  layout?: 'block' | 'fill' | 'contents';
}

/**
 * The only element that carries the scope attribute, direction and language. Direction and language are set
 * here and never on html or body, so the host page is not affected.
 */
export function ScopeRoot({ layout = 'block', className = '', ...rest }: ScopeRootProps) {
  const layoutClass = layout === 'fill' ? styles.fill : layout === 'contents' ? styles.contents : '';
  return (
    <div
      data-car-advisor=""
      dir="rtl"
      lang="he"
      className={`${styles.root} ${layoutClass} ${className}`}
      {...rest}
    />
  );
}
