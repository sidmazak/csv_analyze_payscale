'use client';

import { useState } from 'react';
import { FileBrowserPanel } from '@/components/FileBrowserPanel';
import { CSVProcessorPanel } from '@/components/CSVProcessorPanel';

export default function Home() {
  const [selectedFiles, setSelectedFiles] = useState<
    Array<{ path: string; name: string }>
  >([]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-zinc-50 dark:bg-black">
      {/* Left Panel - File Browser */}
      <div className="w-1/3 min-w-[300px] max-w-[400px] h-full overflow-hidden">
        <FileBrowserPanel onFilesSelected={setSelectedFiles} />
      </div>

      {/* Right Panel - CSV Processor */}
      <div className="flex-1 overflow-hidden h-full">
        <CSVProcessorPanel selectedFiles={selectedFiles} />
      </div>
    </div>
  );
}
