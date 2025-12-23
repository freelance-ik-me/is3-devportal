import {
  createPlugin,
  createRoutableExtension,
} from '@backstage/core-plugin-api';
import React from 'react';
import { rootRouteRef } from './routes';

export const versionMatrixPlugin = createPlugin({
  id: 'version-matrix',
  routes: {
    root: rootRouteRef,
  },
});

export const VersionMatrixPage = versionMatrixPlugin.provide(
  createRoutableExtension({
    name: 'VersionMatrixPage',
    component: () =>
      import('./components/VersionMatrixPage').then(m => {
        const { VersionMatrixPage } = m;
        return () => React.createElement(VersionMatrixPage);
      }),
    mountPoint: rootRouteRef,
  }),
);
