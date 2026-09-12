/** Label/value line, shared by the centre-of-mass overlay and the properties panel. */
export function Row({
  label,
  value,
  highlight,
  small,
}: {
  label: string
  value: string
  highlight?: boolean
  small?: boolean
}) {
  return (
    <div className={`flex justify-between gap-3 ${small ? 'text-xs' : ''}`}>
      <span className="shrink-0 text-[var(--color-text-muted)]">{label}</span>
      <span
        className={`truncate text-right tabular-nums ${
          highlight ? 'font-medium text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'
        }`}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}
