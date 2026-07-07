export const APP_NAME = "dockerstart";
export const DISPLAY_NAME = "Docker Manager";
export const GATEWAY_PREFIX = "/app/dockerstart";
export const GATEWAY_SOCKET = "app.sock";
export const LAUNCH_ID = "dockerstart.Application";

export const DEFAULT_SETTINGS = {
  checkIntervalSeconds: 60,
  startupRetryDelaySeconds: 10,
  startupTimeoutSeconds: 120,
};

export const DEFAULT_CONTAINER_CONFIG = {
  enabled: false,
  startupOrder: 0,
  startupDelaySeconds: 0,
  monitor: false,
  monitorOrder: 0,
};

export const LIMITS = {
  checkIntervalSeconds: { min: 10, max: 3600 },
  startupRetryDelaySeconds: { min: 3, max: 600 },
  startupTimeoutSeconds: { min: 15, max: 3600 },
  startupDelaySeconds: { min: 0, max: 3600 },
  startupOrder: { min: 0, max: 999999 },
  monitorOrder: { min: 0, max: 999999 },
};
