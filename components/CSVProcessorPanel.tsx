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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Search, Replace, Loader2, ChevronDown, ChevronRight, MapPin, Edit } from 'lucide-react';

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

type MatchMode = 'contains' | 'equals' | 'regex' | 'startsWith' | 'endsWith';
type AdvancedLogic = 'AND' | 'OR';

interface FieldCondition {
  id: string;
  field: string;
  value: string;
  mode: MatchMode;
}

interface ReplaceCondition {
  id: string;
  field: string;
  value: string;
}

export function CSVProcessorPanel({ selectedFiles }: CSVProcessorPanelProps) {
  const [searchTerm, setSearchTerm] = useState(''); // kept for compatibility, not used in advanced mode
  const [replaceTerm, setReplaceTerm] = useState('');
  const [showOnlyMatches, setShowOnlyMatches] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isReplacing, setIsReplacing] = useState(false);
  const [isFixingSlugUrls, setIsFixingSlugUrls] = useState(false);
  const [stats, setStats] = useState<ProcessStats | null>(null);
  const [fileResults, setFileResults] = useState<Map<string, FileResult>>(
    new Map(),
  );
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [saveMode, setSaveMode] = useState<SaveMode>('filebrowser');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [conditions, setConditions] = useState<FieldCondition[]>([]);
  const [advancedLogic, setAdvancedLogic] = useState<AdvancedLogic>('AND');
  const [replaceTargetField, setReplaceTargetField] = useState<string | undefined>();
  const [replaceConditions, setReplaceConditions] = useState<ReplaceCondition[]>([]);
  const [lastAdvancedConfig, setLastAdvancedConfig] = useState<{
    conditions: FieldCondition[];
    logic: AdvancedLogic;
    caseSensitive: boolean;
  } | null>(null);
  const [hasSearchResults, setHasSearchResults] = useState(false);
  const [currentFileName, setCurrentFileName] = useState<string>('');
  const [fieldFilter, setFieldFilter] = useState<string>('All');
  const eventSourceRef = useRef<EventSource | null>(null);
  // Use ref to track operation type (avoids React state closure issues)
  const operationTypeRef = useRef<'search' | 'replace' | 'fix-slug-urls' | null>(null);
  
  // State for location/state detection
  const [isDetecting, setIsDetecting] = useState(false);
  const [uniqueStates, setUniqueStates] = useState<string[]>([]);
  const [uniqueLocations, setUniqueLocations] = useState<string[]>([]);
  const [stateLocationCombos, setStateLocationCombos] = useState<Array<{ state: string; location: string }>>([]);
  const [activeTab, setActiveTab] = useState('find-replace');
  const [shouldAutoTrigger, setShouldAutoTrigger] = useState(false);

  // Check if Fix Slug URLs section should be shown
  const shouldShowFixSlugSection = () => {
    if (!hasSearchResults || fileResults.size === 0) return false;
    
    const hasSlugUrlCondition = conditions.some(
      (cond) =>
        cond.field === 'slug_url' &&
        cond.mode === 'endsWith' &&
        cond.value === '-salary'
    );
    const hasLocationCondition = conditions.some(
      (cond) =>
        cond.field === 'location' &&
        cond.mode === 'regex' &&
        cond.value === '.+'
    );
    
    return hasSlugUrlCondition && hasLocationCondition;
  };

  const addCondition = () => {
    setConditions((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        field: CSV_FIELDS[1] || 'slug_url',
        value: '',
        mode: 'contains',
      },
    ]);
  };

  const updateCondition = (id: string, patch: Partial<FieldCondition>) => {
    setConditions((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    );
  };

  const removeCondition = (id: string) => {
    setConditions((prev) => prev.filter((c) => c.id !== id));
  };

  const addReplaceCondition = () => {
    setReplaceConditions((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        field: CSV_FIELDS[1] || 'slug_url',
        value: '',
      },
    ]);
  };

  const updateReplaceCondition = (id: string, patch: Partial<ReplaceCondition>) => {
    setReplaceConditions((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    );
  };

  const removeReplaceCondition = (id: string) => {
    setReplaceConditions((prev) => prev.filter((c) => c.id !== id));
  };

  const startReplace = async () => {
    // Filter out invalid conditions
    const activeReplaceConditions = replaceConditions.filter(
      (cond) => cond.field && cond.value !== undefined && cond.value !== null
    );

    if (activeReplaceConditions.length === 0) {
      alert('Please add at least one replace condition with a field and value');
      return;
    }

    if (fileResults.size === 0 || !hasSearchResults) {
      alert('No search results found. Please run a search first.');
      return;
    }

    setIsProcessing(true);
    setIsReplacing(true);
    operationTypeRef.current = 'replace'; // Track operation type
    setStats(null);
    setCurrentFileName('');

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    try {
      // Convert fileResults to API format - ONLY files with matches
      const searchResults = Array.from(fileResults.values())
        .filter((fileResult) => fileResult.rows.length > 0) // Only files with matches
        .map((fileResult) => ({
          filename: fileResult.filename,
          path: fileResult.path,
          rows: fileResult.rows.map((row) => ({
            rowIndex: row.rowIndex,
            fields: row.fields,
          })),
        }));

      if (searchResults.length === 0) {
        alert('No files with matches found. Please run a search first.');
        setIsProcessing(false);
        setIsReplacing(false);
        operationTypeRef.current = null;
        return;
      }

      // Build replace operations array
      const replaceOperations: Array<{ field: string; value: string }> = [];
      
      for (const cond of activeReplaceConditions) {
        const actualValue = cond.value.trim().toLowerCase() === 'empty' ? '' : cond.value;
        replaceOperations.push({
          field: cond.field,
          value: actualValue,
        });
      }

      const payload = {
        searchResults,
        replaceOperations,
        saveMode,
      };

      const response = await fetch('/api/csv/replace', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
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
          // Process remaining buffer - must handle both event: and data: lines
          let completeEventProcessed = false;
          if (buffer.trim()) {
            const lines = buffer.split('\n');
            let tempEventType = currentEventType;
            
            for (const line of lines) {
              const trimmed = line.trim();
              
              if (trimmed === '') {
                // Empty line - event block complete, reset
                tempEventType = '';
                continue;
              }
              
              if (line.startsWith('event: ')) {
                tempEventType = line.substring(7).trim();
                if (tempEventType === 'complete') {
                  completeEventProcessed = true;
                }
              } else if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.substring(6));
                  handleEvent(tempEventType, data);
                } catch (e) {
                  console.error('Failed to parse event data:', e);
                }
              }
            }
          }
          // Only reset if complete event wasn't processed (it handles its own state reset)
          if (!completeEventProcessed) {
            setIsProcessing(false);
            setIsReplacing(false);
            operationTypeRef.current = null;
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
      console.error('Replace error:', error);
      setIsProcessing(false);
      setIsReplacing(false);
      operationTypeRef.current = null;
      alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const startFixSlugUrls = async () => {
    if (fileResults.size === 0 || !hasSearchResults) {
      alert('No search results found. Please run a search first.');
      return;
    }

    if (!shouldShowFixSlugSection()) {
      alert('Fix Slug URLs is only available when searching for slug_url ending with "-salary" and location with regex ".+"');
      return;
    }

    setIsProcessing(true);
    setIsFixingSlugUrls(true);
    operationTypeRef.current = 'fix-slug-urls';
    setStats(null);
    setCurrentFileName('');

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    try {
      // Convert fileResults to API format - ONLY files with matches
      const searchResults = Array.from(fileResults.values())
        .filter((fileResult) => fileResult.rows.length > 0) // Only files with matches
        .map((fileResult) => ({
          filename: fileResult.filename,
          path: fileResult.path,
          rows: fileResult.rows.map((row) => ({
            rowIndex: row.rowIndex,
            fields: row.fields,
          })),
        }));

      if (searchResults.length === 0) {
        alert('No files with matches found. Please run a search first.');
        setIsProcessing(false);
        setIsFixingSlugUrls(false);
        operationTypeRef.current = null;
        return;
      }

      const payload = {
        searchResults,
        saveMode,
      };

      const response = await fetch('/api/csv/fix-slug-urls', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
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
          // Process remaining buffer - must handle both event: and data: lines
          let completeEventProcessed = false;
          if (buffer.trim()) {
            const lines = buffer.split('\n');
            let tempEventType = currentEventType;

            for (const line of lines) {
              const trimmed = line.trim();

              if (trimmed === '') {
                // Empty line - event block complete, reset
                tempEventType = '';
                continue;
              }

              if (line.startsWith('event: ')) {
                tempEventType = line.substring(7).trim();
                if (tempEventType === 'complete') {
                  completeEventProcessed = true;
                }
              } else if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.substring(6));
                  handleEvent(tempEventType, data);
                } catch (e) {
                  console.error('Failed to parse event data:', e);
                }
              }
            }
          }
          // Only reset if complete event wasn't processed (it handles its own state reset)
          if (!completeEventProcessed) {
            setIsProcessing(false);
            setIsFixingSlugUrls(false);
            operationTypeRef.current = null;
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
      console.error('Fix Slug URLs error:', error);
      setIsProcessing(false);
      setIsFixingSlugUrls(false);
      operationTypeRef.current = null;
      alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const startProcessing = async () => {
    if (selectedFiles.length === 0) {
      alert('Please select at least one file');
      return;
    }

    const isAdvanced = conditions.length > 0;

    if (!isAdvanced) {
      alert('Add at least one advanced search condition');
      return;
    }

    setIsProcessing(true);
    setIsReplacing(false);
    operationTypeRef.current = 'search'; // Track operation type
    setStats(null);
    setCurrentFileName('');

    // clear previous results and remember config
    setFileResults(new Map());
    setExpandedFiles(new Set());
    setHasSearchResults(false);
    setLastAdvancedConfig({
      conditions: [...conditions],
      logic: advancedLogic,
      caseSensitive,
    });

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    try {
      const payload: any = {
        files: selectedFiles,
        showOnlyMatches,
        saveMode: 'filebrowser',
        advanced: {
          conditions: conditions.map(({ field, value, mode }) => ({
            field,
            value,
            mode,
          })),
          logic: advancedLogic,
          caseSensitive,
        },
      };

      const response = await fetch('/api/csv/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
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
          // Process remaining buffer - must handle both event: and data: lines
          let completeEventProcessed = false;
          if (buffer.trim()) {
            const lines = buffer.split('\n');
            let tempEventType = currentEventType;
            
            for (const line of lines) {
              const trimmed = line.trim();
              
              if (trimmed === '') {
                // Empty line - event block complete, reset
                tempEventType = '';
                continue;
              }
              
              if (line.startsWith('event: ')) {
                tempEventType = line.substring(7).trim();
                if (tempEventType === 'complete') {
                  completeEventProcessed = true;
                }
              } else if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.substring(6));
                  handleEvent(tempEventType, data);
                } catch (e) {
                  console.error('Failed to parse event data:', e);
                }
              }
            }
          }
          // Only reset if complete event wasn't processed (it handles its own state reset)
          if (!completeEventProcessed) {
            setIsProcessing(false);
            operationTypeRef.current = null;
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
      operationTypeRef.current = null;
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
          setHasSearchResults(true);
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
        // Use ref to get operation type (avoids React state closure issues)
        const operationType = operationTypeRef.current;
        setIsProcessing(false);
        setIsReplacing(false);
        setIsFixingSlugUrls(false);
        operationTypeRef.current = null; // Reset after use
        
        if (operationType === 'replace') {
          const filesProcessed = data.stats?.totalFiles || 0;
          const filesWithReplacements = data.stats?.processedFiles || 0;
          const totalReplacements = data.stats?.totalReplacements || 0;
          
          if (filesWithReplacements === 0) {
            alert(
              `Replace All complete! No replacements were made. Processed ${filesProcessed} file${filesProcessed !== 1 ? 's' : ''} with matches, but no values needed to be replaced.`
            );
          } else {
            alert(
              `Replace All complete! Replaced ${totalReplacements} value${totalReplacements !== 1 ? 's' : ''} in ${filesWithReplacements} file${filesWithReplacements !== 1 ? 's' : ''} out of ${filesProcessed} file${filesProcessed !== 1 ? 's' : ''} processed.`
            );
          }
        } else if (operationType === 'fix-slug-urls') {
          const filesProcessed = data.stats?.totalFiles || 0;
          const filesFixed = data.stats?.processedFiles || 0;
          const totalFixed = data.stats?.totalReplacements || 0; // Reusing totalReplacements for count
          
          if (filesFixed === 0) {
            alert(
              `Fix Slug URLs complete! No slug URLs were fixed. Processed ${filesProcessed} file${filesProcessed !== 1 ? 's' : ''} with matches, but no slug URLs needed to be fixed.`
            );
          } else {
            alert(
              `Fix Slug URLs complete! Fixed ${totalFixed} slug URL${totalFixed !== 1 ? 's' : ''} in ${filesFixed} file${filesFixed !== 1 ? 's' : ''} out of ${filesProcessed} file${filesProcessed !== 1 ? 's' : ''} processed.`
            );
          }
        } else {
          alert(
            `Search complete! Found ${data.stats?.totalMatches || 0} match${data.stats?.totalMatches !== 1 ? 'es' : ''} in ${data.stats?.processedFiles || 0} file${data.stats?.processedFiles !== 1 ? 's' : ''}.`
          );
        }
        break;
      case 'error':
        console.error('Processing error:', data.error || data.message);
        const operationTypeOnError = operationTypeRef.current;
        setIsProcessing(false);
        setIsReplacing(false);
        setIsFixingSlugUrls(false);
        operationTypeRef.current = null;
        let errorMsg = '';
        if (operationTypeOnError === 'replace') {
          errorMsg = `Replace All error: ${data.error || data.message || 'Unknown error'}`;
        } else if (operationTypeOnError === 'fix-slug-urls') {
          errorMsg = `Fix Slug URLs error: ${data.error || data.message || 'Unknown error'}`;
        } else {
          errorMsg = `Search error: ${data.error || data.message || 'Unknown error'}`;
        }
        alert(errorMsg);
        break;
      default:
        // Handle direct data objects without event type
        if (data.filename) setCurrentFileName(data.filename);
        if (data.totalFiles !== undefined) setStats(data);
    }
  };

  // Function to start location/state detection
  const startDetection = async () => {
    if (selectedFiles.length === 0) {
      alert('Please select at least one CSV file');
      return;
    }

    setIsDetecting(true);
    setUniqueStates([]);
    setUniqueLocations([]);
    setStateLocationCombos([]);

    try {
      const response = await fetch('/api/csv/detect-location-state', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files: selectedFiles }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Detection failed' }));
        throw new Error(errorData.error || 'Detection failed');
      }

      const data = await response.json();
      setUniqueStates(data.uniqueStates || []);
      setUniqueLocations(data.uniqueLocations || []);
      setStateLocationCombos(data.stateLocationCombos || []);
    } catch (error) {
      console.error('Detection error:', error);
      alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsDetecting(false);
    }
  };

  // Function to handle edit from unique states table
  const handleEditFromState = (stateValue: string) => {
    // Switch to Find & Replace tab
    setActiveTab('find-replace');
    
    // Check if state is empty or whitespace only
    const isStateEmpty = !stateValue || stateValue.trim() === '';
    
    // Clear existing conditions and set new ones
    setConditions([
      {
        id: crypto.randomUUID(),
        field: 'state',
        value: isStateEmpty ? '^\\s*$' : stateValue,
        mode: isStateEmpty ? 'regex' : 'equals',
      },
    ]);
    
    // Set logic to AND
    setAdvancedLogic('AND');
    
    // Clear previous results
    setFileResults(new Map());
    setExpandedFiles(new Set());
    setHasSearchResults(false);
    setStats(null);
    
    // Reset Replace All section completely
    setReplaceConditions([]);
    setReplaceTargetField(undefined);
    setReplaceTerm('');
    
    // Set flag to auto-trigger search after state updates
    setShouldAutoTrigger(true);
  };

  // Function to handle edit from state & location combinations table
  const handleEditFromCombo = (stateValue: string, locationValue: string) => {
    // Switch to Find & Replace tab
    setActiveTab('find-replace');
    
    // Clear existing conditions and set new ones
    const newConditions: FieldCondition[] = [];
    
    // Handle state - check if empty or whitespace only
    const isStateEmpty = !stateValue || stateValue.trim() === '';
    // Always add state condition (even if empty, use regex to match empty)
    newConditions.push({
      id: crypto.randomUUID(),
      field: 'state',
      value: isStateEmpty ? '^\\s*$' : stateValue,
      mode: isStateEmpty ? 'regex' : 'equals',
    });
    
    // Handle location - check if empty or whitespace only
    const isLocationEmpty = !locationValue || locationValue.trim() === '';
    // Always add location condition (even if empty, use regex to match empty)
    newConditions.push({
      id: crypto.randomUUID(),
      field: 'location',
      value: isLocationEmpty ? '^\\s*$' : locationValue,
      mode: isLocationEmpty ? 'regex' : 'equals',
    });
    
    setConditions(newConditions);
    
    // Set logic to AND
    setAdvancedLogic('AND');
    
    // Clear previous results
    setFileResults(new Map());
    setExpandedFiles(new Set());
    setHasSearchResults(false);
    setStats(null);
    
    // Reset Replace All section completely
    setReplaceConditions([]);
    setReplaceTargetField(undefined);
    setReplaceTerm('');
    
    // Set flag to auto-trigger search after state updates
    setShouldAutoTrigger(true);
  };

  // Function to handle edit from unique locations table
  const handleEditFromLocation = (locationValue: string) => {
    // Switch to Find & Replace tab
    setActiveTab('find-replace');
    
    // Check if location is empty or whitespace only
    const isLocationEmpty = !locationValue || locationValue.trim() === '';
    
    // Clear existing conditions and set new ones
    setConditions([
      {
        id: crypto.randomUUID(),
        field: 'location',
        value: isLocationEmpty ? '^\\s*$' : locationValue,
        mode: isLocationEmpty ? 'regex' : 'equals',
      },
    ]);
    
    // Set logic to AND
    setAdvancedLogic('AND');
    
    // Clear previous results
    setFileResults(new Map());
    setExpandedFiles(new Set());
    setHasSearchResults(false);
    setStats(null);
    
    // Reset Replace All section completely
    setReplaceConditions([]);
    setReplaceTargetField(undefined);
    setReplaceTerm('');
    
    // Set flag to auto-trigger search after state updates
    setShouldAutoTrigger(true);
  };

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Auto-trigger search when conditions are set from edit buttons
  useEffect(() => {
    if (shouldAutoTrigger && conditions.length > 0 && selectedFiles.length > 0 && !isProcessing) {
      // Reset the flag first to prevent re-triggering
      setShouldAutoTrigger(false);
      
      // Trigger search with current conditions (state is now updated)
      startProcessing();
    }
  }, [shouldAutoTrigger, conditions, selectedFiles.length, isProcessing]);

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

      <div className="flex-1 overflow-auto p-4">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="find-replace">Find & Replace</TabsTrigger>
            <TabsTrigger value="detect-location-state">Detect Location & State</TabsTrigger>
          </TabsList>

          {/* Find & Replace Tab */}
          <TabsContent value="find-replace" className="space-y-6">
        {/* Search Section (Advanced only) */}
        <div className="space-y-4">
          <div className="space-y-3 border rounded p-3">
              <div className="flex items-center justify-between">
                <Label>Advanced Search Conditions</Label>
                <Button size="sm" variant="outline" onClick={addCondition}>
                  + Add Condition
                </Button>
              </div>

              {conditions.length === 0 && (
                <p className="text-xs text-zinc-500">
                  No conditions yet. All rows will match until you add one.
                </p>
              )}

              {conditions.map((cond) => (
                <div key={cond.id} className="flex gap-2 items-center">
                  {/* Field selector */}
                  <Select
                    value={cond.field}
                    onValueChange={(val) =>
                      updateCondition(cond.id, { field: val })
                    }
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CSV_FIELDS.slice(1).map((field) => (
                        <SelectItem key={field} value={field}>
                          {field}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Match mode */}
                  <Select
                    value={cond.mode}
                    onValueChange={(val) =>
                      updateCondition(cond.id, { mode: val as MatchMode })
                    }
                  >
                    <SelectTrigger className="w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="contains">Contains</SelectItem>
                      <SelectItem value="equals">Equals</SelectItem>
                      <SelectItem value="startsWith">Starts with</SelectItem>
                      <SelectItem value="endsWith">Ends with</SelectItem>
                      <SelectItem value="regex">Regex</SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Value */}
                  <Input
                    className="flex-1"
                    placeholder="Value..."
                    value={cond.value}
                    onChange={(e) =>
                      updateCondition(cond.id, { value: e.target.value })
                    }
                  />

                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => removeCondition(cond.id)}
                  >
                    ✕
                  </Button>
                </div>
              ))}

              {/* AND / OR toggle */}
              <div className="flex items-center gap-4 text-xs text-zinc-600 dark:text-zinc-400">
                <span>Match rows where:</span>
                <Button
                  size="sm"
                  variant={advancedLogic === 'AND' ? 'default' : 'outline'}
                  onClick={() => setAdvancedLogic('AND')}
                >
                  All conditions (AND)
                </Button>
                <Button
                  size="sm"
                  variant={advancedLogic === 'OR' ? 'default' : 'outline'}
                  onClick={() => setAdvancedLogic('OR')}
                >
                  Any condition (OR)
                </Button>
              </div>

              {/* Full-width Search button */}
              <div className="mt-3">
                <Button
                  variant="outline"
                  onClick={() => startProcessing()}
                  disabled={isProcessing || selectedFiles.length === 0}
                  className="w-full justify-center"
                >
                  {isProcessing && !isReplacing && !isFixingSlugUrls ? (
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
              </div>
            </div>
          </div>

        {/* Replace All Section */}
        <div className="mt-6 pt-4 border-t space-y-4">
          <div className="space-y-3 border rounded p-3">
            <div className="flex items-center justify-between">
              <Label className="text-base font-semibold">Replace All</Label>
              <Button size="sm" variant="outline" onClick={addReplaceCondition}>
                + Add Replace Condition
              </Button>
            </div>

            {/* Multiple Replace Conditions */}
            {replaceConditions.length === 0 && (
              <p className="text-xs text-zinc-500">
                No replace conditions yet. Add one to replace multiple fields.
              </p>
            )}

            {replaceConditions.map((cond) => (
              <div key={cond.id} className="flex gap-2 items-center">
                {/* Field selector */}
                <Select
                  value={cond.field}
                  onValueChange={(val) =>
                    updateReplaceCondition(cond.id, { field: val })
                  }
                >
                  <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder="Select field" />
                  </SelectTrigger>
                  <SelectContent>
                    {CSV_FIELDS.slice(1).map((field) => (
                      <SelectItem key={field} value={field}>
                        {field}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* Replace value */}
                <Input
                  className="flex-1"
                  placeholder="Enter replacement value (or 'empty' to clear)..."
                  value={cond.value}
                  onChange={(e) =>
                    updateReplaceCondition(cond.id, { value: e.target.value })
                  }
                />

                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => removeReplaceCondition(cond.id)}
                >
                  ✕
                </Button>
              </div>
            ))}

            {/* Replace All button */}
            <div className="mt-3">
              <Button
                onClick={() => startReplace()}
                disabled={
                  isProcessing ||
                  replaceConditions.length === 0 ||
                  !hasSearchResults ||
                  fileResults.size === 0
                }
                className="w-full justify-center"
              >
                {isReplacing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Replacing...
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

          {/* Save mode options for Replace All */}
          <div className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
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

        {/* Fix Slug URLs Section */}
        {shouldShowFixSlugSection() && (
          <div className="mt-6 pt-4 border-t space-y-4">
            <div className="space-y-3 border rounded p-3">
              <div className="flex items-center justify-between">
                <Label className="text-base font-semibold">Fix Slug URLs</Label>
              </div>

              <div className="space-y-3">
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  This will append the location value to slug_url fields ending with "-salary".
                  <br />
                  Example: "path-salary" + location "Munich" → "path-salary-Munich"
                </p>

                <div className="mt-3">
                  <Button
                    onClick={() => startFixSlugUrls()}
                    disabled={
                      isProcessing ||
                      !hasSearchResults ||
                      fileResults.size === 0
                    }
                    className="w-full justify-center"
                  >
                    {isFixingSlugUrls ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Fixing Slug URLs...
                      </>
                    ) : (
                      <>
                        <Replace className="mr-2 h-4 w-4" />
                        Fix Slug URLs
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

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
                ? isReplacing
                  ? 'Replacing values... Results will appear as replacements are made.'
                  : isFixingSlugUrls
                  ? 'Fixing slug URLs... Results will appear as fixes are made.'
                  : 'Searching files... Results will appear as matches are found.'
                : 'No search results yet. Click Search to find matches.'}
            </div>
          )}
        </div>
          </TabsContent>

          {/* Detect Location & State Tab */}
          <TabsContent value="detect-location-state" className="space-y-6">
            <div className="space-y-4">
              <div className="space-y-3 border rounded p-3">
                <div className="flex items-center justify-between">
                  <Label className="text-base font-semibold">Detect Location & State</Label>
                </div>
                
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  This will scan all selected CSV files and extract unique states and unique combinations of state and location.
                </p>

                <div className="mt-3">
                  <Button
                    onClick={startDetection}
                    disabled={isDetecting || selectedFiles.length === 0}
                    className="w-full justify-center"
                  >
                    {isDetecting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Detecting...
                      </>
                    ) : (
                      <>
                        <MapPin className="mr-2 h-4 w-4" />
                        Start Detection
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {/* State & Location Combinations Table - TOP */}
              <div className="border rounded p-4">
                <Label className="text-base font-semibold mb-3 block">Unique State & Location Combinations</Label>
                {stateLocationCombos.length > 0 ? (
                  <div className="overflow-auto max-h-[300px]">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12">#</TableHead>
                          <TableHead>State</TableHead>
                          <TableHead>Location</TableHead>
                          <TableHead className="w-20">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {stateLocationCombos.map((combo, index) => (
                          <TableRow key={`${combo.state}-${combo.location}-${index}`}>
                            <TableCell className="font-mono text-xs">{index + 1}</TableCell>
                            <TableCell>{combo.state || '(empty)'}</TableCell>
                            <TableCell>{combo.location || '(empty)'}</TableCell>
                            <TableCell>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleEditFromCombo(combo.state, combo.location)}
                                className="h-8 w-8 p-0"
                                title="Edit rows with this state and location"
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <div className="text-center text-zinc-500 py-8">
                    {isDetecting ? 'Detecting combinations...' : 'No combinations detected yet. Click "Start Detection" to begin.'}
                  </div>
                )}
              </div>

              {/* Unique Locations Table - MIDDLE */}
              <div className="border rounded p-4">
                <Label className="text-base font-semibold mb-3 block">Unique Locations</Label>
                {uniqueLocations.length > 0 ? (
                  <div className="overflow-auto max-h-[300px]">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12">#</TableHead>
                          <TableHead>Location</TableHead>
                          <TableHead className="w-20">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {uniqueLocations.map((location, index) => (
                          <TableRow key={location}>
                            <TableCell className="font-mono text-xs">{index + 1}</TableCell>
                            <TableCell>{location || '(empty)'}</TableCell>
                            <TableCell>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleEditFromLocation(location)}
                                className="h-8 w-8 p-0"
                                title="Edit rows with this location"
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <div className="text-center text-zinc-500 py-8">
                    {isDetecting ? 'Detecting locations...' : 'No locations detected yet. Click "Start Detection" to begin.'}
                  </div>
                )}
              </div>

              {/* Unique States Table - BOTTOM */}
              <div className="border rounded p-4">
                <Label className="text-base font-semibold mb-3 block">Unique States</Label>
                {uniqueStates.length > 0 ? (
                  <div className="overflow-auto max-h-[300px]">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12">#</TableHead>
                          <TableHead>State</TableHead>
                          <TableHead className="w-20">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {uniqueStates.map((state, index) => (
                          <TableRow key={state}>
                            <TableCell className="font-mono text-xs">{index + 1}</TableCell>
                            <TableCell>{state || '(empty)'}</TableCell>
                            <TableCell>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleEditFromState(state)}
                                className="h-8 w-8 p-0"
                                title="Edit rows with this state"
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <div className="text-center text-zinc-500 py-8">
                    {isDetecting ? 'Detecting states...' : 'No states detected yet. Click "Start Detection" to begin.'}
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

