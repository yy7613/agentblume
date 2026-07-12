// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { DataSourcesPage } from './DataSourcesPage';

afterEach(cleanup);

describe('DataSourcesPage', () => {
  it('バックエンド管理の接続IDを選択して登録し、接続テスト・削除を実行できる', async () => {
    const client = {
      listDataSources: vi.fn().mockResolvedValue([{ id: 'db-1', tenant: { tenantId: 'local', workspaceId: 'default' }, name: 'Sales', kind: 'database', connectionId: 'sales', driver: 'postgresql', createdAt: '', updatedAt: '' }]),
      listDatabaseConnections: vi.fn().mockResolvedValue([{ id: 'sales', driver: 'postgresql' }]),
      registerDatabaseDataSource: vi.fn().mockResolvedValue({}),
      testDatabaseConnection: vi.fn().mockResolvedValue({ id: 'sales', driver: 'postgresql', available: true }),
      deleteDataSource: vi.fn().mockResolvedValue(undefined),
      uploadDataSourceFile: vi.fn().mockResolvedValue({}),
    } as unknown as ToolApiClient;
    render(<DataSourcesPage client={client} />);
    await screen.findByText('Sales');
    await userEvent.selectOptions(screen.getByLabelText('Database connection ID'), 'sales');
    await userEvent.type(screen.getByLabelText('Database source name'), 'Reporting');
    await userEvent.type(screen.getByLabelText('Default database schema'), 'analytics');
    await userEvent.click(screen.getByRole('button', { name: 'Register connection' }));
    await waitFor(() => expect(client.registerDatabaseDataSource).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'sales', name: 'Reporting', defaultSchema: 'analytics' })));
    await userEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(client.testDatabaseConnection).toHaveBeenCalledWith('sales', { tenantId: 'local', workspaceId: 'default' }));
    expect(await screen.findByText('Connection available')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(client.deleteDataSource).toHaveBeenCalledWith('db-1', { tenantId: 'local', workspaceId: 'default' }));
  });

  it('選択したCSVを本文付きでバックエンドへアップロードする', async () => {
    const client = {
      listDataSources: vi.fn().mockResolvedValue([]), listDatabaseConnections: vi.fn().mockResolvedValue([]),
      uploadDataSourceFile: vi.fn().mockResolvedValue({}), registerDatabaseDataSource: vi.fn(), testDatabaseConnection: vi.fn(), deleteDataSource: vi.fn(),
    } as unknown as ToolApiClient;
    render(<DataSourcesPage client={client} />);
    const file = new File(['id,name\n1,A'], 'customers.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => 'id,name\n1,A' });
    fireEvent.change(screen.getByLabelText('Data file'), { target: { files: [file] } });
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(client.uploadDataSourceFile).toHaveBeenCalledWith({ scope: { tenantId: 'local', workspaceId: 'default' }, name: 'customers.csv', format: 'csv', content: 'id,name\n1,A' }));
  });

  it('不正な拡張子とAPIエラーを画面に表示する', async () => {
    const client = {
      listDataSources: vi.fn().mockResolvedValue([]), listDatabaseConnections: vi.fn().mockResolvedValue([]),
      uploadDataSourceFile: vi.fn(), registerDatabaseDataSource: vi.fn(), testDatabaseConnection: vi.fn(), deleteDataSource: vi.fn(),
    } as unknown as ToolApiClient;
    render(<DataSourcesPage client={client} />);
    const file = new File(['x'], 'unsupported.txt', { type: 'text/plain' }); Object.defineProperty(file, 'text', { value: async () => 'x' });
    fireEvent.change(screen.getByLabelText('Data file'), { target: { files: [file] } });
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('Select a CSV or JSON file.')).toBeTruthy();
  });
});
