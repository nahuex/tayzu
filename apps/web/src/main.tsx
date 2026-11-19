import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('The #root element is missing from index.html');
}

createRoot(rootElement).render(<StrictMode />);
