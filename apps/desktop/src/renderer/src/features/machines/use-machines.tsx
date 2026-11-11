import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { machineViewSchema, type MachineView } from '@ari/contracts/machines'
import { rpc } from '../../lib/rpc'
import { messageOf } from './remote-client'

interface MachinesState {
  machines: MachineView[]
  error: string | null
  refresh: () => Promise<void>
}
const Context = createContext<MachinesState>({ machines: [], error: null, refresh: async () => undefined })

export function MachinesProvider({ children }: { children: ReactNode }) {
  const [machines, setMachines] = useState<MachineView[]>([])
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      setMachines(machineViewSchema.array().parse(await rpc.invoke('machines.list')))
      setError(null)
    } catch (error) {
      setError(messageOf(error))
    }
  }, [])
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 15_000)
    return () => clearInterval(timer)
  }, [refresh])
  return <Context.Provider value={{ machines, error, refresh }}>{children}</Context.Provider>
}

export const useMachines = () => useContext(Context)

export function machineCan(machine: MachineView, op: string): boolean {
  return machine.status === 'connected' && machine.identity?.capabilities.includes(op as never) === true
}
