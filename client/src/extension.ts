import * as path from 'path';
import {setEnableSpellChecking, ConfigTarget} from './settings';
import * as settings from './settings';
import * as infoViewer from './infoViewer';
import {CSpellClient} from './client';

import { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';

import { initStatusBar } from './statusbar';

import {userCommandAddWordToDictionary, handlerApplyTextEdits} from './commands';
import * as commands from './commands';

export interface ExtensionApi {
    registerConfig(path: string): void;
    triggerGetSettings(): void;
    enableLanguageId(languageId: string, uri?: string): Thenable<void>;
    disableLanguageId(languageId: string, uri?: string): Thenable<void>;
    enableCurrentLanguage(): Thenable<void>;
    disableCurrentLanguage(): Thenable<void>;
    addWordToUserDictionary(word: string): Thenable<void>;
    addWordToWorkspaceDictionary(word: string, uri?: string | null | vscode.Uri): Thenable<void>;
    enableLocal(target: ConfigTarget, local: string): Thenable<void>;
    disableLocal(target: ConfigTarget, local: string): Thenable<void>;
    updateSettings(): false;
    cSpellClient(): CSpellClient;
}

export function activate(context: ExtensionContext): Thenable<ExtensionApi> {

    // The server is implemented in node
    const serverModule = context.asAbsolutePath(path.join('server', 'src', 'server.js'));

    // Get the cSpell Client
    const client = CSpellClient.create(serverModule);
    const server = client.then(client => {
        // Start the client.
        const clientDispose = client.start();

        function triggerGetSettings() {
            client.triggerSettingsRefresh();
        }

        function splitTextFn(
            apply: (word: string, uri: string | vscode.Uri | null) => Thenable<void>
        ): (word: string) => Thenable<void> {
            const editor = vscode.window.activeTextEditor;
            const document = editor && editor.document;
            const uri = document && document.uri || null;
            return (word: string) => {
                return client.splitTextIntoDictionaryWords(word)
                .then(result => result.words)
                .then(words => apply(words.join(' '), uri))
                .then(_ => {});
            };
        }

        const actionAddWordToFolder = userCommandAddWordToDictionary(
            'Add Word to Workspace Dictionary',
            splitTextFn(commands.addWordToFolderDictionary)
        );
        const actionAddWordToWorkspace = userCommandAddWordToDictionary(
            'Add Word to Workspace Dictionary',
            splitTextFn(commands.addWordToWorkspaceDictionary)
        );
        const actionAddWordToDictionary = userCommandAddWordToDictionary(
            'Add Word to Dictionary',
            splitTextFn(commands.addWordToUserDictionary)
        );

        initStatusBar(context, client);

        // Push the disposable to the context's subscriptions so that the
        // client can be deactivated on extension deactivation
        context.subscriptions.push(
            clientDispose,
            vscode.commands.registerCommand('cSpell.editText', handlerApplyTextEdits(client.client)),
            vscode.commands.registerCommand('cSpell.addWordToDictionarySilent', commands.addWordToFolderDictionary),
            vscode.commands.registerCommand('cSpell.addWordToWorkspaceDictionarySilent', commands.addWordToWorkspaceDictionary),
            vscode.commands.registerCommand('cSpell.addWordToUserDictionarySilent', commands.addWordToUserDictionary),
            vscode.commands.registerCommand('cSpell.addWordToDictionary', actionAddWordToFolder),
            vscode.commands.registerCommand('cSpell.addWordToWorkspaceDictionary', actionAddWordToWorkspace),
            vscode.commands.registerCommand('cSpell.addWordToUserDictionary', actionAddWordToDictionary),
            vscode.commands.registerCommand('cSpell.enableLanguage', commands.enableLanguageId),
            vscode.commands.registerCommand('cSpell.disableLanguage', commands.disableLanguageId),
            vscode.commands.registerCommand('cSpell.enableForWorkspace', () => setEnableSpellChecking(settings.Target.Workspace, false)),
            vscode.commands.registerCommand('cSpell.disableForWorkspace', () => setEnableSpellChecking(settings.Target.Workspace, false)),
            vscode.commands.registerCommand('cSpell.toggleEnableSpellChecker', commands.toggleEnableSpellChecker),
            vscode.commands.registerCommand('cSpell.enableCurrentLanguage', commands.enableCurrentLanguage),
            vscode.commands.registerCommand('cSpell.disableCurrentLanguage', commands.disableCurrentLanguage),
            settings.watchSettingsFiles(triggerGetSettings),
        );

        infoViewer.activate(context, client);

        function registerConfig(path: string) {
            client.registerConfiguration(path);
        }

        return {
            registerConfig,
            triggerGetSettings,
            enableLanguageId: commands.enableLanguageId,
            disableLanguageId: commands.disableLanguageId,
            enableCurrentLanguage: commands.enableCurrentLanguage,
            disableCurrentLanguage: commands.disableCurrentLanguage,
            addWordToUserDictionary: commands.addWordToUserDictionary,
            addWordToWorkspaceDictionary: commands.addWordToWorkspaceDictionary,
            enableLocal: settings.enableLocal,
            disableLocal: settings.disableLocal,
            updateSettings: () => false,
            cSpellClient: () => client,
        };
    });

    return server;
}
