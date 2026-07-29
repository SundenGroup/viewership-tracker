/* Clutch Viewership Tracker — icons as inline SVG components.
   Ported 1:1 from design_handoff_clutch_tracker/reference/src/icons.jsx. */

export interface IconProps {
  size?: number;
  /** Stroke width. Defaults to 1.6. */
  strokeWidth?: number;
  /** SVG fill. Defaults to "none". */
  fill?: string;
  className?: string;
  style?: React.CSSProperties;
}

function Icon({
  d,
  size = 16,
  strokeWidth = 1.6,
  fill = 'none',
  className,
  style,
}: IconProps & { d: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      <path d={d} />
    </svg>
  );
}

export const IconSearch = (p: IconProps) => (
  <Icon {...p} d="M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm10 2-4.35-4.35" />
);
export const IconBell = (p: IconProps) => (
  <Icon {...p} d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
);
export const IconUser = (p: IconProps) => (
  <Icon {...p} d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
);
export const IconSun = (p: IconProps) => (
  <Icon
    {...p}
    d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z"
  />
);
export const IconMoon = (p: IconProps) => (
  <Icon {...p} d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
);
export const IconMenu = (p: IconProps) => <Icon {...p} d="M4 6h16M4 12h16M4 18h16" />;
export const IconChev = (p: IconProps) => <Icon {...p} d="M9 18l6-6-6-6" />;
export const IconChevDown = (p: IconProps) => <Icon {...p} d="M6 9l6 6 6-6" />;
export const IconArrowUp = (p: IconProps) => <Icon {...p} d="M7 17 17 7M7 7h10v10" />;
export const IconArrowDn = (p: IconProps) => <Icon {...p} d="M7 7l10 10M17 7v10H7" />;
export const IconDownload = (p: IconProps) => (
  <Icon {...p} d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16" />
);
export const IconShare = (p: IconProps) => (
  <Icon {...p} d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v14" />
);
export const IconFilter = (p: IconProps) => (
  <Icon {...p} d="M4 5h16l-6 8v5l-4 2v-7L4 5Z" />
);
export const IconPlay = (p: IconProps) => (
  <Icon {...p} d="M5 3l14 9-14 9V3Z" fill="currentColor" />
);
export const IconPause = (p: IconProps) => (
  <Icon {...p} d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor" />
);
export const IconCheck = (p: IconProps) => <Icon {...p} d="M20 6 9 17l-5-5" />;
export const IconX = (p: IconProps) => <Icon {...p} d="M18 6 6 18M6 6l12 12" />;
export const IconPlus = (p: IconProps) => <Icon {...p} d="M12 5v14M5 12h14" />;
export const IconMore = (p: IconProps) => (
  <Icon {...p} d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth={3} />
);
export const IconSettings = (p: IconProps) => (
  <Icon
    {...p}
    d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.5-3a7.5 7.5 0 0 0-.15-1.5l2-1.5-2-3.4-2.3.8a7.5 7.5 0 0 0-2.6-1.5L14 2h-4l-.45 2.4a7.5 7.5 0 0 0-2.6 1.5l-2.3-.8-2 3.4 2 1.5A7.5 7.5 0 0 0 4.5 12c0 .5.05 1 .15 1.5l-2 1.5 2 3.4 2.3-.8a7.5 7.5 0 0 0 2.6 1.5L10 22h4l.45-2.4a7.5 7.5 0 0 0 2.6-1.5l2.3.8 2-3.4-2-1.5c.1-.5.15-1 .15-1.5Z"
  />
);
export const IconCalendar = (p: IconProps) => (
  <Icon
    {...p}
    d="M3 9h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM8 3v4M16 3v4"
  />
);
export const IconUsers = (p: IconProps) => (
  <Icon
    {...p}
    d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11"
  />
);
export const IconEye = (p: IconProps) => (
  <Icon {...p} d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
);
export const IconEyeOff = (p: IconProps) => (
  <Icon
    {...p}
    d="M17.9 17.9A10.7 10.7 0 0 1 12 20c-7 0-11-8-11-8a19.8 19.8 0 0 1 5.1-6M9.9 4.2A10.9 10.9 0 0 1 12 4c7 0 11 8 11 8a19.9 19.9 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M1 1l22 22"
  />
);
export const IconDot = (p: IconProps) => <Icon {...p} d="M12 12h.01" strokeWidth={6} />;
export const IconBolt = (p: IconProps) => <Icon {...p} d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z" />;
export const IconClock = (p: IconProps) => (
  <Icon {...p} d="M12 6v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
);
export const IconTrophy = (p: IconProps) => (
  <Icon
    {...p}
    d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4ZM17 4h3v3a3 3 0 0 1-3 3M7 4H4v3a3 3 0 0 0 3 3"
  />
);
export const IconGrid = (p: IconProps) => (
  <Icon {...p} d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
);
export const IconGlobe = (p: IconProps) => (
  <Icon
    {...p}
    d="M12 22c5.5 0 10-4.5 10-10S17.5 2 12 2 2 6.5 2 12s4.5 10 10 10ZM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"
  />
);
export const IconList = (p: IconProps) => (
  <Icon {...p} d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
);
export const IconSparkle = (p: IconProps) => (
  <Icon {...p} d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />
);
export const IconEdit = (p: IconProps) => (
  <Icon {...p} d="M12 20h9M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
);
export const IconTrash = (p: IconProps) => (
  <Icon
    {...p}
    d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14ZM10 11v6M14 11v6"
  />
);
export const IconExternal = (p: IconProps) => (
  <Icon {...p} d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
);
