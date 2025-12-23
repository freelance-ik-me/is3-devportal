import React from 'react';
import { Page, Header, Content, ContentHeader } from '@backstage/core-components';
import { VersionMatrix } from './VersionMatrix';

export const VersionMatrixPage: React.FC = () => (
  <Page themeId="tool">
    <Header title="Version Matrix" subtitle="Component versions por entorno" />
    <Content>
      <ContentHeader title="Versiones desplegadas" />
      <VersionMatrix />
    </Content>
  </Page>
);
