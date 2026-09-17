import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { SystemRoles } from 'librechat-data-provider';
import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react';
import AdminUsersPage from './Page';

const mockUseAdminUsersQuery = jest.fn();
const mockUseAdminMCPServersQuery = jest.fn();

jest.mock('~/data-provider', () => ({
  useAdminUsersQuery: (...args: never[]) => mockUseAdminUsersQuery(...args),
  useAdminMCPServersQuery: (...args: never[]) => mockUseAdminMCPServersQuery(...args),
  useInviteAdminUserMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useUpdateAdminUserStatusMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useUpdateAdminUserMCPAccessMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));

const mockAuth = {
  user: { id: 'admin-id', role: SystemRoles.ADMIN },
};

jest.mock('~/hooks', () => ({
  useAuthContext: () => mockAuth,
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Spinner: () => <span data-testid="spinner" />,
  useToastContext: () => ({ showToast: jest.fn() }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminUsersPage />
    </MemoryRouter>,
  );
}

describe('AdminUsersPage', () => {
  beforeEach(() => {
    mockAuth.user = { id: 'admin-id', role: SystemRoles.ADMIN };
    mockUseAdminMCPServersQuery.mockReturnValue({
      data: { servers: ['dataforseo', 'formbricks', 'listmonk'] },
    });
  });

  it('renders its loading state', () => {
    mockUseAdminUsersQuery.mockReturnValue({ isLoading: true });

    renderPage();

    expect(screen.getByText('com_admin_users_loading')).toBeInTheDocument();
  });

  it('renders its error state', () => {
    mockUseAdminUsersQuery.mockReturnValue({ isLoading: false, isError: true });

    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('com_admin_users_load_error');
  });

  it('renders users and permission controls', () => {
    mockUseAdminUsersQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        users: [
          {
            id: 'user-id',
            name: 'Test User',
            username: 'test',
            email: 'test@example.com',
            role: 'user',
            provider: 'local',
            blocked: false,
            mcpAccess: { policy: 'allowlist', servers: ['formbricks'] },
          },
        ],
      },
    });

    renderPage();

    expect(screen.getByText('test@example.com')).toBeInTheDocument();
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_admin_users_mcp_access' })).toBeEnabled();
  });

  it('does not request admin data for non-admin users', () => {
    mockAuth.user = { id: 'user-id', role: SystemRoles.USER };
    mockUseAdminUsersQuery.mockReturnValue({ isLoading: false });

    renderPage();

    expect(mockUseAdminUsersQuery).toHaveBeenCalledWith(expect.any(Object), false);
  });
});
