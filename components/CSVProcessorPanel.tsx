'use client';

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Search, Replace, Loader2, ChevronDown, ChevronRight } from 'lucide-react';

const CSV_FIELDS = [
  'All',
  'slug_url',
  'title',
  'occ_name',
  'country',
  'state',
  'location',
  'avg_annual_salary',
  'avg_hourly_salary',
  'hourly_low_value',
  'hourly_high_value',
  'fortnightly_salary',
  'monthly_salary',
  'total_pay_min',
  'total_pay_max',
  'bonus_range_min',
  'bonus_range_max',
  'profit_sharing_min',
  'profit_sharing_max',
  'commission_min',
  'commission_max',
  'gender_male',
  'gender_female',
  'one_yr',
  'one_four_yrs',
  'five_nine_yrs',
  'ten_nineteen_yrs',
  'twenty_yrs_plus',
  'percentile_10',
  'percentile_25',
  'percentile_50',
  'percentile_75',
  'percentile_90',
  'skills',
  'data_source',
  'contribution_count',
  'last_verified_at',
  'created_at',
  'updated_at',
  'company_name',
];

interface ProcessStats {
  totalFiles: number;
  processedFiles: number;
  totalRows: number;
  processedRows: number;
  totalMatches: number;
  totalReplacements: number;
  currentFile?: string;
}

type SaveMode = 'filebrowser' | 'overwrite' | 'local';

interface FileResultRow {
  rowIndex: number;
  fields: Record<string, string>;
}

interface FileResult {
  filename: string;
  path: string;
  matches: number;
  rows: FileResultRow[];
}

interface CSVProcessorPanelProps {
  selectedFiles: Array<{ path: string; name: string }>;
}

export function CSVProcessorPanel({ selectedFiles }: CSVProcessorPanelProps) {
  const [selectedFields, setSelectedFields] = useState<string[]>(['All']);
  const [searchTerm, setSearchTerm] = useState('');
  const [replaceTerm, setReplaceTerm] = useState('');
  const [showOnlyMatches, setShowOnlyMatches] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [stats, setStats] = useState<ProcessStats | null>(null);
  const [fileResults, setFileResults] = useState<Map<string, FileResult>>(
    new Map(),
  );
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [saveMode, setSaveMode] = useState<SaveMode>('filebrowser');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [currentFileName, setCurrentFileName] = useState<string>('');
  const [fieldFilter, setFieldFilter] = useState<string>('All');
  const eventSourceRef = useRef<EventSource | null>(null);

  const handleFieldToggle = (field: string) => {
    if (field === 'All') {
      setSelectedFields(['All']);
    } else {
      setSelectedFields((prev) => {
        const newFields = prev.filter((f) => f !== 'All');
        if (newFields.includes(field)) {
          return newFields.filter((f) => f !== field);
        } else {
          return [...newFields, field];
        }
      });
    }
  };

  const startProcessing = async (mode: 'search' | 'replace') => {
    if (!searchTerm || selectedFiles.length === 0) {
      alert('Please select files and enter a search term');
      return;
    }

    // For replace mode, require a replace term
    if (mode === 'replace' && !replaceTerm) {
      alert('Please enter a replacement value for Replace All');
      return;
    }

    setIsProcessing(true);
    setStats(null);
    setFileResults(new Map()); // clear previous results
    setExpandedFiles(new Set());
    setCurrentFileName('');

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    try {
      const response = await fetch('/api/csv/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: selectedFiles,
          searchTerm,
          // Only send replaceTerm in replace mode
          replaceTerm: mode === 'replace' && replaceTerm ? replaceTerm : undefined,
          selectedFields: selectedFields.includes('All') ? [] : selectedFields,
          showOnlyMatches,
          // Only meaningful in replace mode; search mode ignores this
          saveMode: mode === 'replace' ? saveMode : 'filebrowser',
          caseSensitive,
          wholeWord,
          useRegex,
        }),
      });

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEventType = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Process remaining buffer
          if (buffer.trim()) {
            const lines = buffer.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.substring(6));
                  handleEvent(currentEventType, data);
                } catch (e) {
                  console.error('Failed to parse event data:', e);
                }
              }
            }
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          
          if (trimmed === '') {
            // Empty line - event block complete, reset
            currentEventType = '';
            continue;
          }

          if (line.startsWith('event: ')) {
            currentEventType = line.substring(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
              handleEvent(currentEventType, data);
            } catch (e) {
              console.error('Failed to parse event data:', e, line);
            }
          }
        }
      }
    } catch (error) {
      console.error('Processing error:', error);
      setIsProcessing(false);
      alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleEvent = (eventType: string, data: any) => {
    switch (eventType) {
      case 'file-start': {
        const fileKey = data.filename || data.path || '';
        setCurrentFileName(fileKey);
        // initialise file bucket
        setFileResults((prev) => {
          const map = new Map(prev);
          if (!map.has(fileKey)) {
            map.set(fileKey, {
              filename: fileKey,
              path: data.path || '',
              matches: 0,
              rows: [],
            });
          }
          return map;
        });
        break;
      }
      case 'file-info':
        setCurrentFileName(data.filename || '');
        break;
      case 'row-processed':
        if (data.matches && data.matches.length > 0) {
          // Group results per file
          setFileResults((prev) => {
            const map = new Map(prev);
            const fileKey = data.filename || data.filePath || currentFileName;

            const existing: FileResult =
              map.get(fileKey) ?? {
                filename: fileKey,
                path: data.filePath || '',
                matches: 0,
                rows: [],
              };

            const rowIndex = data.rowIndex || existing.rows.length + 1;

            // build fields from this event
            const fields: Record<string, string> = {};
            data.matches.forEach((match: any) => {
              if (match.newValue && match.newValue !== match.oldValue) {
                fields[match.field] = `${match.oldValue} → ${match.newValue}`;
              } else {
                fields[match.field] = match.oldValue || '';
              }
            });

            const existingRowIndex = existing.rows.findIndex(
              (r) => r.rowIndex === rowIndex,
            );

            if (existingRowIndex >= 0) {
              // merge into existing row (avoid duplicates)
              const existingRow = existing.rows[existingRowIndex];
              const mergedFields = { ...existingRow.fields, ...fields };

              // count only newly added fields as new matches
              const newFieldKeys = Object.keys(fields).filter(
                (key) => !existingRow.fields[key],
              );
              existing.matches += newFieldKeys.length;

              existing.rows[existingRowIndex] = {
                rowIndex,
                fields: mergedFields,
              };
            } else {
              // new row for this file
              existing.rows.push({
                rowIndex,
                fields,
              });
              existing.matches += data.matches.length;
            }

            map.set(fileKey, existing);
            return map;
          });
        }
        break;
      case 'stats':
        setStats(data);
        break;
      case 'file-complete':
        setCurrentFileName('');
        if (data?.filename) {
          setExpandedFiles((prev) => {
            const next = new Set(prev);
            next.add(data.filename);
            return next;
          });
        }
        break;
      case 'complete':
        setIsProcessing(false);
        alert(
          `Processing complete! Processed ${data.stats?.processedFiles || 0} files, found ${data.stats?.totalMatches || 0} matches.`
        );
        break;
      case 'error':
        console.error('Processing error:', data.error || data.message);
        setIsProcessing(false);
        alert(`Error: ${data.error || data.message || 'Unknown error'}`);
        break;
      default:
        // Handle direct data objects without event type
        if (data.filename) setCurrentFileName(data.filename);
        if (data.totalFiles !== undefined) setStats(data);
    }
  };

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-white dark:bg-zinc-900">
      <div className="border-b p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">CSV Search & Replace</h2>
          {selectedFiles.length > 0 && (
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''} ready
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-6">
        {/* Fields Section */}
        <div>
          <Label className="text-sm font-medium mb-2 block">Fields</Label>
          <div className="flex flex-wrap gap-2 mb-2">
            {CSV_FIELDS.slice(0, 4).map((field) => (
              <Button
                key={field}
                variant={
                  selectedFields.includes(field) ? 'default' : 'outline'
                }
                size="sm"
                onClick={() => handleFieldToggle(field)}
              >
                {field}
              </Button>
            ))}
            <Select
              value={selectedFields.includes('All') ? 'All' : 'custom'}
              onValueChange={(value) => {
                if (value === 'All') {
                  setSelectedFields(['All']);
                }
              }}
            >
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All</SelectItem>
                {CSV_FIELDS.slice(4).map((field) => (
                  <SelectItem key={field} value={field}>
                    {field}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Search & Replace Section */}
        <div className="space-y-4">
          <div>
            <Label htmlFor="search-from">From</Label>
            <div className="flex gap-2 mt-1">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                <Input
                  id="search-from"
                  placeholder="Search Keyword"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      !isProcessing &&
                      searchTerm &&
                      selectedFiles.length > 0
                    ) {
                      startProcessing('search');
                    }
                  }}
                  className="pl-10"
                />
              </div>
              <Button
                variant="outline"
                onClick={() => startProcessing('search')}
                disabled={isProcessing || !searchTerm || selectedFiles.length === 0}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Searching...
                  </>
                ) : (
                  <>
                    <Search className="mr-2 h-4 w-4" />
                    Search
                  </>
                )}
              </Button>

              {/* VS Code-style search options */}
              <div className="flex gap-1 border rounded-md p-1">
                <Button
                  type="button"
                  variant={caseSensitive ? 'default' : 'ghost'}
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => setCaseSensitive((v) => !v)}
                  title="Match Case (Aa)"
                >
                  Aa
                </Button>
                <Button
                  type="button"
                  variant={wholeWord ? 'default' : 'ghost'}
                  size="sm"
                  className="h-8 px-2 text-xs font-mono"
                  onClick={() => setWholeWord((v) => !v)}
                  title="Match Whole Word"
                >
                  W
                </Button>
                <Button
                  type="button"
                  variant={useRegex ? 'default' : 'ghost'}
                  size="sm"
                  className="h-8 px-2 text-xs font-mono"
                  onClick={() => setUseRegex((v) => !v)}
                  title="Use Regular Expression"
                >
                  .*
                </Button>
              </div>
            </div>
          </div>

          {/* Save mode options for Replace All */}
          <div className="mt-2 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
            <div className="font-medium text-zinc-700 dark:text-zinc-200">
              Output destination (for Replace All)
            </div>
            <div className="flex flex-wrap gap-3">
              {/* Save in Filebrowser */}
              <button
                type="button"
                onClick={() => setSaveMode('filebrowser')}
                className={`inline-flex items-center gap-2 px-2 py-1 rounded border text-xs
                  ${
                    saveMode === 'filebrowser'
                      ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black'
                      : 'border-zinc-300 hover:border-zinc-600 dark:border-zinc-700 dark:hover:border-zinc-400'
                  }`}
              >
                <span
                  className={`h-3 w-3 rounded-full border ${
                    saveMode === 'filebrowser'
                      ? 'bg-white border-white'
                      : 'border-zinc-400'
                  }`}
                />
                Save in Filebrowser
              </button>

              {/* Overwrite in Filebrowser */}
              <button
                type="button"
                onClick={() => setSaveMode('overwrite')}
                className={`inline-flex items-center gap-2 px-2 py-1 rounded border text-xs
                  ${
                    saveMode === 'overwrite'
                      ? 'border-red-600 bg-red-600 text-white'
                      : 'border-zinc-300 hover:border-red-600 dark:border-zinc-700 dark:hover:border-red-500'
                  }`}
              >
                <span
                  className={`h-3 w-3 rounded-full border ${
                    saveMode === 'overwrite'
                      ? 'bg-white border-white'
                      : 'border-zinc-400'
                  }`}
                />
                Overwrite in Filebrowser
              </button>

              {/* Save Local */}
              <button
                type="button"
                onClick={() => setSaveMode('local')}
                className={`inline-flex items-center gap-2 px-2 py-1 rounded border text-xs
                  ${
                    saveMode === 'local'
                      ? 'border-emerald-600 bg-emerald-600 text-white'
                      : 'border-zinc-300 hover:border-emerald-600 dark:border-zinc-700 dark:hover:border-emerald-500'
                  }`}
              >
                <span
                  className={`h-3 w-3 rounded-full border ${
                    saveMode === 'local'
                      ? 'bg-white border-white'
                      : 'border-zinc-400'
                  }`}
                />
                Save Local
              </button>
            </div>
          </div>

          <div>
            <Label htmlFor="search-to">To</Label>
            <div className="flex gap-2 mt-1">
              <Input
                id="search-to"
                placeholder="Replace with..."
                value={replaceTerm}
                onChange={(e) => setReplaceTerm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isProcessing && searchTerm && replaceTerm && selectedFiles.length > 0) {
                    startProcessing('replace');
                  }
                }}
                className="flex-1"
              />
              <Button
                onClick={() => startProcessing('replace')}
                disabled={
                  isProcessing ||
                  !searchTerm ||
                  !replaceTerm ||
                  selectedFiles.length === 0
                }
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <Replace className="mr-2 h-4 w-4" />
                    Replace All
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="show-matches"
              checked={showOnlyMatches}
              onCheckedChange={(checked) =>
                setShowOnlyMatches(checked === true)
              }
            />
            <Label
              htmlFor="show-matches"
              className="text-sm font-normal cursor-pointer"
            >
              Show only rows with matches
            </Label>
          </div>
        </div>

        {/* Statistics Section */}
        <div className="grid grid-cols-2 gap-4">
          <div className="border rounded p-4">
            <div className="text-sm text-zinc-600 dark:text-zinc-400">
              Total Found
            </div>
            <div className="text-2xl font-bold">
              {stats?.totalMatches || 0}
            </div>
          </div>
          <div className="border rounded p-4">
            <div className="text-sm text-zinc-600 dark:text-zinc-400">
              General overall Stats
            </div>
            <div className="text-sm">
              Files: {stats?.processedFiles || 0}/{stats?.totalFiles || 0}
              <br />
              Rows: {stats?.processedRows || 0}/{stats?.totalRows || 0}
              {stats?.totalReplacements ? (
                <>
                  <br />
                  Replacements: {stats.totalReplacements}
                </>
              ) : null}
            </div>
          </div>
        </div>

        {/* CSV Filename */}
        {currentFileName && (
          <div>
            <Label>CSV Filename</Label>
            <Input value={currentFileName} readOnly className="mt-1" />
            <p className="text-xs text-zinc-500 mt-1">
              Currently processing: {currentFileName}
            </p>
          </div>
        )}

        {/* Search Results per CSV */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label>Search Results</Label>
            <Select value={fieldFilter} onValueChange={setFieldFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All Fields</SelectItem>
                {CSV_FIELDS.slice(1).map((field) => (
                  <SelectItem key={field} value={field}>
                    {field}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {fileResults.size > 0 ? (
            <div className="space-y-2">
              {Array.from(fileResults.entries()).map(([filename, fileResult]) => {
                const isExpanded = expandedFiles.has(filename);

                const allFields = new Set<string>();
                fileResult.rows.forEach((row) => {
                  Object.keys(row.fields).forEach((f) => allFields.add(f));
                });

                const displayFields =
                  fieldFilter === 'All'
                    ? Array.from(allFields)
                    : [fieldFilter];

                const filteredRows =
                  fieldFilter === 'All'
                    ? fileResult.rows
                    : fileResult.rows.filter((row) =>
                        Object.prototype.hasOwnProperty.call(
                          row.fields,
                          fieldFilter,
                        ),
                      );

                return (
                  <Collapsible
                    key={filename}
                    open={isExpanded}
                    onOpenChange={(open) => {
                      setExpandedFiles((prev) => {
                        const next = new Set(prev);
                        if (open) {
                          next.add(filename);
                        } else {
                          next.delete(filename);
                        }
                        return next;
                      });
                    }}
                  >
                    <div className="border rounded">
                      <CollapsibleTrigger className="w-full p-4 hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center justify-between">
                        <div className="flex items-center gap-3 flex-1 text-left">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                          <div className="flex items-center gap-2 flex-1">
                            <Search className="h-4 w-4 text-zinc-500" />
                            <span className="font-medium">{filename}</span>
                            <span className="text-sm text-zinc-500">
                              ({fileResult.matches} matches in{' '}
                              {fileResult.rows.length} rows)
                            </span>
                          </div>
                        </div>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="border-t overflow-auto max-h-[400px]">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-20">Row</TableHead>
                                {displayFields.map((field) => (
                                  <TableHead
                                    key={field}
                                    className="min-w-[150px]"
                                  >
                                    {field}
                                  </TableHead>
                                ))}
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {filteredRows.map((row, idx) => (
                                <TableRow
                                  key={idx}
                                  className="hover:bg-zinc-50 dark:hover:bg-zinc-800"
                                >
                                  <TableCell className="font-mono text-xs">
                                    {row.rowIndex}
                                  </TableCell>
                                  {displayFields.map((field) => (
                                    <TableCell
                                      key={field}
                                      className="max-w-[300px] truncate"
                                      title={row.fields[field] || '-'}
                                    >
                                      {row.fields[field] || '-'}
                                    </TableCell>
                                  ))}
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                );
              })}
            </div>
          ) : (
            <div className="border rounded p-8 text-center text-zinc-500">
              {isProcessing
                ? 'Processing files... Results will appear as matches are found.'
                : 'No search results yet. Click Search to find matches.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

