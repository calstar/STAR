import { useState, useCallback } from 'react';
import { uploadConfig } from '../api/client';
import type { EngineConfig } from '../api/client';

interface ConfigUploadProps {
  onConfigLoaded: (config: EngineConfig) => void;
}

export function ConfigUpload({ onConfigLoaded }: ConfigUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.endsWith('.yaml') && !file.name.endsWith('.yml')) {
      setError('Please upload a YAML file (.yaml or .yml)');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccessMessage(null);

    const result = await uploadConfig(file);

    setIsLoading(false);

    if (result.error) {
      setError(result.error);
    } else if (result.data) {
      setSuccessMessage(result.data.message);
      onConfigLoaded(result.data.config);
    }
  }, [onConfigLoaded]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file) {
      handleFile(file);
    }
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
  }, [handleFile]);

  return (
    <div className="w-full">
      <label
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`
          relative flex flex-col items-center justify-center w-full h-40
          border-2 border-dashed rounded-xl cursor-pointer
          transition-all duration-200 ease-in-out
          ${isDragging
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-blue-500/50 hover:bg-[var(--color-bg-tertiary)]'
          }
          ${isLoading ? 'opacity-50 pointer-events-none' : ''}
        `}
      >
        <input
          type="file"
          accept=".yaml,.yml"
          onChange={handleInputChange}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          disabled={isLoading}
        />
        
        <div className="flex flex-col items-center gap-2 text-center p-4">
          {isLoading ? (
            <>
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-[var(--color-text-secondary)]">Loading config...</span>
            </>
          ) : (
            <>
              <svg className="w-10 h-10 text-[var(--color-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <div>
                <span className="text-blue-400 font-medium">Click to upload</span>
                <span className="text-[var(--color-text-secondary)]"> or drag and drop</span>
              </div>
              <span className="text-sm text-[var(--color-text-secondary)]">YAML config file (.yaml, .yml)</span>
            </>
          )}
        </div>
      </label>

      {error && (
        <div className="mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      {successMessage && (
        <div className="mt-3 p-3 bg-green-500/10 border border-green-500/30 rounded-lg text-green-400 text-sm">
          {successMessage}
        </div>
      )}
    </div>
  );
}

