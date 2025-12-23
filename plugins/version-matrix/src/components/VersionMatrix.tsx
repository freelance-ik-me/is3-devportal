import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  CircularProgress,
  IconButton,
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
    background: theme.palette.background.paper,
    color: theme.palette.text.primary,
  },
  versionCell: {
    textAlign: 'center',
    fontFamily: 'monospace',
    whiteSpace: 'nowrap',
  },
  actionCell: {
    textAlign: 'center',
    whiteSpace: 'nowrap',
  },
}));

type EndpointMap = Record<string, string>;

type ComponentRow = {
  name: string;
  title?: string;
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

const fetchRowVersions = async (
  row: ComponentRow,
  signal?: AbortSignal,
): Promise<ComponentRow> => {
  const envs = Object.keys(row.endpoints);
  const results = await Promise.allSettled(
    envs.map(env => fetchVersion(row.endpoints[env], signal as AbortSignal)),
  );

  const versions: Record<string, string> = {};
  results.forEach((result, idx) => {
    const env = envs[idx];
    if (result.status === 'fulfilled') {
      versions[env] = result.value;
    } else {
      const err = result.reason;
      if (err instanceof Error) {
        if (err.message === 'TIMEOUT') {
          versions[env] = 'TIMEOUT';
        } else if (err.message.startsWith('HTTP ')) {
          versions[env] = err.message;
        } else {
          versions[env] = 'N/C';
        }
      } else {
        versions[env] = 'N/C';
      }
      if (!signal?.aborted) {
        console.warn(`Version fetch failed for ${row.name}/${env}:`, err);
      }
    }
  });

  return { ...row, versions };
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

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        setLoading(true);
        setError(null);

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
            namespace: entity.metadata.namespace || 'default',
            system: entity.spec?.system as string | undefined,
            endpoints,
            versions: {},
          });
        }

        setEnvironments(Array.from(collectedEnvs));

        // fetch versions
        const resolved = await Promise.all(
          preparedRows.map(r => fetchRowVersions(r, controller.signal)),
        );
        resolved.sort((a, b) => a.name.localeCompare(b.name));
        setAllRows(resolved);
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Failed to load versions');
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    load();
    return () => controller.abort();
  }, [catalogApi]);

  const systems = useMemo(() => {
    const uniqueSystems = new Set<string>();
    allRows.forEach(row => {
      if (row.system) uniqueSystems.add(row.system);
    });
    return Array.from(uniqueSystems).sort();
  }, [allRows]);

  // Auto-select first system when data loads
  useEffect(() => {
    if (systems.length > 0 && selectedSystem === 'all') {
      setSelectedSystem(systems[0]);
    }
  }, [systems, selectedSystem]);

  const filteredRows = useMemo(() => {
    if (selectedSystem === 'all') return allRows;
    return allRows.filter(row => row.system === selectedSystem);
  }, [allRows, selectedSystem]);

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

  const handleRefresh = async (row: ComponentRow) => {
    // mark row as pending and show spinner sentinel per env
    setAllRows(prev =>
      prev.map(r =>
        r.name === row.name
          ? {
              ...r,
              versions: Object.fromEntries(
                Object.keys(r.endpoints).map(env => [env, '__loading__']),
              ),
            }
          : r,
      ),
    );

    setRefreshing(prev => new Set(prev).add(row.name));

    const release = () =>
      setRefreshing(prev => {
        const next = new Set(prev);
        next.delete(row.name);
        return next;
      });

    // Disable button for 5s
    setTimeout(release, 5000);

    // Fetch each environment independently and update as results arrive
    const envs = Object.keys(row.endpoints);
    envs.forEach(async env => {
      try {
        const version = await fetchVersion(row.endpoints[env]);
        setAllRows(prev =>
          prev.map(r =>
            r.name === row.name
              ? { ...r, versions: { ...r.versions, [env]: version } }
              : r,
          ),
        );
      } catch (err) {
        let errorValue = 'N/C';
        if (err instanceof Error) {
          if (err.message === 'TIMEOUT') {
            errorValue = 'TIMEOUT';
          } else if (err.message.startsWith('HTTP ')) {
            errorValue = err.message;
          }
        }
        setAllRows(prev =>
          prev.map(r =>
            r.name === row.name
              ? { ...r, versions: { ...r.versions, [env]: errorValue } }
              : r,
          ),
        );
        console.warn(`Version fetch failed for ${row.name}/${env}:`, err);
      }
    });
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
              <TableCell className={classes.headerCell}>Acción</TableCell>
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
                  <div>
                    <Typography variant="caption" color="textSecondary">
                      {row.namespace && row.namespace !== 'default'
                        ? `${row.namespace}/${row.name}`
                        : row.name}
                    </Typography>
                  </div>
                </TableCell>
                {columns.map(env => (
                  <TableCell key={`${row.name}-${env}`} className={classes.versionCell}>
                    {row.versions[env] === '__loading__' ? (
                      <CircularProgress size={14} thickness={5} />
                    ) : row.versions[env] === 'TIMEOUT' ? (
                      '⌛'
                    ) : (
                      row.versions[env] ?? '-'
                    )}
                  </TableCell>
                ))}
                <TableCell className={classes.actionCell}>
                  <IconButton
                    aria-label="Refrescar"
                    onClick={() => handleRefresh(row)}
                    disabled={refreshing.has(row.name)}
                    size="small"
                  >
                    <RefreshIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};
