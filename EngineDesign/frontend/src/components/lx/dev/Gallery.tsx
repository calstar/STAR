import { useState } from 'react';
import { GalleryCharts } from './GalleryCharts';
import { GalleryUI } from './GalleryUI';

/**
 * Visual QA for the Layer X primitives and charts, at ?lx-gallery=1 (App.tsx mounts it instead of
 * the app). Two sheets: every lx/ui primitive in both themes, and the charts with the timeline.
 * Synthetic data; nothing is fetched or written.
 */
export function Gallery() {
  const [sheet, setSheet] = useState<'ui' | 'charts'>(() => (new URLSearchParams(window.location.search).get('sheet') === 'charts' ? 'charts' : 'ui'));
  return (
    <div className="min-h-screen bg-[#0c0e11]">
      <nav aria-label="Gallery sheets" className="flex gap-1 border-b border-[#262b33] bg-[#13161a] px-4 py-2 text-[13px]">
        {(['ui', 'charts'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={sheet === k} onClick={() => setSheet(k)}
                  className={`rounded-[6px] px-3 py-1 ${sheet === k ? 'bg-[#262c35] text-[#e7eaee]' : 'text-[#a7afba] hover:text-[#e7eaee]'}`}>
            {k === 'ui' ? 'Primitives' : 'Charts and timeline'}
          </button>
        ))}
      </nav>
      {sheet === 'ui' ? <GalleryUI /> : <GalleryCharts />}
    </div>
  );
}

export default Gallery;
