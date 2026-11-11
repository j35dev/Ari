import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { machineViewSchema, type MachineView } from '@ari/contracts/machines'
import { rpc } from '../../lib/rpc'
import { messageOf } from './remote-client'

interface MachinesState {
  machines: MachineView[]
  error: string | null
  refresh: () => Promise<void>
}
const Context = createContext<MachinesState>({
  machines: [],
  error: null,
  refresh: () => Promise.resolve(),
})

export function MachinesProvider({ children }: { children: ReactNode }) {
  const [machines, setMachines] = useState<MachineView[]>([])
  const [error, setError] = useState<string | null>(null)
  const revision = useRef(0)
  const alive = useRef(true)
  const refresh = useCallback(async () => {
    const started = ++revision.current
    try {
      const next = machineViewSchema.array().parse(await rpc.invoke('machines.list'))
      if (!alive.current || revision.current !== started) return
      setMachines(next)
      setError(null)
    } catch (error) {
      if (alive.current && revision.current === started) setError(messageOf(error))
    }
  }, [])
  useEffect(() => {
    alive.current = true
    const unsubscribe = rpc.subscribe('machines.updates', {}, (raw) => {
      const parsed = machineViewSchema.array().safeParse(raw)
      if (alive.current && parsed.success) {
        revision.current++
        setMachines(parsed.data)
      }
    })
    void refresh()
    const timer = setInterval(() => void refresh(), 15_000)
    return () => {
      alive.current = false
      unsubscribe()
      clearInterval(timer)
    }
  }, [refresh])
  return <Context.Provider value={{ machines, error, refresh }}>{children}</Context.Provider>
}

export const useMachines = () => useContext(Context)

export function machineCan(machine: MachineView, op: string): boolean {
  return machine.status === 'connected' && machine.identity?.capabilities.includes(op) === true
}
