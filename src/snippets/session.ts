import { Neovim } from '@chemzqm/neovim'
import { FormattingOptions } from 'jsonc-parser'
import { Emitter, Event, Range, TextDocumentContentChangeEvent, TextEdit } from 'vscode-languageserver-protocol'
import Uri from 'vscode-uri'
import Document from '../model/document'
import { wait } from '../util'
import { positionInRange, rangeInRange, comparePosition } from '../util/position'
import workspace from '../workspace'
import { CocSnippet, CocSnippetPlaceholder } from "./snippet"
import { SnippetVariableResolver } from "./variableResolve"
const logger = require('../util/logger')('snippets-session')

export class SnippetSession {
  private _isActive = false
  private _currId = 0
  // Get state of line where we inserted
  private _changedtick: number
  private _snippet: CocSnippet = null
  private _onCancelEvent = new Emitter<void>()
  private _preferComplete = false
  public readonly onCancel: Event<void> = this._onCancelEvent.event

  constructor(private nvim: Neovim, public readonly bufnr: number) {
  }

  public async start(snippetString: string, select = true): Promise<boolean> {
    const { document, nvim } = this
    const position = await workspace.getCursorPosition()
    if (!document) return false
    const formatOptions = await workspace.getFormatOptions(this.document.uri)
    const currentLine = document.getline(position.line)
    const currentIndent = currentLine.match(/^\s*/)[0]
    const inserted = normalizeSnippetString(snippetString, currentIndent, formatOptions)
    const snippet = new CocSnippet(
      inserted,
      position,
      new SnippetVariableResolver(position.line, Uri.parse(document.uri).fsPath))
    const edit = TextEdit.insert(position, snippet.toString())
    const endPart = currentLine.slice(position.character)
    const { mode } = await nvim.mode
    if (mode != 'i') nvim.command('startinsert', true)
    if (snippetString.endsWith('\n') && endPart) {
      // make next line same indent
      edit.newText = edit.newText + currentIndent
    }
    if (snippet.isPlainText) {
      // insert as text
      await document.applyEdits(nvim, [edit])
      let placeholder = snippet.finalPlaceholder
      let { start } = placeholder.range
      await nvim.call('cursor', [start.line + 1, start.character + 1])
      return this._isActive
    }
    this._changedtick = document.changedtick
    await document.applyEdits(nvim, [edit])
    if (this._isActive) {
      // insert check
      let placeholder = this.findPlaceholder(Range.create(position, position))
      // insert to placeholder
      if (placeholder && !placeholder.isFinalTabstop) {
        // don't repeat snippet insert
        let index = this.snippet.insertSnippet(placeholder, inserted, position)
        let p = this.snippet.getPlaceholder(index)
        this._currId = p.id
        if (select) {
          await this.selectPlaceholder(p)
          await wait(50)
        }
        return true
      }
    }
    let config = workspace.getConfiguration('coc.preferences')
    this._preferComplete = config.get<boolean>('preferCompleteThanJumpPlaceholder', false)
    // new snippet
    this._snippet = snippet
    this._currId = snippet.firstPlaceholder.id
    if (select) {
      await this.selectPlaceholder(snippet.firstPlaceholder)
      await wait(50)
    }
    this.activate()
    return true
  }

  private activate(): void {
    if (this._isActive) return
    this._isActive = true
    this.nvim.call('coc#snippet#enable', [this._preferComplete ? 1 : 0], true)
  }

  public deactivate(): void {
    if (!this._isActive) return
    this._isActive = false
    this._snippet = null
    this.nvim.call('coc#snippet#disable', [], true)
    logger.debug("[SnippetManager::cancel]")
    this._onCancelEvent.fire(void 0)
    this._onCancelEvent.dispose()
  }

  public get isActive(): boolean {
    return this._isActive
  }

  public async nextPlaceholder(): Promise<void> {
    await this.documentSynchronize()
    if (!this.isActive) return
    let curr = this.placeholder
    let next = this.snippet.getNextPlaceholder(curr.index)
    await this.selectPlaceholder(next)
  }

  public async previousPlaceholder(): Promise<void> {
    await this.documentSynchronize()
    if (!this.isActive) return
    let curr = this.placeholder
    let prev = this.snippet.getPrevPlaceholder(curr.index)
    await this.selectPlaceholder(prev)
  }

  public async synchronizeUpdatedPlaceholders(change: TextDocumentContentChangeEvent): Promise<void> {
    if (!this.isActive) return
    if (this._changedtick && this.document.changedtick - this._changedtick == 1) return
    let edit: TextEdit = { range: change.range, newText: change.text }
    let { snippet } = this
    // change outside range
    let adjusted = snippet.adjustTextEdit(edit)
    if (adjusted) return
    if (comparePosition(edit.range.start, snippet.range.end) > 0) {
      if (!edit.newText) return
      logger.info('Content add after snippet, cancelling snippet session')
      this.deactivate()
      return
    }
    let placeholder = this.findPlaceholder(edit.range)
    if (!placeholder) {
      logger.info('Change outside placeholder, cancelling snippet session')
      this.deactivate()
      return
    }
    if (placeholder.isFinalTabstop) {
      logger.info('Change final placeholder, cancelling snippet session')
      this.deactivate()
      return
    }
    this._currId = placeholder.id
    let edits = snippet.updatePlaceholder(placeholder, edit)
    if (!edits.length) return
    this._changedtick = this.document.changedtick
    await this.document.applyEdits(this.nvim, edits)
  }

  public async selectCurrentPlaceholder(): Promise<void> {
    let placeholder = this.snippet.getPlaceholderById(this._currId)
    if (placeholder) await this.selectPlaceholder(placeholder)
  }

  public async selectPlaceholder(placeholder: CocSnippetPlaceholder): Promise<void> {
    if (!placeholder) return
    let { start, end } = placeholder.range
    const len = end.character - start.character
    const col = start.character + 1
    this._currId = placeholder.id
    if (placeholder.choice) {
      this.nvim.call('coc#snippet#show_choices', [start.line + 1, col, len, placeholder.choice], true)
    } else {
      this.nvim.call('coc#snippet#range_select', [start.line + 1, col, len], true)
    }
  }

  private async documentSynchronize(): Promise<void> {
    if (!this.isActive) return
    await this.document.patchChange()
    this.document.forceSync()
    await wait(40)
  }

  public async checkPosition(): Promise<void> {
    if (!this.isActive) return
    let position = await workspace.getCursorPosition()
    if (this.snippet && positionInRange(position, this.snippet.range) != 0) {
      logger.info('Cursor insert out of range, cancelling snippet session')
      this.deactivate()
    }
  }

  public findPlaceholder(range: Range): CocSnippetPlaceholder | null {
    if (!this.snippet) return null
    let { placeholder } = this
    if (!placeholder || !rangeInRange(range, placeholder.range)) return null
    return placeholder
  }

  public get placeholder(): CocSnippetPlaceholder {
    if (!this.snippet) return
    return this.snippet.getPlaceholderById(this._currId)
  }

  public get snippet(): CocSnippet {
    return this._snippet
  }

  private get document(): Document {
    return workspace.getDocument(this.bufnr)
  }
}

function normalizeSnippetString(snippet: string, indent: string, opts: FormattingOptions): string {
  let lines = snippet.split(/\r?\n/)
  let ind = (new Array(opts.tabSize || 2)).fill(opts.insertSpaces ? ' ' : '\t').join('')
  lines = lines.map((line, idx) => {
    return (idx == 0 || line.length == 0 ? '' : indent) + line.split('\t').join(ind)
  })
  return lines.join('\n')
}
