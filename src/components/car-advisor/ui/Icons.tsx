import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** Icons carry their size through width/height so they do not depend on any host CSS. */
const sized = (size: number) => ({ width: size, height: size });

export function CarIcon({ size = 24, ...props }: IconProps & { size?: number }) {
  return (
    <svg {...base} {...sized(size)} {...props}>
      <path d="M5 16V12l1.6-4.2A2 2 0 0 1 8.5 6.5h7a2 2 0 0 1 1.9 1.3L19 12v4" />
      <path d="M3.5 16h17" />
      <circle cx="7.5" cy="16.5" r="1.5" />
      <circle cx="16.5" cy="16.5" r="1.5" />
    </svg>
  );
}

/** Paper-plane arrow drawn pointing right. Mirror it (scaleX(-1)) in right-to-left layouts. */
export function SendIcon({ size = 20, ...props }: IconProps & { size?: number }) {
  return (
    <svg {...base} {...sized(size)} {...props}>
      <path d="M4 12l16-8-6 16-3-6.5L4 12z" />
      <path d="M11 13.5L20 4" />
    </svg>
  );
}

export function CheckIcon({ size = 20, ...props }: IconProps & { size?: number }) {
  return (
    <svg {...base} {...sized(size)} {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function CrossIcon({ size = 20, ...props }: IconProps & { size?: number }) {
  return (
    <svg {...base} {...sized(size)} {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function DocumentIcon({ size = 24, ...props }: IconProps & { size?: number }) {
  return (
    <svg {...base} {...sized(size)} {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

export function PaperclipIcon({ size = 20, ...props }: IconProps & { size?: number }) {
  return (
    <svg {...base} {...sized(size)} {...props}>
      <path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
    </svg>
  );
}

/** Filled car with a small lightning accent, for the header badge. Colours come from the widget's CSS variables. */
export function CarBadgeIcon({ size = 24, ...props }: IconProps & { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...sized(size)} {...props}>
      <path
        d="M2.5 15.5v-2.3c0-.6.2-1.1.6-1.5l2.1-2.7c.5-.9 1.4-1.5 2.4-1.5h8.8c1 0 1.9.6 2.4 1.5l2.1 2.7c.4.4.6.9.6 1.5v2.3c0 .6-.4 1-1 1h-1.2a2.6 2.6 0 0 0-5.1 0H9.8a2.6 2.6 0 0 0-5.1 0H3.5c-.6 0-1-.4-1-1z"
        fill="currentColor"
      />
      <path d="M8.1 8.9h7.8l1.6 2.6H6.5z" fill="var(--ca-action)" opacity="0.9" />
      <path d="M12.9 9.4l-1.7 1.7h1.2l-.6 1.4 1.9-1.8h-1.2z" fill="currentColor" />
      <circle cx="7.3" cy="16.6" r="2" fill="currentColor" stroke="var(--ca-action)" strokeWidth="1.2" />
      <circle cx="16.7" cy="16.6" r="2" fill="currentColor" stroke="var(--ca-action)" strokeWidth="1.2" />
    </svg>
  );
}
