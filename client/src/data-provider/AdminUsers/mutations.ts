import { dataService, QueryKeys } from 'librechat-data-provider';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AdminDeleteUserResponse,
  AdminInviteUserRequest,
  AdminInviteUserResponse,
  AdminResendAccessResponse,
  AdminUpdateMCPAccessRequest,
  AdminUpdateUserStatusRequest,
  AdminUser,
} from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';

function invalidateAdminUserQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries([QueryKeys.adminUsers]);
  queryClient.invalidateQueries([QueryKeys.adminPendingInvites]);
}

export function useInviteAdminUserMutation(): UseMutationResult<
  AdminInviteUserResponse,
  Error,
  AdminInviteUserRequest
> {
  const queryClient = useQueryClient();
  return useMutation((payload) => dataService.inviteAdminUser(payload), {
    onSuccess: () => invalidateAdminUserQueries(queryClient),
  });
}

export function useRevokeAdminUserInviteMutation(): UseMutationResult<
  { success: boolean },
  Error,
  string
> {
  const queryClient = useQueryClient();
  return useMutation((email) => dataService.revokeAdminUserInvite(email), {
    onSuccess: () => invalidateAdminUserQueries(queryClient),
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

export function useResendAdminUserAccessMutation(): UseMutationResult<
  AdminResendAccessResponse,
  Error,
  string
> {
  return useMutation((userId) => dataService.resendAdminUserAccess(userId));
}

export function useDeleteAdminUserMutation(): UseMutationResult<
  AdminDeleteUserResponse,
  Error,
  string
> {
  const queryClient = useQueryClient();
  return useMutation((userId) => dataService.deleteAdminUser(userId), {
    onSuccess: () => invalidateAdminUserQueries(queryClient),
  });
}
