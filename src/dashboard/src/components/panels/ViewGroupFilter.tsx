import type { ViewGroup } from '@/types/api';

interface ViewGroupFilterProps {
  groups: ViewGroup[];
  active: string | null;
  onChange: (groupName: string | null) => void;
}

export function ViewGroupFilter({ groups, active, onChange }: ViewGroupFilterProps) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-navy-700/50 bg-navy-850 px-3 py-2 shadow-lg">
      <svg className="h-3.5 w-3.5 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
      <select
        value={active ?? '__all__'}
        onChange={(e) => {
          const val = e.target.value;
          onChange(val === '__all__' ? null : val);
          window.umami?.track('view-group-change', { group: val });
        }}
        className="rounded-md border border-navy-700 bg-navy-800 px-2 py-1 text-xs text-gray-200 outline-none focus:border-clutch-red/50"
      >
        <option value="__all__">All</option>
        {groups.map((g) => (
          <option key={g.name} value={g.name}>
            {g.name}
          </option>
        ))}
      </select>
    </div>
  );
}
