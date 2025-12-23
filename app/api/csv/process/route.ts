import { NextRequest } from 'next/server';
import { filebrowserClient } from '@/lib/filebrowser-client';
import Papa from 'papaparse';
import fs from 'fs/promises';
import path from 'path';

interface ProcessRequest {
  files: Array<{ path: string; name: string }>;
  searchTerm: string;
  replaceTerm?: string;
  selectedFields: string[];
  showOnlyMatches: boolean;
  saveMode?: 'filebrowser' | 'overwrite' | 'local';
  caseSensitive?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
}

interface ProcessStats {
  totalFiles: number;
  processedFiles: number;
  totalRows: number;
  processedRows: number;
  totalMatches: number;
  totalReplacements: number;
  currentFile?: string;
  currentFileRows?: number;
  currentFileMatches?: number;
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: any) => {
        const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(message));
      };

      try {
        const body: ProcessRequest = await request.json();
        const {
          files,
          searchTerm,
          replaceTerm,
          selectedFields,
          showOnlyMatches,
          saveMode = 'filebrowser',
          caseSensitive = false,
          wholeWord = false,
          useRegex = false,
        } = body;

        if (!searchTerm || files.length === 0) {
          sendEvent('error', { message: 'Search term and files are required' });
          controller.close();
          return;
        }

        const stats: ProcessStats = {
          totalFiles: files.length,
          processedFiles: 0,
          totalRows: 0,
          processedRows: 0,
          totalMatches: 0,
          totalReplacements: 0,
        };

        const outputFiles: Array<{ originalPath: string; newPath: string | null }> = [];

        // Process each file serially
        for (const file of files) {
          try {
            stats.currentFile = file.name;
            stats.currentFileRows = 0;
            stats.currentFileMatches = 0;

            sendEvent('file-start', {
              filename: file.name,
              path: file.path,
            });

            // Download CSV from filebrowser
            const blob = await filebrowserClient.downloadFile(file.path);
            const text = await blob.text();

            // Parse CSV
            const parseResult = Papa.parse(text, {
              header: true,
              skipEmptyLines: true,
              transformHeader: (header) => header.trim(),
            });

            if (parseResult.errors.length > 0) {
              sendEvent('error', {
                filename: file.name,
                error: `CSV parsing errors: ${parseResult.errors.map((e) => e.message).join(', ')}`,
              });
              continue;
            }

            const rows = parseResult.data as Record<string, string>[];
            const headers = Object.keys(rows[0] || {});
            stats.totalRows += rows.length;
            stats.currentFileRows = rows.length;

            // Determine which fields to search
            const fieldsToSearch =
              selectedFields.includes('All') || selectedFields.length === 0
                ? headers
                : selectedFields.filter((f) => headers.includes(f));

            // Build search regex based on options (VS Code-style)
            let searchPattern: string;
            let searchFlags: string;

            if (useRegex) {
              // Use user-provided regex pattern, optionally enforce whole word
              searchPattern = wholeWord ? `\\b(${searchTerm})\\b` : searchTerm;
              searchFlags = caseSensitive ? 'g' : 'gi';
            } else {
              // Escape user text
              const escaped = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              searchPattern = wholeWord ? `\\b${escaped}\\b` : escaped;
              searchFlags = caseSensitive ? 'g' : 'gi';
            }

            const searchRegex = new RegExp(searchPattern, searchFlags);

            sendEvent('file-info', {
              filename: file.name,
              totalRows: rows.length,
              fieldsToSearch: fieldsToSearch.length,
            });

            // Process each row
            const processedRows: Record<string, string>[] = [];
            let fileMatches = 0;
            let fileReplacements = 0;

            for (let i = 0; i < rows.length; i++) {
              const row = { ...rows[i] };
              let rowHasMatch = false;
              const rowMatches: Array<{
                field: string;
                oldValue: string;
                newValue: string;
              }> = [];

              // Search in selected fields
              for (const field of fieldsToSearch) {
                const value = row[field] || '';

                // reset regex state before each test
                searchRegex.lastIndex = 0;

                if (searchRegex.test(value)) {
                  rowHasMatch = true;
                  fileMatches++;
                  stats.totalMatches++;

                  if (replaceTerm !== undefined && replaceTerm !== '') {
                    const newValue = value.replace(searchRegex, replaceTerm);
                    rowMatches.push({
                      field,
                      oldValue: value,
                      newValue,
                    });
                    row[field] = newValue;
                    fileReplacements++;
                    stats.totalReplacements++;
                  } else {
                    rowMatches.push({
                      field,
                      oldValue: value,
                      newValue: value,
                    });
                  }
                }
              }

              // Only include row if it matches (if showOnlyMatches is true) or always include
              if (!showOnlyMatches || rowHasMatch) {
                processedRows.push(row);
              }

              stats.processedRows++;

              // Send row-processed event immediately for every row that has matches
              if (rowMatches.length > 0) {
                sendEvent('row-processed', {
                  filename: file.name,
                  filePath: file.path,
                  rowIndex: i + 1,
                  totalRows: rows.length,
                  matches: rowMatches,
                });
              }

              // Send stats update every 10 rows (progress only)
              if ((i + 1) % 10 === 0 || i === rows.length - 1) {
                sendEvent('stats', { ...stats });
              }
            }

            stats.currentFileMatches = fileMatches;

            let newPath: string | null = null;

            // Only generate output when replaceTerm is provided (replace mode)
            if (replaceTerm !== undefined && replaceTerm !== '') {
              const newCsv = Papa.unparse(processedRows, {
                header: true,
              });

              const pathParts = file.path.split('/');
              const fileName = pathParts.pop() || 'file.csv';
              const directory = pathParts.join('/') || '/';
              const nameWithoutExt = fileName.replace(/\.csv$/i, '');
              const replacedFileName = `${nameWithoutExt}_replaced.csv`;

              if (saveMode === 'local') {
                // Save into public directory
                const publicDir = path.join(process.cwd(), 'public');
                const localPath = path.join(publicDir, replacedFileName);

                await fs.writeFile(localPath, newCsv, 'utf8');
                newPath = `/${replacedFileName}`;
              } else if (saveMode === 'overwrite') {
                // Overwrite original in Filebrowser
                newPath = file.path;
                const newBlob = new Blob([newCsv], { type: 'text/csv' });
                await filebrowserClient.uploadFile(newBlob, newPath, true);
              } else {
                // Default: save as new file in Filebrowser
                const fbPath = `${directory}/${replacedFileName}`.replace(
                  /\/+/g,
                  '/',
                );
                newPath = fbPath;
                const newBlob = new Blob([newCsv], { type: 'text/csv' });
                await filebrowserClient.uploadFile(newBlob, fbPath, false);
              }
            }

            outputFiles.push({
              originalPath: file.path,
              newPath,
            });

            // Count file as processed in both search and replace modes
            stats.processedFiles++;
            stats.currentFile = undefined;

            sendEvent('file-complete', {
              filename: file.name,
              matchesCount: fileMatches,
              replacementsCount: fileReplacements,
              newPath,
            });

            sendEvent('stats', { ...stats });
          } catch (error) {
            sendEvent('error', {
              filename: file.name,
              error:
                error instanceof Error ? error.message : 'Unknown error',
            });
          }
        }

        sendEvent('complete', {
          outputFiles,
          stats: {
            totalFiles: stats.totalFiles,
            processedFiles: stats.processedFiles,
            totalRows: stats.totalRows,
            totalMatches: stats.totalMatches,
            totalReplacements: stats.totalReplacements,
          },
        });
      } catch (error) {
        sendEvent('error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

