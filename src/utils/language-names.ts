/**
 * English display names for the language codes the pipeline ingests
 * (Twitch broadcaster_language, YouTube defaultLanguage / defaultAudioLanguage,
 * Kick, SOOP, TikTok). Region subtags are dropped ("pt-BR" reads as
 * Portuguese). Unknown codes fall back to the uppercased code so a report
 * never shows an empty label.
 */
const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  en: 'English', de: 'German', fr: 'French', es: 'Spanish', pt: 'Portuguese', it: 'Italian',
  nl: 'Dutch', pl: 'Polish', ru: 'Russian', uk: 'Ukrainian', be: 'Belarusian', cs: 'Czech',
  sk: 'Slovak', sl: 'Slovenian', hr: 'Croatian', sr: 'Serbian', bs: 'Bosnian', mk: 'Macedonian',
  bg: 'Bulgarian', ro: 'Romanian', hu: 'Hungarian', el: 'Greek', sq: 'Albanian', tr: 'Turkish',
  sv: 'Swedish', no: 'Norwegian', nb: 'Norwegian', nn: 'Norwegian', da: 'Danish', fi: 'Finnish',
  is: 'Icelandic', et: 'Estonian', lv: 'Latvian', lt: 'Lithuanian', ga: 'Irish', cy: 'Welsh',
  mt: 'Maltese', lb: 'Luxembourgish', ca: 'Catalan', eu: 'Basque', gl: 'Galician',
  ar: 'Arabic', he: 'Hebrew', fa: 'Persian', ku: 'Kurdish', ur: 'Urdu', ps: 'Pashto',
  hi: 'Hindi', bn: 'Bengali', pa: 'Punjabi', gu: 'Gujarati', mr: 'Marathi', ta: 'Tamil',
  te: 'Telugu', kn: 'Kannada', ml: 'Malayalam', si: 'Sinhala', ne: 'Nepali',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', tw: 'Taiwanese', th: 'Thai', vi: 'Vietnamese',
  id: 'Indonesian', ms: 'Malay', tl: 'Tagalog', fil: 'Filipino', my: 'Burmese', km: 'Khmer',
  lo: 'Lao', mn: 'Mongolian', kk: 'Kazakh', ky: 'Kyrgyz', uz: 'Uzbek', tg: 'Tajik',
  az: 'Azerbaijani', hy: 'Armenian', ka: 'Georgian', af: 'Afrikaans', sw: 'Swahili',
  am: 'Amharic', asl: 'American Sign Language', other: 'Other',
};

export function languageDisplayName(code: string | null | undefined): string {
  if (!code) return 'Unknown';
  const k = code.trim().toLowerCase();
  if (!k) return 'Unknown';
  return LANGUAGE_DISPLAY_NAMES[k] ?? LANGUAGE_DISPLAY_NAMES[k.split(/[-_]/)[0]] ?? k.toUpperCase();
}
