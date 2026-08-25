let managedExecutionTail: Promise<void> = Promise.resolve()

export function runSerializedManagedExecution(task: () => void | Promise<void>): Promise<void> {
  const next = managedExecutionTail.then(task, task)
  managedExecutionTail = next.then(
    () => undefined,
    () => undefined
  )
  return next
}
