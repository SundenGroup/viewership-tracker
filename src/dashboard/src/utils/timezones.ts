export interface TimezoneOption {
  value: string;
  label: string;
}

/**
 * Curated list of common IANA timezones for the series timezone dropdown.
 * Grouped by region for easy scanning.
 */
export const TIMEZONE_OPTIONS: TimezoneOption[] = [
  // UTC
  { value: 'UTC', label: 'UTC (Coordinated Universal Time)' },

  // Americas
  { value: 'America/New_York', label: 'Eastern Time (ET) — New York' },
  { value: 'America/Chicago', label: 'Central Time (CT) — Chicago' },
  { value: 'America/Denver', label: 'Mountain Time (MT) — Denver' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT) — Los Angeles' },
  { value: 'America/Anchorage', label: 'Alaska Time (AKT) — Anchorage' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time (HST) — Honolulu' },
  { value: 'America/Toronto', label: 'Eastern Time (ET) — Toronto' },
  { value: 'America/Mexico_City', label: 'Central Time (CT) — Mexico City' },
  { value: 'America/Sao_Paulo', label: 'Brasilia Time (BRT) — São Paulo' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Argentina Time (ART) — Buenos Aires' },
  { value: 'America/Bogota', label: 'Colombia Time (COT) — Bogotá' },

  // Europe
  { value: 'Europe/London', label: 'Greenwich Mean Time (GMT) — London' },
  { value: 'Europe/Berlin', label: 'Central European (CET) — Berlin' },
  { value: 'Europe/Paris', label: 'Central European (CET) — Paris' },
  { value: 'Europe/Stockholm', label: 'Central European (CET) — Stockholm' },
  { value: 'Europe/Helsinki', label: 'Eastern European (EET) — Helsinki' },
  { value: 'Europe/Moscow', label: 'Moscow Time (MSK) — Moscow' },
  { value: 'Europe/Istanbul', label: 'Turkey Time (TRT) — Istanbul' },
  { value: 'Europe/Kiev', label: 'Eastern European (EET) — Kyiv' },
  { value: 'Europe/Warsaw', label: 'Central European (CET) — Warsaw' },
  { value: 'Europe/Bucharest', label: 'Eastern European (EET) — Bucharest' },

  // Middle East & Africa
  { value: 'Asia/Dubai', label: 'Gulf Standard Time (GST) — Dubai' },
  { value: 'Asia/Riyadh', label: 'Arabia Standard Time (AST) — Riyadh' },
  { value: 'Africa/Johannesburg', label: 'South Africa (SAST) — Johannesburg' },
  { value: 'Africa/Cairo', label: 'Eastern European (EET) — Cairo' },

  // Asia
  { value: 'Asia/Kolkata', label: 'India Standard Time (IST) — Kolkata' },
  { value: 'Asia/Bangkok', label: 'Indochina Time (ICT) — Bangkok' },
  { value: 'Asia/Singapore', label: 'Singapore Time (SGT) — Singapore' },
  { value: 'Asia/Shanghai', label: 'China Standard Time (CST) — Shanghai' },
  { value: 'Asia/Hong_Kong', label: 'Hong Kong Time (HKT) — Hong Kong' },
  { value: 'Asia/Seoul', label: 'Korea Standard Time (KST) — Seoul' },
  { value: 'Asia/Tokyo', label: 'Japan Standard Time (JST) — Tokyo' },

  // Oceania
  { value: 'Australia/Perth', label: 'Australian Western (AWST) — Perth' },
  { value: 'Australia/Sydney', label: 'Australian Eastern (AEST) — Sydney' },
  { value: 'Pacific/Auckland', label: 'New Zealand (NZST) — Auckland' },
];
