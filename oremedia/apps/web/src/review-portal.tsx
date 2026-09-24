import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { ReviewPortalRoute } from './app/review-portal/route';

/** Separate build target (spec 21.1): served from REVIEW_PORTAL_ORIGIN so reviewer links never share app cookies. */
const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <ReviewPortalRoute standalone />
  </StrictMode>,
);
