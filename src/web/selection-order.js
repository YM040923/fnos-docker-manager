function itemFor(container, config) {
  return config?.containers?.[container.id] || container.config || {};
}

function isSelected(container, config, mode) {
  const item = itemFor(container, config);
  return mode === "guard" ? item.monitor === true : item.enabled === true;
}

function orderOf(container, config, mode = "orchestration") {
  const item = itemFor(container, config);
  const order = Number(mode === "guard" ? item.monitorOrder ?? item.startupOrder : item.startupOrder);
  return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
}

function selectedContainers(containers, config, mode) {
  return [...containers]
    .filter((container) => isSelected(container, config, mode))
    .sort((a, b) => {
      return (
        orderOf(a, config, mode) - orderOf(b, config, mode) ||
        String(a.name || a.id).localeCompare(String(b.name || b.id))
      );
    });
}

export function sortSelectionContainers(containers, config, mode) {
  const selected = selectedContainers(containers, config, mode);
  const selectedIds = new Set(selected.map((container) => container.id));
  const unselected = [...containers]
    .filter((container) => !selectedIds.has(container.id))
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  return [...selected, ...unselected];
}

export function positionInMode(id, containers, config, mode) {
  return selectedContainers(containers, config, mode).findIndex((container) => container.id === id) + 1;
}

export function nextSelectionOrder(config, mode) {
  const entries = Object.values(config?.containers || {}).filter((item) =>
    mode === "guard" ? item.monitor === true : item.enabled === true,
  );
  const orders = entries
    .map((item) => Number(mode === "guard" ? item.monitorOrder ?? item.startupOrder : item.startupOrder))
    .filter(Number.isFinite);
  return orders.length > 0 ? Math.max(...orders) + 10 : 10;
}

export function reorderModeConfig({ config, containers, mode, draggedId, targetId }) {
  if (mode === "guard") return config;
  if (!draggedId || draggedId === targetId) return config;
  const dragged = containers.find((container) => container.id === draggedId);
  if (!dragged) return config;

  const next = {
    ...config,
    containers: { ...(config.containers || {}) },
  };
  const selected = selectedContainers(containers, next, mode)
    .map((container) => container.id)
    .filter((id) => id !== draggedId);
  const targetIndex = targetId ? selected.indexOf(targetId) : -1;
  const insertIndex = targetIndex >= 0 ? targetIndex : selected.length;
  selected.splice(insertIndex, 0, draggedId);

  const activeIds = selected;
  const activeSet = new Set(activeIds);
  const otherIds = Object.keys(next.containers)
    .filter((id) => !activeSet.has(id))
    .sort((a, b) => {
      const aContainer = containers.find((item) => item.id === a);
      const bContainer = containers.find((item) => item.id === b);
      const aOrder = orderOf(aContainer || { id: a, config: next.containers[a] }, next, mode);
      const bOrder = orderOf(bContainer || { id: b, config: next.containers[b] }, next, mode);
      return aOrder - bOrder || String(next.containers[a]?.name || a).localeCompare(String(next.containers[b]?.name || b));
    });

  [...activeIds, ...otherIds].forEach((id, index) => {
    const container = containers.find((item) => item.id === id);
    const current = {
      ...(next.containers[id] || container?.config || {}),
      name: container?.name || id,
      image: container?.image || next.containers[id]?.image || "",
    };
    next.containers[id] = {
      ...current,
      enabled: activeSet.has(id) && mode === "orchestration" ? true : current.enabled === true,
      monitor: activeSet.has(id) && mode === "guard" ? true : current.monitor === true,
      startupOrder: (index + 1) * 10,
    };
  });

  return next;
}
