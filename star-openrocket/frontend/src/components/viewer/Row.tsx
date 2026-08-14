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
      <span className="shrink-0 text-slate-400">{label}</span>
      <span
        className={`truncate text-right tabular-nums ${
          highlight ? 'font-semibold text-cyan-300' : 'text-slate-100'
        }`}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}
