import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type {
  AdminInviteUserRequest,
  AdminInviteUserResponse,
  AdminUpdateMCPAccessRequest,
  AdminUpdateUserStatusRequest,
  AdminUser,
} from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';

export function useInviteAdminUserMutation(): UseMutationResult<
  AdminInviteUserResponse,
  Error,
  AdminInviteUserRequest
> {
  const queryClient = useQueryClient();
  return useMutation((payload) => dataService.inviteAdminUser(payload), {
    onSuccess: () => queryClient.invalidateQueries([QueryKeys.adminUsers]),
  });
}

export function useUpdateAdminUserStatusMutation(): UseMutationResult<
  { user: AdminUser },
  Error,
  { userId: string; payload: AdminUpdateUserStatusRequest }
> {
  const queryClient = useQueryClient();
  return useMutation(({ userId, payload }) => dataService.updateAdminUserStatus(userId, payload), {
    onSuccess: () => queryClient.invalidateQueries([QueryKeys.adminUsers]),
  });
}

export function useUpdateAdminUserMCPAccessMutation(): UseMutationResult<
  { user: AdminUser },
  Error,
  { userId: string; payload: AdminUpdateMCPAccessRequest }
> {
  const queryClient = useQueryClient();
  return useMutation(
    ({ userId, payload }) => dataService.updateAdminUserMCPAccess(userId, payload),
    {
      onSuccess: () => {
        queryClient.invalidateQueries([QueryKeys.adminUsers]);
        queryClient.invalidateQueries([QueryKeys.mcpTools]);
      },
    },
  );
}
