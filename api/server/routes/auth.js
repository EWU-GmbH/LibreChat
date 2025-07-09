const express = require('express');
const {
  refreshController,
  registrationController,
  resetPasswordController,
  resetPasswordRequestController,
} = require('~/server/controllers/AuthController');
const { loginController } = require('~/server/controllers/auth/LoginController');
const { logoutController } = require('~/server/controllers/auth/LogoutController');
const { verify2FAWithTempToken } = require('~/server/controllers/auth/TwoFactorAuthController');
const {
  enable2FA,
  verify2FA,
  disable2FA,
  regenerateBackupCodes,
  confirm2FA,
} = require('~/server/controllers/TwoFactorController');
const {
  checkBan,
  logHeaders,
  loginLimiter,
  requireJwtAuth,
  checkInviteUser,
  registerLimiter,
  requireLdapAuth,
  setBalanceConfig,
  requireLocalAuth,
  resetPasswordLimiter,
  validateRegistration,
  validatePasswordReset,
} = require('~/server/middleware');

const session = require('express-session');
const passport = require('passport');
const { User } = require('~/db/models');
const { setAuthTokens } = require('~/server/services/AuthService');

const router = express.Router();

const ldapAuth = !!process.env.LDAP_URL && !!process.env.LDAP_USER_SEARCH_BASE;
//Local
router.post('/logout', requireJwtAuth, logoutController);
router.post(
  '/login',
  logHeaders,
  loginLimiter,
  checkBan,
  ldapAuth ? requireLdapAuth : requireLocalAuth,
  setBalanceConfig,
  loginController,
);
router.post('/refresh', refreshController);
router.post(
  '/register',
  registerLimiter,
  checkBan,
  checkInviteUser,
  validateRegistration,
  registrationController,
);
router.post(
  '/requestPasswordReset',
  resetPasswordLimiter,
  checkBan,
  validatePasswordReset,
  resetPasswordRequestController,
);
router.post('/resetPassword', checkBan, validatePasswordReset, resetPasswordController);

router.get('/2fa/enable', requireJwtAuth, enable2FA);
router.post('/2fa/verify', requireJwtAuth, verify2FA);
router.post('/2fa/verify-temp', checkBan, verify2FAWithTempToken);
router.post('/2fa/confirm', requireJwtAuth, confirm2FA);
router.post('/2fa/disable', requireJwtAuth, disable2FA);
router.post('/2fa/backup/regenerate', requireJwtAuth, regenerateBackupCodes);

router.post(
  '/bitrix24',
  async (req, res, next) => {
  const { user } = req.body;
  if (!user || !user.id) {
    return res.status(400).json({ error: 'Invalid Bitrix24 user info' });
  }
  try {
      let dbUser = null;
      if (user.email) {
        dbUser = await User.findOne({ email: user.email });
      }
      if (!dbUser) {
        dbUser = await User.create({
          email: user.email,
          name: `${user.name.firstName} ${user.name.lastName}`,
          avatar: user.photo,
          authProvider: 'bitrix24',
          authProviderId: user.id,
          // ...các trường khác nếu cần
        });
      }
      // Đăng nhập với Passport (tạo session)
      const token = await setAuthTokens(dbUser, res);
      res.json({ user: dbUser, token:token });
  } catch (error) {
    next(error);
  }
});
module.exports = router;
