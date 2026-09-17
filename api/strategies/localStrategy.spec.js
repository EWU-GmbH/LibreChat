const mockFindUser = jest.fn();
const mockUpdateUser = jest.fn();
let mockVerify;

jest.mock('passport-local', () => ({
  Strategy: jest.fn((_options, callback) => {
    mockVerify = callback;
    return { verify: callback };
  }),
}));

jest.mock('@librechat/api', () => ({
  checkEmailConfig: jest.fn(() => true),
  comparePassword: jest.fn(),
  isEnabled: jest.fn(() => false),
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  errorsToString: jest.fn(),
}));

jest.mock('~/models', () => ({
  findUser: mockFindUser,
  updateUser: mockUpdateUser,
}));

jest.mock('./validators', () => ({
  loginSchema: { safeParse: jest.fn(() => ({ success: true })) },
}));

const localStrategy = require('./localStrategy');

describe('localStrategy blocked users', () => {
  it('rejects a blocked account before password authentication', async () => {
    mockFindUser.mockResolvedValue({
      _id: 'blocked-user',
      email: 'blocked@example.com',
      password: 'hash',
      blocked: true,
    });
    const done = jest.fn();
    localStrategy();

    await mockVerify(
      { body: { email: 'blocked@example.com' }, ip: '127.0.0.1' },
      'blocked@example.com',
      'password',
      done,
    );

    expect(done).toHaveBeenCalledWith(null, false, {
      message: 'This account has been blocked.',
    });
  });
});
