// cSpell:words rxjs cspell diags
import * as vscode from 'vscode';
import * as path from 'path';
import { CSpellClient } from '../client';
import * as Rx from 'rxjs/Rx';
import * as preview from './pugCSpellInfo';
import * as commands from '../commands';
import * as util from '../util';
import {Maybe, uniqueFilter} from '../util';
import { isSupportedUri } from '../util';
import * as serverSettings from '../server';
import * as langCode from '../iso639-1';
import * as config from '../settings';
import { LocalInfo, ActiveTab, LocalSetting } from './pugCSpellInfo';
import { ConfigTarget } from '../settings/config';

const schemeCSpellInfo = 'cspell-info';

export const commandDisplayCSpellInfo    = 'cSpell.displayCSpellInfo';
export const commandEnableLanguage       = 'cSpell.enableLanguageFromCSpellInfo';
export const commandDisableLanguage      = 'cSpell.disableLanguageFromCSpellInfo';
export const commandSetLocal             = 'cSpell.setLocal';
export const commandOverrideLocalSetting = 'cSpell.overrideLocalSetting';
export const commandSelectInfoTab        = 'cSpell.selectInfoTab';

function genCommandLink(command: string, paramValues?: any[]) {
    const cmd = `command:${command}?`;
    const params = paramValues ? JSON.stringify(paramValues) : '';
    return encodeURI(cmd + params);
}

function generateEnableDisableLanguageLink(enable: boolean, languageId: string) {
    const links = [
        commandDisableLanguage,
        commandEnableLanguage,
    ];
    return genCommandLink(links[enable ? 1 : 0], [languageId]);
}

export function activate(context: vscode.ExtensionContext, client: CSpellClient) {

    const previewUri = vscode.Uri.parse(`${schemeCSpellInfo}://authority/cspell-info-preview`);
    const onRefresh = new Rx.Subject<vscode.Uri>();

    let lastDocumentUri: Maybe<vscode.Uri> = undefined;
    let activeTab: ActiveTab = 'LocalInfo';
    const imagesUri = vscode.Uri.file(context.asAbsolutePath('images'));
    const imagesPath = imagesUri.path;

    let knownLocals = new Map<string, LocalInfo>();

    class CSpellInfoTextDocumentContentProvider implements vscode.TextDocumentContentProvider {
        private _onDidChange = new vscode.EventEmitter<vscode.Uri>();

        public provideTextDocumentContent(_: vscode.Uri): Thenable<string> {
            // console.log(_);
            const editor = vscode.window.activeTextEditor;
            const doc = lastDocumentUri && findMatchingDocument(lastDocumentUri.toString())
                || (editor && editor.document);
            return this.createInfoHtml(doc);
        }

        get onDidChange(): vscode.Event<vscode.Uri> {
            return this._onDidChange.event;
        }

        public update(uri: vscode.Uri) {
            this._onDidChange.fire(uri);
        }

        private createInfoHtml(document: Maybe<vscode.TextDocument>): Thenable<string> {
            if (!document) {
                return Promise.resolve('<body>Select an editor tab.</body>');
            }
            const uri = document.uri;
            const filename = path.basename(uri.path);
            const diagnostics = client.diagnostics;
            const diags = diagnostics && diagnostics.get(uri);
            const allSpellingErrors = (diags || [])
                .map(d => d.range)
                .map(range => document.getText(range));
            const spellingErrors = diags && util.freqCount(allSpellingErrors);
            autoRefresh(uri);  // Since the diags can change, we need to setup a refresh.
            return client.getConfigurationForDocument(document).then(response => {
                const { fileEnabled = false, languageEnabled = false, settings = {}, docSettings = {} } = response;
                const languageId = document.languageId;
                const dictionaries = settings.dictionaryDefinitions || [];
                const local = getLocalSetting();
                const availableLocals = friendlyLocals(serverSettings.extractLocals(settings));
                const localInfo = composeLocalInfo(settings);
                const dictionariesForFile = [...(docSettings.dictionaries || [])].sort();
                const dictionariesInUse = new Set(dictionariesForFile);
                const isDictionaryInUse = (dict: string) => dictionariesInUse.has(dict);
                const useDarkTheme = isDarkTheme();
                const html = preview.render({
                    useDarkTheme,
                    fileEnabled,
                    languageEnabled,
                    languageId,
                    filename,
                    spellingErrors,
                    linkEnableDisableLanguage: generateEnableDisableLanguageLink(!languageEnabled, languageId),
                    linkEnableLanguage: generateEnableDisableLanguageLink(true, languageId),
                    linkDisableLanguage: generateEnableDisableLanguageLink(false, languageId),
                    imagesPath,
                    localInfo,
                    local,
                    availableLocals,
                    genSetLocal,
                    genSelectInfoTabLink,
                    genOverrideLocal,
                    dictionariesForFile,
                    isDictionaryInUse,
                    dictionaries,
                    activeTab,
                });
                return html;
            });
        }
    }

    const provider = new CSpellInfoTextDocumentContentProvider();
    const registration = vscode.workspace.registerTextDocumentContentProvider(schemeCSpellInfo, provider);

    const subOnDidChangeTextDocument = onRefresh
        .filter(uri => isSupportedUri(uri))
        // .do(uri => console.log('subOnDidChangeTextDocument: ' + uri.toString()))
        .do(uri => lastDocumentUri = uri)
        .debounceTime(250)
        .subscribe(() => provider.update(previewUri));

    const subOnDidChangeDoc = vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
        if (vscode.window.activeTextEditor && e.document && e.document === vscode.window.activeTextEditor.document) {
            onRefresh.next(e.document.uri);
        }
    });

    const subOnDidChangeEditor = vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor) => {
        if (editor && editor === vscode.window.activeTextEditor && editor.document) {
            onRefresh.next(editor.document.uri);
        }
    });


    function displayCSpellInfo() {
        return vscode.commands
            .executeCommand('vscode.previewHtml', previewUri, vscode.ViewColumn.Two, 'Spell Checker Info')
            .then(
                (success) => {},
                (reason) => {
                    vscode.window.showErrorMessage(reason);
                }
            );
    }

    function findDocumentInVisibleTextEditors(uri: string):  Maybe<vscode.TextDocument> {
        const docs = vscode.window.visibleTextEditors
            .map(e => e.document)
            .filter(doc => !!doc)
            .filter(doc => doc.uri.toString() === uri);
        return docs[0];
    }

    function findMatchingDocument(uri: string): Maybe<vscode.TextDocument> {
        const workspace = vscode.workspace || {};
        const docs = (workspace.textDocuments || [])
            .filter(doc => doc.uri.toString() === uri);
        return docs[0] || findDocumentInVisibleTextEditors(uri);
    }

    function enableLanguage(languageId: string, uri: string) {
        commands.enableLanguageId(languageId, uri);
    }

    function disableLanguage(languageId: string, uri: string) {
        commands.disableLanguageId(languageId, uri);
    }

    type targetScope = 'folder' | 'workspace' | 'global';

    function setLocal(local: string, enable: boolean, isGlobalOrTarget: boolean | targetScope) {
        const target = toTarget(isGlobalOrTarget);
        if (enable) {
            config.enableLocal(target, local);
        } else {
            config.disableLocal(target, local);
        }
    }

    function overrideLocalSetting(enable: boolean, isGlobalOrTarget: boolean | targetScope) {
        config.overrideLocal(enable, toTarget(isGlobalOrTarget));
    }

    function genSetLocal(code: string, enable: boolean, isGlobalOrTarget: boolean | targetScope) {
        return genCommandLink(commandSetLocal, [code, enable, isGlobalOrTarget]);
    }

    function genOverrideLocal(enable: boolean, isGlobalOrTarget: boolean | targetScope) {
        return genCommandLink(commandOverrideLocalSetting, [enable, isGlobalOrTarget]);
    }

    function selectInfoTab(tab: ActiveTab) {
        activeTab = tab;
    }

    function genSelectInfoTabLink(tab: ActiveTab) {
        return genCommandLink(commandSelectInfoTab, [tab]);
    }

    function makeDisposable(sub: Rx.Subscription) {
        return {
            dispose: () => sub.unsubscribe()
        };
    }

    function autoRefresh(uri: vscode.Uri) {
        lastDocumentUri = uri;
        setTimeout(() => {
            if (uri === lastDocumentUri) {
                onRefresh.next(uri);
            }
        }, 1000);
    }

    function friendlyLocals(locals: string[] = []) {
        return locals
            .filter(a => !!a.trim())
            .map(code => langCode.lookupCode(code) || { lang: code, country: '' })
            .map(({lang, country}) => country ? `${lang} - ${country}` : lang)
            .map(lang => lang.trim())
            .filter(uniqueFilter())
            .sort();
    }

    type PartialLocalInfo = {
        [K in keyof LocalInfo]?: LocalInfo[K];
    };

    function localInfo(locals: string[] = [], defaults: PartialLocalInfo = {}): LocalInfo[] {
        return locals
            .filter(a => !!a.trim())
            .filter(uniqueFilter())
            .sort()
            .map(code => ({ code }))
            .map(info => {
                const {lang, country} = langCode.lookupCode(info.code) || { lang: info.code, country: '' };
                const name = country ? `${lang} - ${country}` : lang;
                return {dictionaries: [], ...defaults, ...info, name };
            });
    }

    function getLocalSetting(): LocalSetting {
        const langSettings = getLanguageSettingFromVSCode();

        return {
            default: langSettings.defaultValue,
            user: langSettings.globalValue,
            workspace: langSettings.workspaceValue,
            folder: langSettings.workspaceFolderValue,
        };
    }

    function getLanguageSettingFromVSCode(): config.Inspect<config.CSpellUserSettings['language']> {
        return config.inspectSettingFromVSConfig('language', determineDocUri() || null) || { key: ''};
    }

    function composeLocalInfo(settingsFromServer?: serverSettings.CSpellUserSettings): LocalInfo[] {
        const dictByLocal = serverSettings.extractDictionariesByLocal(settingsFromServer);
        const availableLocals = localInfo(serverSettings.extractLocals(settingsFromServer));
        const localsFromServer = localInfo(serverSettings.extractLanguage(settingsFromServer), { enabled: true });
        const fromConfig = getLanguageSettingFromVSCode();
        const globalLocals = localInfo(serverSettings.normalizeToLocals(fromConfig.globalValue), { isInUserSettings: true });
        const workspaceLocals = localInfo(serverSettings.normalizeToLocals(fromConfig.workspaceValue), { isInWorkspaceSettings: true });
        const folderLocals = localInfo(serverSettings.normalizeToLocals(fromConfig.workspaceFolderValue), { isInFolderSettings: true });

        function resetKnownLocals() {
            [...knownLocals.values()]
                .forEach(info => {
                    delete info.enabled;
                    delete info.isInUserSettings;
                    delete info.isInWorkspaceSettings;
                    delete info.isInFolderSettings;
                });
        }

        resetKnownLocals();
        // Add all the available locals
        availableLocals.concat(
            localsFromServer,
            globalLocals,
            workspaceLocals,
            folderLocals,
        )
        .forEach(info => knownLocals.set(info.code, {...knownLocals.get(info.code), ...info}));

        if (workspaceLocals.length) {
            // Force values to false.
            [...knownLocals.values()].forEach(info => info.isInWorkspaceSettings = info.isInWorkspaceSettings || false);
        }

        if (folderLocals.length) {
            // Force values to false.
            [...knownLocals.values()].forEach(info => info.isInFolderSettings = info.isInFolderSettings || false);
        }

        const locals = [...knownLocals.values()].sort((a, b) => a.name.localeCompare(b.name));

        return augmentLocals(locals, dictByLocal);
    }

    function augmentLocals(locals: preview.LocalInfo[], dictByLocal: Map<string, string[]>) {
        locals.forEach(local => {
            local.dictionaries = (dictByLocal.get(local.code) || []).sort();
        });

        return locals;
    }

    function determineDoc() {
        const editor = vscode.window.activeTextEditor;
        return lastDocumentUri && findMatchingDocument(lastDocumentUri.toString())
            || (editor && editor.document);
    }

    function determineDocUri() {
        const doc = determineDoc();
        return doc && doc.uri;
    }

    function toTarget(target: boolean | targetScope): ConfigTarget {
        if (typeof target === 'boolean') {
            return target ? config.Target.Global : config.Target.Workspace;
        }

        const uri = determineDocUri();

        switch (target.toLowerCase()) {
            case 'folder':
                return uri
                    ? {
                        target: config.Target.WorkspaceFolder,
                        uri,
                    }
                    : config.Target.Workspace;
            case 'workspace':
                return config.Target.Workspace;
            case 'global':
            default:
                return config.Target.Global;
        }
    }


    context.subscriptions.push(
        subOnDidChangeEditor,
        subOnDidChangeDoc,
        vscode.commands.registerCommand(commandDisplayCSpellInfo, displayCSpellInfo),
        vscode.commands.registerCommand(commandEnableLanguage, enableLanguage),
        vscode.commands.registerCommand(commandDisableLanguage, disableLanguage),
        vscode.commands.registerCommand(commandSetLocal, setLocal),
        vscode.commands.registerCommand(commandOverrideLocalSetting, overrideLocalSetting),
        vscode.commands.registerCommand(commandSelectInfoTab, selectInfoTab),
        registration,
        makeDisposable(subOnDidChangeTextDocument),
    );
}


function isDarkTheme() {
    const config = vscode.workspace.getConfiguration();
    const theme = (config.get('workbench.colorTheme') || '').toString();
    return (/dark|black|midnight|graphite/i).test(theme);
}