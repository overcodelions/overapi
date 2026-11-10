import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';

// Follows the system, or the theme picked in Settings: main sets
// nativeTheme.themeSource, which is what prefers-color-scheme reports.
const media = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', media.matches);
applyTheme();
media.addEventListener('change', applyTheme);

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
