const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();
let mockVerify;

jest.mock('passport-jwt', () => ({
  ExtractJwt: { fromAuthHeaderAsBearerToken: jest.fn(() => 'extractor') },
  Strategy: jest.fn((_options, callback) => {
    mockVerify = callback;
    return { verify: callback };
  }),
}));

jest.mock('~/models', () => ({
  getUserById: mockGetUserById,
  updateUser: mockUpdateUser,
}));

const jwtLogin = require('./jwtStrategy');

describe('jwtStrategy blocked users', () => {
  it('rejects an existing access token after the account is blocked', async () => {
    mockGetUserById.mockResolvedValue({
      _id: { toString: () => 'blocked-user' },
      email: 'blocked@example.com',
      role: 'USER',
      blocked: true,
    });
    const done = jest.fn();
    jwtLogin();

    await mockVerify({ id: 'blocked-user' }, done);

    expect(done).toHaveBeenCalledWith(null, false);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});
