import type { ActionBinding, DynamicValue } from '@json-render/core'
import type { ActionRef } from '../../../shared/gen-ui-catalog'

/**
 * Convert a catalog `ActionRef` (discriminated by `type`) into the
 * `ActionBinding` shape json-render's ActionProvider expects (`{ action, params }`).
 * The catalog action name equals the `ActionRef.type`; the remaining fields
 * become the `params` payload.
 */
export function actionRefToBinding(ref: ActionRef): ActionBinding {
  const { type, ...rest } = ref
  return {
    action: type,
    params: rest as unknown as Record<string, DynamicValue>,
  }
}
