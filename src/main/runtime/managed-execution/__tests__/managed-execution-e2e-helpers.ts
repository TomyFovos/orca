import type { Server } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import type { ExecuteRequest } from '../issuer'

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

export async function postExecute(port: number, request: ExecuteRequest) {
  const response = await fetch(`http://127.0.0.1:${port}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request)
  })
  return {
    status: response.status,
    receipt: await response.json()
  }
}

export async function postRawExecute(port: number, body: string) {
  const response = await fetch(`http://127.0.0.1:${port}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  })
  return {
    status: response.status,
    body: await response.json()
  }
}

export function connectToEndpoint(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

export function writeRequest(socket: Socket, body: string): void {
  socket.write(
    `POST /execute HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  )
}

export async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Condition was not met before timeout')
}
