// Worker entry: routes /api/* to the API handler; everything else is served from ./public (static assets)
import { onRequest } from '../functions/api/[[path]].js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
      return onRequest({ request, env, params: { path } });
    }
    return env.ASSETS.fetch(request);
  },
};
