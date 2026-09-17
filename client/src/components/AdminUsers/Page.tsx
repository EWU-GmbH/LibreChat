import { useDeferredValue, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { SystemRoles } from 'librechat-data-provider';
import { Button, Input, Spinner, useToastContext } from '@librechat/client';
import { ChevronLeft, ChevronRight, Search, ShieldCheck, UserPlus, X } from 'lucide-react';
import type { AdminUser, UserMCPAccess } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  useAdminMCPServersQuery,
  useAdminUsersQuery,
  useInviteAdminUserMutation,
  useUpdateAdminUserMCPAccessMutation,
  useUpdateAdminUserStatusMutation,
} from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';

function formatDate(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString();
}

function AccessFields({
  access,
  servers,
  onChange,
}: {
  access: UserMCPAccess;
  servers: string[];
  onChange: (access: UserMCPAccess) => void;
}) {
  const localize = useLocalize();
  const toggleServer = (server: string) => {
    const selected = new Set(access.servers);
    if (selected.has(server)) {
      selected.delete(server);
    } else {
      selected.add(server);
    }
    onChange({ policy: 'allowlist', servers: [...selected] });
  };

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium text-text-primary">
        {localize('com_admin_users_mcp_access')}
      </legend>
      <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
        <input
          type="radio"
          name="mcp-policy"
          checked={access.policy === 'all'}
          onChange={() => onChange({ policy: 'all', servers: [] })}
        />
        {localize('com_admin_users_mcp_all')}
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
        <input
          type="radio"
          name="mcp-policy"
          checked={access.policy === 'allowlist'}
          onChange={() => onChange({ policy: 'allowlist', servers: [] })}
        />
        {localize('com_admin_users_mcp_selected')}
      </label>
      {access.policy === 'allowlist' && (
        <div className="grid gap-2 rounded-lg border border-border-light p-3 sm:grid-cols-2">
          {servers.map((server) => (
            <label
              key={server}
              className="flex cursor-pointer items-center gap-2 text-sm text-text-primary"
            >
              <input
                type="checkbox"
                checked={access.servers.includes(server)}
                onChange={() => toggleServer(server)}
              />
              {server}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const localize = useLocalize();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-user-dialog-title"
        className="w-full max-w-lg rounded-xl bg-background p-6 shadow-2xl"
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 id="admin-user-dialog-title" className="text-lg font-semibold text-text-primary">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={localize('com_admin_users_close')}
            className="rounded-md p-1 text-text-secondary hover:bg-surface-hover"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export default function AdminUsersPage() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [cursor, setCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [expiryDays, setExpiryDays] = useState(7);
  const [inviteAccess, setInviteAccess] = useState<UserMCPAccess>({
    policy: 'all',
    servers: [],
  });
  const [accessUser, setAccessUser] = useState<AdminUser>();
  const [editedAccess, setEditedAccess] = useState<UserMCPAccess>({
    policy: 'all',
    servers: [],
  });
  const isAdmin = user?.role === SystemRoles.ADMIN;
  const usersQuery = useAdminUsersQuery(
    { cursor, limit: 25, search: deferredSearch || undefined },
    isAdmin,
  );
  const serversQuery = useAdminMCPServersQuery(isAdmin);
  const inviteMutation = useInviteAdminUserMutation();
  const statusMutation = useUpdateAdminUserStatusMutation();
  const accessMutation = useUpdateAdminUserMCPAccessMutation();
  const servers = useMemo(() => serversQuery.data?.servers ?? [], [serversQuery.data?.servers]);

  if (!isAdmin) {
    return <Navigate to="/c/new" replace={true} />;
  }

  const resetPagination = () => {
    setCursor(undefined);
    setCursorHistory([]);
  };

  const submitInvite = () => {
    inviteMutation.mutate(
      { email: inviteEmail, expiresInDays: expiryDays, mcpAccess: inviteAccess },
      {
        onSuccess: () => {
          showToast({ status: 'success', message: localize('com_admin_users_invite_success') });
          setShowInvite(false);
          setInviteEmail('');
        },
        onError: () =>
          showToast({ status: 'error', message: localize('com_admin_users_invite_error') }),
      },
    );
  };

  const toggleStatus = (target: AdminUser) => {
    statusMutation.mutate(
      { userId: target.id, payload: { blocked: !target.blocked } },
      {
        onSuccess: () =>
          showToast({ status: 'success', message: localize('com_admin_users_status_success') }),
        onError: () =>
          showToast({ status: 'error', message: localize('com_admin_users_status_error') }),
      },
    );
  };

  const saveAccess = () => {
    if (!accessUser) {
      return;
    }
    accessMutation.mutate(
      { userId: accessUser.id, payload: { mcpAccess: editedAccess } },
      {
        onSuccess: () => {
          showToast({ status: 'success', message: localize('com_admin_users_mcp_success') });
          setAccessUser(undefined);
        },
        onError: () =>
          showToast({ status: 'error', message: localize('com_admin_users_mcp_error') }),
      },
    );
  };

  return (
    <main className="h-full overflow-y-auto bg-background p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl">
        <Link
          to="/c/new"
          className="mb-4 inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          {localize('com_ui_back')}
        </Link>
        <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-7 w-7 text-green-600" aria-hidden="true" />
              <h1 className="text-2xl font-semibold text-text-primary">
                {localize('com_admin_users_title')}
              </h1>
            </div>
            <p className="mt-2 text-sm text-text-secondary">
              {localize('com_admin_users_description')}
            </p>
          </div>
          <Button type="button" onClick={() => setShowInvite(true)} className="gap-2">
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            {localize('com_admin_users_invite')}
          </Button>
        </div>

        <div className="mb-4 flex items-center gap-2 rounded-lg border border-border-light bg-surface-primary px-3">
          <Search className="h-4 w-4 text-text-secondary" aria-hidden="true" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetPagination();
            }}
            aria-label={localize('com_admin_users_search')}
            placeholder={localize('com_admin_users_search')}
            className="border-0 bg-transparent focus-visible:ring-0"
          />
        </div>

        <div className="overflow-hidden rounded-xl border border-border-light bg-surface-primary">
          {usersQuery.isLoading && (
            <div className="flex min-h-48 items-center justify-center gap-2 text-text-secondary">
              <Spinner className="h-5 w-5" />
              {localize('com_admin_users_loading')}
            </div>
          )}
          {!usersQuery.isLoading && usersQuery.isError && (
            <div role="alert" className="p-8 text-center text-red-600">
              {localize('com_admin_users_load_error')}
            </div>
          )}
          {!usersQuery.isLoading && !usersQuery.isError && usersQuery.data?.users.length === 0 && (
            <div className="p-8 text-center text-text-secondary">
              {localize('com_admin_users_empty')}
            </div>
          )}
          {!usersQuery.isLoading &&
            !usersQuery.isError &&
            usersQuery.data != null &&
            usersQuery.data.users.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] border-collapse text-left text-sm">
                  <thead className="bg-surface-secondary text-text-secondary">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">
                        {localize('com_admin_users_name')}
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        {localize('com_admin_users_role')}
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        {localize('com_admin_users_status')}
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        {localize('com_admin_users_last_login')}
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        {localize('com_admin_users_mcp_access')}
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        {localize('com_admin_users_actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {usersQuery.data?.users.map((target) => (
                      <tr key={target.id} className="border-t border-border-light">
                        <td className="px-4 py-3">
                          <div className="font-medium text-text-primary">
                            {target.name || target.username || target.email}
                          </div>
                          <div className="text-xs text-text-secondary">{target.email}</div>
                        </td>
                        <td className="px-4 py-3 text-text-secondary">{target.role}</td>
                        <td className="px-4 py-3">
                          <span
                            className={
                              target.blocked
                                ? 'rounded-full bg-red-100 px-2 py-1 text-xs text-red-700'
                                : 'rounded-full bg-green-100 px-2 py-1 text-xs text-green-700'
                            }
                          >
                            {localize(
                              target.blocked ? 'com_admin_users_blocked' : 'com_admin_users_active',
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-text-secondary">
                          {formatDate(target.lastLoginAt, localize('com_admin_users_never'))}
                        </td>
                        <td className="px-4 py-3 text-text-secondary">
                          {target.role === SystemRoles.ADMIN || target.mcpAccess.policy === 'all'
                            ? localize('com_admin_users_mcp_all')
                            : `${target.mcpAccess.servers.length} / ${servers.length}`}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={statusMutation.isLoading || target.id === user?.id}
                              onClick={() => toggleStatus(target)}
                            >
                              {localize(
                                target.blocked
                                  ? 'com_admin_users_unblock'
                                  : 'com_admin_users_block',
                              )}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={target.role === SystemRoles.ADMIN}
                              onClick={() => {
                                setAccessUser(target);
                                setEditedAccess(target.mcpAccess);
                              }}
                            >
                              {localize('com_admin_users_mcp_access')}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>

        <nav
          className="mt-4 flex justify-end gap-2"
          aria-label={localize('com_admin_users_pagination')}
        >
          <Button
            type="button"
            variant="outline"
            disabled={cursorHistory.length === 0}
            onClick={() => {
              const history = [...cursorHistory];
              setCursor(history.pop());
              setCursorHistory(history);
            }}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            {localize('com_admin_users_previous')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!usersQuery.data?.nextCursor}
            onClick={() => {
              setCursorHistory((history) => [...history, cursor]);
              setCursor(usersQuery.data?.nextCursor);
            }}
          >
            {localize('com_admin_users_next')}
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </nav>
      </div>

      {showInvite && (
        <Modal title={localize('com_admin_users_invite')} onClose={() => setShowInvite(false)}>
          <div className="space-y-5">
            <label className="block text-sm font-medium text-text-primary">
              {localize('com_admin_users_email')}
              <Input
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                className="mt-2"
              />
            </label>
            <label className="block text-sm font-medium text-text-primary">
              {localize('com_admin_users_expiry')}
              <Input
                type="number"
                min={1}
                max={30}
                value={expiryDays}
                onChange={(event) => setExpiryDays(Number(event.target.value))}
                className="mt-2"
              />
            </label>
            <AccessFields access={inviteAccess} servers={servers} onChange={setInviteAccess} />
            <div className="flex justify-end">
              <Button
                type="button"
                disabled={!inviteEmail.trim() || inviteMutation.isLoading}
                onClick={submitInvite}
              >
                {inviteMutation.isLoading && <Spinner className="mr-2 h-4 w-4" />}
                {localize('com_admin_users_send_invite')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {accessUser && (
        <Modal
          title={`${localize('com_admin_users_mcp_access')}: ${accessUser.email}`}
          onClose={() => setAccessUser(undefined)}
        >
          <div className="space-y-5">
            <AccessFields access={editedAccess} servers={servers} onChange={setEditedAccess} />
            <div className="flex justify-end">
              <Button type="button" disabled={accessMutation.isLoading} onClick={saveAccess}>
                {accessMutation.isLoading && <Spinner className="mr-2 h-4 w-4" />}
                {localize('com_admin_users_mcp_save')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
