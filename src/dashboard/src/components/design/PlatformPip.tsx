import { getPlatform } from '@/design/platforms';

export function PlatformPip({
  id,
  size = 14,
}: {
  id: string | null | undefined;
  size?: number;
}) {
  const p = getPlatform(id);
  if (!p) return null;
  return (
    <span
      title={p.name}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: 4,
        background: p.color,
        flex: 'none',
      }}
    />
  );
}
