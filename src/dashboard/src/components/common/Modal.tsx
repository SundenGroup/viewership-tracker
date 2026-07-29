import { useEffect, type ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  maxWidth = 'max-w-lg',
}: ModalProps) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`
          relative z-10 w-full ${maxWidth}
          rounded-xl border border-navy-700/50 bg-navy-850
          shadow-2xl shadow-black/40
        `}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-navy-700/50 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-100">{title}</h2>
            <button
              onClick={onClose}
              aria-label="Close dialog"
              className="text-gray-500 hover:text-gray-300 transition-colors"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        )}

        <div className="px-6 py-4">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-3 border-t border-navy-700/50 px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
