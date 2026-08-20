import type { Server } from 'node:http'

const DEFAULT_MANAGED_EXECUTION_PORT = 6770
export const DEFAULT_MANAGED_EXECUTION_HOST = '127.0.0.1'

export function resolveManagedExecutionPort(
  configPort: number | undefined,
  environmentPort: string | undefined
): number {
  if (configPort !== undefined) {
    return validateManagedExecutionPort(configPort, 'endpoint configuration')
  }
  if (environmentPort === undefined) {
    return DEFAULT_MANAGED_EXECUTION_PORT
  }
  return validateManagedExecutionPort(Number(environmentPort), 'ORCA_MANAGED_ENDPOINT_PORT')
}

function validateManagedExecutionPort(value: number, source: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`${source} must be an integer between 0 and 65535`)
  }
  return value
}

export function listenForManagedExecutionStartup(
  server: Server,
  port: number,
  host: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      server.off('listening', onListening)
      server.off('error', onError)
    }

    server.once('listening', onListening)
    server.once('error', onError)
    try {
      server.listen(port, host)
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}
