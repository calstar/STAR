/**
 * The stand has failed.
 *
 * A vessel went over the pressure the drawing rates it for -- a regulator
 * turned too far, a shut LOX tank left to boil, a fill with the vent closed.
 * The model could carry it on; a real tank would not. So the twin stops on
 * the frame it failed on, says which vessel and how far, and asks to be
 * reset. Nothing on the panel takes a command until it is.
 */

interface Props {
  message: string;
  onReset: () => void;
}

export default function TripOverlay({ message, onReset }: Props) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="mx-6 max-w-xl rounded-xl border-2 border-red-700 bg-[#160a0a] px-8 py-6 shadow-2xl">
        <div className="mb-2 flex items-center gap-3">
          <span className="h-3 w-3 animate-pulse rounded-full bg-red-500" />
          <h2 className="text-lg font-bold uppercase tracking-widest text-red-400">Overpressure</h2>
        </div>
        <p className="text-[14px] leading-relaxed text-red-100">{message}</p>
        <p className="mt-3 text-[12px] leading-relaxed text-red-300/80">
          The stand is frozen on the frame it failed on; the gauges and the plot show how it got
          there. Reset empties the tanks and starts a new stand. The regulators stay where you
          set them: turn the dome down on the GSE tab before you press again.
        </p>
        <button
          type="button"
          onClick={onReset}
          className="mt-4 rounded-lg bg-red-700 px-4 py-2 text-[13px] font-bold uppercase tracking-wider text-white hover:bg-red-600"
        >
          Reset the stand
        </button>
      </div>
    </div>
  );
}
