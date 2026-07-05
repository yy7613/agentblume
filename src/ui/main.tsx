import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToolApiClient } from './api/tool-api';
import './styles.css';
import { I18nProvider } from './i18n';

const root = document.getElementById('root');
if (root === null) throw new Error('UI root element is missing');
createRoot(root).render(<StrictMode><I18nProvider><App client={new ToolApiClient()} /></I18nProvider></StrictMode>);
