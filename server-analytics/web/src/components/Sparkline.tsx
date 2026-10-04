/** A bare trend line for table rows and host cards: no axes, no hover. */
export function Sparkline({
  values,
  max,
  floor = 0,
  slot = 1,
  width = 96,
  height = 24,
  fluid = false,
}: {
  values: (number | null)[];
  max?: number;
  floor?: number; // smallest top of scale, so idle noise is not drawn as a swing
  slot?: 1 | 2 | 3;
  width?: number;
  height?: number;
  fluid?: boolean; // stretch to the container's width instead of `width` px
}) {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return <span className="inline-block text-xs text-neutral-400" style={{ width }}>—</span>;
  const top = max ?? Math.max(...nums, floor, 1e-9);
  const step = width / (values.length - 1);
  let d = "";
  values.forEach((v, i) => {
    if (v == null) return;
    const y = height - 1 - (Math.min(v, top) / top) * (height - 2);
    d += `${d === "" || values[i - 1] == null ? "M" : "L"}${(i * step).toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      width={fluid ? "100%" : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block align-middle"
      aria-hidden
    >
      <path d={d} fill="none" stroke={`var(--series-${slot})`} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
