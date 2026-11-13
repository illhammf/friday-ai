const PERMISSION_CATEGORIES = new Set([
  'read_only',
  'action',
  'approval_required',
]);
const CAPABILITY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export class ToolPermissionError extends Error {
  constructor(message = 'Tool permission denied.') {
    super(message);
    this.name = 'ToolPermissionError';
    this.code = 'TOOL_PERMISSION_DENIED';
  }
}

export function hasRequiredCapabilities(tool, grantedCapabilities) {
  const uniqueCapabilities = new Set(
    Array.isArray(grantedCapabilities) ? grantedCapabilities : [],
  );
  return Boolean(
    Array.isArray(tool?.requiredCapabilities) &&
    tool.requiredCapabilities.length > 0 &&
    Array.isArray(grantedCapabilities) &&
    grantedCapabilities.every((capability) =>
      typeof capability === 'string' &&
      CAPABILITY_PATTERN.test(capability)) &&
    uniqueCapabilities.size === grantedCapabilities.length &&
    tool.requiredCapabilities.every((capability) =>
      grantedCapabilities.includes(capability)),
  );
}

export function assertToolPermission(tool, trustedContext = {}) {
  if (!tool || !PERMISSION_CATEGORIES.has(tool.category)) {
    throw new ToolPermissionError('Tool has an unknown permission category.');
  }
  if (tool.category !== 'read_only') {
    throw new ToolPermissionError('Action tools are unavailable in this release.');
  }

  const grantedCapabilities = trustedContext.grantedCapabilities;
  if (!hasRequiredCapabilities(tool, grantedCapabilities)) {
    throw new ToolPermissionError();
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
