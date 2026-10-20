// Public addresses. On a server, set PUBLIC_API_URL (e.g. https://api.yourdomain.com) and FRONTEND_ORIGIN.
export const API_URL = (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, '');
export const FRONTEND_URL = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000').replace(/\/+$/, '');

export const isLocalUrl = (url) => /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
