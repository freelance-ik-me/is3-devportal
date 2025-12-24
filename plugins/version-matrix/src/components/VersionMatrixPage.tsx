import React from 'react';
import { Page, Header, Content, ContentHeader } from '@backstage/core-components';
import { VersionMatrix } from './VersionMatrix';

export const VersionMatrixPage: React.FC = () => (
  <Page themeId="tool">
    <Header title="Versiones" subtitle="Componentes por entorno" />
    <Content>
      <ContentHeader title="Componentes desplegados" />
      <VersionMatrix />
    </Content>
  </Page>
);
