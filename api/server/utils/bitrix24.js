/**
 * Bitrix24 OAuth2 Utility (JS version)
 * @see https://apidocs.bitrix24.com/api-reference/oauth/index.html
 */

const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const defu = require('defu');

function getBitrix24Tokens(tokens) {
  return {
    accessToken: tokens.access_token,
    clientEndpoint: tokens.client_endpoint,
    domain: tokens.domain,
    expiresIn: tokens.expires_in,
    memberId: tokens.member_id,
    refreshToken: tokens.refresh_token,
    scope: tokens.scope,
    serverEndpoint: tokens.server_endpoint,
    status: tokens.status,
  };
}

function getBitrix24UserProfile(response, tokens) {
  return {
    id: parseInt(response.result.ID, 10),
    isAdmin: response.result.ADMIN,
    email: response.result.EMAIL,
    targetOrigin: `https://${tokens.params.client_endpoint.replace(/https?:\/\//, '').replace(/:(80|443)$/, '').replace('/rest/', '')}`,
    name: {
      firstName: response.result.NAME,
      lastName: response.result.LAST_NAME,
    },
    gender: response.result.PERSONAL_GENDER,
    photo: response.result.PERSONAL_PHOTO,
    timeZone: response.result.TIME_ZONE,
    timeZoneOffset: response.result.TIME_ZONE_OFFSET,
  };
}

/**
 * Main Bitrix24 OAuth2 handler
 * @param {Object} config
 * @param {Function} onSuccess
 * @param {Function} onError
 */
async function handleBitrix24OAuth(req, res, config = {}, onSuccess, onError) {
  try {
    // //console.log('Handling Bitrix24 OAuth request:', req.query);
    const { domain, code, state } = req.query;

    if (!code && typeof domain === 'undefined') {
      const error = new Error('Query parameter `domain` empty or missing. Please provide a valid Bitrix24 domain.');
      if (onError) return onError(req, res, error);
      throw error;
    }
    //console.log('Bitrix24 OAuth request:', { domain, code, state });
    config = defu(config, {
      authorizationURL: `${domain}/oauth/authorize/`,
      tokenURL: `${domain}/oauth/token/`,
      server_domain: domain,
      clientId: process.env.BITRIX24_CLIENT_ID,
      clientSecret: process.env.BITRIX24_CLIENT_SECRET,
    });
    //console.log('Bitrix24 OAuth config QUYQUY:', config);
    // State check (implement your own state logic if needed)
    // ...

    if (!code) {
      // Redirect to Bitrix24 OAuth page
      const params = new URLSearchParams({
        client_id: config.clientId,
        state: state || '',
      });
      return res.redirect(`${config.authorizationURL}?${params.toString()}`);
    }

    // // Exchange code for tokens
    // const tokenParams = new URLSearchParams({
    //   grant_type: 'authorization_code',
    //   client_id: config.clientId,
    //   client_secret: config.clientSecret,
    //   redirect_uri: 'http://127.0.0.1:3080/oauth/bitrix24/callback/', // set if needed
    //   code,
    // });
    // //console.log('Bitrix24 token request params:', tokenParams.toString());
    // const tokenRes = await fetch(config.tokenURL+'?'+tokenParams.toString());
    // //console.log('Bitrix24 token response status:', tokenRes);
    // const tokens = await tokenRes.json();
    // //console.log('Bitrix24 tokens received:', tokens);
    // if (tokens.error) {
    //   if (onError) return onError(req, res, tokens);
    //   throw new Error(tokens.error_description || 'Bitrix24 token error');
    // }

    const payload = config;
    //console.log('Bitrix24 OAuth payload:', payload);
    // Get user profile
    const profileRes = await fetch(`https://io.ewu-web.de/rest/user.current`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth: payload.accessToken }),
    });
    //console.log('Bitrix24 user profile response status:', profileRes);
    const profileData = await profileRes.json();
    //console.log('Bitrix24 user profile response:', profileData);
    const user = getBitrix24UserProfile(profileData, config);
    //console.log('Bitrix24 user profile:', user);
    //console.log('Bitrix24 onon:', onSuccess);

    if (onSuccess) return onSuccess(req, res, { user, payload, config });
    res.json({ user, payload, config });
  } catch (err) {
    if (onError) return onError(req, res, err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  handleBitrix24OAuth,
};