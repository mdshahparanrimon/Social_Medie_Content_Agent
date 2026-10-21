// No API key: the user's own Claude (claude.ai, Claude Desktop) does the writing with their subscription,
// reading the Brand Brain and saving posts through the MCP connector (see ../mcp.js). Nothing here calls an AI.
export const label = 'Claude.ai (MCP)';
export const isConfigured = (config) => Boolean(config.mcp_token_hash);
export const model = () => 'your Claude subscription';

// Shown when an in-app AI button is used while this provider is selected.
export const unavailable =
  'Your AI is Claude.ai (MCP): ask Claude in claude.ai to plan or write posts and they appear here. ' +
  'To also write from inside the app, pick a provider with an API key in Settings → AI.';
