import {
  buildRegistry,
  formatZodError,
  isStreamingMethod,
  type RpcAnyMethod,
  type RpcContext,
  type RpcEnvelopeMeta,
  type RpcMethod,
  type RpcRegistry,
  type RpcRequest,
  type RpcResponse
} from './core'

import type { FeatureInteractionId } from '../../../shared/feature-interactions'
import { errorResponse, successResponse } from './errors'
import { ALL_RPC_METHODS } from './methods'
import { emulatorProbe, emulatorProbeError } from '../../emulator/emulator-probe'
import type { OrcaRuntimeService } from '../orca-runtime'
import { orchestrationMigrationFence } from './orchestration-contract-fence'
import { recordRuntimeFeatureInteraction } from './runtime-feature-interaction'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import { invalidArgumentResponse, mapDispatcherError } from './dispatcher-error-response'
import { resolveOrcaRuntimeProfile } from '../runtime-profile'
import {
  createOrchestrationDispatchMiddleware,
  type OrchestrationDispatchContext,
  type OrchestrationDispatchMiddleware,
  type OrchestrationMethodInvocation
} from './orchestration-dispatch-middleware'
import { selectRpcMethodsForRuntimeProfile } from './runtime-profile-method-registry'

export type DispatcherOptions = { runtime: OrcaRuntimeService; methods?: readonly RpcAnyMethod[] }

export class RpcDispatcher {
  private readonly runtime: OrcaRuntimeService
  private readonly registry: RpcRegistry
  private readonly orchestrationDispatchMiddleware: OrchestrationDispatchMiddleware | undefined

  constructor({ runtime, methods = ALL_RPC_METHODS }: DispatcherOptions) {
    this.runtime = runtime
    const profile = resolveOrcaRuntimeProfile()
    this.registry = buildRegistry(selectRpcMethodsForRuntimeProfile(profile, methods))
    this.orchestrationDispatchMiddleware = createOrchestrationDispatchMiddleware(runtime, profile)
  }

  async dispatch(request: RpcRequest, options?: { signal?: AbortSignal }): Promise<RpcResponse> {
    const meta = this.meta()
    const method = this.registry.get(request.method)
    if (!method) {
      return errorResponse(
        request.id,
        meta,
        'method_not_found',
        `Unknown method: ${request.method}`
      )
    }

    if (this.orchestrationDispatchMiddleware) {
      const migrationFence = orchestrationMigrationFence(request, meta)
      if (migrationFence) {
        return migrationFence
      }
    }

    const parsedParams = this.parseParams(request, method, meta)
    if (parsedParams.error) {
      return parsedParams.error
    }

    if (isStreamingMethod(method)) {
      return errorResponse(
        request.id,
        meta,
        'method_not_supported',
        `Method ${request.method} requires a streaming transport`
      )
    }

    if (request.method.startsWith('emulator.')) {
      emulatorProbe(`rpc ${request.method}`, request.params)
    }
    try {
      const result = await this.invokeNonStreamingMethod(
        request,
        method,
        parsedParams.value,
        {
          runtime: this.runtime,
          signal: options?.signal,
          requestId: request.id
        },
        options?.signal
      )
      recordRuntimeFeatureInteraction(
        this.runtime,
        request.method,
        result,
        undefined,
        request.params
      )
      return successResponse(request.id, meta, result)
    } catch (error) {
      if (request.method.startsWith('emulator.')) {
        emulatorProbeError(`rpc ${request.method}`, error, { params: request.params })
      }
      return mapDispatcherError(request, meta, error)
    }
  }

  // Why: streaming dispatch sends multiple responses through the reply callback
  // instead of returning a single Promise. This enables terminal.subscribe and
  // other subscription-style methods that push data over time.
  async dispatchStreaming(
    request: RpcRequest,
    reply: (response: string) => void,
    options?: RpcDispatchStreamingOptions
  ): Promise<void> {
    const meta = this.meta()
    const method = this.registry.get(request.method)
    if (!method) {
      reply(
        JSON.stringify(
          errorResponse(request.id, meta, 'method_not_found', `Unknown method: ${request.method}`)
        )
      )
      return
    }

    if (this.orchestrationDispatchMiddleware) {
      const migrationFence = orchestrationMigrationFence(request, meta)
      if (migrationFence) {
        reply(JSON.stringify(migrationFence))
        return
      }
    }

    const parsedParams = this.parseParams(request, method, meta)
    if (parsedParams.error) {
      reply(JSON.stringify(parsedParams.error))
      return
    }

    if (!isStreamingMethod(method)) {
      try {
        const result = await this.invokeNonStreamingMethod(
          request,
          method,
          parsedParams.value,
          {
            runtime: this.runtime,
            signal: options?.signal,
            requestId: request.id,
            connectionId: options?.connectionId,
            clientId: options?.clientId,
            pairedDeviceId: options?.pairedDeviceId,
            clientKind: options?.clientKind,
            clientCapabilities: options?.clientCapabilities,
            pairing: options?.pairing,
            sendBinary: options?.sendBinary,
            registerBinaryStreamHandler: options?.registerBinaryStreamHandler
          },
          options?.signal
        )
        recordRuntimeFeatureInteraction(
          this.runtime,
          request.method,
          result,
          undefined,
          request.params
        )
        reply(JSON.stringify(successResponse(request.id, meta, result)))
      } catch (error) {
        reply(JSON.stringify(mapDispatcherError(request, meta, error)))
      }
      return
    }

    const recordedStreamingFeatureInteractions = new Set<FeatureInteractionId>()
    const emit = (result: unknown): void => {
      recordRuntimeFeatureInteraction(
        this.runtime,
        request.method,
        result,
        recordedStreamingFeatureInteractions,
        request.params
      )
      const response = successResponse(request.id, meta, result)
      response.streaming = true
      reply(JSON.stringify(response))
    }

    try {
      const result = await method.handler(
        parsedParams.value,
        {
          runtime: this.runtime,
          signal: options?.signal,
          requestId: request.id,
          connectionId: options?.connectionId,
          clientId: options?.clientId,
          pairedDeviceId: options?.pairedDeviceId,
          clientKind: options?.clientKind,
          clientCapabilities: options?.clientCapabilities,
          orchestrationCapability: request.orchestrationCapability,
          pairing: options?.pairing,
          sendBinary: options?.sendBinary,
          registerBinaryStreamHandler: options?.registerBinaryStreamHandler
        },
        emit
      )
      recordRuntimeFeatureInteraction(
        this.runtime,
        request.method,
        result,
        recordedStreamingFeatureInteractions,
        request.params
      )
    } catch (error) {
      reply(JSON.stringify(mapDispatcherError(request, meta, error)))
    }
  }

  private parseParams(
    request: RpcRequest,
    method: RpcAnyMethod,
    meta: RpcEnvelopeMeta
  ): { value: unknown; error?: undefined } | { value?: undefined; error: RpcResponse } {
    if (method.params === null) {
      return { value: undefined }
    }
    const rawParams = request.params ?? {}
    const result = method.params.safeParse(rawParams)
    if (!result.success) {
      return {
        error: invalidArgumentResponse(request, meta, formatZodError(result.error))
      }
    }
    return { value: result.data }
  }

  private meta(): RpcEnvelopeMeta {
    return { runtimeId: this.runtime.getRuntimeId() }
  }

  private async invokeNonStreamingMethod(
    request: RpcRequest,
    method: RpcMethod,
    params: unknown,
    context: RpcContext,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    const invoke: OrchestrationMethodInvocation = (
      effectiveParams: unknown,
      orchestrationContext: OrchestrationDispatchContext
    ) => method.handler(effectiveParams, { ...context, ...orchestrationContext })
    if (!this.orchestrationDispatchMiddleware) {
      return await invoke(params, {})
    }
    return await this.orchestrationDispatchMiddleware.invoke(request, params, signal, invoke)
  }
}
