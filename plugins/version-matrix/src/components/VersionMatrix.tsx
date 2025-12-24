import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Checkbox,
  Button,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import RefreshIcon from '@material-ui/icons/Refresh';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef, EntityRefLink } from '@backstage/plugin-catalog-react';
import { Entity } from '@backstage/catalog-model';

const DEFAULT_ENVIRONMENTS = ['CONSO', 'INT', 'PRE', 'PRO'];
const ENDPOINTS_ANNOTATION = 'is3-devportal/version-endpoints';

const useStyles = makeStyles(theme => ({
  tableContainer: {
    marginTop: theme.spacing(2),
  },
  headerCell: {
    background: theme.palette.primary.dark,
    color: theme.palette.primary.contrastText,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  componentCell: {
    fontWeight: 'bold',
    color: theme.palette.text.primary,
  },
  versionCell: {
    textAlign: 'center',
    fontFamily: 'monospace',
    whiteSpace: 'nowrap',
    width: '180px',
    minWidth: '180px',
    fontSize: '1rem',
  },
  versionCellChanging: {
    textAlign: 'center',
    fontFamily: 'monospace',
    whiteSpace: 'nowrap',
    width: '180px',
    minWidth: '180px',
    fontSize: '1rem',
    animation: '$cellFlash 1s ease-in-out',
  },
  actionCell: {
    textAlign: 'center',
    whiteSpace: 'nowrap',
  },
  errorText: {
    fontWeight: 'bold',
    color: theme.palette.error.main,
  },
  timeoutText: {
    fontWeight: 'bold',
    color: theme.palette.warning.main,
  },
  '@keyframes cellFlash': {
    '0%': {
      backgroundColor: theme.palette.secondary.light,
    },
    '100%': {
      backgroundColor: 'transparent',
    },
  },
}));

type EndpointMap = Record<string, string>;

type ComponentRow = {
  name: string;
  title?: string;
  description?: string;
  namespace?: string;
  system?: string;
  endpoints: EndpointMap;
  versions: Record<string, string>;
};



const parseEndpoints = (entity: Entity): EndpointMap => {
  const annotations = entity.metadata.annotations || {};
  const map: EndpointMap = {};

  // New format: one annotation per environment (is3-devportal/version-<env>)
  for (const [key, value] of Object.entries(annotations)) {
    if (key.startsWith('is3-devportal/version-') && typeof value === 'string') {
      const env = key.replace('is3-devportal/version-', '').toUpperCase();
      map[env] = value.trim();
    }
  }
  if (Object.keys(map).length > 0) return map;

  // Legacy: is3-devportal/versions as object, array, JSON string
  const annotation = annotations['is3-devportal/versions'];

  // Helper to clean a URL string (trim and drop trailing commas)
  const cleanUrl = (value: string) => value.trim().replace(/,+$/, '');

  // If annotation is an object (YAML map)
  if (annotation && typeof annotation === 'object' && !Array.isArray(annotation)) {
    for (const [env, url] of Object.entries(annotation)) {
      if (typeof url === 'string') {
        map[env] = cleanUrl(url);
      }
    }
    if (Object.keys(map).length > 0) return map;
  }

  // If annotation is an array of single-key objects (YAML list)
  if (Array.isArray(annotation)) {
    for (const entry of annotation) {
      if (entry && typeof entry === 'object') {
        for (const [env, url] of Object.entries(entry as Record<string, unknown>)) {
          if (typeof url === 'string') {
            map[env] = cleanUrl(url);
          }
        }
      }
    }
    if (Object.keys(map).length > 0) return map;
  }

  // If annotation is a string, try JSON first
  if (typeof annotation === 'string') {
    try {
      const parsed = JSON.parse(annotation);
      if (parsed && typeof parsed === 'object') {
        for (const [env, url] of Object.entries(parsed)) {
          if (typeof url === 'string') {
            map[env] = cleanUrl(url);
          }
        }
        if (Object.keys(map).length > 0) return map;
      }
    } catch {
      // continue to YAML-ish parsing
    }

    // Try to parse YAML-ish multi-line content (list or map)
    const yamlLines = annotation
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));

    const mapFromLines: EndpointMap = {};
    for (const line of yamlLines) {
      const cleaned = line.replace(/^[-\s]+/, '');
      const [envRaw, urlRaw] = cleaned.split(/:\s*/, 2);
      if (envRaw && urlRaw) {
        mapFromLines[envRaw.trim()] = cleanUrl(urlRaw.replace(/^['\"]|['\"]$/g, ''));
      }
    }
    if (Object.keys(mapFromLines).length > 0) return mapFromLines;
  }

  // Legacy format: comma-separated ENV=url
  const legacyAnnotation = annotations[ENDPOINTS_ANNOTATION];
  if (!legacyAnnotation) return {};
  legacyAnnotation.split(',').forEach(pair => {
    const [env, url] = pair.split('=').map(s => s?.trim());
    if (env && url) {
      map[env] = url;
    }
  });
  return map;
};

const fetchVersion = async (
  url: string,
  signal?: AbortSignal,
  timeoutMs = 10000,
): Promise<string> => {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout);
      throw new Error('TIMEOUT');
    }
    signal.addEventListener('abort', onAbort);
  }

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await res.text();
    return text.trim();
  } catch (err) {
    if ((err as any)?.name === 'AbortError') {
      throw new Error('TIMEOUT');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
};

export const VersionMatrix: React.FC = () => {
  const classes = useStyles();
  const catalogApi = useApi(catalogApiRef);
  const [allRows, setAllRows] = useState<ComponentRow[]>([]);
  const [selectedSystem, setSelectedSystem] = useState<string>('all');
  const [environments, setEnvironments] = useState<string[]>(DEFAULT_ENVIRONMENTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [checkedRows, setCheckedRows] = useState<Set<string>>(new Set());
  const [changedCells, setChangedCells] = useState<Set<string>>(new Set());
  const isInitialLoad = useRef(true);

  // Load cached versions from localStorage
  const loadCachedVersions = (): Record<string, Record<string, string>> => {
    try {
      const cached = localStorage.getItem('version-matrix-cache');
      return cached ? JSON.parse(cached) : {};
    } catch {
      return {};
    }
  };

  // Save versions to localStorage
  const saveCachedVersions = (rows: ComponentRow[]) => {
    try {
      const cache: Record<string, Record<string, string>> = {};
      rows.forEach(row => {
        if (Object.keys(row.versions).length > 0) {
          cache[row.name] = row.versions;
        }
      });
      localStorage.setItem('version-matrix-cache', JSON.stringify(cache));
    } catch {
      // Silently fail if localStorage is not available
    }
  };

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setError(null);

        const cachedVersions = loadCachedVersions();

        const entities = await catalogApi.getEntities({
          filter: { kind: 'Component' },
        });

        const collectedEnvs = new Set<string>(DEFAULT_ENVIRONMENTS);
        const preparedRows: ComponentRow[] = [];

        for (const entity of entities.items as Entity[]) {
          const endpoints = parseEndpoints(entity);
          if (Object.keys(endpoints).length === 0) {
            continue;
          }
          Object.keys(endpoints).forEach(env => collectedEnvs.add(env));
          preparedRows.push({
            name: entity.metadata.name,
            title: entity.metadata.title,
            description: entity.metadata.description,
            namespace: entity.metadata.namespace || 'default',
            system: entity.spec?.system as string | undefined,
            endpoints,
            versions: cachedVersions[entity.metadata.name] || {},
          });
        }

        preparedRows.sort((a, b) => a.name.localeCompare(b.name));
        setEnvironments(Array.from(collectedEnvs));

        // Render immediately with cached versions
        setAllRows(preparedRows);
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load entities');
        setLoading(false);
      }
    };

    load();
  }, [catalogApi]);

  const systems = useMemo(() => {
    const uniqueSystems = new Set<string>();
    allRows.forEach(row => {
      if (row.system) uniqueSystems.add(row.system);
    });
    return Array.from(uniqueSystems).sort();
  }, [allRows]);

  // Auto-select first system only on initial load
  useEffect(() => {
    if (isInitialLoad.current && systems.length > 0 && selectedSystem === 'all') {
      setSelectedSystem(systems[0]);
      isInitialLoad.current = false;
    }
  }, [systems]);

  const filteredRows = useMemo(() => {
    if (selectedSystem === 'all') return allRows;
    return allRows.filter(row => row.system === selectedSystem);
  }, [allRows, selectedSystem]);

  // Clear checked rows when selectedSystem changes (not when data updates)
  useEffect(() => {
    setCheckedRows(new Set());
  }, [selectedSystem]);

  const columns = useMemo(() => {
    // Put LOCAL first, then others in original order
    const sorted = [...environments];
    const localIdx = sorted.findIndex(env => env.toUpperCase() === 'LOCAL');
    if (localIdx > 0) {
      const [local] = sorted.splice(localIdx, 1);
      sorted.unshift(local);
    }
    return sorted;
  }, [environments]);

  const markCellAsChanged = (rowName: string, env: string) => {
    const cellKey = `${rowName}-${env}`;
    setChangedCells(prevSet => new Set(prevSet).add(cellKey));
    // Clear animation after it completes (1000ms to match animation duration)
    setTimeout(() => {
      setChangedCells(prevSet => {
        const next = new Set(prevSet);
        next.delete(cellKey);
        return next;
      });
    }, 1000);
  };

  const handleRefresh = async (row: ComponentRow) => {
    setRefreshing(prev => new Set(prev).add(row.name));

    // Fetch each environment independently and update as results arrive
    const envs = Object.keys(row.endpoints);
    let completedCount = 0;

    envs.forEach(async env => {
      try {
        const version = await fetchVersion(row.endpoints[env]);
        setAllRows(prev => {
          const updated = prev.map(r => {
            if (r.name === row.name) {
              const oldVersion = r.versions[env];
              // Mark cell as changed if version differs (including from empty/undefined)
              if (oldVersion !== version) {
                markCellAsChanged(row.name, env);
              }
              return { ...r, versions: { ...r.versions, [env]: version } };
            }
            return r;
          });
          saveCachedVersions(updated);
          return updated;
        });
      } catch (err) {
        let errorValue = 'N/C';
        if (err instanceof Error) {
          if (err.message === 'TIMEOUT') {
            errorValue = 'TIMEOUT';
          } else if (err.message.startsWith('HTTP ')) {
            errorValue = err.message;
          }
        }
        setAllRows(prev => {
          const updated = prev.map(r => {
            if (r.name === row.name) {
              const oldVersion = r.versions[env];
              // Mark cell as changed even for errors (including from empty/undefined)
              if (oldVersion !== errorValue) {
                markCellAsChanged(row.name, env);
              }
              return { ...r, versions: { ...r.versions, [env]: errorValue } };
            }
            return r;
          });
          saveCachedVersions(updated);
          return updated;
        });
        console.warn(`Version fetch failed for ${row.name}/${env}:`, err);
      } finally {
        completedCount++;
        // Release the button when all environments have completed
        if (completedCount === envs.length) {
          setRefreshing(prev => {
            const next = new Set(prev);
            next.delete(row.name);
            return next;
          });
        }
      }
    });
  };

  const handleGlobalRefresh = () => {
    if (checkedRows.size === 0) return;
    
    const rowsToRefresh = allRows.filter(r => checkedRows.has(r.name));
    rowsToRefresh.forEach(row => {
      handleRefresh(row);
    });
  };

  const handleCheckboxChange = (rowName: string) => {
    setCheckedRows(prev => {
      const next = new Set(prev);
      if (next.has(rowName)) {
        next.delete(rowName);
      } else {
        next.add(rowName);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (checkedRows.size === filteredRows.length) {
      // Deselect all
      setCheckedRows(new Set());
    } else {
      // Select all
      setCheckedRows(new Set(filteredRows.map(r => r.name)));
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight={240}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert severity="error">Error loading versions: {error}</Alert>
    );
  }

  if (allRows.length === 0) {
    return (
      <Alert severity="info">
        No components with version annotations found. Use "is3-devportal/versions" (YAML object) or "is3-devportal/version-endpoints" (legacy).
      </Alert>
    );
  }

  return (
    <Box>
      <Box display="flex" alignItems="center" mb={2} style={{ gap: '16px' }}>
        <FormControl variant="outlined" size="small" style={{ minWidth: 200 }}>
          <InputLabel>System</InputLabel>
          <Select
            value={selectedSystem}
            onChange={(e) => setSelectedSystem(e.target.value as string)}
            label="System"
          >
            {systems.map(sys => (
              <MenuItem key={sys} value={sys}>
                {sys}
              </MenuItem>
            ))}
            <MenuItem value="all">All Systems</MenuItem>
          </Select>
        </FormControl>
        <Typography variant="caption" color="textSecondary">
          {filteredRows.length} component(s)
        </Typography>
        <Button
          variant="contained"
          color="primary"
          startIcon={<RefreshIcon />}
          onClick={handleGlobalRefresh}
          disabled={checkedRows.size === 0}
        >
          Refrescar
        </Button>
      </Box>
      <TableContainer component={Paper} className={classes.tableContainer}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell className={classes.headerCell}>Componente</TableCell>
              {columns.map(env => (
                <TableCell key={env} className={classes.headerCell}>
                  {env}
                </TableCell>
              ))}
              <TableCell className={classes.headerCell} style={{ textAlign: 'center' }}>
                <Checkbox
                  checked={filteredRows.length > 0 && checkedRows.size === filteredRows.length}
                  indeterminate={checkedRows.size > 0 && checkedRows.size < filteredRows.length}
                  onChange={handleSelectAll}
                  size="small"
                />
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filteredRows.map((row: ComponentRow) => (
              <TableRow key={row.name}>
                <TableCell className={classes.componentCell}>
                  <div>
                    <EntityRefLink
                      entityRef={{
                        kind: 'Component',
                        name: row.name,
                        namespace: row.namespace || 'default',
                      }}
                      title={row.title || row.name}
                    />
                  </div>
                  {row.description && (
                    <div>
                      <Typography variant="caption" color="textSecondary">
                        {row.description}
                      </Typography>
                    </div>
                  )}
                  <div>
                    <Typography variant="caption" color="textSecondary">
                      {row.system}
                    </Typography>
                  </div>
                </TableCell>
                {columns.map(env => {
                  const cellKey = `${row.name}-${env}`;
                  const currentVersion = row.versions[env];
                  const isChanged = changedCells.has(cellKey);
                  
                  return (
                    <TableCell 
                      key={cellKey}
                      className={isChanged ? classes.versionCellChanging : classes.versionCell}
                    >
                      {currentVersion === 'TIMEOUT' ? (
                        <span className={classes.timeoutText}>TIMEOUT</span>
                      ) : currentVersion?.startsWith('HTTP ') ? (
                        <span className={classes.errorText}>{currentVersion}</span>
                      ) : currentVersion === 'N/C' ? (
                        'N/C'
                      ) : currentVersion ? (
                        currentVersion
                      ) : (
                        'N/C'
                      )}
                    </TableCell>
                  );
                })}
                <TableCell className={classes.actionCell}>
                  {refreshing.has(row.name) ? (
                    <CircularProgress size={24} thickness={5} />
                  ) : (
                    <Checkbox
                      checked={checkedRows.has(row.name)}
                      onChange={() => handleCheckboxChange(row.name)}
                      size="small"
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};
