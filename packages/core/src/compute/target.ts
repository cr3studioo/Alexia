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
    ...(model.params !== undefined && { params: model.params }),
    ...(model.quant !== undefined && { quant: model.quant }),
    ...(model.diskBytes !== undefined && { diskBytes: model.diskBytes }),
    ...(model.abliterated !== undefined && { abliterated: model.abliterated }),
  }
  return row
}

export function remoteModels(views: readonly HostView[], selected: string): Model[] {
  if (selected === THIS_HOST) return []
  return views.find((view) => view.host.id === selected)?.inventory?.models.map((model) => remoteModel(selected, model)) ?? []
}
