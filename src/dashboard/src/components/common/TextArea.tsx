import { forwardRef, type TextareaHTMLAttributes } from 'react';

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ className = '', ...rest }, ref) => {
    return (
      <textarea
        ref={ref}
        className={`w-full rounded-lg border border-navy-600 bg-navy-800 px-3 py-1.5 text-sm text-gray-200
                    placeholder:text-gray-600
                    focus:border-clutch-red focus:outline-none focus:ring-1 focus:ring-clutch-red/50
                    disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        {...rest}
      />
    );
  },
);

TextArea.displayName = 'TextArea';
