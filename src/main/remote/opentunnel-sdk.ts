/**
 * The real OpenTunnel SDK behind `OpenTunnelSdk`, in a module of its own so
 * `opentunnel.ts` can import it lazily while the bundler still tree-shakes
 * Effect through these static imports (a dynamic `import('effect')` pulls in
 * the whole library).
 *
 * Built on the SDK's Effect client rather than its promise wrapper, whose
 * `create` and `connect` take no signal: the only way to stop a certificate
 * poll is to interrupt the fiber running it.
 */
import { Effect, Exit, ManagedRuntime, Scope, Stream } from 'effect'
import { OpenTunnelStorage, toEffectStorage } from '@opentunnel/client'
import { OpenTunnelClient } from '@opentunnel/client/effect'
import { PROFILE, type OpenTunnelSdk } from './opentunnel'

export const openTunnelSdk: OpenTunnelSdk = {
  store: (dataDir) => OpenTunnelStorage.xdg({ env: { XDG_DATA_HOME: dataDir } }),
  client: (store) => {
    const runtime = ManagedRuntime.make(OpenTunnelClient.layer({ storage: toEffectStorage(store) }))
    return {
      hasIdentity: async () =>
        (await runtime.runPromise(Effect.flatMap(OpenTunnelClient, (c) => c.tunnel.get({ profile: PROFILE })))) !== undefined,
      create: async ({ onProgress, signal }) => {
        await runtime.runPromise(
          Effect.flatMap(OpenTunnelClient, (c) => c.tunnel.create({ profile: PROFILE, onProgress })),
          { signal },
        )
      },
      connect: async ({ routes, signal }) => {
        const scope = await runtime.runPromise(Scope.make())
        const closeScope = (): Promise<void> => runtime.runPromise(Scope.close(scope, Exit.void))
        const connection = await runtime
          .runPromise(
            Effect.flatMap(OpenTunnelClient, (c) => c.tunnel.connect({ profile: PROFILE, routes })).pipe(
              Effect.provideService(Scope.Scope, scope),
            ),
            { signal },
          )
          .catch(async (error: unknown) => {
            await closeScope()
            throw error
          })
        // The scope is released however the tunnel ends, ours or the relay's.
        void runtime.runPromise(connection.closed).then(closeScope, closeScope)
        return {
          tunnel: connection.tunnel,
          events: Stream.toAsyncIterable(connection.events),
          setRoutes: (next) => runtime.runPromise(connection.setRoutes(next)),
          close: () => runtime.runPromise(connection.close).finally(closeScope),
        }
      },
    }
  },
}
