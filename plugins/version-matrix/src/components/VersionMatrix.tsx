import React, { useEffect, useMemo, useState } from 'react';
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
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
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
}));

type EndpointMap = Record<string, string>;

type ComponentRow = {
  name: string;
  title?: string;
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

const fetchVersion = async (url: string, signal: AbortSignal): Promise<string> => {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return text.trim();
};

export const VersionMatrix: React.FC = () => {
  const classes = useStyles();
  const catalogApi = useApi(catalogApiRef);
  const [allRows, setAllRows] = useState<ComponentRow[]>([]);
  const [selectedSystem, setSelectedSystem] = useState<string>('all');
  const [environments, setEnvironments] = useState<string[]>(DEFAULT_ENVIRONMENTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
            system: entity.spec?.system as string | undefined,
            endpoints,
            versions: {},
          });
        }

        setEnvironments(Array.from(collectedEnvs));

        // fetch versions
        const fetchRowVersions = async (row: ComponentRow) => {
          const versions: Record<string, string> = {};
          for (const env of Object.keys(row.endpoints)) {
            try {
              const v = await fetchVersion(row.endpoints[env], controller.signal);
              versions[env] = v;
            } catch (err) {
              versions[env] = 'N/D';
              if (!controller.signal.aborted) {
                // log but continue
                console.warn(`Version fetch failed for ${row.name}/${env}:`, err);
              }
            }
          }
          return { ...row, versions };
        };

        const resolved = await Promise.all(preparedRows.map(r => fetchRowVersions(r)));
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

  const columns = useMemo(() => environments, [environments]);

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
            </TableRow>
          </TableHead>
          <TableBody>
            {filteredRows.map((row: ComponentRow) => (
              <TableRow key={row.name}>
                <TableCell className={classes.componentCell}>
                  <div>{row.title || row.name}</div>
                  <Typography variant="caption" color="textSecondary">
                    {row.name}
                  </Typography>
                </TableCell>
                {columns.map(env => (
                  <TableCell key={`${row.name}-${env}`} className={classes.versionCell}>
                    {row.versions[env] ?? '-'}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};
