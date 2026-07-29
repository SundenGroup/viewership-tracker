/**
 * ConfirmButton — tap-again-to-confirm for the live-ops landmines.
 *
 * "End now" completes a broadcast day (reopening is status+end-time
 * surgery) and "Pause" stops collection for every series; both used to
 * fire on a single mis-click. First tap arms for a few seconds and shows
 * the consequence; the second tap executes. Deliberately NOT a modal —
 * operators use these mid-broadcast and a dialog would cost seconds.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel,
  className = 'btn btn-xs',
  style,
  disabled,
  armSeconds = 4,
}: {
  onConfirm: () => void;
  /** Resting label. */
  children: ReactNode;
  /** Armed label — state the consequence ("End broadcast?"). */
  confirmLabel: ReactNode;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  armSeconds?: number;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const click = () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), armSeconds * 1000);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setArmed(false);
    onConfirm();
  };

  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={click}
      aria-live="polite"
      style={{
        ...style,
        ...(armed
          ? {
              color: 'var(--danger)',
              borderColor: 'color-mix(in oklab, var(--danger) 45%, transparent)',
              background: 'color-mix(in oklab, var(--danger) 10%, transparent)',
            }
          : null),
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
