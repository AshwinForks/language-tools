import chokidar from 'chokidar'
import path from 'path'
import {
  CancellationToken,
  CodeAction,
  CodeActionContext,
  Command,
  commands,
  ExtensionContext,
  Range,
  TextDocument,
  window,
  workspace,
} from 'vscode'
import {
  CodeAction as lsCodeAction,
  CodeActionParams,
  CodeActionRequest,
  LanguageClientOptions,
  ProvideCodeActionsSignature,
} from 'vscode-languageclient'
import { LanguageClient, ServerOptions, TransportKind } from 'vscode-languageclient/node'
import TelemetryReporter from '../../telemetryReporter'
import {
  applySnippetWorkspaceEdit,
  checkForMinimalColorTheme,
  checkForOtherPrismaExtension,
  isDebugOrTestSession,
  isSnippetEdit,
  restartClient,
  createLanguageServer,
} from '../../util'
import { PrismaVSCodePlugin } from '../types'

const packageJson = require('../../../../package.json') // eslint-disable-line

let client: LanguageClient
let serverModule: string
let telemetry: TelemetryReporter
let watcher: chokidar.FSWatcher

const isDebugMode = () => process.env.VSCODE_DEBUG_MODE === 'true'
const isE2ETestOnPullRequest = () => process.env.PRISMA_USE_LOCAL_LS === 'true'

const activateClient = (
  context: ExtensionContext,
  serverOptions: ServerOptions,
  clientOptions: LanguageClientOptions,
) => {
  // Create the language client
  client = createLanguageServer(serverOptions, clientOptions)

  const disposable = client.start()

  // Start the client. This will also launch the server
  context.subscriptions.push(disposable)
}

const startFileWatcher = (rootPath: string): chokidar.FSWatcher => {
  console.debug('Starting File Watcher')
  return chokidar.watch(path.join(rootPath, '**/node_modules/.prisma/client/index.d.ts'), {
    // ignore dotfiles (except .prisma) adjusted from chokidar README example
    ignored: /(^|[\/\\])\.(?!prisma)./,
    // limits how many levels of subdirectories will be traversed.
    // Note that `node_modules/.prisma/client/` counts for 3 already
    // Example
    // If vs code extension is open in root folder of a project and the path to index.d.ts is
    // ./server/database/node_modules/.prisma/client/index.d.ts
    // then the depth is equal to 2 + 3 = 5
    depth: 9,
    // When false, only the symlinks themselves will be watched for changes
    // instead of following the link references and bubbling events through the link's path.
    followSymlinks: false,
  })
}

const onFileChange = (path: string) => {
  console.log(`File ${path} has been changed. Restarting TS Server.`)
  commands.executeCommand('typescript.restartTsServer') // eslint-disable-line
}

const plugin: PrismaVSCodePlugin = {
  name: 'prisma-language-server',
  enabled: () => true,
  activate: async (context) => {
    const isDebugOrTest = isDebugOrTestSession()

    const rootPath = workspace.workspaceFolders?.[0].uri.path
    if (rootPath) {
      // This setting defaults to true (see package.json of vscode extension)
      const isFileWatcherEnabled = workspace.getConfiguration('prisma').get('fileWatcher')

      if (isFileWatcherEnabled) {
        watcher = startFileWatcher(rootPath)
        console.debug('File Watcher is enabled and started.')
      } else {
        console.debug('File Watcher is disabled.')
      }
    } else {
      console.debug('File Watcher was skipped, rootPath is falsy')
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (packageJson.name === 'prisma-insider-pr-build') {
      console.log('Using local Language Server for prisma-insider-pr-build')
      serverModule = context.asAbsolutePath(path.join('./language-server/dist/src/bin'))
    } else if (isDebugMode() || isE2ETestOnPullRequest()) {
      // use Language Server from folder for debugging
      console.log('Using local Language Server from filesystem')
      serverModule = context.asAbsolutePath(path.join('../../packages/language-server/dist/src/bin'))
    } else {
      console.log('Using published Language Server (npm)')
      // use published npm package for production
      serverModule = require.resolve('@prisma/language-server/dist/src/bin')
    }
    console.log(`serverModule: ${serverModule}`)

    // The debug options for the server
    // --inspect=6009: runs the server in Node's Inspector mode so VSCode can attach to the server for debugging
    const debugOptions = {
      execArgv: ['--nolazy', '--inspect=6009'],
      env: { DEBUG: true },
    }

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions: ServerOptions = {
      run: { module: serverModule, transport: TransportKind.ipc },
      debug: {
        module: serverModule,
        transport: TransportKind.ipc,
        options: debugOptions,
      },
    }

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
      // Register the server for prisma documents
      documentSelector: [{ scheme: 'file', language: 'prisma' }],

      /* This middleware is part of the workaround for https://github.com/prisma/language-tools/issues/311 */
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      middleware: {
        async provideCodeActions(
          document: TextDocument,
          range: Range,
          context: CodeActionContext,
          token: CancellationToken,
          _: ProvideCodeActionsSignature, // eslint-disable-line @typescript-eslint/no-unused-vars
        ) {
          const params: CodeActionParams = {
            textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(document),
            range: client.code2ProtocolConverter.asRange(range),
            context: client.code2ProtocolConverter.asCodeActionContext(context),
          }

          return client.sendRequest(CodeActionRequest.type, params, token).then(
            (values) => {
              if (values === null) return undefined
              const result: (CodeAction | Command)[] = []
              for (const item of values) {
                if (lsCodeAction.is(item)) {
                  const action = client.protocol2CodeConverter.asCodeAction(item)
                  if (
                    isSnippetEdit(item, client.code2ProtocolConverter.asTextDocumentIdentifier(document)) &&
                    item.edit !== undefined
                  ) {
                    action.command = {
                      command: 'prisma.applySnippetWorkspaceEdit',
                      title: '',
                      arguments: [action.edit],
                    }
                    action.edit = undefined
                  }
                  result.push(action)
                } else {
                  const command = client.protocol2CodeConverter.asCommand(item)
                  result.push(command)
                }
              }
              return result
            },
            (_) => undefined, // eslint-disable-line @typescript-eslint/no-unused-vars
          )
        },
      } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    // const config = workspace.getConfiguration('prisma')

    workspace.onDidChangeConfiguration(
      async (event) => {
        const fileWatcherConfigChanged = event.affectsConfiguration('prisma.fileWatcher')

        if (fileWatcherConfigChanged) {
          const isFileWatcherEnabled = workspace.getConfiguration('prisma').get('fileWatcher')

          const rootPath = workspace.workspaceFolders?.[0].uri.path

          // This setting defaults to true (see package.json of vscode extension)
          if (isFileWatcherEnabled) {
            // if watcher.closed === true, the watcher was closed previously and can be safely restarted
            // if watcher.closed === false, it is already running
            // but if the JSON settings are empty like {} and the user enables the file watcher
            // we need to catch that case to avoid starting another extra file watcher
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
            if (watcher && (watcher as any).closed === false) {
              console.debug("onDidChangeConfiguration: watcher.closed === false so it's already running. Do nothing.")
            } else {
              // Let's start it
              if (rootPath) {
                watcher = startFileWatcher(rootPath)
                watcher.on('change', onFileChange)
                console.debug('onDidChangeConfiguration: File Watcher is now enabled and started.')
              } else {
                console.debug('onDidChangeConfiguration: rootPath is falsy')
              }
            }
          } else {
            // Let's stop it
            if (watcher) {
              await watcher.close()
              console.log('onDidChangeConfiguration: File Watcher stopped.')
            } else {
              console.debug('onDidChangeConfiguration: No File Watcher found')
            }
          }
        }
      }, // eslint-disable-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
      null,
      context.subscriptions,
    )

    context.subscriptions.push(
      commands.registerCommand('prisma.restartLanguageServer', async () => {
        client = await restartClient(context, client, serverOptions, clientOptions)
        window.showInformationMessage('Prisma language server restarted.') // eslint-disable-line @typescript-eslint/no-floating-promises
      }),

      /* This command is part of the workaround for https://github.com/prisma/language-tools/issues/311 */
      commands.registerCommand('prisma.applySnippetWorkspaceEdit', applySnippetWorkspaceEdit()),

      commands.registerCommand('prisma.filewatcherEnable', async () => {
        const prismaConfig = workspace.getConfiguration('prisma')
        // First, is set to true value
        // Second, is set it on Workspace level settings
        await prismaConfig.update('fileWatcher', true, false)
      }),

      commands.registerCommand('prisma.filewatcherDisable', async () => {
        const prismaConfig = workspace.getConfiguration('prisma')
        // First, is set to false value
        // Second, is set it on Workspace level settings
        await prismaConfig.update('fileWatcher', false, false)
      }),
    )

    activateClient(context, serverOptions, clientOptions)

    if (!isDebugOrTest) {
      // eslint-disable-next-line
      const extensionId = 'prisma.' + packageJson.name
      // eslint-disable-next-line
      const extensionVersion: string = packageJson.version

      telemetry = new TelemetryReporter(extensionId, extensionVersion)

      context.subscriptions.push(telemetry)

      await telemetry.sendTelemetryEvent()

      if (extensionId === 'prisma.prisma-insider') {
        checkForOtherPrismaExtension()
      }
    }

    checkForMinimalColorTheme()

    if (watcher) {
      watcher.on('change', onFileChange)
    }
  },
  deactivate: async () => {
    if (!client) {
      return undefined
    }

    if (!isDebugOrTestSession()) {
      telemetry.dispose() // eslint-disable-line @typescript-eslint/no-floating-promises
    }

    return client.stop()
  },
}
export default plugin
