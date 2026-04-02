const Store = require('electron-store');

const store = new Store({ encryptionKey: 'smallchat-v1' });

// GitHub OAuth App client ID for Copilot device flow
const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

class AuthManager {
  constructor() {
    this._token = store.get('github_token', null);
    this._user = store.get('github_user', null);
    this._copilotToken = null;
    this._copilotExpiry = 0;
    this._hasCopilotAccess = store.get('has_copilot_access', false);
    this._deviceFlowAbort = null;
  }

  isLoggedIn() {
    return !!this._token;
  }

  getToken() {
    return this._token;
  }

  getUser() {
    return this._user;
  }

  hasCopilotAccess() {
    return this._hasCopilotAccess;
  }

  // ── GitHub OAuth Device Flow ────────────────────────

  async startDeviceFlow() {
    const response = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: 'read:user',
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to start device flow (HTTP ${response.status})`);
    }

    return await response.json();
    // Returns: { device_code, user_code, verification_uri, expires_in, interval }
  }

  async pollDeviceFlow(deviceCode, interval) {
    const controller = new AbortController();
    this._deviceFlowAbort = controller;

    let pollInterval = interval || 5;

    while (!controller.signal.aborted) {
      await new Promise((r) => setTimeout(r, pollInterval * 1000));
      if (controller.signal.aborted) break;

      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });

      const data = await response.json();

      if (data.access_token) {
        this._deviceFlowAbort = null;
        return await this._completeLogin(data.access_token);
      }

      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') {
        pollInterval += 5;
        continue;
      }
      if (data.error === 'expired_token') throw new Error('Login expired. Please try again.');
      if (data.error === 'access_denied') throw new Error('Login was denied by the user.');
      throw new Error(data.error_description || data.error || 'Unknown login error');
    }

    throw new Error('Login cancelled.');
  }

  cancelDeviceFlow() {
    if (this._deviceFlowAbort) {
      this._deviceFlowAbort.abort();
      this._deviceFlowAbort = null;
    }
  }

  // ── Complete login (shared by OAuth and PAT) ────────

  async _completeLogin(token) {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'SmallChat/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch user info (HTTP ${response.status})`);
    }

    const user = await response.json();
    this._token = token;
    this._user = { login: user.login, avatar: user.avatar_url, name: user.name };

    store.set('github_token', this._token);
    store.set('github_user', this._user);

    // Auto-detect Copilot access
    try {
      await this.getCopilotToken();
      this._hasCopilotAccess = true;
    } catch {
      this._hasCopilotAccess = false;
    }
    store.set('has_copilot_access', this._hasCopilotAccess);

    return { loggedIn: true, user: this._user, copilotAccess: this._hasCopilotAccess };
  }

  // ── Copilot token exchange ──────────────────────────

  async getCopilotToken() {
    if (this._copilotToken && Date.now() < this._copilotExpiry - 60000) {
      return this._copilotToken;
    }

    const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        Authorization: `Bearer ${this._token}`,
        Accept: 'application/json',
        'User-Agent': 'SmallChat/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get Copilot token (HTTP ${response.status}). Make sure you have a GitHub Copilot license.`);
    }

    const data = await response.json();
    this._copilotToken = data.token;
    this._copilotExpiry = data.expires_at * 1000;
    return this._copilotToken;
  }

  // ── PAT login (fallback for GitHub Models) ──────────

  async login(token) {
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      return { error: 'Token is required.' };
    }
    try {
      return await this._completeLogin(token.trim());
    } catch (err) {
      return { error: err.message };
    }
  }

  logout() {
    this.cancelDeviceFlow();
    this._token = null;
    this._user = null;
    this._copilotToken = null;
    this._copilotExpiry = 0;
    this._hasCopilotAccess = false;
    store.delete('github_token');
    store.delete('github_user');
    store.delete('has_copilot_access');
  }
}

module.exports = { AuthManager };
