export const APP_NAME = "dockermanager";
export const DISPLAY_NAME = "Docker Manager";
export const GATEWAY_PREFIX = "/app/dockermanager";
export const GATEWAY_SOCKET = "app.sock";
export const LAUNCH_ID = "dockermanager.Application";

export const DEFAULT_SETTINGS = {
  checkIntervalSeconds: 60,
  startupRetryDelaySeconds: 10,
  startupTimeoutSeconds: 120,
};

export const DEFAULT_CONTAINER_CONFIG = {
  enabled: true,
  startupOrder: 0,
  startupDelaySeconds: 0,
  monitor: true,
};

export const LIMITS = {
  checkIntervalSeconds: { min: 10, max: 3600 },
  startupRetryDelaySeconds: { min: 3, max: 600 },
  startupTimeoutSeconds: { min: 15, max: 3600 },
  startupDelaySeconds: { min: 0, max: 3600 },
  startupOrder: { min: 0, max: 999999 },
};
