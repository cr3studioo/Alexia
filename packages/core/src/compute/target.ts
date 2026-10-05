// SPDX-License-Identifier: AGPL-3.0-only
import type { Model } from '../catalog.js'
import { CORE } from '../secrets.js'
import type { Store } from '../store.js'
import { migrateSelection, qualify, REMOTE_PROVIDER, THIS_HOST, type ExecutionTarget, type HostModel, type HostView } from './types.js'

export const TARGET_KEY = 'local_target'

/** Migrate only an absent target; a cleared or damaged target never selects another model. */
export function selectedTarget(store: Pick<Store, 'kvGet' | 'kvSet'>): ExecutionTarget | undefined {
  const saved = store.kvGet(CORE, TARGET_KEY)
  if (saved !== undefined) return migrateSelection(saved)
  const pin = store.kvGet(CORE, 'pins') as { model?: unknown } | undefined | null
  const target = migrateSelection(store.kvGet(CORE, 'last_local_model')) ??
    (store.kvGet(CORE, 'mode') === 'local' ? migrateSelection(pin?.model) : undefined)
  if (target) store.kvSet(CORE, TARGET_KEY, target)
  return target
}

export function rememberTarget(store: Pick<Store, 'kvSet'>, target: ExecutionTarget): void {
  qualify(target)
  store.kvSet(CORE, TARGET_KEY, { hostId: target.hostId, modelId: target.modelId })
  if (target.hostId === THIS_HOST) store.kvSet(CORE, 'last_local_model', target.modelId)
}

export function selectedHost(store: Pick<Store, 'kvGet' | 'kvSet'>): string {
  return selectedTarget(store)?.hostId ?? THIS_HOST
}

export function remoteModel(hostId: string, model: HostModel): Model {
  const row: Model & { host: string } = {
    id: qualify({ hostId, modelId: model.id }),
    name: model.name,
    provider: REMOTE_PROVIDER,
    tier: 'T0',
    priceIn: 0,
    priceOut: 0,
    context: model.context,
    supportsTools: model.supportsTools,
    modality: [...model.modality],
    nsfwOk: model.abliterated ? 'yes' : 'unknown',
    trainsOnYourData: 'no',
    host: hostId,
    engine: model.engine,
    ...(model.params !== undefined && { params: model.params }),
    ...(model.quant !== undefined && { quant: model.quant }),
    ...(model.diskBytes !== undefined && { diskBytes: model.diskBytes }),
    ...(model.abliterated !== undefined && { abliterated: model.abliterated }),
  }
  return row
}

/** Where each paired host's models were last heard, so a closed session does not take its models away. */
export const SEEN_KEY = 'remote_models'

/** What a host last said it holds, as `HostModel` rows, or nothing. */
export function seenModels(store: Pick<Store, 'kvGet'>, hostId: string): HostModel[] | undefined {
  const saved = store.kvGet(CORE, SEEN_KEY) as Record<string, unknown> | undefined | null
  const models = typeof saved === 'object' && saved !== null ? saved[hostId] : undefined
  return Array.isArray(models) ? models.filter((one): one is HostModel => typeof one?.id === 'string' && one.id !== '' && typeof one.name === 'string' && typeof one.context === 'number') : undefined
}

/** Keep what a host said it holds; written only when it differs, since every inventory event lands here. */
export function rememberModels(store: Pick<Store, 'kvGet' | 'kvSet'>, hostId: string, models: readonly HostModel[]): void {
  const saved = store.kvGet(CORE, SEEN_KEY) as Record<string, unknown> | undefined | null
  const all = typeof saved === 'object' && saved !== null ? { ...saved } : {}
  // `loaded` changes with every request and says nothing about which models exist.
  const kept = models.map((one) => ({ ...one, loaded: false }))
  if (JSON.stringify(all[hostId]) === JSON.stringify(kept)) return
  all[hostId] = kept
  store.kvSet(CORE, SEEN_KEY, all)
}

/**
 * The selected host's models: what its open session says, or — before a session has opened since
 * launch, or after one dropped — what it said last time. Without that, a model chosen on a paired
 * computer is *not available* from every launch until something happens to open a session, and a
 * request is never sent to the one place that would open it (`Bridge.prepare` connects on its own).
 */
export function remoteModels(views: readonly HostView[], selected: string, seen?: (hostId: string) => readonly HostModel[] | undefined): Model[] {
  if (selected === THIS_HOST) return []
  const view = views.find((one) => one.host.id === selected)
  if (!view) return []
  return (view.inventory?.models ?? seen?.(selected) ?? []).map((model) => remoteModel(selected, model))
}
