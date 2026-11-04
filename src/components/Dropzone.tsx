import { useRef, useState } from 'react';

export interface DropzoneProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

export default function Dropzone({ onFiles, disabled }: DropzoneProps) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const take = (list: FileList | null | undefined) => {
    if (!list || disabled) return;
    const files = Array.from(list);
    if (files.length > 0) onFiles(files);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={`dropzone ${over ? 'dropzone-active' : ''} flex flex-col items-center justify-center gap-3 px-6 py-14 text-center cursor-pointer`}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        take(event.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          take(event.target.files);
          event.target.value = '';
        }}
        disabled={disabled}
      />

      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400">
        <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 16V4m0 0L7 9m5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
        </svg>
      </div>

      <div>
        <p className="text-base font-semibold">Drag &amp; drop files here</p>
        <p className="muted text-sm mt-1">
          or <span className="text-indigo-600 dark:text-indigo-400 font-semibold">browse your device</span>
        </p>
      </div>

      <p className="muted text-xs max-w-md">
        CSV · TSV · XLSX · JSON · NDJSON · XML · YAML · PDF · DOCX · HTML · RTF · MD · TXT · LOG · EML ·
        PNG · JPG · WEBP · ZIP — processed entirely in your browser. Files never leave your device.
      </p>
    </div>
  );
}
