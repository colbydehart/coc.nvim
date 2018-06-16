import {Neovim} from 'neovim'
import {
  CompletionItemProvider,
} from './provider'
import {
  ISource,
  ILanguage,
  VimCompleteItem,
  CompleteOption,
  CompleteResult,
  SourceType,
} from './types'
import {
  Position,
  CancellationTokenSource,
  CancellationToken,
  CompletionList,
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from 'vscode-languageserver-protocol'
import {
  CompletionContext,
  CompletionTriggerKind,
} from './provider'
import {
  Disposable,
  echoMessage,
  EventEmitter,
  Event,
} from './util'
import {
  byteSlice,
} from './util/string'
import workspace from './workspace'
import uuid = require('uuid/v4')
const logger = require('./util/logger')('languages')

export interface CompletionProvider {
  id: string
  source: ISource
  languageIds: string[]
}

class Languages implements ILanguage {

  public nvim:Neovim
  private _onDidCompletionSourceCreated = new EventEmitter<ISource>()
  private completionProviders: CompletionProvider[] = []
  private cancelTokenSource: CancellationTokenSource = new CancellationTokenSource()
  public readonly onDidCompletionSourceCreated: Event<ISource> = this._onDidCompletionSourceCreated.event

  public registerCompletionItemProvider(
    name: string,
    shortcut: string,
    languageIds: string | string[],
    provider: CompletionItemProvider,
    triggerCharacters?: string[]
  ):Disposable {
    let id = uuid()
    languageIds = typeof languageIds == 'string' ? [languageIds] : languageIds
    let source = this.createCompleteSource(name, shortcut, provider, languageIds, triggerCharacters)
    this.completionProviders.push({
      id,
      source,
      languageIds: typeof languageIds == 'string' ? [languageIds] : languageIds,
    })
    this._onDidCompletionSourceCreated.fire(source)
    return {
      dispose: () => {
        this.unregisterCompletionItemProvider(id)
      }
    }
  }

  public dispose():void {
    // noop
  }

  public getCompleteSource(languageId: string):ISource | null {
    let {completionProviders} = this
    // only one for each filetype
    let item = completionProviders.find(o => o.languageIds.indexOf(languageId) !== -1)
    return item ? item.source : null
  }

  private createCompleteSource(
    name: string,
    shortcut: string,
    provider: CompletionItemProvider,
    languageIds: string[],
    triggerCharacters: string[],
  ):ISource {
    // track them for resolve
    let completeItems: CompletionItem[] = []
    let hasResolve = typeof provider.resolveCompletionItem === 'function'
    let resolving:string
    return {
      name,
      disabled: false,
      priority: 9,
      sourceType: SourceType.Service,
      filetypes: languageIds,
      triggerCharacters: triggerCharacters || [],
      onCompleteResolve: async (item: VimCompleteItem):Promise<void> => {
        if (!hasResolve) return
        if (completeItems.length == 0) return
        let {word} = item
        resolving = word
        let resolved:CompletionItem
        let prevItem = completeItems.find(o => o.label == word)
        if (!prevItem || prevItem.data.resolving) return
        if (prevItem.data.resolved) {
          resolved = prevItem
        } else {
          prevItem.data.resolving = true
          let token = this.token
          resolved = await provider.resolveCompletionItem(prevItem, this.token)
          if (!resolved || token.isCancellationRequested) return
          resolved.data = Object.assign(resolved.data || {}, {
            resolving: false,
            resolved: true
          })
          let idx = completeItems.findIndex(o => word == o.label)
          if (idx !== -1) completeItems[idx] = resolved
        }
        logger.debug('Resolved complete item', resolved)
        let visible = await this.nvim.call('pumvisible')
        if (visible != 0 && resolving == word) {
          // vim have no suppport for update complete item
          let str = resolved.detail.trim() || ''
          await echoMessage(this.nvim, str)
          let doc = getDocumentation(resolved)
          if (doc) str += '\n\n' + doc
          if (str.length) {
            // vim has bug
            // this.nvim.call('coc#util#preview_info', [str]) // tslint:disable-line
          }
        }
      },
      onCompleteDone: (item: VimCompleteItem):Promise<void> => {
        this.cancelRequest()
        completeItems = []
        return
      },
      async doComplete(opt:CompleteOption):Promise<CompleteResult|null> {
        let {triggerCharacter, bufnr, input} = opt
        let firstChar = input.length ? input[0]: ''
        let doc = workspace.getDocument(bufnr)
        let document = doc.textDocument
        let position = getPosition(opt)
        let context:CompletionContext = {
          triggerKind: triggerCharacter ? CompletionTriggerKind.Invoke : CompletionTriggerKind.TriggerCharacter,
          triggerCharacter
        }
        let cancellSource = new CancellationTokenSource()
        let result = await provider.provideCompletionItems(document, position, cancellSource.token, context)
        let isIncomplete = (result as CompletionList).isIncomplete || false
        completeItems = Array.isArray(result) ? result : result.items
        if (firstChar) {
          completeItems = completeItems.filter(item => {
            return item.label[0] == firstChar
          })
        }
        // mark items unresolved
        completeItems.forEach(item => {
          let data = item.data || {}
          item.data = Object.assign(data, {resolved: false})
        })
        return {
          isIncomplete,
          items: completeItems.map(o => convertVimCompleteItem(o, shortcut))
        }
      }
    }
  }

  private get token():CancellationToken {
    return this.cancelTokenSource.token
  }

  private cancelRequest():void {
    this.cancelTokenSource.cancel()
    this.cancelTokenSource = new CancellationTokenSource()
  }

  private unregisterCompletionItemProvider(id:string):void {
    let idx = this.completionProviders.findIndex(o => o.id == id)
    if (idx !== -1) {
      this.completionProviders.splice(idx, 1)
    }
  }
}

function validString(str:any):boolean {
  if (typeof str !== 'string') return false
  return str.length > 0
}

function convertVimCompleteItem(item: CompletionItem, shortcut: string):VimCompleteItem {
  let isSnippet = item.insertTextFormat === InsertTextFormat.Snippet
  let obj: VimCompleteItem = {
    word: item.insertText ? item.insertText : item.label, // tslint:disable-line
    menu: item.detail ? `${item.detail.replace(/\n/, ' ')} [${shortcut}]` : `[${shortcut}]`,
    kind: completionKindString(item.kind),
    sortText: validString(item.sortText) ? item.sortText : item.label,
    filterText: validString(item.filterText) ? item.filterText : item.label,
    isSnippet
  }
  obj.abbr = obj.filterText
  if (isSnippet) obj.abbr = obj.abbr + '~'
  let document = getDocumentation(item)
  if (document) obj.info = document
  // item.commitCharacters not necessary for vim
  return obj
}

function getDocumentation(item: CompletionItem):string | null {
  let { documentation } = item
  if (!documentation) return null
  if (typeof documentation === 'string') return documentation
  return documentation.value
}

function getPosition(opt: CompleteOption):Position {
  let {line, linenr, col} = opt
  let part = byteSlice(line, 0, col - 1)
  return {
    line: linenr - 1,
    character: part.length + 1
  }
}

function completionKindString(kind: CompletionItemKind):string {
  switch (kind) {
    case CompletionItemKind.Text:
      return 'Text'
    case CompletionItemKind.Method:
      return 'Method'
    case CompletionItemKind.Function:
      return 'Function'
    case CompletionItemKind.Constructor:
      return 'Constructor'
    case CompletionItemKind.Field:
      return 'Field'
    case CompletionItemKind.Variable:
      return 'Variable'
    case CompletionItemKind.Class:
      return 'Class'
    case CompletionItemKind.Interface:
      return 'Interface'
    case CompletionItemKind.Module:
      return 'Module'
    case CompletionItemKind.Property:
      return 'Property'
    case CompletionItemKind.Unit:
      return 'Unit'
    case CompletionItemKind.Value:
      return 'Value'
    case CompletionItemKind.Enum:
      return 'Enum'
    case CompletionItemKind.Keyword:
      return 'Keyword'
    case CompletionItemKind.Snippet:
      return 'Snippet'
    case CompletionItemKind.Color:
      return 'Color'
    case CompletionItemKind.File:
      return 'File'
    case CompletionItemKind.Reference:
      return 'Reference'
    case CompletionItemKind.Folder:
      return 'Folder'
    case CompletionItemKind.EnumMember:
      return 'EnumMember'
    case CompletionItemKind.Constant:
      return 'Constant'
    case CompletionItemKind.Struct:
      return 'Struct'
    case CompletionItemKind.Event:
      return 'Event'
    case CompletionItemKind.Operator:
      return 'Operator'
    case CompletionItemKind.TypeParameter:
      return 'TypeParameter'
    default:
      return ''
  }
}

export default new Languages()