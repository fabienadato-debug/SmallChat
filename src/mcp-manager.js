const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { DeviceCodeCredential } = require('@azure/identity');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Map well-known Azure API hosts to their token scopes
const AZURE_SCOPE_MAP = {
  'api.fabric.microsoft.com': 'https://api.fabric.microsoft.com/.default',
  'management.azure.com': 'https://management.azure.com/.default',
  'graph.microsoft.com': 'https://graph.microsoft.com/.default',
  'api.powerbi.com': 'https://analysis.windows.net/powerbi/api/.default',
};

class McpManager {
  constructor() {
    // Map<serverName, { client, transport, tools[], status }>
    this._servers = new Map();
    this._config = {};
    this._credential = null;
    // Map<sanitizedQualifiedName, { serverName, toolName }> for reverse lookup
    this._toolMap = new Map();
    // Callback to notify UI about device-code login prompts
    this.onDeviceCode = null;
    // Power BI Desktop auto-connect state
    this._pbiConnected = false;
    this._pbiInstance = null;
    // Set of disabled server names
    this._disabledServers = new Set();
  }

  /** Sanitize a name to only contain characters valid for OpenAI function names */
  _sanitize(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  async loadConfig(configPath) {
    if (!fs.existsSync(configPath)) {
      console.log('No MCP config found at', configPath);
      return;
    }

    const raw = fs.readFileSync(configPath, 'utf-8');
    this._config = JSON.parse(raw);
  }

  setConfig(config) {
    this._config = config;
  }

  setDisabledServers(names) {
    this._disabledServers = new Set(names || []);
  }

  getDisabledServers() {
    return [...this._disabledServers];
  }

  async connectAll() {
    const servers = this._config.mcpServers || {};

    for (const [name, cfg] of Object.entries(servers)) {
      if (this._disabledServers.has(name)) {
        console.log(`[MCP] Skipping disabled server "${name}"`);
        this._servers.set(name, {
          client: null,
          transport: null,
          tools: [],
          status: 'disabled',
        });
        continue;
      }
      await this._connectServer(name, cfg);
    }
  }

  /**
   * Resolve a Bearer token for an HTTP MCP server URL.
   * Uses Device Code flow so the user can authenticate via browser.
   */
  async _getAzureToken(url) {
    const host = new URL(url).hostname;
    const scope = AZURE_SCOPE_MAP[host];
    if (!scope) return null;

    if (!this._credential) {
      this._credential = new DeviceCodeCredential({
        userPromptCallback: (info) => {
          console.log(`[Azure Auth] ${info.message}`);
          if (this.onDeviceCode) {
            this.onDeviceCode(info);
          }
        },
      });
    }

    const tokenResponse = await this._credential.getToken(scope);
    return tokenResponse?.token || null;
  }

  async _connectServer(name, cfg) {
    try {
      console.log(`[MCP] Connecting to "${name}" (${cfg.type || 'stdio'})...`);

      let transport;

      if (cfg.type === 'http' || cfg.type === 'sse') {
        const headers = { ...(cfg.headers || {}) };

        // Auto-acquire Azure token if no Authorization header is set
        if (!headers['Authorization'] && cfg.url) {
          try {
            const token = await this._getAzureToken(cfg.url);
            if (token) {
              headers['Authorization'] = `Bearer ${token}`;
              console.log(`[MCP] Acquired Azure token for "${name}"`);
            }
          } catch (err) {
            console.warn(`[MCP] Azure token acquisition failed for "${name}":`, err.message);
          }
        }

        transport = new StreamableHTTPClientTransport(
          new URL(cfg.url),
          { requestInit: { headers } }
        );
      } else {
        // Default: stdio
        transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args || [],
          env: { ...process.env, ...(cfg.env || {}) },
          stderr: 'pipe',
        });
      }

      const client = new Client({
        name: 'SmallChat',
        version: '1.0.0',
      });

      await client.connect(transport);

      // Monitor stderr for device-code login prompts
      if (transport.stderr) {
        transport.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          console.log(`[MCP/${name} stderr] ${text.trim()}`);
          // Detect Azure device code messages and surface them
          const codeMatch = text.match(/code\s+([A-Z0-9]{6,12})\s+/i);
          const urlMatch = text.match(/(https:\/\/microsoft\.com\/devicelogin)/i);
          if (codeMatch && urlMatch && this.onDeviceCode) {
            this.onDeviceCode({
              userCode: codeMatch[1],
              verificationUri: urlMatch[1],
              message: text.trim(),
            });
          }
        });
      }

      // List available tools
      let tools = [];
      try {
        const result = await client.listTools(undefined, { timeout: 300000 });
        const safeName = this._sanitize(name);
        tools = (result.tools || []).map((t) => {
          const safeToolName = this._sanitize(t.name);
          const qualifiedName = `${safeName}__${safeToolName}`;
          this._toolMap.set(qualifiedName, { serverName: name, toolName: t.name });
          return { ...t, serverName: name, qualifiedName };
        });
      } catch {
        // Server may not support tools
      }

      this._servers.set(name, {
        client,
        transport,
        tools,
        status: 'connected',
      });

      console.log(`[MCP] "${name}" connected with ${tools.length} tool(s)`);

      // Auto-connect to Power BI Desktop if this server has the connection tools
      const hasListInstances = tools.some((t) => t.name === 'connection_operations');
      if (hasListInstances) {
        await this._autoConnectPbi(name);
      }
    } catch (err) {
      console.error(`[MCP] Failed to connect "${name}":`, err.message);
      this._servers.set(name, {
        client: null,
        transport: null,
        tools: [],
        status: `error: ${err.message}`,
      });
    }
  }

  /**
   * Discover running Power BI Desktop instances by reading port files from disk
   * (no admin rights needed) and auto-connect to the most recent one.
   */
  async _autoConnectPbi(serverName) {
    try {
      const entry = this._servers.get(serverName);
      if (!entry || entry.status !== 'connected') return;

      // Find PBI Desktop port files — works for both Store and MSI installs
      const userHome = os.homedir();
      const searchPaths = [
        path.join(userHome, 'Microsoft', 'Power BI Desktop Store App', 'AnalysisServicesWorkspaces'),
        path.join(process.env.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local'), 'Microsoft', 'Power BI Desktop', 'AnalysisServicesWorkspaces'),
      ];

      const instances = [];
      for (const basePath of searchPaths) {
        if (!fs.existsSync(basePath)) continue;
        const workspaces = fs.readdirSync(basePath, { withFileTypes: true }).filter((d) => d.isDirectory());
        for (const ws of workspaces) {
          const portFile = path.join(basePath, ws.name, 'Data', 'msmdsrv.port.txt');
          if (!fs.existsSync(portFile)) continue;
          const port = fs.readFileSync(portFile, 'utf-8').trim();
          if (/^\d+$/.test(port)) {
            const stat = fs.statSync(portFile);
            instances.push({ port: parseInt(port, 10), workspace: ws.name, modifiedAt: stat.mtimeMs });
          }
        }
      }

      if (instances.length === 0) {
        console.log('[MCP/PBI] No Power BI Desktop port files found');
        this._pbiConnected = false;
        this._pbiInstance = null;
        return;
      }

      // Pick the most recently modified (most likely the active one)
      instances.sort((a, b) => b.modifiedAt - a.modifiedAt);
      const instance = instances[0];
      console.log(`[MCP/PBI] Found ${instances.length} instance(s), connecting to port ${instance.port}...`);

      // Connect via the MCP server
      const connectResult = await entry.client.callTool({
        name: 'connection_operations',
        arguments: { request: JSON.stringify({ operation: 'Connect', connectionString: `Data Source=localhost:${instance.port}` }) },
      }, undefined, { timeout: 300000 });

      const connectText = (connectResult.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      const connectData = JSON.parse(connectText);

      if (connectData.success) {
        console.log(`[MCP/PBI] Auto-connected to Power BI Desktop on port ${instance.port}`);
        this._pbiConnected = true;
        this._pbiInstance = { port: instance.port, workspace: instance.workspace };
      } else {
        console.warn('[MCP/PBI] Auto-connect failed:', connectData.message);
        this._pbiConnected = false;
        this._pbiInstance = null;
      }
    } catch (err) {
      console.warn('[MCP/PBI] Auto-connect error:', err.message);
      this._pbiConnected = false;
      this._pbiInstance = null;
    }
  }

  async disconnectAll() {
    for (const [name, entry] of this._servers) {
      try {
        if (entry.transport) {
          await entry.transport.close();
        }
      } catch (err) {
        console.error(`[MCP] Error disconnecting "${name}":`, err.message);
      }
    }
    this._servers.clear();
    this._toolMap.clear();
    this._pbiConnected = false;
    this._pbiInstance = null;
  }

  getAllTools() {
    const tools = [];
    for (const entry of this._servers.values()) {
      if (entry.status === 'connected') {
        tools.push(...entry.tools);
      }
    }
    return tools;
  }

  async callTool(qualifiedName, args, signal) {
    // Resolve sanitized qualified name back to original server + tool names
    const mapping = this._toolMap.get(qualifiedName);
    if (!mapping) throw new Error(`Unknown tool: ${qualifiedName}`);

    const { serverName, toolName } = mapping;
    const entry = this._servers.get(serverName);
    if (!entry || entry.status !== 'connected') {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    const result = await entry.client.callTool({ name: toolName, arguments: args }, undefined, { timeout: 300000, signal });

    // Extract text content from MCP result
    if (result.content && Array.isArray(result.content)) {
      return result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    }

    return JSON.stringify(result);
  }

  getStatus() {
    const status = {};
    for (const [name, entry] of this._servers) {
      status[name] = {
        status: entry.status,
        tools: entry.tools.map((t) => ({ name: t.name, description: t.description })),
        disabled: this._disabledServers.has(name),
      };
    }
    // Include configured but not yet in _servers (e.g. disabled on first load)
    const servers = this._config.mcpServers || {};
    for (const name of Object.keys(servers)) {
      if (!status[name]) {
        status[name] = {
          status: 'disabled',
          tools: [],
          disabled: true,
        };
      }
    }
    return status;
  }
}

module.exports = { McpManager };
