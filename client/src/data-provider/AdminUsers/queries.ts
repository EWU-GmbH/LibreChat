import { useQuery } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type {
  AdminMCPServersResponse,
  AdminUsersPage,
  AdminUsersParams,
} from 'librechat-data-provider';
import type { QueryObserverResult } from '@tanstack/react-query';

export function useAdminUsersQuery(
  params: AdminUsersParams,
  enabled = true,
): QueryObserverResult<AdminUsersPage> {
  return useQuery([QueryKeys.adminUsers, params], () => dataService.getAdminUsers(params), {
    enabled,
    keepPreviousData: true,
    retry: false,
  });
}

export function useAdminMCPServersQuery(
  enabled = true,
): QueryObserverResult<AdminMCPServersResponse> {
  return useQuery([QueryKeys.adminMCPServers], () => dataService.getAdminMCPServers(), {
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}
