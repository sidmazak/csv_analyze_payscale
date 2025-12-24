import { NextRequest } from 'next/server';
import { filebrowserClient } from '@/lib/filebrowser-client';
import Papa from 'papaparse';
import fs from 'fs/promises';
import path from 'path';

type MatchMode = 'contains' | 'equals' | 'regex' | 'startsWith' | 'endsWith';
type AdvancedLogic = 'AND' | 'OR';

interface FieldSearchCondition {
  field: string;
  value: string;
  mode: MatchMode;
}

interface AdvancedSearchConfig {
  conditions: FieldSearchCondition[];
  logic?: AdvancedLogic;
  caseSensitive?: boolean;
}

interface ProcessRequest {
  files: Array<{ path: string; name: string }>;

  // Simple search configuration (backwards compatible)
  searchTerm?: string;
  replaceTerm?: string;
  selectedFields: string[];
  showOnlyMatches: boolean;
  saveMode?: 'filebrowser' | 'overwrite' | 'local';
  caseSensitive?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;

  // Advanced per-field search configuration
  advanced?: AdvancedSearchConfig;

  // Targeted replace field/value (used in advanced mode)
  replaceTargetField?: string;
  replaceValue?: string;
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

function buildFieldMatcher(
  cond: FieldSearchCondition,
  globalCaseSensitive: boolean,
): (raw: string) => boolean {
  const caseSensitive = globalCaseSensitive;
  const mode = cond.mode || 'contains';

  if (mode === 'regex') {
    const flags = caseSensitive ? '' : 'i';
    const re = new RegExp(cond.value, flags);
    return (raw: string) => re.test(raw);
  }

  const needle = caseSensitive ? cond.value : cond.value.toLowerCase();

  return (raw: string) => {
    const hay = caseSensitive ? raw : raw.toLowerCase();
    switch (mode) {
      case 'equals':
        return hay === needle;
      case 'startsWith':
        return hay.startsWith(needle);
      case 'endsWith':
        return hay.endsWith(needle);
      case 'contains':
      default:
        return hay.includes(needle);
    }
  };
}

function rowMatchesAdvanced(
  row: Record<string, string>,
  headers: string[],
  advanced: AdvancedSearchConfig,
): {
  matches: boolean;
  matchedFields: string[];
} {
  const logic: AdvancedLogic = advanced.logic || 'AND';
  const caseSensitive = !!advanced.caseSensitive;

  const activeConds = (advanced.conditions || []).filter(
    (c) => c.value && c.value.trim() !== '',
  );

  if (activeConds.length === 0) {
    // no constraints → match all rows
    return { matches: true, matchedFields: [] };
  }

  const fieldMatchers = activeConds.map((c) => ({
    cond: c,
    match: buildFieldMatcher(c, caseSensitive),
  }));

  const matchedFields: string[] = [];

  if (logic === 'AND') {
    for (const { cond, match } of fieldMatchers) {
      if (!headers.includes(cond.field)) return { matches: false, matchedFields: [] };
      const raw = (row[cond.field] ?? '').toString();
      if (!match(raw)) {
        return { matches: false, matchedFields: [] };
      }
      matchedFields.push(cond.field);
    }
    return { matches: true, matchedFields };
  }

  // OR logic
  let any = false;
  for (const { cond, match } of fieldMatchers) {
    if (!headers.includes(cond.field)) continue;
    const raw = (row[cond.field] ?? '').toString();
    if (match(raw)) {
      any = true;
      matchedFields.push(cond.field);
    }
  }
  return { matches: any, matchedFields: any ? matchedFields : [] };
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
          advanced,
          replaceTargetField,
          replaceValue,
        } = body;

        if (!files || files.length === 0) {
          sendEvent('error', { message: 'Files are required' });
          controller.close();
          return;
        }

        const useAdvanced =
          advanced &&
          Array.isArray(advanced.conditions) &&
          advanced.conditions.length > 0;

        const stats: ProcessStats = {
          totalFiles: files.length,
          processedFiles: 0,
          totalRows: 0,
          processedRows: 0,
          totalMatches: 0,
          totalReplacements: 0,
        };

        const outputFiles: Array<{
          originalPath: string;
          newPath: string | null;
        }> = [];

        if (useAdvanced) {
          await processFilesWithAdvancedSearch(
            {
              files,
              advanced: advanced!,
              replaceTargetField,
              replaceValue,
              showOnlyMatches,
              saveMode,
            },
            stats,
            sendEvent,
          );
          return;
        }

        if (!searchTerm) {
          sendEvent('error', { message: 'Search term is required in simple mode' });
          return;
        }

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

            // Fields to replace (target fields selected by user)
            const replaceFields =
              selectedFields.includes('All') || selectedFields.length === 0
                ? headers
                : selectedFields.filter((f) => headers.includes(f));

            // Fields to SEARCH across (row-level search): use all headers so we can match
            // patterns that span multiple columns (e.g. state + location)
            const searchFields = headers;

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
              // We search across all headers in the row-level search
              fieldsToSearch: searchFields.length,
            });

            // Process each row
            const processedRows: Record<string, string>[] = [];
            let fileMatches = 0;
            let fileReplacements = 0;
            const isReplaceMode = replaceTerm !== undefined && replaceTerm !== '';

            for (let i = 0; i < rows.length; i++) {
              const row = { ...rows[i] };
              const rowMatches: Array<{
                field: string;
                oldValue: string;
                newValue: string;
              }> = [];

              // 1) Build row-level text from all SEARCH fields and test once
              const rowText = searchFields
                .map((field) => (row[field] ?? '').toString())
                .join(' ');

              searchRegex.lastIndex = 0;
              const rowMatched = searchRegex.test(rowText);

              if (!rowMatched) {
                // No match anywhere in this row
                if (!showOnlyMatches) {
                  processedRows.push(row);
                }
                stats.processedRows++;

                // Stats update every 10 rows (progress only)
                if ((i + 1) % 10 === 0 || i === rows.length - 1) {
                  sendEvent('stats', { ...stats });
                }
                continue;
              }

              // 2) Row matched somewhere!
              fileMatches++;
              stats.totalMatches++;

              if (!isReplaceMode) {
                // SEARCH-ONLY MODE: detect matched fields but do not modify values
                for (const field of searchFields) {
                  const value = row[field] || '';

                  searchRegex.lastIndex = 0;
                  if (searchRegex.test(value)) {
                    rowMatches.push({
                      field,
                      oldValue: value,
                      newValue: value,
                    });
                  }
                }
              } else {
                // REPLACE MODE: row satisfied the filter, now overwrite target fields
                for (const field of replaceFields) {
                  const oldValue = row[field] || '';
                  const newValue = replaceTerm!;

                  if (newValue !== oldValue) {
                    fileReplacements++;
                    stats.totalReplacements++;

                    row[field] = newValue;
                    rowMatches.push({
                      field,
                      oldValue,
                      newValue,
                    });
                  }
                }
              }

              // Only include row if it matches (if showOnlyMatches is true) or always include
              // In this case rowMatched is already true
              if (!showOnlyMatches || rowMatched) {
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

async function processFilesWithAdvancedSearch(
  cfg: {
    files: Array<{ path: string; name: string }>;
    advanced: AdvancedSearchConfig;
    replaceTargetField?: string;
    replaceValue?: string;
    showOnlyMatches: boolean;
    saveMode: 'filebrowser' | 'overwrite' | 'local';
  },
  stats: ProcessStats,
  sendEvent: (event: string, data: any) => void,
) {
  const {
    files,
    advanced,
    replaceTargetField,
    replaceValue,
    showOnlyMatches,
    saveMode,
  } = cfg;

  const outputFiles: Array<{ originalPath: string; newPath: string | null }> = [];
  const isReplaceMode = !!(replaceTargetField && replaceValue !== undefined);

  for (const file of files) {
    try {
      stats.currentFile = file.name;
      stats.currentFileRows = 0;
      stats.currentFileMatches = 0;

      sendEvent('file-start', {
        filename: file.name,
        path: file.path,
      });

      const blob = await filebrowserClient.downloadFile(file.path);
      const text = await blob.text();

      const parseResult = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => header.trim(),
      });

      if (parseResult.errors.length > 0) {
        sendEvent('error', {
          filename: file.name,
          error: `CSV parsing errors: ${parseResult.errors
            .map((e) => e.message)
            .join(', ')}`,
        });
        continue;
      }

      const rows = parseResult.data as Record<string, string>[];
      const headers = Object.keys(rows[0] || {});
      stats.totalRows += rows.length;
      stats.currentFileRows = rows.length;

      sendEvent('file-info', {
        filename: file.name,
        totalRows: rows.length,
        fieldsToSearch: headers.length,
      });

      const processedRows: Record<string, string>[] = [];
      let fileMatches = 0;
      let fileReplacements = 0;

      for (let i = 0; i < rows.length; i++) {
        const row = { ...rows[i] };
        const rowMatchesEvents: Array<{
          field: string;
          oldValue: string;
          newValue: string;
        }> = [];

        const { matches: rowMatchesFlag, matchedFields } = rowMatchesAdvanced(
          row,
          headers,
          advanced,
        );

        if (!rowMatchesFlag) {
          if (!showOnlyMatches) {
            processedRows.push(row);
          }
          stats.processedRows++;
          if ((i + 1) % 10 === 0 || i === rows.length - 1) {
            sendEvent('stats', { ...stats });
          }
          continue;
        }

        // Row matched somewhere!
        fileMatches++;
        stats.totalMatches++;

        if (isReplaceMode && replaceTargetField && headers.includes(replaceTargetField)) {
          const oldValue = row[replaceTargetField] ?? '';
          const newValue = replaceValue!;

          if (newValue !== oldValue) {
            row[replaceTargetField] = newValue;

            rowMatchesEvents.push({
              field: replaceTargetField,
              oldValue,
              newValue,
            });

            fileReplacements++;
            stats.totalReplacements++;
          }
        } else {
          for (const field of matchedFields) {
            const value = row[field] ?? '';
            rowMatchesEvents.push({
              field,
              oldValue: value,
              newValue: value,
            });
          }
        }

        if (!showOnlyMatches || rowMatchesEvents.length > 0) {
          processedRows.push(row);
        }

        stats.processedRows++;

        if (rowMatchesEvents.length > 0) {
          sendEvent('row-processed', {
            filename: file.name,
            filePath: file.path,
            rowIndex: i + 1,
            totalRows: rows.length,
            matches: rowMatchesEvents,
          });
        }

        if ((i + 1) % 10 === 0 || i === rows.length - 1) {
          sendEvent('stats', { ...stats });
        }
      }

      stats.currentFileMatches = fileMatches;

      let newPath: string | null = null;
      if (isReplaceMode) {
        const newCsv = Papa.unparse(processedRows, { header: true });

        const pathParts = file.path.split('/');
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
          const fbPath = `${directory}/${replacedFileName}`.replace(/\/+/g, '/');
          newPath = saveMode === 'overwrite' ? file.path : fbPath;
          const newBlob = new Blob([newCsv], { type: 'text/csv' });
          await filebrowserClient.uploadFile(
            newBlob,
            newPath,
            saveMode === 'overwrite',
          );
        }
      }

      outputFiles.push({ originalPath: file.path, newPath });
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
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Send complete event after all files are processed
  sendEvent('complete', {
    outputFiles,
    stats: {
      totalFiles: stats.totalFiles,
      processedFiles: stats.processedFiles,
      totalRows: stats.totalRows,
      processedRows: stats.processedRows,
      totalMatches: stats.totalMatches,
      totalReplacements: stats.totalReplacements,
    },
  });
}

