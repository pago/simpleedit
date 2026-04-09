export interface AgentTabInfo {
  id: string
  label: string
}

export function createAgentTerminalStore() {
  let terminals = $state<AgentTabInfo[]>([])

  let _createClaudeTab: (() => string) | undefined
  let _selectTab: ((id: string) => void) | undefined

  return {
    get terminals(): AgentTabInfo[] {
      return terminals
    },

    registerCallbacks(createClaudeTab: () => string, selectTab: (id: string) => void): void {
      _createClaudeTab = createClaudeTab
      _selectTab = selectTab
    },

    syncTabs(tabs: AgentTabInfo[]): void {
      terminals = tabs
    },

    send(terminalId: string, message: string): void {
      _selectTab?.(terminalId)
      window.api.invoke('pty:write', terminalId, message + '\r')
    },

    spawnAndSend(message: string): string | undefined {
      if (!_createClaudeTab) return undefined
      const id = _createClaudeTab()
      setTimeout(() => {
        window.api.invoke('pty:write', id, message + '\r')
      }, 1000)
      return id
    },
  }
}

export type AgentTerminalStore = ReturnType<typeof createAgentTerminalStore>
