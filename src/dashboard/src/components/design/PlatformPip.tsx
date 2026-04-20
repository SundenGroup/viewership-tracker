import { getPlatform } from '@/design/platforms';
import { PlatformLogo } from './PlatformLogo';

/**
 * PlatformPip — small square containing the platform logo on a tinted
 * background. Matches design v5 where pips carry the real platform glyph.
 */
export function PlatformPip({
  id,
  size = 14,
}: {
  id: string | null | undefined;
  size?: number;
}) {
  const p = getPlatform(id);
  if (!p) return null;
  // Give the wrapper a little breathing room around the logo.
  const box = size + 6;
  return (
    <span
      title={p.name}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: box,
        height: box,
        borderRadius: 4,
        background: `color-mix(in oklab, ${p.color} 18%, transparent)`,
        flex: 'none',
      }}
    >
      <PlatformLogo id={p.id} size={size} color={p.color} />
    </span>
  );
}
