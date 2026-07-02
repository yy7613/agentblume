import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToolApiClient } from './api/tool-api';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('UI root element is missing');
createRoot(root).render(<StrictMode><App client={new ToolApiClient()} /></StrictMode>);
