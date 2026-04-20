import type { CSSProperties } from 'react';

/**
 * Clutch Group wordmark asset is ~1158 × 237 px (wordmark + C-glyph together).
 * We crop to just the glyph for LogoMark, and show the full wordmark for ClutchWordmark.
 * Dark/light theme swap via overlaid <img> + opacity rules in tokens.css.
 */

const FULL_ASPECT = 1158 / 237;
const GLYPH_ASPECT = 228 / 237;

export function LogoImg({
  height,
  cropToGlyph = false,
  style,
}: {
  height: number;
  cropToGlyph?: boolean;
  style?: CSSProperties;
}) {
  const h = height;
  const wrapW = cropToGlyph ? h * GLYPH_ASPECT : h * FULL_ASPECT;
  const imgW = h * FULL_ASPECT;
  return (
    <span
      style={{
        display: 'inline-block',
        width: wrapW,
        height: h,
        overflow: 'hidden',
        flex: 'none',
        position: 'relative',
        ...style,
      }}
    >
      {/* Dark logo (black) — visible on light theme */}
      <img
        src={`${import.meta.env.BASE_URL}brand/clutch-group-black.png`}
        alt="Clutch Group"
        className="clutch-logo clutch-logo-dark"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          height: h,
          width: imgW,
          display: 'block',
          objectFit: 'cover',
          objectPosition: 'left center',
        }}
      />
      {/* Light logo (white) — visible on dark theme */}
      <img
        src={`${import.meta.env.BASE_URL}brand/clutch-group-white.png`}
        alt=""
        aria-hidden="true"
        className="clutch-logo clutch-logo-light"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          height: h,
          width: imgW,
          display: 'block',
          objectFit: 'cover',
          objectPosition: 'left center',
        }}
      />
    </span>
  );
}

export function LogoMark({
  size = 24,
  withWordmark = false,
}: {
  size?: number;
  withWordmark?: boolean;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: withWordmark ? 8 : 0,
      }}
    >
      <LogoImg height={size} cropToGlyph={!withWordmark} />
      {withWordmark && (
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
          <div
            className="eyebrow"
            style={{ fontSize: size * 0.38, marginTop: 2 }}
          >
            Tracker
          </div>
        </div>
      )}
    </div>
  );
}

export function ClutchWordmark({
  size = 16,
  muted = false,
}: {
  size?: number;
  muted?: boolean;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        opacity: muted ? 0.55 : 1,
      }}
    >
      <LogoImg height={size * 1.25} />
      <span
        style={{
          fontSize: size * 0.95,
          fontWeight: 500,
          letterSpacing: '-0.01em',
          color: 'var(--fg-muted)',
          paddingLeft: 10,
          borderLeft: '1px solid var(--border)',
        }}
      >
        Tracker
      </span>
    </span>
  );
}
