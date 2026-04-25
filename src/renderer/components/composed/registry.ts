/**
 * Phase 1 component registry for the gen-ui catalog (issue #62).
 *
 * Binds the 12 hand-authored primitives to the catalog so json-render's
 * `<Renderer>` can resolve `<ProseBlock>`, `<FileList>`, etc. The 13th
 * primitive (`Diagram`) is intentionally absent — Phase 3 fills that slot.
 *
 * Action handlers are registered separately in Phase 2 via `<ActionProvider>`.
 */

import { defineRegistry } from '@json-render/svelte'
import { catalog } from '../../../shared/gen-ui-catalog'
import ActionButton from './ActionButton.svelte'
import Callout from './Callout.svelte'
import CodeSnippet from './CodeSnippet.svelte'
import DecisionCard from './DecisionCard.svelte'
import FileList from './FileList.svelte'
import KeyValueSummary from './KeyValueSummary.svelte'
import ProseBlock from './ProseBlock.svelte'
import Row from './Row.svelte'
import Section from './Section.svelte'
import StatusIndicator from './StatusIndicator.svelte'
import TextInput from './TextInput.svelte'
import Textarea from './Textarea.svelte'

export const { registry, handlers, executeAction } = defineRegistry(catalog, {
  components: {
    ActionButton,
    Callout,
    CodeSnippet,
    DecisionCard,
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
