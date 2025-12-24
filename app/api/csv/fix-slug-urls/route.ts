import { NextRequest } from 'next/server';
import { filebrowserClient } from '@/lib/filebrowser-client';
import { normalizeToKebabCase } from '@/lib/utils';
import Papa from 'papaparse';
import fs from 'fs/promises';
import path from 'path';

interface SearchResultRow {
  rowIndex: number;
  fields: Record<string, string>;
}

interface SearchResult {
  filename: string;
  path: string;
  rows: SearchResultRow[];
}

interface FixSlugUrlsRequest {
  searchResults: SearchResult[];
  saveMode: 'filebrowser' | 'overwrite' | 'local';
}

interface ProcessStats {
  totalFiles: number;
  processedFiles: number;
  totalRows: number;
  processedRows: number;
  totalMatches: number;
  totalReplacements: number;
  currentFile?: string;
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
        const body: FixSlugUrlsRequest = await request.json();
        const { searchResults, saveMode = 'filebrowser' } = body;

        if (!searchResults || searchResults.length === 0) {
          sendEvent('error', { message: 'No search results provided' });
          controller.close();
          return;
        }

        // Group rows by file for efficient processing
        // Filter out files with no matching rows
        const filesMap = new Map<string, SearchResult>();
        for (const result of searchResults) {
          // Only include files that have matching rows
          if (result.rows && result.rows.length > 0) {
            filesMap.set(result.path, result);
          }
        }

        if (filesMap.size === 0) {
          sendEvent('error', { message: 'No files with matching rows found' });
          controller.close();
          return;
        }

        const stats: ProcessStats = {
          totalFiles: filesMap.size, // Only count files with matches
          processedFiles: 0,
          totalRows: 0,
          processedRows: 0,
          totalMatches: 0,
          totalReplacements: 0,
        };

        // Process each file
        // NOTE: We use the search results directly. We download and parse the full CSV
        // (necessary to modify it), but only fix the specific rows that were found during search.
        for (const [filePath, searchResult] of filesMap.entries()) {
          try {
            stats.currentFile = searchResult.filename;
            sendEvent('file-start', {
              filename: searchResult.filename,
              path: filePath,
            });

            // Download CSV from filebrowser (necessary to modify it)
            const blob = await filebrowserClient.downloadFile(filePath);
            const text = await blob.text();

            // Parse CSV
            const parseResult = Papa.parse(text, {
              header: true,
              skipEmptyLines: true,
              transformHeader: (header) => header.trim(),
            });

            if (parseResult.errors.length > 0) {
              sendEvent('error', {
                filename: searchResult.filename,
                error: `CSV parsing errors: ${parseResult.errors
                  .map((e) => e.message)
                  .join(', ')}`,
              });
              continue;
            }

            const rows = parseResult.data as Record<string, string>[];
            const headers = Object.keys(rows[0] || {});
            stats.totalRows += rows.length;

            // Check if slug_url and location fields exist
            if (!headers.includes('slug_url')) {
              sendEvent('error', {
                filename: searchResult.filename,
                error: 'Field "slug_url" not found in CSV headers',
              });
              continue;
            }

            if (!headers.includes('location')) {
              sendEvent('error', {
                filename: searchResult.filename,
                error: 'Field "location" not found in CSV headers',
              });
              continue;
            }

            sendEvent('file-info', {
              filename: searchResult.filename,
              totalRows: rows.length,
              fieldsToFix: ['slug_url'],
            });

            // Create a map of row indices that need fixing
            const rowsToFix = new Set(
              searchResult.rows.map((r) => r.rowIndex - 1),
            ); // Convert to 0-based index

            const processedRows: Record<string, string>[] = [];
            let fileFixes = 0;

            // Process each row
            for (let i = 0; i < rows.length; i++) {
              const row = { ...rows[i] };
              const rowMatchesEvents: Array<{
                field: string;
                oldValue: string;
                newValue: string;
              }> = [];

              // Only fix if this row was in the search results
              if (rowsToFix.has(i)) {
                const currentSlugUrl = (row['slug_url'] ?? '').toString().trim();
                const location = (row['location'] ?? '').toString().trim();

                // Normalize location to kebab-case (lowercase, remove diacritics, spaces to hyphens)
                const normalizedLocation = normalizeToKebabCase(location);

                // Verify slug_url ends with -salary
                if (currentSlugUrl.endsWith('-salary')) {
                  // Only fix if location is not empty after normalization
                  if (normalizedLocation) {
                    // Check if location is already appended (avoid duplicates)
                    const expectedSuffix = `-salary-${normalizedLocation}`;
                    if (!currentSlugUrl.endsWith(expectedSuffix)) {
                      const newSlugUrl = `${currentSlugUrl}-${normalizedLocation}`;
                      row['slug_url'] = newSlugUrl;
                      fileFixes++;
                      stats.totalReplacements++;

                      rowMatchesEvents.push({
                        field: 'slug_url',
                        oldValue: currentSlugUrl,
                        newValue: newSlugUrl,
                      });
                    }
                  }
                }
              }

              processedRows.push(row);
              stats.processedRows++;

              // Send row-processed event for fixed rows
              if (rowMatchesEvents.length > 0) {
                sendEvent('row-processed', {
                  filename: searchResult.filename,
                  filePath: filePath,
                  rowIndex: i + 1,
                  totalRows: rows.length,
                  matches: rowMatchesEvents,
                });
              }

              // Send stats update every 10 rows
              if ((i + 1) % 10 === 0 || i === rows.length - 1) {
                sendEvent('stats', { ...stats });
              }
            }

            // Track file fixes (for stats, though not part of ProcessStats interface)

            // Only save if fixes were actually made
            let newPath: string | null = null;

            if (fileFixes > 0) {
              // Save the modified CSV
              const newCsv = Papa.unparse(processedRows, { header: true });

              const pathParts = filePath.split('/');
              const fileName = pathParts.pop() || 'file.csv';
              const directory = pathParts.join('/') || '/';
              const nameWithoutExt = fileName.replace(/\.csv$/i, '');
              const fixedFileName = `${nameWithoutExt}_fixed.csv`;

              if (saveMode === 'local') {
                const publicDir = path.join(process.cwd(), 'public');
                const localPath = path.join(publicDir, fixedFileName);
                await fs.writeFile(localPath, newCsv, 'utf8');
                newPath = `/${fixedFileName}`;
              } else {
                const fbPath = `${directory}/${fixedFileName}`.replace(
                  /\/+/g,
                  '/',
                );
                newPath = saveMode === 'overwrite' ? filePath : fbPath;
                const newBlob = new Blob([newCsv], { type: 'text/csv' });
                await filebrowserClient.uploadFile(
                  newBlob,
                  newPath,
                  saveMode === 'overwrite',
                );
              }

              // Only count as processed if fixes were made
              stats.processedFiles++;
            }

            stats.currentFile = undefined;

            sendEvent('file-complete', {
              filename: searchResult.filename,
              matchesCount: fileFixes,
              replacementsCount: fileFixes,
              newPath,
            });

            sendEvent('stats', { ...stats });
          } catch (error) {
            sendEvent('error', {
              filename: searchResult.filename,
              error:
                error instanceof Error ? error.message : 'Unknown error',
            });
          }
        }

        // Send complete event
        sendEvent('complete', {
          stats: {
            totalFiles: stats.totalFiles,
            processedFiles: stats.processedFiles,
            totalRows: stats.totalRows,
            processedRows: stats.processedRows,
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

