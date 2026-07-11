// Tab group manager: session = group (like Claude in Chrome).
//
// - clicking the icon on a tab → tab joins a new colored group, the group gets
//   its own conversation; the side panel is ENABLED only on tabs in this group
// - dragging a tab into the group → the panel enables on it too
// - leaving the group / tab outside the group → panel disabled (disappears)
//
// The groupId → sessionKey mapping is stored in chrome.storage.local
// ("groupSessions"). After a Chrome restart group identifiers change —
// orphaned entries are cleaned up, while conversations stay in history.

const PANEL_PATH = (groupId) => `sidepanel/panel.html?group=${groupId}`;

// Tab group status indicators
const GROUP_STATUS = {
  idle:    { title: "🦞",  color: "orange" },
  working: { title: "⏳",  color: "yellow" },
  done:    { title: "✅",  color: "green" },
  error:   { title: "❌",  color: "red" },
};

export class GroupManager {
  constructor({ assistantName = "Andrzej", onGroupRemoved, onGroupTabsChanged } = {}) {
    this.assistantName = assistantName;
    this.onGroupRemoved = onGroupRemoved || (() => {});
    this.onGroupTabsChanged = onGroupTabsChanged || (() => {});
    this.lastActiveTab = new Map(); // groupId -> tabId (last active tab of the group)
  }

  async loadMap() {
    const { groupSessions = {} } = await chrome.storage.local.get("groupSessions");
    return groupSessions;
  }
  async saveMap(map) {
    await chrome.storage.local.set({ groupSessions: map });
  }

  async isOurGroup(groupId) {
    if (groupId === undefined || groupId === -1) return false;
    const map = await this.loadMap();
    return !!map[groupId];
  }

  async getSessionKey(groupId) {
    const map = await this.loadMap();
    return map[groupId]?.sessionKey || null;
  }

  async setSessionKey(groupId, sessionKey) {
    const map = await this.loadMap();
    map[groupId] = { ...(map[groupId] || {}), sessionKey, updatedAt: Date.now() };
    await this.saveMap(map);
  }

  /**
   * Update the tab group's title and color to reflect agent status.
   * Statuses: "idle" | "working" | "done" | "error"
   */
  async updateStatus(groupId, status, label = "") {
    const cfg = GROUP_STATUS[status] || GROUP_STATUS.idle;
    const title = `${cfg.title} ${this.assistantName}${label ? ` — ${label}` : ""}`;
    try {
      await chrome.tabGroups.update(groupId, { title, color: cfg.color });
    } catch { /* group may be gone */ }
  }

  /**
   * Ensures a group for a tab: if the tab is in our group — returns it;
   * if it's in someone else's group — we adopt it (without changing its appearance);
   * if it's in no group — we create a new colored group.
   */
  async ensureGroupForTab(tab) {
    let groupId = tab.groupId;
    const map = await this.loadMap();

    if (groupId !== undefined && groupId !== -1) {
      if (!map[groupId]) {
        map[groupId] = { sessionKey: null, updatedAt: Date.now() }; // adopt someone else's group
        await this.saveMap(map);
      }
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, { title: `${GROUP_STATUS.idle.title} ${this.assistantName}`, color: GROUP_STATUS.idle.color }).catch(() => {});
      map[groupId] = { sessionKey: null, updatedAt: Date.now() };
      await this.saveMap(map);
    }

    this.lastActiveTab.set(groupId, tab.id);
    await this.enablePanelForGroup(groupId);
    return groupId;
  }

  async enablePanelForTab(tabId, groupId) {
    try {
      await chrome.sidePanel.setOptions({ tabId, path: PANEL_PATH(groupId), enabled: true });
    } catch { /* tab may have disappeared */ }
  }

  async disablePanelForTab(tabId) {
    try {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
    } catch { /* tab may have disappeared */ }
  }

  async enablePanelForGroup(groupId) {
    const tabs = await chrome.tabs.query({ groupId });
    await Promise.all(tabs.map(t => this.enablePanelForTab(t.id, groupId)));
  }

  /** On SW startup: globally disable the panel, enable for known group tabs, remove orphaned entries. */
  async rebuild() {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
    await chrome.sidePanel.setOptions({ enabled: false }).catch(() => {}); // default: no panel
    const map = await this.loadMap();
    let changed = false;
    for (const groupIdStr of Object.keys(map)) {
      const groupId = Number(groupIdStr);
      try {
        await chrome.tabGroups.get(groupId);
        await this.enablePanelForGroup(groupId);
      } catch {
        delete map[groupIdStr]; // group no longer exists (e.g. after Chrome restart)
        changed = true;
      }
    }
    if (changed) await this.saveMap(map);
  }

  /** Wires up event listeners. Call once, at SW top-level. */
  wireEvents() {
    // tab changed group membership (dragged into/out of a group)
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (changeInfo.groupId === undefined) return;
      const groupId = changeInfo.groupId;
      if (groupId !== -1 && await this.isOurGroup(groupId)) {
        await this.enablePanelForTab(tabId, groupId);
        this.onGroupTabsChanged(groupId);
      } else {
        await this.disablePanelForTab(tabId);
        // it might have left one of our groups
        this.onGroupTabsChanged(null);
      }
    });

    // new tab already in the group (e.g. "open in new tab" from a group tab)
    chrome.tabs.onCreated.addListener(async (tab) => {
      if (tab.groupId !== undefined && tab.groupId !== -1 && await this.isOurGroup(tab.groupId)) {
        await this.enablePanelForTab(tab.id, tab.groupId);
      }
    });

    // tab activation — remember the last active tab of each of our groups
    chrome.tabs.onActivated.addListener(async ({ tabId }) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.groupId !== -1 && await this.isOurGroup(tab.groupId)) {
          this.lastActiveTab.set(tab.groupId, tabId);
          this.onGroupTabsChanged(tab.groupId);
        }
      } catch { /* tab gone */ }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      for (const [g, t] of this.lastActiveTab) if (t === tabId) this.lastActiveTab.delete(g);
    });

    // group removed (last tab closed/dragged out)
    chrome.tabGroups.onRemoved.addListener(async (group) => {
      const map = await this.loadMap();
      if (map[group.id]) {
        delete map[group.id];
        await this.saveMap(map);
        this.lastActiveTab.delete(group.id);
        this.onGroupRemoved(group.id);
      }
    });
  }
}
