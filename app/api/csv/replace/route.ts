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

interface ReplaceRequest {
  searchResults: SearchResult[];
  replaceTargetField?: string; // Keep for backwards compatibility
  replaceValue?: string; // Keep for backwards compatibility
  replaceOperations?: Array<{ field: string; value: string }>; // New: multiple replacements
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
        const body: ReplaceRequest = await request.json();
        const {
          searchResults,
          replaceTargetField,
          replaceValue,
          replaceOperations,
          saveMode = 'filebrowser',
        } = body;

        if (!searchResults || searchResults.length === 0) {
          sendEvent('error', { message: 'No search results provided' });
          controller.close();
          return;
        }

        // Build replace operations array (support both old and new format)
        let operations: Array<{ field: string; value: string }> = [];
        
        if (replaceOperations && replaceOperations.length > 0) {
          // New format: multiple operations
          operations = replaceOperations;
        } else if (replaceTargetField) {
          // Old format: single field/value (backwards compatible)
          if (replaceValue === undefined || replaceValue === null) {
            sendEvent('error', {
              message: 'Replace value must be provided (empty string is allowed)',
            });
            controller.close();
            return;
          }
          operations = [{ field: replaceTargetField, value: replaceValue }];
        } else {
          sendEvent('error', {
            message: 'Either replaceOperations or replaceTargetField must be provided',
          });
          controller.close();
          return;
        }

        // Validate all operations
        for (const op of operations) {
          if (!op.field) {
            sendEvent('error', {
              message: 'All replace operations must have a field specified',
            });
            controller.close();
            return;
          }
          if (op.value === undefined || op.value === null) {
            sendEvent('error', {
              message: 'All replace operations must have a value specified (empty string is allowed)',
            });
            controller.close();
            return;
          }
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
        // NOTE: We are NOT re-searching. We use the search results directly.
        // We download and parse the full CSV (necessary to modify it), but only
        // replace the specific rows that were found during the search.
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

            // Check if all replace operation fields exist in headers
            const invalidFields = operations
              .map((op) => op.field)
              .filter((field) => !headers.includes(field));
            
            if (invalidFields.length > 0) {
              sendEvent('error', {
                filename: searchResult.filename,
                error: `Fields not found in CSV headers: ${invalidFields.join(', ')}`,
              });
              continue;
            }

            sendEvent('file-info', {
              filename: searchResult.filename,
              totalRows: rows.length,
              fieldsToReplace: operations.length,
            });

            // Create a map of row indices that need replacement
            const rowsToReplace = new Set(
              searchResult.rows.map((r) => r.rowIndex - 1),
            ); // Convert to 0-based index

            const processedRows: Record<string, string>[] = [];
            let fileReplacements = 0;

            // Process each row
            for (let i = 0; i < rows.length; i++) {
              const row = { ...rows[i] };
              const rowMatchesEvents: Array<{
                field: string;
                oldValue: string;
                newValue: string;
              }> = [];

              // Only replace if this row was in the search results
              if (rowsToReplace.has(i)) {
                // Track if location is being replaced
                let locationReplacement: { oldValue: string; newValue: string } | null = null;
                
                // Process all replace operations for this row
                for (const op of operations) {
                  // Check if field exists in headers (should already be validated, but double-check)
                  if (!headers.includes(op.field)) {
                    continue; // Skip if field doesn't exist
                  }

                  const oldValue = row[op.field] ?? '';
                  const newValue = op.value;

                  if (oldValue !== newValue) {
                    row[op.field] = newValue;
                    fileReplacements++;
                    stats.totalReplacements++;

                    rowMatchesEvents.push({
                      field: op.field,
                      oldValue,
                      newValue,
                    });

                    // Track location replacement for slug_url update
                    if (op.field === 'location') {
                      locationReplacement = { oldValue, newValue };
                    }
                  }
                }

                // Update slug_url if location was replaced
                if (locationReplacement && headers.includes('slug_url')) {
                  const currentSlugUrl = (row['slug_url'] ?? '').toString().trim();
                  
                  // Only process if slug_url contains -salary
                  if (currentSlugUrl.includes('-salary')) {
                    // Find the position of -salary
                    const salaryIndex = currentSlugUrl.indexOf('-salary');
                    if (salaryIndex !== -1) {
                      // Extract base part (everything up to and including -salary)
                      const baseSlug = currentSlugUrl.substring(0, salaryIndex + 7); // 7 = length of '-salary'
                      
                      // Normalize the new location
                      const normalizedNewLocation = normalizeToKebabCase(locationReplacement.newValue);
                      
                      let newSlugUrl: string;
                      if (normalizedNewLocation) {
                        // Append new location: -salary-{location}
                        newSlugUrl = `${baseSlug}-${normalizedNewLocation}`;
                      } else {
                        // New location is empty, just keep -salary (remove any existing location suffix)
                        newSlugUrl = baseSlug;
                      }
                      
                      // Only update if slug_url actually changed
                      if (newSlugUrl !== currentSlugUrl) {
                        row['slug_url'] = newSlugUrl;
                        fileReplacements++;
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
              }

              processedRows.push(row);
              stats.processedRows++;

              // Send row-processed event for replaced rows
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

            // Track file replacements (for stats, though not part of ProcessStats interface)

            // Only save if replacements were actually made
            let newPath: string | null = null;
            
            if (fileReplacements > 0) {
              // Save the modified CSV
              const newCsv = Papa.unparse(processedRows, { header: true });

              const pathParts = filePath.split('/');
              const fileName = pathParts.pop() || 'file.csv';
              const directory = pathParts.join('/') || '/';
              const nameWithoutExt = fileName.replace(/\.csv$/i, '');
              const replacedFileName = `${nameWithoutExt}_replaced.csv`;

              if (saveMode === 'local') {
                const publicDir = path.join(process.cwd(), 'public');
                const localPath = path.join(publicDir, replacedFileName);
                await fs.writeFile(localPath, newCsv, 'utf8');
                newPath = `/${replacedFileName}`;
              } else {
                const fbPath = `${directory}/${replacedFileName}`.replace(
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

              // Only count as processed if replacements were made
              stats.processedFiles++;
            }

            stats.currentFile = undefined;

            sendEvent('file-complete', {
              filename: searchResult.filename,
              matchesCount: fileReplacements,
              replacementsCount: fileReplacements,
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

