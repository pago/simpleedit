import { contextBridge, ipcRenderer } from 'electron'
import type { InvokeMap, EventMap, SendMap } from '../shared/ipc-types'

type Channel = keyof InvokeMap
type EventChannel = keyof EventMap
type SendChannel = keyof SendMap

const api = {
  send<K extends SendChannel>(channel: K, data: SendMap[K]): void {
    ipcRenderer.send(channel, data)
  },

  invoke<K extends Channel>(
    channel: K,
    ...args: InvokeMap[K]['args']
  ): Promise<InvokeMap[K]['result']> {
    return ipcRenderer.invoke(channel, ...args)
  },

  on<K extends EventChannel>(
    channel: K,
    callback: (data: EventMap[K]) => void
  ): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: EventMap[K]): void => {
      callback(data)
    }
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  once<K extends EventChannel>(
    channel: K,
    callback: (data: EventMap[K]) => void
  ): void {
    ipcRenderer.once(channel, (_event, data: EventMap[K]) => callback(data))
  }
}

export type SimpleEditAPI = typeof api

contextBridge.exposeInMainWorld('api', api)
