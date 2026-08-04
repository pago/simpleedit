/**
 * Component registry for the gen-ui catalog (issue #62).
 *
 * Binds the hand-authored primitives to the catalog so json-render's
 * `<Renderer>` can resolve `<ProseBlock>`, `<FileList>`, etc.
 *
 * Every entry is then wrapped in `BlockBoundary`, which stamps a
 * `data-block-id` anchor on the rendered subtree so a text selection inside any
 * block can be routed to "Discuss this" with the right block identity.
 */

import { defineRegistry, type ComponentRegistry, type ComponentRenderer } from '@json-render/svelte'
import type { UIElement } from '@json-render/core'
import { catalog } from '../../../shared/gen-ui-catalog'
import ActionButton from './ActionButton.svelte'
import BlockBoundary from './BlockBoundary.svelte'
import Callout from './Callout.svelte'
import CodeSnippet from './CodeSnippet.svelte'
import DecisionCard from './DecisionCard.svelte'
import Diagram from './Diagram.svelte'
import DiffBlock from './DiffBlock.svelte'
import FileList from './FileList.svelte'
import KeyValueSummary from './KeyValueSummary.svelte'
import ProseBlock from './ProseBlock.svelte'
import Row from './Row.svelte'
import Section from './Section.svelte'
import StatusIndicator from './StatusIndicator.svelte'
import TextInput from './TextInput.svelte'
import Textarea from './Textarea.svelte'

const base = defineRegistry(catalog, {
  components: {
    ActionButton,
    Callout,
    CodeSnippet,
    DecisionCard,
    Diagram,
    DiffBlock,
    FileList,
    KeyValueSummary,
    ProseBlock,
    Row,
    Section,
    StatusIndicator,
    TextInput,
    Textarea,
  },
})

export const { handlers, executeAction } = base

/** Props json-render passes to a registry entry (the type is not exported). */
interface RenderProps {
  element: UIElement
  children?: unknown
  emit: unknown
  on: unknown
  bindings?: Record<string, string>
  loading?: boolean
}

type SvelteFn = (anchor: unknown, props: Record<string, unknown>) => unknown

/**
 * Compose a registry entry with `BlockBoundary`. Getters (rather than a plain
 * object) keep the props reactive across the extra hop — the same technique
 * `defineRegistry` uses internally.
 */
function withBlockBoundary(blockType: string, Inner: ComponentRenderer): ComponentRenderer {
  const boundary = BlockBoundary as unknown as SvelteFn
  return ((anchor: unknown, props: RenderProps) =>
    boundary(anchor, {
      Inner,
      blockType,
      get element() {
        return props.element
      },
      get children() {
        return props.children
      },
      get emit() {
        return props.emit
      },
      get on() {
        return props.on
      },
      get bindings() {
        return props.bindings
      },
      get loading() {
        return props.loading
      },
    })) as unknown as ComponentRenderer
}

export const registry: ComponentRegistry = Object.fromEntries(
  Object.entries(base.registry).map(([type, component]) => [type, withBlockBoundary(type, component)]),
)
