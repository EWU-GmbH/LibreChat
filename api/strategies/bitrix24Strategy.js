const OAuth2Strategy = require('passport-oauth2');
const passport = require('passport');
const { handleBitrix24OAuth } = require('../server/utils/bitrix24');
const { logger } = require('~/config');
const User = require('../models/User'); // Đường dẫn tới model User của bạn

module.exports = function bitrix24Login() {
  return new OAuth2Strategy(
    {
      authorizationURL: `${process.env.BITRIX24_BASE_URL}/oauth/authorize/`,
      tokenURL: `${process.env.BITRIX24_BASE_URL}/oauth/token/`,
      clientID: process.env.BITRIX24_CLIENT_ID,
      clientSecret: process.env.BITRIX24_CLIENT_SECRET,
      callbackURL: `${process.env.DOMAIN_SERVER}${process.env.BITRIX24_CALLBACK_URL}`,
      scope: [],
      proxy: false,
      passReqToCallback: true, // Để truyền req vào verify callback
    },
    async (req, accessToken, refreshToken, params, profile, done) => {
      try {
        // Sử dụng handleBitrix24OAuth để lấy user, payload, tokens
        await handleBitrix24OAuth(
          req,
          {
            json: async (data) => {
              // --- ĐỒNG BỘ USER VỚI DATABASE ---
              let user = await User.findOne({ 'authProvider': 'bitrix24', 'authProviderId': data.user.id });
              if (!user && data.user.email) {
                user = await User.findOne({ email: data.user.email });
              }
              if (!user) {
                user = await User.create({
                  email: data.user.email,
                  name: `${data.user.name.firstName} ${data.user.name.lastName}`,
                  avatar: data.user.photo,
                  authProvider: 'bitrix24',
                  authProviderId: data.user.id,
                  // ...các trường khác nếu cần
                });
              }

              // Trả về user DB cho Passport (phải có _id)
              return done(null, {
                ...data.user,
                _id: user._id,
                tokens: data.tokens,
                payload: data.payload,
              });
            },
            status: () => ({
              json: (err) => done(err, false),
            }),
            redirect: () => done(new Error('Should not redirect in strategy'), false),
          },
          {
            // Truyền accessToken, refreshToken, params vào config nếu cần
            accessToken,
            refreshToken,
            params,
          }
        );
      } catch (err) {
        logger.error('Bitrix24 strategy error:', err);
        return done(err);
      }
    }
  );
};