import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/pages.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root 缺失：界面壳未挂载');

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>
);
