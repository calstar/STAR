'use client'

import { useEffect, useRef, useState } from 'react';

interface CameraFeedProps {
  url: string;
  className?: string;
}

export default function CameraFeed({ url, className = '' }: CameraFeedProps) {
  const [streamUrl, setStreamUrl] = useState<string>(url);
  const [error, setError] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Try different camera stream endpoints
  const endpoints = [
    url,
    url.endsWith('/') ? `${url}stream` : `${url}/stream`,
    url.endsWith('/') ? `${url}mjpeg` : `${url}/mjpeg`,
    url.endsWith('/') ? `${url}video` : `${url}/video`,
    url.endsWith('/') ? `${url}cam` : `${url}/cam`,
  ];

  useEffect(() => {
    // Reset error when URL changes
    setError(null);
  }, [url]);

  const handleImageError = () => {
    const currentIndex = endpoints.indexOf(streamUrl);
    if (currentIndex < endpoints.length - 1) {
      // Try next endpoint
      setStreamUrl(endpoints[currentIndex + 1]);
    } else {
      setError('Unable to load camera feed. Please check the camera URL and network connection.');
    }
  };

  const handleImageLoad = () => {
    // If image loads successfully, hide iframe
    if (iframeRef.current) {
      iframeRef.current.style.display = 'none';
    }
    setError(null);
  };

  return (
    <div className={`bg-card rounded-xl border border-gray-800 p-4 ${className}`}>
      <h2 className="text-sm font-bold tracking-widest text-text-muted uppercase mb-3">
        Camera Feed
      </h2>
      <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden">
        {/* Try iframe first (for web interfaces) */}
        <iframe
          ref={iframeRef}
          src={url}
          className="absolute inset-0 w-full h-full border-0"
          allow="camera; microphone"
          title="Camera Feed"
          onError={() => {
            // If iframe fails, try image stream
            if (iframeRef.current) {
              iframeRef.current.style.display = 'none';
            }
            if (imgRef.current) {
              imgRef.current.style.display = 'block';
            }
          }}
        />
        {/* Fallback: MJPEG/stream as img */}
        <img
          ref={imgRef}
          src={streamUrl}
          alt="Camera Feed"
          className="absolute inset-0 w-full h-full object-contain"
          style={{ display: 'none' }}
          onError={handleImageError}
          onLoad={handleImageLoad}
        />
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-red-400 text-sm p-4 text-center">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

