import type { CSSProperties, ReactNode } from 'react';

/** Row — flex wrapper with sensible defaults. */
export function Row({
  children,
  gap = 12,
  align = 'center',
  justify = 'flex-start',
  wrap = false,
  style,
  className,
}: {
  children: ReactNode;
  gap?: number;
  align?: CSSProperties['alignItems'];
  justify?: CSSProperties['justifyContent'];
  wrap?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        gap,
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap ? 'wrap' : 'nowrap',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Col — flex-column wrapper with sensible defaults. */
export function Col({
  children,
  gap = 12,
  style,
  className,
}: {
  children: ReactNode;
  gap?: number;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{ display: 'flex', flexDirection: 'column', gap, ...style }}
    >
      {children}
    </div>
  );
}

/** Section — bordered card with eyebrow + title header. */
export function Section({
  title,
  eyebrow,
  right,
  children,
  compact,
  style,
}: {
  title?: ReactNode;
  eyebrow?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  compact?: boolean;
  style?: CSSProperties;
}) {
  return (
    <section
      className="card"
      style={{
        padding: compact ? 16 : 20,
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 12 : 16,
        ...style,
      }}
    >
      <Row justify="space-between" align="flex-start">
        <Col gap={2}>
          {eyebrow && <div className="eyebrow">{eyebrow}</div>}
          {title && <h3>{title}</h3>}
        </Col>
        {right}
      </Row>
      {children}
    </section>
  );
}
