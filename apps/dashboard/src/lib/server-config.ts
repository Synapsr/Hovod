import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';
import type { ServerConfig } from './types.js';

/**
 * `GET /v1/config` — public, unauthenticated. It is what tells the dashboard
 * whether it is talking to Hovod Cloud or to a self-hosted install, so the
 * signup/billing pages read it before anything else.
 *
 * One shared query key so the sign-up page, the paywall and the upload page all
 * hit the network once.
 */
export const SERVER_CONFIG_QUERY_KEY = ['config'] as const;

/** What a self-hosted install looks like when the request has not landed yet. */
export const SELF_HOST_CONFIG: ServerConfig = {
  aiAvailable: false,
  chaptersAvailable: false,
  cloud: false,
  plans: [],
  emailEnabled: false,
};

export function useServerConfig() {
  const query = useQuery({
    queryKey: SERVER_CONFIG_QUERY_KEY,
    queryFn: () => api<ServerConfig>('/v1/config'),
    staleTime: 5 * 60_000,
    // A missing/failing /v1/config must degrade to "self-host", never to a paywall.
    retry: 1,
  });

  return {
    config: query.data,
    /** `false` until the server says otherwise — self-host is the safe default. */
    cloud: query.data?.cloud === true,
    emailEnabled: query.data?.emailEnabled !== false,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
