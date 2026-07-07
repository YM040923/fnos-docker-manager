export function setStartupParticipation(config = {}, enabled) {
  return {
    ...config,
    enabled: Boolean(enabled),
    monitor: config.monitor === true,
  };
}

export function setGuardParticipation(config = {}, monitor) {
  return {
    ...config,
    enabled: config.enabled === true,
    monitor: Boolean(monitor),
  };
}
