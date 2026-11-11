const PERMISSION_CATEGORIES = new Set([
  'read_only',
  'action',
  'approval_required',
]);

export class ToolPermissionError extends Error {
  constructor(message = 'Tool permission denied.') {
    super(message);
    this.name = 'ToolPermissionError';
    this.code = 'TOOL_PERMISSION_DENIED';
  }
}

export function assertToolPermission(tool, trustedContext = {}) {
  if (!tool || !PERMISSION_CATEGORIES.has(tool.category)) {
    throw new ToolPermissionError('Tool has an unknown permission category.');
  }
  if (tool.category !== 'read_only') {
    throw new ToolPermissionError('Action tools are unavailable in this release.');
  }

  const grants = trustedContext.authorizedTools;
  const explicitlyAuthorized = grants instanceof Set
    ? grants.has(tool.name)
    : Array.isArray(grants) && grants.includes(tool.name);

  if (!explicitlyAuthorized) {
    throw new ToolPermissionError();
  }
  return true;
}
