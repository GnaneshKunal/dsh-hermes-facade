/**
 * dsh-hermes-facade - cordis host plugin entry.
 *
 * Mounts a hermes-webui-shaped HTTP+SSE server on its own loopback port so the
 * stock Hermex iOS app can drive this DeepSeek Harness. Nothing is registered
 * on dsh's :3080 origin.
 *
 * @module @gnanesh/dsh-hermes-facade
 */

import { resolveConfig } from './src/config.mjs'
import { createDshHost } from './src/host.mjs'
import { createFacadeServer } from './src/server.mjs'
import { createGatewayServer } from './src/hermes/server.mjs'

/** Plugin name used by the loader patch. */
export const name = 'hermes-facade'

/** Host services this plugin depends on. */
export const inject = ['typertGateway', 'connection']

/**
 * Mount the facade in the host composition.
 * @param {object} ctx cordis host context.
 * @param {object} [config] patch-row config.
 * @returns {Promise<void>} resolves once the facade is listening.
 */
export async function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  try {
    await mount(ctx, config, logger)
  } catch (error) {
    // A facade failure must never take the harness down with it.
    logger.warn?.('hermes-facade: not mounted: ' + String(error?.stack ?? error))
  }
}

/**
 * Mount the facade, letting any failure propagate to apply().
 * @param {object} ctx cordis host context.
 * @param {object} config patch-row config.
 * @param {object} logger logger.
 * @returns {Promise<void>} resolves once listening.
 */
async function mount(ctx, config, logger) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) {
    logger.info?.('hermes-facade: disabled by config')
    return
  }

  let host
  try {
    host = createDshHost({ ctx, logger })
  } catch (error) {
    logger.warn?.('hermes-facade: host services unavailable, not mounting (' + String(error?.message ?? error) + ')')
    return
  }

  const facade = createFacadeServer({ config: resolved, host, logger })
  const address = await facade.listen()

  // Read the model catalog once in the background: the first composer open is
  // otherwise a cold multi-provider query, which the app renders as a dead
  // server when it takes too long.
  host.warm?.()

  logger.info?.('hermes-facade: listening on http://' + address.host + ':' + address.port)
  logger.info?.('hermes-facade: logs in ' + resolved.dir + ' (access: ' + (resolved.logRequests ? 'on' : 'off') +
    ', unknown endpoints: always)')
  logger.info?.('hermes-facade: expose it with  tailscale serve --bg --https=9443 http://' + address.host + ':' + address.port)

  if (facade.auth.generatedPassword) {
    logger.info?.('hermes-facade: FIRST RUN password = ' + facade.auth.generatedPassword)
    logger.info?.('hermes-facade: stored hashed at ' + facade.auth.passwordPath)
  }

  // The Hermes-protocol listener (Hermex 2.x hosts). It is a second port with its
  // own auth routes and its own socket; every answer still comes from the facade
  // above, so DSH stays integrated in one place. Disabled with gatewayEnabled:false.
  let gateway
  if (resolved.gatewayEnabled) {
    try {
      gateway = createGatewayServer({
        config: resolved,
        facadeUrl: 'http://127.0.0.1:' + address.port,
        facadeAuth: facade.auth,
        host,
        logger,
      })
      const gatewayAddress = await gateway.listen()
      logger.info?.('hermes-gateway: Hermes host on http://' + gatewayAddress.host + ':' + gatewayAddress.port)
      logger.info?.('hermes-gateway: expose it with  tailscale serve --bg --https=9444 http://' +
        gatewayAddress.host + ':' + gatewayAddress.port)
    } catch (error) {
      // A gateway failure must not take the webui facade down with it.
      logger.warn?.('hermes-gateway: not mounted: ' + String(error?.stack ?? error))
      gateway = undefined
    }
  }

  // Return the close promise: on a hot reload cordis awaits the disposer
  // before starting the replacement, and the replacement must find the port
  // free. Firing it off unawaited races the new listener into EADDRINUSE.
  ctx.effect(() => () => {
    host.dispose()
    const stopped = gateway === undefined ? Promise.resolve() : gateway.close()
    return stopped.then(() => facade.close()).then(() => {
      logger.info?.('hermes-facade: stopped')
    })
  })
}
