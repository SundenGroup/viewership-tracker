import { forwardRef, type SelectHTMLAttributes } from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ options, placeholder, className = '', ...rest }, ref) => {
    return (
      <select
        ref={ref}
        className={`w-full rounded-lg border border-navy-600 bg-navy-800 px-3 py-1.5 text-sm text-gray-200
                    focus:border-clutch-red focus:outline-none focus:ring-1 focus:ring-clutch-red/50
                    disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        {...rest}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  },
);

Select.displayName = 'Select';
