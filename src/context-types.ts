/**
 * Structural types for the cordis services this plugin consumes, plus the
 * Context augmentation. The host half needs `ctx.webServer` (the DSH HTTP
 * carrier); the client half consumes `ctx.betterSidebar` (published by
 * dsh-better-sidebar). Both members are restated structurally here because a
 * third-party package resolves outside the DSH monorepo's single cordis
 * instance and the upstream augmentations do not reach this Context.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from 'cordis'

/** One named webserver route (mirror of the host-webserver WebRoute). */
export interface DsaWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The webServer service face this plugin uses. */
export interface DsaWebServer {
  register(route: DsaWebRoute): () => void
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  }): () => void
}

/** The betterSidebar service face consumed by the client half (optional). */
export interface DsaBetterSidebar {
  registerTab(descriptor: {
    id: string
    title: string | (() => string)
    icon?: unknown
    order?: number
    single?: boolean
    component: (props: unknown) => unknown
  }): () => void
}

/** The host tool registry face (`@deepseek-ai/dsh-tools`), used to register the resolve tool. */
export interface DsaTools {
  register(definition: unknown): () => void
}

/** The session store face (used to resolve a session's composer scope). */
export interface DsaSessions {
  scope(sessionId: string): Context | undefined
  get(id: string): unknown
  list?: {
    getSnapshot(): { current?: string }
  }
}

/** The input-trigger pipeline face (consumed by the client half so chips serialize). */
export interface DsaInputTriggers {
  registerSource(src: unknown): () => void
}

declare module 'cordis' {
  interface Context {
    /** Host-side HTTP carrier. */
    webServer: DsaWebServer
    /** Client-side sidebar registry (provided by dsh-better-sidebar). */
    betterSidebar: DsaBetterSidebar
    /** Host tool registry (optional). */
    tools: DsaTools
    /** The session store (optional). */
    sessions: DsaSessions
    /** Client-side input-trigger pipeline (for chip source registration). */
    inputTriggers?: DsaInputTriggers
  }
}

export type { Context }
